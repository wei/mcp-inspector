import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import type { OAuthStorage } from "@inspector/core/auth/storage.js";
import { BaseOAuthClientProvider } from "@inspector/core/auth/providers.js";
import { ensureCimdClientRegistration } from "@inspector/core/auth/cimd.js";

const SERVER_URL = "http://127.0.0.1:9999/mcp";
const METADATA_URL = "http://127.0.0.1:8888/client-metadata.json";

function createProvider(storage: OAuthStorage): BaseOAuthClientProvider {
  return new BaseOAuthClientProvider(SERVER_URL, {
    storage,
    redirectUrlProvider: {
      getRedirectUrl: () => "http://127.0.0.1:3000/oauth/callback",
    },
    navigation: { navigateToAuthorization: vi.fn() },
    clientMetadataUrl: METADATA_URL,
  });
}

describe("ensureCimdClientRegistration", () => {
  let storage: OAuthStorage;

  beforeEach(() => {
    storage = {
      getClientInformation: vi.fn(async () => undefined),
      saveClientInformation: vi.fn(async () => {}),
      getScope: vi.fn().mockResolvedValue(undefined),
      getTokens: vi.fn(async () => undefined),
      saveTokens: vi.fn(async () => {}),
      clear: vi.fn(),
    } as unknown as OAuthStorage;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("pre-registers URL-based client id when AS supports CIMD", async () => {
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/.well-known/oauth-protected-resource")) {
        return new Response(JSON.stringify({ resource: SERVER_URL }));
      }
      if (url.includes("/.well-known/oauth-authorization-server")) {
        return new Response(
          JSON.stringify({
            issuer: "http://127.0.0.1:9999",
            authorization_endpoint: "http://127.0.0.1:9999/oauth/authorize",
            token_endpoint: "http://127.0.0.1:9999/oauth/token",
            response_types_supported: ["code"],
            client_id_metadata_document_supported: true,
          }),
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const provider = createProvider(storage);
    await ensureCimdClientRegistration({
      serverUrl: SERVER_URL,
      provider,
      fetchFn,
    });

    expect(storage.saveClientInformation).toHaveBeenCalledWith(
      SERVER_URL,
      {
        client_id: METADATA_URL,
      },
      { registrationKind: "cimd" },
    );
  });

  it("does not register when the AS metadata omits CIMD support", async () => {
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/.well-known/oauth-protected-resource")) {
        return new Response(JSON.stringify({ resource: SERVER_URL }));
      }
      if (url.includes("/.well-known/oauth-authorization-server")) {
        return new Response(
          JSON.stringify({
            issuer: "http://127.0.0.1:9999",
            authorization_endpoint: "http://127.0.0.1:9999/oauth/authorize",
            token_endpoint: "http://127.0.0.1:9999/oauth/token",
            response_types_supported: ["code"],
            // client_id_metadata_document_supported intentionally absent.
          }),
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const provider = createProvider(storage);
    await ensureCimdClientRegistration({
      serverUrl: SERVER_URL,
      provider,
      fetchFn,
    });

    expect(storage.saveClientInformation).not.toHaveBeenCalled();
  });

  it("discovers protected-resource metadata at the challenge-advertised URL (#2071)", async () => {
    const metadataUrl = new URL(
      "http://127.0.0.1:9999/custom/protected-resource",
    );
    // `ensureCimdClientRegistration` runs protected-resource discovery through
    // the SDK's default fetch, so the advertised URL is observable only on the
    // global — the AS-metadata leg is the one that takes `fetchFn`.
    const globalFetch = vi.fn(async (input: RequestInfo | URL) =>
      String(input) === metadataUrl.href
        ? new Response(
            JSON.stringify({
              resource: SERVER_URL,
              authorization_servers: ["http://127.0.0.1:9999"],
            }),
          )
        : new Response(null, { status: 404 }),
    );
    vi.stubGlobal("fetch", globalFetch);

    const fetchFn = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            issuer: "http://127.0.0.1:9999",
            authorization_endpoint: "http://127.0.0.1:9999/oauth/authorize",
            token_endpoint: "http://127.0.0.1:9999/oauth/token",
            response_types_supported: ["code"],
            client_id_metadata_document_supported: true,
          }),
        ),
    );

    await ensureCimdClientRegistration({
      serverUrl: SERVER_URL,
      provider: createProvider(storage),
      fetchFn,
      resourceMetadataUrl: metadataUrl,
    });

    expect(globalFetch).toHaveBeenCalled();
    for (const [input] of globalFetch.mock.calls) {
      expect(String(input)).toBe(metadataUrl.href);
    }
    expect(storage.saveClientInformation).toHaveBeenCalledWith(
      SERVER_URL,
      { client_id: METADATA_URL },
      { registrationKind: "cimd" },
    );
  });

  it("no-ops when client information is already stored", async () => {
    storage.getClientInformation = vi.fn(async () => ({
      client_id: "existing-client",
    }));

    const provider = createProvider(storage);
    await ensureCimdClientRegistration({
      serverUrl: SERVER_URL,
      provider,
      fetchFn: vi.fn(),
    });

    expect(storage.saveClientInformation).not.toHaveBeenCalled();
  });
});
