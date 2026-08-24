/**
 * RFC 9728 `resource_metadata` end-to-end, against a real OAuth test server
 * whose protected-resource metadata document lives at a non-default path and
 * whose well-known locations deliberately 404 (#2071).
 *
 * The unit tests prove the URL is parsed and handed to `mcpAuth()`. This file
 * proves the two halves that only a real server can: that the challenge the
 * server actually emits parses into `AuthChallenge.resourceMetadataUrl`, and
 * that SDK discovery genuinely cannot find the document without it — so the
 * plumbing is load-bearing rather than merely present.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { fileURLToPath } from "node:url";
import { discoverOAuthProtectedResourceMetadata } from "@modelcontextprotocol/client";
import {
  TestServerHttp,
  getDefaultServerConfig,
  createOAuthTestServerConfig,
  loadConfig,
  resolveConfig,
  waitForOAuthWellKnown,
} from "@modelcontextprotocol/inspector-test-server";
import {
  challengeResourceMetadataUrl,
  parseAuthChallengeFromResponse,
} from "@inspector/core/auth/challenge.js";

const METADATA_PATH = "/custom/protected-resource";

describe("OAuth challenge resource_metadata (RFC 9728)", () => {
  let mcpServer: TestServerHttp | null = null;
  let serverUrl = "";

  beforeAll(async () => {
    mcpServer = new TestServerHttp({
      ...getDefaultServerConfig(),
      serverType: "streamable-http" as const,
      ...createOAuthTestServerConfig({
        requireAuth: true,
        resourceMetadataPath: METADATA_PATH,
      }),
    });
    const port = await mcpServer.start();
    serverUrl = `http://localhost:${port}`;
    await waitForOAuthWellKnown(serverUrl);
  }, 30_000);

  afterAll(async () => {
    await mcpServer?.stop();
    mcpServer = null;
  }, 30_000);

  it("advertises the non-default metadata URL on the 401 challenge", async () => {
    const response = await fetch(`${serverUrl}/mcp`, { method: "POST" });

    expect(response.status).toBe(401);
    const challenge = parseAuthChallengeFromResponse(response);
    expect(challenge?.resourceMetadataUrl).toBe(`${serverUrl}${METADATA_PATH}`);
    expect(challengeResourceMetadataUrl(challenge!)?.href).toBe(
      `${serverUrl}${METADATA_PATH}`,
    );
  });

  it("serves the metadata document only from the advertised path", async () => {
    const advertised = await fetch(`${serverUrl}${METADATA_PATH}`);
    expect(advertised.status).toBe(200);
    await expect(advertised.json()).resolves.toMatchObject({
      authorization_servers: [serverUrl],
    });

    const wellKnown = await fetch(
      `${serverUrl}/.well-known/oauth-protected-resource`,
    );
    expect(wellKnown.status).toBe(404);
  });

  it("SDK discovery resolves with the advertised URL and fails without it", async () => {
    await expect(
      discoverOAuthProtectedResourceMetadata(serverUrl, {
        resourceMetadataUrl: new URL(`${serverUrl}${METADATA_PATH}`),
      }),
    ).resolves.toMatchObject({ authorization_servers: [serverUrl] });

    // The pre-fix behavior: discovery derived from the MCP server URL alone.
    await expect(
      discoverOAuthProtectedResourceMetadata(serverUrl),
    ).rejects.toThrow();
  });

  it("keeps the showcase config valid and carrying the custom path", () => {
    const configPath = fileURLToPath(
      new URL(
        "../../../../../../test-servers/configs/oauth-custom-resource-metadata-http.json",
        import.meta.url,
      ),
    );

    // loadConfig validates as it parses, so this is the regression test for
    // the checked-in showcase config as much as for the new field.
    expect(resolveConfig(loadConfig(configPath)).oauth).toMatchObject({
      enabled: true,
      resourceMetadataPath: METADATA_PATH,
    });
  });
});
