/**
 * RFC 7009 OAuth 2.0 Token Revocation (#2144).
 *
 * Clearing the Inspector's OAuth state used to delete the *local* copy of the
 * tokens and stop there: the access token, and the refresh token when one was
 * issued, stayed valid at the authorization server until they expired on their
 * own. From the AS's side nothing happened — the client just went quiet — so a
 * day of connect/disconnect iteration left it holding a pile of live grants for
 * sessions that had ended hours ago. RFC 7009 §1 describes exactly this case
 * (a client invalidating its tokens when the user logs out or walks away) and
 * this module is the request that closes it.
 *
 * Everything here is **best-effort**, and deliberately so: the local clear is
 * what the user asked for, and it must finish whether or not the AS cooperates.
 * An authorization server that advertises no `revocation_endpoint` is left
 * behaving exactly as before, a network error or a non-2xx is reported and
 * swallowed, and a short timeout keeps a slow AS from hanging the teardown.
 * Every path therefore returns a {@link TokenRevocationOutcome} rather than
 * throwing — a caller is telling us to forget these tokens, and there is no
 * failure here that should stop it.
 */

import type {
  OAuthClientInformation,
  OAuthMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/client";
import { selectClientAuthMethod } from "@modelcontextprotocol/client";
import type { InspectorLogger } from "../logging/index.js";
import type { OAuthStorage } from "./storage.js";

/**
 * How long a revocation request may take before it is abandoned.
 *
 * Short on purpose. This runs inside a disconnect the user has already
 * committed to, so an unreachable or wedged authorization server must not hold
 * the teardown open — five seconds is long enough for a real endpoint on a slow
 * link and short enough that a dead one is not felt as a hang.
 */
export const DEFAULT_REVOCATION_TIMEOUT_MS = 5000;

/** Why a revocation request was not sent. */
export type TokenRevocationSkipReason =
  /** The caller turned revocation off for this server. */
  | "disabled"
  /** The authorization server advertises no `revocation_endpoint`. */
  | "no_endpoint"
  /** Nothing is stored for this server, so there is no grant to revoke. */
  | "no_tokens"
  /** Authorization-server metadata could not be resolved at all. */
  | "no_metadata";

/**
 * What happened on the revocation leg. Never an exception: see the module
 * comment — the local clear runs regardless, so this is reported, not thrown.
 */
export type TokenRevocationOutcome =
  | {
      status: "revoked";
      /** Which token RFC 7009 §2.1 was asked about. */
      tokenTypeHint: "refresh_token" | "access_token";
      endpoint: string;
    }
  | { status: "skipped"; reason: TokenRevocationSkipReason }
  | { status: "failed"; detail: string; endpoint?: string };

/**
 * The token to name in the request, and the hint that describes it.
 *
 * A refresh token is preferred when one exists, and not merely as a
 * tie-breaker: RFC 7009 §2.1 says an AS asked to revoke a refresh token SHOULD
 * also invalidate the access tokens issued under the same grant, so the single
 * request covers both. Naming the access token instead would leave the refresh
 * token — the long-lived half, and the one a user cannot wait out — alive.
 */
export function selectRevocableToken(
  tokens: OAuthTokens | undefined,
): { token: string; tokenTypeHint: "refresh_token" | "access_token" } | null {
  if (!tokens) return null;
  if (tokens.refresh_token) {
    return { token: tokens.refresh_token, tokenTypeHint: "refresh_token" };
  }
  if (tokens.access_token) {
    return { token: tokens.access_token, tokenTypeHint: "access_token" };
  }
  return null;
}

/**
 * The client-authentication methods the revocation endpoint advertises.
 *
 * RFC 8414 §2 gives `revocation_endpoint_auth_methods_supported` a default of
 * **`client_secret_basic`** when it is omitted — it does *not* inherit
 * `token_endpoint_auth_methods_supported`. Falling through to the token
 * endpoint's list would make metadata advertising only `client_secret_post`
 * there send POST credentials to a revocation endpoint that never advertised
 * that method, which a strict server rejects.
 *
 * An empty result is returned rather than a literal `["client_secret_basic"]`
 * because that is what makes {@link selectClientAuthMethod} apply exactly the
 * RFC's default — `client_secret_basic` when the client holds a secret, `none`
 * when it does not — while still honoring a `token_endpoint_auth_method` the
 * client's own registration declares.
 */
export function revocationAuthMethods(metadata: OAuthMetadata): string[] {
  return metadata.revocation_endpoint_auth_methods_supported ?? [];
}

export interface RevocationRequestParams {
  endpoint: string;
  token: string;
  tokenTypeHint: "refresh_token" | "access_token";
  clientInformation?: OAuthClientInformation;
  supportedAuthMethods: string[];
}

/**
 * Build the RFC 7009 §2.1 request — an `application/x-www-form-urlencoded` POST
 * carrying `token` and `token_type_hint`, plus client authentication.
 *
 * Split out from {@link revokeToken} because *what is sent* is the part worth
 * asserting directly: a credential in the wrong place (basic vs. post) is a
 * silent 401 at a real AS and indistinguishable from "the server declined" in
 * an end-to-end test.
 */
export function buildRevocationRequest(params: RevocationRequestParams): {
  url: string;
  init: RequestInit;
} {
  const body = new URLSearchParams({
    token: params.token,
    token_type_hint: params.tokenTypeHint,
  });
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  };

  const client = params.clientInformation;
  if (client) {
    const method = selectClientAuthMethod(client, params.supportedAuthMethods);
    if (method === "client_secret_basic" && client.client_secret) {
      // Deliberately byte-identical to what the SDK's `applyBasicAuth` sends at
      // the token endpoint: the raw `id:secret`, *not* the form-urlencoded pair
      // RFC 6749 §2.3.1 asks for. Matching the RFC here instead would mean this
      // request and the token request present the same credential differently,
      // so an authorization server holding a secret with a reserved character
      // could accept one and reject the other — a failure that would look like
      // "revocation is broken" rather than like an encoding disagreement.
      // Whatever the AS accepted to mint these tokens is what ends them.
      headers.Authorization = `Basic ${base64Encode(`${client.client_id}:${client.client_secret}`)}`;
    } else if (method === "client_secret_post" && client.client_secret) {
      body.set("client_id", client.client_id);
      body.set("client_secret", client.client_secret);
    } else {
      // Public client (or a confidential one with no secret on hand): RFC 7009
      // §2.1 still wants the client identified.
      body.set("client_id", client.client_id);
    }
  }

  return {
    url: params.endpoint,
    init: { method: "POST", headers, body: body.toString() },
  };
}

/**
 * Base64 for the Basic credential, in both runtimes this code runs in.
 *
 * `btoa` is the browser's and is byte-oriented, so the percent-encoded
 * credential above (which is ASCII by construction) is safe to pass it. Node
 * has `Buffer`; reaching for it first would pull a Node built-in into the
 * browser bundle, which the #1769 build gate rejects outright.
 */
function base64Encode(value: string): string {
  if (typeof btoa === "function") return btoa(value);
  /* v8 ignore next 2 -- Node 22 and every supported browser define btoa; this is the belt-and-braces branch. */
  return Buffer.from(value, "utf8").toString("base64");
}

export interface RevokeTokenParams extends RevocationRequestParams {
  fetchFn: typeof fetch;
  timeoutMs?: number;
}

/**
 * POST the revocation request and classify the answer.
 *
 * RFC 7009 §2.2 makes a 200 the success case *and* the response to a token the
 * AS does not recognize, which is why an already-expired token is not an error
 * here. Anything else — a 4xx, a 5xx, a network failure, the timeout — is
 * reported as `failed` and goes no further than a warning at the call site.
 */
export async function revokeToken(
  params: RevokeTokenParams,
): Promise<TokenRevocationOutcome> {
  const { url, init } = buildRevocationRequest(params);
  const timeoutMs = params.timeoutMs ?? DEFAULT_REVOCATION_TIMEOUT_MS;
  try {
    // The signal alone is not enough to bound this. In the browser the fetch is
    // `createRemoteFetch`, which re-issues the call as a POST to `/api/fetch`
    // and does not forward `init.signal`; the backend's outbound fetch gets no
    // signal either. So a wedged authorization server would hold the teardown
    // open indefinitely on exactly the path the timeout exists for. The race is
    // what actually enforces the deadline; the signal is kept because it does
    // cancel the direct-fetch paths (CLI, TUI, backend) rather than merely
    // abandoning them.
    const response = await withDeadline(
      params.fetchFn(url, { ...init, signal: AbortSignal.timeout(timeoutMs) }),
      timeoutMs,
    );
    if (!response.ok) {
      return {
        status: "failed",
        endpoint: url,
        detail:
          `revocation endpoint responded ${response.status} ${response.statusText}`.trim(),
      };
    }
    return {
      status: "revoked",
      tokenTypeHint: params.tokenTypeHint,
      endpoint: url,
    };
  } catch (err) {
    return {
      status: "failed",
      endpoint: url,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Reject with a timeout error if `promise` has not settled within `timeoutMs`.
 *
 * The underlying request is abandoned rather than cancelled — nothing here can
 * cancel a fetch the proxy already stripped the signal from. That is the right
 * trade for this caller: the point is that the *teardown* proceeds, and the
 * response, if it ever arrives, is a revocation we no longer need to wait for.
 * The timer is cleared on the settled path so a caller is never held awake by it.
 */
async function withDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(new Error(`revocation request timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export interface RevokeStoredOAuthTokensParams {
  serverUrl: string;
  storage: OAuthStorage;
  fetchFn: typeof fetch;
  /**
   * `false` skips the request entirely — the deliberate case from #2144, where
   * a user wants to watch a server cope with a client that walks off still
   * holding live tokens.
   */
  enabled?: boolean;
  timeoutMs?: number;
  logger?: InspectorLogger;
}

/**
 * Revoke the tokens the Inspector holds for `serverUrl`, reading everything it
 * needs out of the OAuth store.
 *
 * Called immediately **before** the local clear, since the store is where the
 * token, the client credentials, and the discovered `revocation_endpoint` all
 * live — after the clear there is nothing left to revoke with.
 *
 * The metadata comes from the cache the OAuth flow already populated rather
 * than from a fresh discovery round-trip: the tokens being revoked were minted
 * by that same authorization server, so its cached document is the document
 * that describes them, and re-discovering would add two network legs to a
 * teardown for no new information. A server that has never completed an OAuth
 * flow has no cached metadata *and* no tokens, so it short-circuits either way.
 */
export async function revokeStoredOAuthTokens(
  params: RevokeStoredOAuthTokensParams,
): Promise<TokenRevocationOutcome> {
  const { serverUrl, logger } = params;
  if (params.enabled === false) {
    return { status: "skipped", reason: "disabled" };
  }

  const outcome = await computeOutcome(params);
  if (outcome.status === "failed") {
    logger?.warn(
      { serverUrl, endpoint: outcome.endpoint, detail: outcome.detail },
      "Token revocation failed; clearing local OAuth state anyway",
    );
  } else if (outcome.status === "skipped" && outcome.reason === "no_endpoint") {
    logger?.debug(
      { serverUrl },
      "Skipping token revocation: authorization server metadata has no revocation_endpoint",
    );
  }
  return outcome;
}

/**
 * The client credentials to authenticate the revocation request with.
 *
 * Mirrors `BaseOAuthClientProvider.clientInformation`: the preregistered
 * (static, issuer-independent) entry wins, then the per-issuer dynamic
 * registration. Reading only the second would silently drop client
 * authentication for every server configured with an `oauth.clientId` — the
 * confidential case, where an authorization server is most likely to *require*
 * it and answer 401.
 */
async function resolveClientInformation(
  storage: OAuthStorage,
  serverUrl: string,
): Promise<OAuthClientInformation | undefined> {
  return (
    (await storage.getClientInformation(serverUrl, true)) ??
    (await storage.getClientInformation(serverUrl, false))
  );
}

async function computeOutcome(
  params: RevokeStoredOAuthTokensParams,
): Promise<TokenRevocationOutcome> {
  const { serverUrl, storage, fetchFn } = params;

  // Read the token first. It is the cheapest disqualifier, and a server with no
  // stored grant should not provoke a metadata read at all.
  let tokens: OAuthTokens | undefined;
  let metadata: OAuthMetadata | null;
  let clientInformation: OAuthClientInformation | undefined;
  try {
    tokens = await storage.getTokens(serverUrl);
    const revocable = selectRevocableToken(tokens);
    if (!revocable) return { status: "skipped", reason: "no_tokens" };

    metadata = await storage.getServerMetadata(serverUrl);
    if (!metadata) return { status: "skipped", reason: "no_metadata" };
    if (!metadata.revocation_endpoint) {
      return { status: "skipped", reason: "no_endpoint" };
    }

    clientInformation = await resolveClientInformation(storage, serverUrl);
    return await revokeToken({
      endpoint: metadata.revocation_endpoint,
      token: revocable.token,
      tokenTypeHint: revocable.tokenTypeHint,
      clientInformation,
      supportedAuthMethods: revocationAuthMethods(metadata),
      fetchFn,
      timeoutMs: params.timeoutMs,
    });
  } catch (err) {
    // A store that cannot be read (a corrupt blob, a remote backend that 500s)
    // is not a reason to abandon the clear the user asked for.
    return {
      status: "failed",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}
