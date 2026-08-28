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
 *
 * It is a budget for the **whole** call, not per request: a server with several
 * issuer-bound grants revokes them sequentially against one shared deadline, so
 * the bound the user feels is this number regardless of how many grants the
 * clear is about to delete.
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
      // RFC 6749 §2.3.1: each half is form-urlencoded *before* the colon joins
      // them. This deliberately differs from the SDK's `applyBasicAuth`, which
      // base64s the raw pair — matching that was the first instinct, on the
      // theory that a credential should be presented the same way here as at
      // the token endpoint. It does not hold up: a client authenticated with
      // `client_secret_post` never exercised the SDK's Basic path at all, so
      // there is no precedent to match, and the raw form is ambiguous for a
      // client id containing `:` and makes `btoa` throw outright on a
      // non-Latin-1 secret. Encoding is what the server decodes.
      const credentials = `${encodeURIComponent(client.client_id)}:${encodeURIComponent(client.client_secret)}`;
      headers.Authorization = `Basic ${base64Encode(credentials)}`;
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
    /* v8 ignore next -- the Promise executor runs synchronously, so `timer` is
       always assigned by the time this runs; the guard exists only because
       TypeScript cannot see that. */
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
 * tokens, the client credentials, and the discovered `revocation_endpoint` all
 * live — after the clear there is nothing left to revoke with. Every grant the
 * clear will delete is covered, not just the active issuer's: see
 * {@link collectGrants}.
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
 * (static, issuer-independent) entry wins, then the registration bound to
 * `issuer`. Reading only the second would silently drop client authentication
 * for every server configured with an `oauth.clientId` — the confidential case,
 * where an authorization server is most likely to *require* it and answer 401.
 */
async function resolveClientInformation(
  storage: OAuthStorage,
  serverUrl: string,
  issuer?: string,
): Promise<OAuthClientInformation | undefined> {
  return (
    (await storage.getClientInformation(serverUrl, true)) ??
    (await storage.getClientInformation(serverUrl, false, issuer))
  );
}

/** One revocable grant held for a server, and which AS minted it. */
interface StoredGrant {
  /** Undefined for the legacy unkeyed slot, which predates issuer binding. */
  issuer?: string;
  token: string;
  tokenTypeHint: "refresh_token" | "access_token";
  clientInformation?: OAuthClientInformation;
}

/** What {@link collectGrants} found, including the slots it could not read. */
interface CollectedGrants {
  grants: StoredGrant[];
  /**
   * One `failed` outcome per slot whose read threw. Kept apart from the grants
   * so a single corrupt slot cannot abandon the ones that are still revocable
   * — the clear deletes them all either way, so the failure has to be reported
   * *beside* the successes rather than instead of them.
   */
  failures: TokenRevocationOutcome[];
}

/**
 * Every grant `clear(serverUrl)` is about to delete.
 *
 * `clear` drops **every** `byIssuer` slot, so reading only the context-free
 * (active-issuer) token would leave an earlier authorization server's grant
 * live while destroying the local record of it — the exact leak this feature
 * exists to close, just moved one level down. A server that authorized against
 * issuers A and B has two grants here, not one.
 *
 * Deduplication is by **issuer *and* token**, not by token alone. A token is
 * only meaningful to the authorization server that minted it, so two issuers
 * that happen to mint the same opaque string are two grants; collapsing them
 * would drop the second before the issuer-mismatch check could even report it.
 *
 * The ctx-less read is included last and is the one exception: it resolves to
 * the *active* issuer's slot (already collected above) or, on a pre-SEP-2352
 * entry, to the legacy unkeyed token — which nothing else returns. It is
 * suppressed on the issuer *stamp* the store puts on a slot-sourced value
 * rather than on the token's value, because the active slot may hold client
 * information without a token: the read then falls back to the legacy grant,
 * and a value collision with any other issuer would drop a real grant. It is
 * also the only read here allowed to fall back; an enumerated issuer is read
 * exactly, so a legacy token is never mislabelled as belonging to one.
 */
async function collectGrants(
  storage: OAuthStorage,
  serverUrl: string,
): Promise<CollectedGrants> {
  const grants: StoredGrant[] = [];
  const failures: TokenRevocationOutcome[] = [];
  const seenKeys = new Set<string>();

  const add = async (issuer?: string): Promise<void> => {
    const tokens =
      issuer === undefined
        ? await storage.getTokens(serverUrl)
        : await storage.getIssuerTokens(serverUrl, issuer);
    const revocable = selectRevocableToken(tokens);
    if (!revocable) return;

    if (issuer === undefined) {
      // `getTokens` stamps the resolved issuer onto a value it took from a
      // byIssuer slot and leaves an unkeyed one unstamped (see `withIssuer` in
      // oauth-storage.ts — the stamp is the key it came from). That, not the
      // token's *value*, is what says this read duplicates a slot already
      // collected: the active slot can hold client information without a token,
      // in which case this falls back to the legacy grant, and a coincidental
      // value collision with some other issuer would otherwise drop it
      // unrevoked and unreported.
      const fromSlot = (tokens as { issuer?: string } | undefined)?.issuer;
      if (fromSlot !== undefined) return;
    } else {
      const key = `${issuer}\u0000${revocable.token}`;
      if (seenKeys.has(key)) return;
      seenKeys.add(key);
    }

    grants.push({
      issuer,
      ...revocable,
      clientInformation: await resolveClientInformation(
        storage,
        serverUrl,
        issuer,
      ),
    });
  };

  /** Read one slot; a slot that throws is reported, not fatal to the rest. */
  const addSafely = async (issuer?: string): Promise<void> => {
    try {
      await add(issuer);
    } catch (err) {
      const where =
        issuer === undefined ? "the unkeyed slot" : `issuer ${issuer}`;
      failures.push({
        status: "failed",
        detail: `could not read the stored grant for ${where}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
    }
  };

  // A `listIssuers` failure is fatal on its own — there is nothing to
  // enumerate — but the ctx-less read below can still find a legacy grant, so
  // it is recorded rather than thrown.
  let issuers: string[] = [];
  try {
    issuers = await storage.listIssuers(serverUrl);
  } catch (err) {
    failures.push({
      status: "failed",
      detail: `could not list the stored authorization servers: ${
        err instanceof Error ? err.message : String(err)
      }`,
    });
  }
  for (const issuer of issuers) {
    await addSafely(issuer);
  }
  await addSafely();
  return { grants, failures };
}

/**
 * Combine per-grant outcomes into the one this function reports.
 *
 * A **failure outranks a success**: a grant still live at the authorization
 * server is what the caller needs to surface, and reporting another grant's
 * success would leave that silent. A success outranks a skip for the same
 * reason in the other direction — "revoked" is the more specific truth.
 *
 * Exported for its own test. `computeOutcome` returns early when there are no
 * grants, so the empty case cannot arise from there — which is exactly why the
 * fallback needs testing somewhere: nothing else would ever exercise it, and a
 * function that returns `undefined` while typed otherwise is a trap for the
 * next caller.
 */
export function aggregateOutcomes(
  outcomes: TokenRevocationOutcome[],
): TokenRevocationOutcome {
  return (
    outcomes.find((o) => o.status === "failed") ??
    outcomes.find((o) => o.status === "revoked") ??
    outcomes[0] ?? { status: "skipped", reason: "no_tokens" }
  );
}

async function computeOutcome(
  params: RevokeStoredOAuthTokensParams,
): Promise<TokenRevocationOutcome> {
  const { serverUrl, storage, fetchFn } = params;

  try {
    // Grants first. They are the cheapest disqualifier, and a server with no
    // stored grant should not provoke a metadata read at all.
    //
    // `failures` seeds `outcomes` rather than short-circuiting: a slot that
    // could not be read is still about to be deleted, so it has to be reported
    // *alongside* whatever the readable grants do, not instead of them.
    const { grants, failures } = await collectGrants(storage, serverUrl);
    if (grants.length === 0) {
      return failures.length > 0
        ? aggregateOutcomes(failures)
        : { status: "skipped", reason: "no_tokens" };
    }

    const metadata = await storage.getServerMetadata(serverUrl);
    if (!metadata) {
      return aggregateOutcomes([
        ...failures,
        { status: "skipped", reason: "no_metadata" },
      ]);
    }
    const endpoint = metadata.revocation_endpoint;
    if (!endpoint) {
      return aggregateOutcomes([
        ...failures,
        { status: "skipped", reason: "no_endpoint" },
      ]);
    }

    const supportedAuthMethods = revocationAuthMethods(metadata);
    const outcomes: TokenRevocationOutcome[] = [...failures];
    // ONE deadline for the whole teardown, not one per grant. `clear` deletes
    // every issuer slot, so a server with N of them would otherwise block the
    // disconnect for N × the timeout — at which point the "short timeout"
    // bounds a single request and nothing the user experiences. Grants are
    // revoked sequentially on purpose (a burst of parallel requests to one
    // authorization server is not a kindness), so the budget is shared instead.
    const timeoutMs = params.timeoutMs ?? DEFAULT_REVOCATION_TIMEOUT_MS;
    const deadlineAt = Date.now() + timeoutMs;
    for (const grant of grants) {
      // Metadata is cached once per server, not per issuer, so it describes
      // whichever authorization server was discovered last. Sending another
      // issuer's token to *this* endpoint would hand a credential to a server
      // that never minted it — worse than not revoking. So say plainly that the
      // grant is being dropped unrevoked rather than doing either silently.
      if (
        grant.issuer !== undefined &&
        metadata.issuer !== undefined &&
        grant.issuer !== metadata.issuer
      ) {
        outcomes.push({
          status: "failed",
          detail: `the cached authorization-server metadata is for ${metadata.issuer}, so the grant bound to ${grant.issuer} was cleared without revocation`,
        });
        continue;
      }
      const remainingMs = deadlineAt - Date.now();
      if (remainingMs <= 0) {
        outcomes.push({
          status: "failed",
          endpoint,
          detail: `the ${timeoutMs}ms revocation budget was exhausted before this grant was attempted${
            grant.issuer === undefined ? "" : ` (issuer ${grant.issuer})`
          }`,
        });
        continue;
      }
      outcomes.push(
        await revokeToken({
          endpoint,
          token: grant.token,
          tokenTypeHint: grant.tokenTypeHint,
          clientInformation: grant.clientInformation,
          supportedAuthMethods,
          fetchFn,
          timeoutMs: remainingMs,
        }),
      );
    }
    return aggregateOutcomes(outcomes);
  } catch (err) {
    // A store that cannot be read (a corrupt blob, a remote backend that 500s)
    // is not a reason to abandon the clear the user asked for.
    return {
      status: "failed",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}
