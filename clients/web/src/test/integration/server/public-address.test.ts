import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  resolveAppOriginPublicOrigin,
  resolveSandboxPublicUrl,
} from "../../../../server/public-address.js";

const UI = ["http://localhost:6274", "http://127.0.0.1:6274"];

describe("public addresses (#1862)", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  /** The single warning line, or undefined when nothing was warned. */
  function warned(): string | undefined {
    return (
      warnSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n") ||
      undefined
    );
  }

  describe("resolveSandboxPublicUrl", () => {
    it.each([[undefined], [""], ["   "]])(
      "is unset, silently, for %j",
      (raw) => {
        expect(resolveSandboxPublicUrl(raw, UI)).toBeUndefined();
        expect(warned()).toBeUndefined();
      },
    );

    it("advertises a full URL as given", () => {
      expect(
        resolveSandboxPublicUrl(
          "https://inspector-sandbox.example.com/sandbox",
          ["https://inspector.example.com"],
        ),
      ).toBe("https://inspector-sandbox.example.com/sandbox");
      expect(warned()).toBeUndefined();
    });

    it("appends /sandbox to a bare origin, the only path the listener serves", () => {
      expect(
        resolveSandboxPublicUrl(" https://sb.example.com ", [
          "https://inspector.example.com",
        ]),
      ).toBe("https://sb.example.com/sandbox");
    });

    it("keeps a non-root path, which a reverse proxy may rewrite", () => {
      expect(
        resolveSandboxPublicUrl("https://sb.example.com/mcp/sandbox", UI),
      ).toBe("https://sb.example.com/mcp/sandbox");
    });

    it.each([
      ["not a url", "not an absolute URL"],
      ["ftp://sb.example.com/sandbox", "http:// or https://"],
      ["https://user:pw@sb.example.com/sandbox", "credentials"],
      ["https://*.example.com/sandbox", "wildcard"],
      ["http://[::1]:6275/sandbox", "IPv6"],
      ["https://sb.example.com/sandbox?x=1", "query string or fragment"],
      ["https://sb.example.com/sandbox#frag", "query string or fragment"],
    ])("refuses %s", (raw, reason) => {
      expect(resolveSandboxPublicUrl(raw, UI)).toBeUndefined();
      expect(warned()).toContain("MCP_SANDBOX_FULL_ADDRESS");
      expect(warned()).toContain(reason);
    });

    it.each([
      ["https://user:hunter2@sb.example.com/sandbox", "hunter2"],
      ["https://sb.example.com/sandbox?token=hunter2", "hunter2"],
      ["https://sb.example.com/sandbox#hunter2", "hunter2"],
      ["not a url hunter2", "hunter2"],
    ])("never echoes a secret from a refused value (%s)", (raw, secret) => {
      expect(resolveSandboxPublicUrl(raw, UI)).toBeUndefined();
      expect(warned()).toContain("MCP_SANDBOX_FULL_ADDRESS");
      expect(warned()).not.toContain(secret);
    });

    it("refuses an origin shared with the Inspector UI — the same-origin collapse", () => {
      // The natural reverse-proxy layout: one hostname, /sandbox routed to 6275.
      // The spec requires host != sandbox origin, so this must not be advertised.
      expect(
        resolveSandboxPublicUrl("https://inspector.example.com/sandbox", [
          "https://inspector.example.com",
        ]),
      ).toBeUndefined();
      expect(warned()).toContain("different origin from its host");
    });

    it("advertises, but warns about, plain http under an https UI", () => {
      expect(
        resolveSandboxPublicUrl("http://sb.example.com/sandbox", [
          "https://inspector.example.com",
        ]),
      ).toBe("http://sb.example.com/sandbox");
      expect(warned()).toContain("mixed content");
    });

    it("does not warn about http when every UI origin is http", () => {
      resolveSandboxPublicUrl("http://sb.example.com/sandbox", UI);
      expect(warned()).toBeUndefined();
    });
  });

  describe("resolveAppOriginPublicOrigin", () => {
    const SANDBOX = "https://sb.example.com/sandbox";
    const HOST = ["https://inspector.example.com"];

    it("is unset, silently, for a blank value", () => {
      expect(resolveAppOriginPublicOrigin(" ", HOST, SANDBOX)).toBeUndefined();
      expect(warned()).toBeUndefined();
    });

    it("returns the canonical origin", () => {
      expect(
        resolveAppOriginPublicOrigin(
          "https://Apps.Example.com/",
          HOST,
          SANDBOX,
        ),
      ).toBe("https://apps.example.com");
      expect(warned()).toBeUndefined();
    });

    it("refuses a path, since documents are served at the origin root", () => {
      expect(
        resolveAppOriginPublicOrigin(
          "https://apps.example.com/x",
          HOST,
          SANDBOX,
        ),
      ).toBeUndefined();
      expect(warned()).toContain("origin only");
    });

    it("refuses a malformed value", () => {
      expect(
        resolveAppOriginPublicOrigin("javascript:alert(1)", HOST, SANDBOX),
      ).toBeUndefined();
      expect(warned()).toContain("MCP_APP_ORIGIN_FULL_ADDRESS");
    });

    it.each([
      ["the Inspector UI", "https://inspector.example.com"],
      ["the sandbox proxy", "https://sb.example.com"],
    ])("refuses an origin shared with %s", (_label, raw) => {
      expect(resolveAppOriginPublicOrigin(raw, HOST, SANDBOX)).toBeUndefined();
      expect(warned()).toContain("must differ from both");
    });

    it("checks only the UI origins when the sandbox URL is bind-derived", () => {
      expect(
        resolveAppOriginPublicOrigin("https://sb.example.com", HOST, undefined),
      ).toBe("https://sb.example.com");
    });

    it("warns about plain http under an https UI", () => {
      expect(
        resolveAppOriginPublicOrigin("http://apps.example.com", HOST, SANDBOX),
      ).toBe("http://apps.example.com");
      expect(warned()).toContain("mixed content");
    });
  });
});
