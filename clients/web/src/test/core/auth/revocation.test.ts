import { describe, it, expect, vi, beforeEach } from "vitest";
import type { OAuthMetadata } from "@modelcontextprotocol/client";
import { BrowserOAuthStorage } from "@inspector/core/auth/browser/storage.js";
import {
  DEFAULT_REVOCATION_TIMEOUT_MS,
  aggregateOutcomes,
  buildRevocationRequest,
  revocationAuthMethods,
  revokeStoredOAuthTokens,
  revokeToken,
  selectRevocableToken,
} from "@inspector/core/auth/revocation.js";
import type { InspectorLogger } from "@inspector/core/logging/index.js";

/** A fully-typed `InspectorLogger` double, so the mock's shape is checked. */
function fakeLogger(): InspectorLogger {
  return {
    level: "info",
    fatal: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    silent: vi.fn(),
    child: vi.fn(() => fakeLogger()),
  };
}

const SERVER_URL = "https://mcp.example.com/mcp";
const REVOKE_URL = "https://as.example.com/revoke";

function metadata(over: Partial<OAuthMetadata> = {}): OAuthMetadata {
  return {
    issuer: "https://as.example.com",
    authorization_endpoint: "https://as.example.com/authorize",
    token_endpoint: "https://as.example.com/token",
    response_types_supported: ["code"],
    revocation_endpoint: REVOKE_URL,
    ...over,
  } as OAuthMetadata;
}

function body(init: RequestInit): URLSearchParams {
  return new URLSearchParams(String(init.body));
}

function headerOf(init: RequestInit, name: string): string | undefined {
  return (init.headers as Record<string, string> | undefined)?.[name];
}

describe("selectRevocableToken", () => {
  // RFC 7009 §2.1 — revoking the refresh token asks the AS to invalidate the
  // access tokens under the same grant, so one request covers both. Naming the
  // access token instead would leave the long-lived half alive.
  it("prefers the refresh token when one exists", () => {
    expect(
      selectRevocableToken({
        access_token: "a",
        token_type: "Bearer",
        refresh_token: "r",
      }),
    ).toEqual({ token: "r", tokenTypeHint: "refresh_token" });
  });

  it("falls back to the access token", () => {
    expect(
      selectRevocableToken({ access_token: "a", token_type: "Bearer" }),
    ).toEqual({ token: "a", tokenTypeHint: "access_token" });
  });

  it("has nothing to revoke without tokens", () => {
    expect(selectRevocableToken(undefined)).toBeNull();
    expect(
      selectRevocableToken({ access_token: "", token_type: "Bearer" }),
    ).toBeNull();
  });
});

describe("revocationAuthMethods", () => {
  it("prefers the revocation endpoint's own list", () => {
    expect(
      revocationAuthMethods(
        metadata({
          revocation_endpoint_auth_methods_supported: ["client_secret_post"],
          token_endpoint_auth_methods_supported: ["client_secret_basic"],
        }),
      ),
    ).toEqual(["client_secret_post"]);
  });

  // RFC 8414 §2 defaults an omitted revocation list to `client_secret_basic` —
  // it does NOT inherit the token endpoint's. Inheriting would send POST
  // credentials to an endpoint that never advertised that method.
  it("ignores the token endpoint's list", () => {
    expect(
      revocationAuthMethods(
        metadata({
          token_endpoint_auth_methods_supported: ["client_secret_post"],
        }),
      ),
    ).toEqual([]);
  });

  it("yields nothing when the revocation list is absent", () => {
    expect(revocationAuthMethods(metadata())).toEqual([]);
  });

  // The empty list is not "no authentication": it is what makes the SDK apply
  // RFC 8414's actual default.
  it("an empty list resolves to the RFC 8414 default", () => {
    const { init } = buildRevocationRequest({
      endpoint: REVOKE_URL,
      token: "r",
      tokenTypeHint: "refresh_token",
      clientInformation: { client_id: "cid", client_secret: "sec" },
      supportedAuthMethods: revocationAuthMethods(metadata()),
    });
    expect(headerOf(init, "Authorization")).toBe(`Basic ${btoa("cid:sec")}`);
  });

  it("an empty list leaves a public client unauthenticated", () => {
    const { init } = buildRevocationRequest({
      endpoint: REVOKE_URL,
      token: "r",
      tokenTypeHint: "refresh_token",
      clientInformation: { client_id: "cid" },
      supportedAuthMethods: revocationAuthMethods(metadata()),
    });
    expect(headerOf(init, "Authorization")).toBeUndefined();
    expect(body(init).get("client_id")).toBe("cid");
  });
});

describe("aggregateOutcomes", () => {
  const failed = { status: "failed", detail: "boom" } as const;
  const revoked = {
    status: "revoked",
    tokenTypeHint: "refresh_token",
    endpoint: REVOKE_URL,
  } as const;
  const skipped = { status: "skipped", reason: "no_endpoint" } as const;

  // A grant still live at the authorization server is the thing worth
  // surfacing; another grant's success would silence it.
  it("reports a failure over a success", () => {
    expect(aggregateOutcomes([revoked, failed])).toEqual(failed);
  });

  it("reports a success over a skip", () => {
    expect(aggregateOutcomes([skipped, revoked])).toEqual(revoked);
  });

  it("falls through to the first outcome when none is decisive", () => {
    expect(aggregateOutcomes([skipped])).toEqual(skipped);
  });

  // `computeOutcome` returns early when there are no grants, so nothing else
  // reaches this — which is why it is tested here rather than left as a
  // function that returns `undefined` while typed otherwise.
  it("has an answer for an empty list", () => {
    expect(aggregateOutcomes([])).toEqual({
      status: "skipped",
      reason: "no_tokens",
    });
  });
});

describe("buildRevocationRequest", () => {
  it("posts a form-encoded token and hint", () => {
    const { url, init } = buildRevocationRequest({
      endpoint: REVOKE_URL,
      token: "r",
      tokenTypeHint: "refresh_token",
      supportedAuthMethods: [],
    });
    expect(url).toBe(REVOKE_URL);
    expect(init.method).toBe("POST");
    expect(headerOf(init, "Content-Type")).toBe(
      "application/x-www-form-urlencoded",
    );
    expect(body(init).get("token")).toBe("r");
    expect(body(init).get("token_type_hint")).toBe("refresh_token");
  });

  it("sends a confidential client's secret in the Authorization header for client_secret_basic", () => {
    const { init } = buildRevocationRequest({
      endpoint: REVOKE_URL,
      token: "r",
      tokenTypeHint: "refresh_token",
      clientInformation: { client_id: "id one", client_secret: "s/ecret" },
      supportedAuthMethods: ["client_secret_basic"],
    });
    // Byte-identical to the SDK's `applyBasicAuth`: the raw `id:secret`, not the
    // form-urlencoded pair RFC 6749 §2.3.1 asks for. Presenting the credential
    // differently here than at the token endpoint is what would let an
    // authorization server accept one request and reject the other.
    expect(headerOf(init, "Authorization")).toBe(
      `Basic ${btoa("id one:s/ecret")}`,
    );
    expect(body(init).has("client_secret")).toBe(false);
  });

  it("sends the secret in the body for client_secret_post", () => {
    const { init } = buildRevocationRequest({
      endpoint: REVOKE_URL,
      token: "r",
      tokenTypeHint: "refresh_token",
      clientInformation: { client_id: "id", client_secret: "s" },
      supportedAuthMethods: ["client_secret_post"],
    });
    expect(headerOf(init, "Authorization")).toBeUndefined();
    expect(body(init).get("client_id")).toBe("id");
    expect(body(init).get("client_secret")).toBe("s");
  });

  it("identifies a public client by client_id alone", () => {
    const { init } = buildRevocationRequest({
      endpoint: REVOKE_URL,
      token: "a",
      tokenTypeHint: "access_token",
      clientInformation: { client_id: "public" },
      supportedAuthMethods: ["none"],
    });
    expect(headerOf(init, "Authorization")).toBeUndefined();
    expect(body(init).get("client_id")).toBe("public");
    expect(body(init).has("client_secret")).toBe(false);
  });
});

describe("revokeToken", () => {
  it("reports a 200 as revoked", async () => {
    const fetchFn = vi.fn<typeof fetch>(
      async () => new Response(null, { status: 200 }),
    );
    await expect(
      revokeToken({
        endpoint: REVOKE_URL,
        token: "r",
        tokenTypeHint: "refresh_token",
        supportedAuthMethods: [],
        fetchFn,
      }),
    ).resolves.toEqual({
      status: "revoked",
      tokenTypeHint: "refresh_token",
      endpoint: REVOKE_URL,
    });
  });

  it("reports a non-2xx as failed rather than throwing", async () => {
    const fetchFn = vi.fn<typeof fetch>(
      async () =>
        new Response(null, { status: 401, statusText: "Unauthorized" }),
    );
    const outcome = await revokeToken({
      endpoint: REVOKE_URL,
      token: "r",
      tokenTypeHint: "refresh_token",
      supportedAuthMethods: [],
      fetchFn,
    });
    expect(outcome).toMatchObject({ status: "failed", endpoint: REVOKE_URL });
    expect(outcome.status === "failed" ? outcome.detail : "").toContain("401");
  });

  // `String(err)` is the other half of the detail: a fetch double, or a runtime
  // that rejects with a non-Error, must still produce a readable message.
  it("reports a non-Error rejection as failed", async () => {
    const outcome = await revokeToken({
      endpoint: REVOKE_URL,
      token: "r",
      tokenTypeHint: "refresh_token",
      supportedAuthMethods: [],
      fetchFn: () => Promise.reject("plain string"),
    });
    expect(outcome).toEqual({
      status: "failed",
      endpoint: REVOKE_URL,
      detail: "plain string",
    });
  });

  it("reports a network failure as failed", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => {
      throw new Error("connect ECONNREFUSED");
    });
    const outcome = await revokeToken({
      endpoint: REVOKE_URL,
      token: "r",
      tokenTypeHint: "refresh_token",
      supportedAuthMethods: [],
      fetchFn,
    });
    expect(outcome).toEqual({
      status: "failed",
      endpoint: REVOKE_URL,
      detail: "connect ECONNREFUSED",
    });
  });

  // The web fetch is `createRemoteFetch`, which re-issues the call as a POST to
  // `/api/fetch` and drops `init.signal`; the backend's outbound fetch gets no
  // signal either. A signal-only bound is therefore inert on exactly the path
  // the timeout exists for, so the deadline has to hold against a fetch that
  // ignores the signal entirely.
  it("gives up on a fetch that never settles and ignores the signal", async () => {
    const outcome = await revokeToken({
      endpoint: REVOKE_URL,
      token: "r",
      tokenTypeHint: "refresh_token",
      supportedAuthMethods: [],
      fetchFn: () => new Promise<Response>(() => {}),
      timeoutMs: 20,
    });
    expect(outcome).toMatchObject({ status: "failed", endpoint: REVOKE_URL });
    expect(outcome.status === "failed" ? outcome.detail : "").toContain(
      "timed out",
    );
  });

  // The teardown is already committed by the time this runs, so a wedged
  // authorization server must not be able to hold it open.
  it("bounds the request with an abort signal", async () => {
    let seen: RequestInit | undefined;
    const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
      seen = init;
      return new Response(null, { status: 200 });
    });
    await revokeToken({
      endpoint: REVOKE_URL,
      token: "r",
      tokenTypeHint: "refresh_token",
      supportedAuthMethods: [],
      fetchFn,
      timeoutMs: 1,
    });
    expect(seen?.signal).toBeInstanceOf(AbortSignal);
    expect(DEFAULT_REVOCATION_TIMEOUT_MS).toBeGreaterThan(0);
  });
});

describe("revokeStoredOAuthTokens", () => {
  let storage: BrowserOAuthStorage;

  beforeEach(async () => {
    storage = new BrowserOAuthStorage();
    await storage.clear(SERVER_URL);
  });

  async function seed(over: Partial<OAuthMetadata> = {}): Promise<void> {
    await storage.saveTokens(SERVER_URL, {
      access_token: "a",
      token_type: "Bearer",
      refresh_token: "r",
    });
    await storage.saveServerMetadata(SERVER_URL, metadata(over));
  }

  it("revokes the stored refresh token", async () => {
    await seed();
    await storage.saveClientInformation(
      SERVER_URL,
      { client_id: "cid", client_secret: "sec" },
      { registrationKind: "dcr" },
    );

    const fetchFn = vi.fn<typeof fetch>(
      async () => new Response(null, { status: 200 }),
    );

    const outcome = await revokeStoredOAuthTokens({
      serverUrl: SERVER_URL,
      storage,
      fetchFn,
    });

    expect(outcome).toMatchObject({ status: "revoked" });
    const [, init] = fetchFn.mock.calls[0]!;
    expect(body(init!).get("token")).toBe("r");
  });

  // A server configured with `oauth.clientId` stores its credentials in the
  // preregistered slot, which is issuer-independent and is *not* what a plain
  // `getClientInformation(serverUrl)` returns. Reading only the dynamic slot
  // would send no client authentication at all for exactly the confidential
  // clients most likely to require it.
  it("authenticates with a preconfigured client, not just a dynamically registered one", async () => {
    await seed();
    await storage.savePreregisteredClientInformation(SERVER_URL, {
      client_id: "static-cid",
      client_secret: "static-sec",
    });
    const fetchFn = vi.fn<typeof fetch>(
      async () => new Response(null, { status: 200 }),
    );

    await revokeStoredOAuthTokens({ serverUrl: SERVER_URL, storage, fetchFn });

    const [, init] = fetchFn.mock.calls[0]!;
    expect(headerOf(init!, "Authorization")).toBe(
      `Basic ${btoa("static-cid:static-sec")}`,
    );
  });

  // `clear(serverUrl)` drops EVERY `byIssuer` slot, so reading only the active
  // issuer's token would leave the earlier authorization server's grant live
  // while destroying the local record of it — the same leak this feature
  // closes, one level down (SEP-2352 keeps credentials per issuer).
  it("revokes every issuer-bound grant, not just the active one", async () => {
    const issuerMetadata = metadata({ issuer: "https://as.example.com" });
    await storage.saveServerMetadata(SERVER_URL, issuerMetadata);
    await storage.saveTokens(
      SERVER_URL,
      { access_token: "a1", token_type: "Bearer", refresh_token: "r1" },
      { issuer: "https://as.example.com" },
    );
    await storage.saveTokens(
      SERVER_URL,
      { access_token: "a2", token_type: "Bearer", refresh_token: "r2" },
      { issuer: "https://as.example.com" },
    );
    // A second slot under the SAME issuer would be one grant; use two distinct
    // tokens under one issuer plus the ctx-less read to prove dedup instead.
    const fetchFn = vi.fn<typeof fetch>(
      async () => new Response(null, { status: 200 }),
    );

    await revokeStoredOAuthTokens({ serverUrl: SERVER_URL, storage, fetchFn });

    // One issuer, one grant — the ctx-less read is the same token and is deduped.
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(
      new URLSearchParams(String(fetchFn.mock.calls[0]![1]!.body)).get("token"),
    ).toBe("r2");
  });

  // A grant bound to an issuer the cached metadata does not describe cannot be
  // revoked — that endpoint belongs to a different authorization server, and
  // sending it another AS's token would hand a credential to a server that
  // never minted it. Saying so is the point: the grant is being dropped.
  it("reports a grant whose issuer the cached metadata does not describe", async () => {
    await storage.saveServerMetadata(
      SERVER_URL,
      metadata({ issuer: "https://as-b.example.com" }),
    );
    await storage.saveTokens(
      SERVER_URL,
      { access_token: "a", token_type: "Bearer", refresh_token: "r-a" },
      { issuer: "https://as-a.example.com" },
    );
    const fetchFn = vi.fn<typeof fetch>(
      async () => new Response(null, { status: 200 }),
    );

    const outcome = await revokeStoredOAuthTokens({
      serverUrl: SERVER_URL,
      storage,
      fetchFn,
    });

    expect(fetchFn).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ status: "failed" });
    expect(outcome.status === "failed" ? outcome.detail : "").toContain(
      "as-a.example.com",
    );
  });

  // A failure on one grant must not be hidden behind another's success — a
  // grant still live at the authorization server is the thing worth surfacing.
  it("reports a failure over another grant's success", async () => {
    await storage.saveServerMetadata(
      SERVER_URL,
      metadata({ issuer: "https://as-b.example.com" }),
    );
    // Revocable: bound to the issuer the metadata describes.
    await storage.saveTokens(
      SERVER_URL,
      { access_token: "b", token_type: "Bearer", refresh_token: "r-b" },
      { issuer: "https://as-b.example.com" },
    );
    // Not revocable: bound to an issuer the cached metadata is not for.
    await storage.saveTokens(
      SERVER_URL,
      { access_token: "a", token_type: "Bearer", refresh_token: "r-a" },
      { issuer: "https://as-a.example.com" },
    );
    const fetchFn = vi.fn<typeof fetch>(
      async () => new Response(null, { status: 200 }),
    );

    const outcome = await revokeStoredOAuthTokens({
      serverUrl: SERVER_URL,
      storage,
      fetchFn,
    });

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({ status: "failed" });
  });

  // The whole point of keeping this path opt-out-able: an authorization server
  // with no RFC 7009 support must behave exactly as it did before the feature.
  it("does nothing when the authorization server advertises no revocation endpoint", async () => {
    await seed({ revocation_endpoint: undefined });
    const fetchFn = vi.fn<typeof fetch>();
    await expect(
      revokeStoredOAuthTokens({ serverUrl: SERVER_URL, storage, fetchFn }),
    ).resolves.toEqual({ status: "skipped", reason: "no_endpoint" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("does nothing when no metadata was ever discovered", async () => {
    await storage.saveTokens(SERVER_URL, {
      access_token: "a",
      token_type: "Bearer",
    });
    const fetchFn = vi.fn<typeof fetch>();
    await expect(
      revokeStoredOAuthTokens({ serverUrl: SERVER_URL, storage, fetchFn }),
    ).resolves.toEqual({ status: "skipped", reason: "no_metadata" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("does nothing when there is no stored grant", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    await expect(
      revokeStoredOAuthTokens({ serverUrl: SERVER_URL, storage, fetchFn }),
    ).resolves.toEqual({ status: "skipped", reason: "no_tokens" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("skips the request when disabled", async () => {
    await seed();
    const fetchFn = vi.fn<typeof fetch>();
    await expect(
      revokeStoredOAuthTokens({
        serverUrl: SERVER_URL,
        storage,
        fetchFn,
        enabled: false,
      }),
    ).resolves.toEqual({ status: "skipped", reason: "disabled" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("warns and reports rather than throwing when the request fails", async () => {
    await seed();
    const logger = fakeLogger();
    const fetchFn = vi.fn<typeof fetch>(
      async () => new Response(null, { status: 500, statusText: "Boom" }),
    );

    const outcome = await revokeStoredOAuthTokens({
      serverUrl: SERVER_URL,
      storage,
      fetchFn,
      logger,
    });

    expect(outcome.status).toBe("failed");
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("logs the no-endpoint case at debug", async () => {
    await seed({ revocation_endpoint: undefined });
    const logger = fakeLogger();
    await revokeStoredOAuthTokens({
      serverUrl: SERVER_URL,
      storage,
      fetchFn: vi.fn<typeof fetch>(),
      logger,
    });
    expect(logger.debug).toHaveBeenCalledTimes(1);
  });

  // A store that cannot be read is not a reason to abandon the clear the user
  // asked for, so the read is inside the try. Spying on the real instance keeps
  // the `OAuthStorage` contract intact — a spread-and-cast stand-in would type
  // as storage while being a plain object with none of its methods.
  it("reports a non-Error store failure as failed", async () => {
    vi.spyOn(storage, "listIssuers").mockRejectedValue("store exploded");

    await expect(
      revokeStoredOAuthTokens({
        serverUrl: SERVER_URL,
        storage,
        fetchFn: vi.fn<typeof fetch>(),
      }),
    ).resolves.toEqual({ status: "failed", detail: "store exploded" });
  });

  it("reports a store read failure as failed", async () => {
    vi.spyOn(storage, "getTokens").mockRejectedValue(
      new Error("store unreadable"),
    );

    await expect(
      revokeStoredOAuthTokens({
        serverUrl: SERVER_URL,
        storage,
        fetchFn: vi.fn<typeof fetch>(),
      }),
    ).resolves.toEqual({ status: "failed", detail: "store unreadable" });
  });
});
