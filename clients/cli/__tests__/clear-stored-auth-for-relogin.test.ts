import { describe, it, expect, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  getStateFilePath,
  resetNodeOAuthStorageCache,
} from "@inspector/core/auth/node/storage-node.js";
import { clearStoredAuthForRelogin } from "../src/clear-stored-auth-for-relogin.js";

describe("clearStoredAuthForRelogin", () => {
  let dir: string | undefined;
  let prevPath: string | undefined;

  afterEach(() => {
    if (prevPath === undefined)
      delete process.env.MCP_INSPECTOR_OAUTH_STATE_PATH;
    else process.env.MCP_INSPECTOR_OAUTH_STATE_PATH = prevPath;
    resetNodeOAuthStorageCache();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  it("no-ops when serverUrl is missing or blank", async () => {
    await clearStoredAuthForRelogin(undefined);
    await clearStoredAuthForRelogin("   ");
  });

  it("clears a URL-keyed entry and tolerates non-URL keys", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-relogin-"));
    const file = path.join(dir, "oauth.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        servers: {
          "https://example.com/mcp": {
            tokens: { access_token: "a", token_type: "Bearer" },
          },
          "not a url": {
            tokens: { access_token: "b", token_type: "Bearer" },
          },
        },
        idpSessions: {},
      }),
      "utf8",
    );
    prevPath = process.env.MCP_INSPECTOR_OAUTH_STATE_PATH;
    process.env.MCP_INSPECTOR_OAUTH_STATE_PATH = file;
    resetNodeOAuthStorageCache();
    expect(getStateFilePath()).toBe(file);

    await clearStoredAuthForRelogin("https://example.com/mcp");
    let blob = JSON.parse(fs.readFileSync(file, "utf8")) as {
      servers: Record<string, unknown>;
    };
    expect(blob.servers["https://example.com/mcp"]).toBeUndefined();
    expect(blob.servers["not a url"]).toBeDefined();

    // normalizeServerUrl catch path — clears under the raw key
    await clearStoredAuthForRelogin("not a url");
    blob = JSON.parse(fs.readFileSync(file, "utf8")) as {
      servers: Record<string, unknown>;
    };
    expect(blob.servers["not a url"]).toBeUndefined();
  });

  // #2144 — RFC 7009. The request has to go out *before* the delete, since it
  // is built from the token, the client id and the cached metadata the delete
  // removes.
  describe("token revocation", () => {
    function seed(over: Record<string, unknown> = {}): string {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-relogin-revoke-"));
      const file = path.join(dir, "oauth.json");
      fs.writeFileSync(
        file,
        JSON.stringify({
          servers: {
            "https://example.com/mcp": {
              tokens: {
                access_token: "a",
                token_type: "Bearer",
                refresh_token: "r",
              },
              serverMetadata: {
                issuer: "https://as.example.com",
                authorization_endpoint: "https://as.example.com/authorize",
                token_endpoint: "https://as.example.com/token",
                revocation_endpoint: "https://as.example.com/revoke",
                response_types_supported: ["code"],
              },
              ...over,
            },
          },
          idpSessions: {},
        }),
        "utf8",
      );
      prevPath = process.env.MCP_INSPECTOR_OAUTH_STATE_PATH;
      process.env.MCP_INSPECTOR_OAUTH_STATE_PATH = file;
      resetNodeOAuthStorageCache();
      return file;
    }

    it("revokes the stored grant before deleting it", async () => {
      const file = seed();
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response(null, { status: 200 }));
      try {
        await expect(
          clearStoredAuthForRelogin("https://example.com/mcp"),
        ).resolves.toMatchObject({
          status: "revoked",
          tokenTypeHint: "refresh_token",
        });
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        const [url, init] = fetchSpy.mock.calls[0]!;
        expect(String(url)).toBe("https://as.example.com/revoke");
        expect(new URLSearchParams(String(init?.body)).get("token")).toBe("r");
      } finally {
        fetchSpy.mockRestore();
      }
      const blob = JSON.parse(fs.readFileSync(file, "utf8")) as {
        servers: Record<string, unknown>;
      };
      expect(blob.servers["https://example.com/mcp"]).toBeUndefined();
    });

    // Both key spellings are cleared, but they are two spellings of one server:
    // a second request would name a grant the first one already ended. The raw
    // key here holds nothing, so this also proves the walk does not stop at the
    // first empty one.
    it("sends one request even though both key spellings are cleared", async () => {
      seed();
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response(null, { status: 200 }));
      try {
        // Normalises to the stored `https://example.com/mcp`.
        await expect(
          clearStoredAuthForRelogin("https://Example.com/mcp"),
        ).resolves.toMatchObject({ status: "revoked" });
        expect(fetchSpy).toHaveBeenCalledTimes(1);
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it("deletes the local entry even when the request fails", async () => {
      const file = seed();
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValue(new Error("unreachable"));
      try {
        await expect(
          clearStoredAuthForRelogin("https://example.com/mcp"),
        ).resolves.toMatchObject({ status: "failed" });
      } finally {
        fetchSpy.mockRestore();
      }
      const blob = JSON.parse(fs.readFileSync(file, "utf8")) as {
        servers: Record<string, unknown>;
      };
      expect(blob.servers["https://example.com/mcp"]).toBeUndefined();
    });

    it("skips the request when revocation is turned off", async () => {
      seed();
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      try {
        await expect(
          clearStoredAuthForRelogin("https://example.com/mcp", {
            revoke: false,
          }),
        ).resolves.toBeUndefined();
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it("reports no_tokens when the store holds nothing for the server", async () => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-relogin-empty-"));
      const file = path.join(dir, "oauth.json");
      fs.writeFileSync(
        file,
        JSON.stringify({ servers: {}, idpSessions: {} }),
        "utf8",
      );
      prevPath = process.env.MCP_INSPECTOR_OAUTH_STATE_PATH;
      process.env.MCP_INSPECTOR_OAUTH_STATE_PATH = file;
      resetNodeOAuthStorageCache();

      await expect(
        clearStoredAuthForRelogin("https://example.com/mcp"),
      ).resolves.toEqual({ status: "skipped", reason: "no_tokens" });
    });
  });

  it("clears both raw and URL-normalised keys (bare origin / mixed-case host)", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-relogin-norm-"));
    const file = path.join(dir, "oauth.json");
    // Runtime storage keys by the transport's raw url string — often without a
    // trailing slash / with mixed-case host — while new URL().href normalises.
    fs.writeFileSync(
      file,
      JSON.stringify({
        servers: {
          "https://example.com": {
            tokens: { access_token: "bare", token_type: "Bearer" },
          },
          "https://example.com/": {
            tokens: { access_token: "slash", token_type: "Bearer" },
          },
          "https://Example.com/mcp": {
            tokens: { access_token: "mixed", token_type: "Bearer" },
          },
        },
        idpSessions: {},
      }),
      "utf8",
    );
    prevPath = process.env.MCP_INSPECTOR_OAUTH_STATE_PATH;
    process.env.MCP_INSPECTOR_OAUTH_STATE_PATH = file;
    resetNodeOAuthStorageCache();

    await clearStoredAuthForRelogin("https://example.com");
    let blob = JSON.parse(fs.readFileSync(file, "utf8")) as {
      servers: Record<string, unknown>;
    };
    expect(blob.servers["https://example.com"]).toBeUndefined();
    expect(blob.servers["https://example.com/"]).toBeUndefined();
    expect(blob.servers["https://Example.com/mcp"]).toBeDefined();

    await clearStoredAuthForRelogin("https://Example.com/mcp");
    blob = JSON.parse(fs.readFileSync(file, "utf8")) as {
      servers: Record<string, unknown>;
    };
    expect(blob.servers["https://Example.com/mcp"]).toBeUndefined();
    // Normalised key (lowercased host) is cleared too when distinct.
    expect(blob.servers["https://example.com/mcp"]).toBeUndefined();
  });
});
