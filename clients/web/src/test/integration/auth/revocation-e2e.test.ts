/**
 * RFC 7009 revocation against the real OAuth test server (#2144).
 *
 * The unit suite (`src/test/core/auth/revocation.test.ts`) pins what is *sent*;
 * this pins what the request actually *does*. The two halves that only a real
 * authorization server can show are both here: that the Inspector's request is
 * accepted at all (its client authentication and form encoding are right), and
 * that §2.1's grant linkage holds — one request naming the refresh token kills
 * the access token issued alongside it, which is the whole reason the Inspector
 * sends one request rather than two.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import {
  TestServerHttp,
  createOAuthTestServerConfig,
  getDefaultServerConfig,
  waitForOAuthWellKnown,
} from "@modelcontextprotocol/inspector-test-server";
import { BrowserOAuthStorage } from "@inspector/core/auth/browser/storage.js";
import {
  executeOAuthRevocation,
  planOAuthRevocation,
} from "@inspector/core/auth/revocation.js";
import type { TokenRevocationOutcome } from "@inspector/core/auth/revocation.js";
import type { OAuthMetadata } from "@modelcontextprotocol/client";

const CLIENT_ID = "test-2144-revocation";
const CLIENT_SECRET = "test-2144-secret";
const REDIRECT_URL = "http://localhost:3000/oauth/callback";
/** A second registered client, used to prove tokens are not cross-revocable. */
const OTHER_CLIENT_ID = "test-2144-other";
const OTHER_CLIENT_SECRET = "test-2144-other-secret";

function base64Url(buffer: Buffer): string {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

describe("OAuth token revocation (RFC 7009)", () => {
  let mcpServer: TestServerHttp | null = null;
  let serverUrl = "";
  let metadata: OAuthMetadata;

  beforeAll(async () => {
    mcpServer = new TestServerHttp({
      ...getDefaultServerConfig(),
      serverType: "streamable-http" as const,
      ...createOAuthTestServerConfig({
        requireAuth: true,
        staticClients: [
          {
            clientId: CLIENT_ID,
            clientSecret: CLIENT_SECRET,
            redirectUris: [REDIRECT_URL],
          },
          {
            clientId: OTHER_CLIENT_ID,
            clientSecret: OTHER_CLIENT_SECRET,
            redirectUris: [REDIRECT_URL],
          },
        ],
      }),
    });
    const port = await mcpServer.start();
    serverUrl = `http://localhost:${port}`;
    await waitForOAuthWellKnown(serverUrl);
    metadata = (await (
      await fetch(`${serverUrl}/.well-known/oauth-authorization-server`)
    ).json()) as OAuthMetadata;
  }, 30_000);

  afterAll(async () => {
    await mcpServer?.stop();
    mcpServer = null;
  }, 30_000);

  /** Run a real authorization-code exchange and return the issued tokens. */
  async function authorize(): Promise<{
    access_token: string;
    refresh_token: string;
  }> {
    const verifier = base64Url(randomBytes(32));
    const challenge = base64Url(createHash("sha256").update(verifier).digest());

    const authorizeResponse = await fetch(`${serverUrl}/oauth/authorize`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      redirect: "manual",
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URL,
        response_type: "code",
        scope: "mcp",
        code_challenge: challenge,
        code_challenge_method: "S256",
      }),
    });
    const location = authorizeResponse.headers.get("location");
    expect(location).toBeTruthy();
    const code = new URL(location!).searchParams.get("code");
    expect(code).toBeTruthy();

    const tokenResponse = await fetch(`${serverUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code!,
        redirect_uri: REDIRECT_URL,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code_verifier: verifier,
      }),
    });
    expect(tokenResponse.status).toBe(200);
    return (await tokenResponse.json()) as {
      access_token: string;
      refresh_token: string;
    };
  }

  /** Whether the MCP endpoint still accepts this bearer token. */
  async function tokenAccepted(accessToken: string): Promise<boolean> {
    const response = await fetch(`${serverUrl}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    return response.status !== 401;
  }

  async function seededStorage(tokens: {
    access_token: string;
    refresh_token?: string;
  }): Promise<BrowserOAuthStorage> {
    const storage = new BrowserOAuthStorage();
    await storage.clear(serverUrl);
    // Issuer-bound and matching the discovered metadata: an unkeyed grant
    // records no authorization server and is deliberately refused.
    await storage.saveTokens(
      serverUrl,
      { token_type: "Bearer", ...tokens },
      { issuer: metadata.issuer },
    );
    await storage.saveServerMetadata(serverUrl, metadata);
    // Preconfigured, so it goes in the preregistered slot — the same one a
    // server with `oauth.clientId` uses. That is the slot the revocation path
    // must read first, or a confidential client sends no authentication at all.
    await storage.savePreregisteredClientInformation(serverUrl, {
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    });
    return storage;
  }

  // The fixture enforces RFC 7009 §2.1 client authentication, so this is what
  // makes the passing cases below mean something: a request with the wrong
  // credentials is refused, and the endpoint is not simply answering 200 to
  // anything.
  it("refuses a revocation request with the wrong client secret", async () => {
    const response = await fetch(`${serverUrl}/oauth/revoke`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(`${CLIENT_ID}:wrong`).toString("base64")}`,
      },
      body: new URLSearchParams({ token: "anything" }),
    });
    expect(response.status).toBe(401);
  });

  it("refuses a revocation request naming no client at all", async () => {
    const response = await fetch(`${serverUrl}/oauth/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: "anything" }),
    });
    expect(response.status).toBe(401);
  });

  // RFC 7009 §2.1: only the client a token was issued to may revoke it. The
  // response stays 200 (§2.2 — it must not tell one client whether another's
  // token exists), so the assertion is that the token still works.
  it("does not revoke a token belonging to a different client", async () => {
    const tokens = await authorize();
    const response = await fetch(`${serverUrl}/oauth/revoke`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(`${OTHER_CLIENT_ID}:${OTHER_CLIENT_SECRET}`).toString("base64")}`,
      },
      body: new URLSearchParams({
        token: tokens.refresh_token,
        token_type_hint: "refresh_token",
      }),
    });

    expect(response.status).toBe(200);
    expect(await tokenAccepted(tokens.access_token)).toBe(true);
  });

  /**
   * The caller's real sequence — snapshot, clear, send — so this exercises the
   * ordering the product uses rather than a convenience wrapper.
   */
  async function clearAndRevoke(
    storage: BrowserOAuthStorage,
  ): Promise<TokenRevocationOutcome> {
    const plan = await planOAuthRevocation({ serverUrl, storage });
    await storage.clear(serverUrl);
    return executeOAuthRevocation(plan, { fetchFn: fetch });
  }

  it("advertises a revocation endpoint", () => {
    expect(metadata.revocation_endpoint).toBe(`${serverUrl}/oauth/revoke`);
  });

  // The failure this feature exists to fix: without the request, the token is
  // still accepted after the Inspector has forgotten it.
  it("revokes the whole grant from the stored refresh token", async () => {
    const tokens = await authorize();
    expect(await tokenAccepted(tokens.access_token)).toBe(true);

    const outcome = await clearAndRevoke(await seededStorage(tokens));

    expect(outcome).toMatchObject({
      status: "revoked",
      tokenTypeHint: "refresh_token",
    });
    // RFC 7009 §2.1 — the access token issued under the same grant dies too,
    // which is why one request is enough.
    expect(await tokenAccepted(tokens.access_token)).toBe(false);
  });

  it("revokes an access token when no refresh token was issued", async () => {
    const tokens = await authorize();
    const outcome = await clearAndRevoke(
      await seededStorage({ access_token: tokens.access_token }),
    );

    expect(outcome).toMatchObject({
      status: "revoked",
      tokenTypeHint: "access_token",
    });
    expect(await tokenAccepted(tokens.access_token)).toBe(false);
  });

  // RFC 7009 §2.2: an unknown token is a success, so revoking a grant the
  // server has already expired must not be reported as a failure.
  it("treats an already-unknown token as revoked", async () => {
    const storage = await seededStorage({ access_token: "never-issued" });
    await expect(clearAndRevoke(storage)).resolves.toMatchObject({
      status: "revoked",
    });
  });
});
