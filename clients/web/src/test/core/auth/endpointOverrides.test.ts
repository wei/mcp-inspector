import { describe, it, expect, vi, afterEach } from "vitest";
import {
  applyOAuthEndpointOverrides,
  isAuthorizationServerMetadata,
  normalizeOAuthEndpointOverrides,
  oauthEndpointUrlError,
  withOAuthEndpointOverrides,
} from "@inspector/core/auth/endpointOverrides.js";

const METADATA = {
  issuer: "https://as.example.com",
  authorization_endpoint: "https://as.example.com/authorize",
  token_endpoint: "https://as.example.com/token",
  response_types_supported: ["code"],
};

const STAGING_AUTHORIZE = "https://staging.example.com/authorize";
const STAGING_TOKEN = "https://staging.example.com/token";

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    ...init,
  });
}

/** A `fetch` that always resolves to the same prepared response. */
function passThrough(response: Response): typeof fetch {
  return async () => response;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("oauthEndpointUrlError", () => {
  it("accepts a blank value as 'no override'", () => {
    expect(oauthEndpointUrlError("")).toBeUndefined();
    expect(oauthEndpointUrlError("   ")).toBeUndefined();
  });

  it("accepts absolute http and https URLs", () => {
    expect(oauthEndpointUrlError(STAGING_AUTHORIZE)).toBeUndefined();
    expect(
      oauthEndpointUrlError("http://localhost:9000/token"),
    ).toBeUndefined();
  });

  it("rejects a relative path", () => {
    expect(oauthEndpointUrlError("/authorize")).toMatch(/not an absolute URL/);
  });

  it("rejects a non-http(s) scheme", () => {
    expect(oauthEndpointUrlError("ftp://example.com/authorize")).toMatch(
      /not an http\(s\) URL/,
    );
  });

  // `new URL` accepts these, but Fetch rejects a request URL carrying them —
  // so without this check the value passes validation and fails mid-flow.
  it("rejects embedded credentials", () => {
    expect(
      oauthEndpointUrlError("https://user:pass@as.example.com/token"),
    ).toMatch(/username or password/);
    expect(oauthEndpointUrlError("https://user@as.example.com/token")).toMatch(
      /username or password/,
    );
  });
});

describe("normalizeOAuthEndpointOverrides", () => {
  it("returns undefined when nothing is configured", () => {
    expect(normalizeOAuthEndpointOverrides(undefined)).toBeUndefined();
    expect(normalizeOAuthEndpointOverrides({})).toBeUndefined();
    expect(
      normalizeOAuthEndpointOverrides({ authorizationUrl: "  " }),
    ).toBeUndefined();
  });

  it("trims and keeps each configured endpoint independently", () => {
    expect(
      normalizeOAuthEndpointOverrides({
        authorizationUrl: `  ${STAGING_AUTHORIZE} `,
      }),
    ).toEqual({ authorizationUrl: STAGING_AUTHORIZE });
    expect(
      normalizeOAuthEndpointOverrides({ tokenUrl: STAGING_TOKEN }),
    ).toEqual({ tokenUrl: STAGING_TOKEN });
  });

  it("drops a malformed value with a warning, keeping the valid sibling", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(
      normalizeOAuthEndpointOverrides({
        authorizationUrl: "not a url",
        tokenUrl: STAGING_TOKEN,
      }),
    ).toEqual({ tokenUrl: STAGING_TOKEN });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Ignoring `authorizationUrl`"),
    );
  });

  it("drops a URL with embedded credentials", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(
      normalizeOAuthEndpointOverrides({
        tokenUrl: "https://user:pass@as.example.com/token",
      }),
    ).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("username or password"),
    );
  });

  it("returns undefined when every configured value is malformed", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(
      normalizeOAuthEndpointOverrides({
        authorizationUrl: "ftp://example.com/a",
        tokenUrl: "also not a url",
      }),
    ).toBeUndefined();
  });
});

describe("isAuthorizationServerMetadata", () => {
  it("accepts a document with an issuer and at least one endpoint", () => {
    expect(isAuthorizationServerMetadata(METADATA)).toBe(true);
    expect(
      isAuthorizationServerMetadata({
        issuer: "https://as.example.com",
        token_endpoint: "https://as.example.com/token",
      }),
    ).toBe(true);
  });

  it("rejects a non-object body", () => {
    expect(isAuthorizationServerMetadata(null)).toBe(false);
    expect(isAuthorizationServerMetadata("nope")).toBe(false);
    expect(isAuthorizationServerMetadata([METADATA])).toBe(false);
  });

  it("rejects protected-resource metadata, which has no issuer", () => {
    expect(
      isAuthorizationServerMetadata({
        resource: "https://mcp.example.com",
        authorization_servers: ["https://as.example.com"],
      }),
    ).toBe(false);
  });

  it("rejects a document with an issuer but neither endpoint", () => {
    expect(
      isAuthorizationServerMetadata({ issuer: "https://as.example.com" }),
    ).toBe(false);
  });
});

describe("applyOAuthEndpointOverrides", () => {
  it("replaces only the configured endpoints and copies the rest", () => {
    const patched = applyOAuthEndpointOverrides(METADATA, {
      tokenUrl: STAGING_TOKEN,
    });
    expect(patched).toEqual({
      ...METADATA,
      token_endpoint: STAGING_TOKEN,
    });
    expect(METADATA.token_endpoint).toBe("https://as.example.com/token");
  });

  it("supplies an endpoint the document never advertised", () => {
    const patched = applyOAuthEndpointOverrides(
      { issuer: "https://as.example.com" },
      { authorizationUrl: STAGING_AUTHORIZE, tokenUrl: STAGING_TOKEN },
    );
    expect(patched).toEqual({
      issuer: "https://as.example.com",
      authorization_endpoint: STAGING_AUTHORIZE,
      token_endpoint: STAGING_TOKEN,
    });
  });
});

describe("withOAuthEndpointOverrides", () => {
  it("rewrites the endpoints of a metadata response", async () => {
    const base: typeof fetch = async () => jsonResponse(METADATA);
    const wrapped = withOAuthEndpointOverrides(base, () => ({
      authorizationUrl: STAGING_AUTHORIZE,
      tokenUrl: STAGING_TOKEN,
    }));

    const response = await wrapped("https://as.example.com/.well-known/x");
    await expect(response.json()).resolves.toEqual({
      ...METADATA,
      authorization_endpoint: STAGING_AUTHORIZE,
      token_endpoint: STAGING_TOKEN,
    });
    expect(response.status).toBe(200);
  });

  it("re-reads the overrides on every call, so a settings edit takes effect", async () => {
    const base: typeof fetch = async () => jsonResponse(METADATA);
    // Held in a box rather than a `let`: the resolver closes over it before the
    // first assignment, which is what the lazy read exists to support.
    const config: { overrides?: { tokenUrl?: string } } = {};
    const wrapped = withOAuthEndpointOverrides(base, () => config.overrides);

    const before = await wrapped("https://as.example.com/.well-known/x");
    await expect(before.json()).resolves.toMatchObject({
      token_endpoint: METADATA.token_endpoint,
    });

    config.overrides = { tokenUrl: STAGING_TOKEN };
    const after = await wrapped("https://as.example.com/.well-known/x");
    await expect(after.json()).resolves.toMatchObject({
      token_endpoint: STAGING_TOKEN,
    });
  });

  it("warns once about a malformed override, not on every request", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const base: typeof fetch = async () => jsonResponse(METADATA);
    const wrapped = withOAuthEndpointOverrides(base, () => ({
      tokenUrl: "not a url",
    }));

    await wrapped("https://as.example.com/x");
    await wrapped("https://as.example.com/x");
    await wrapped("https://as.example.com/x");

    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("passes the response through untouched when nothing is configured", async () => {
    const original = jsonResponse(METADATA);
    const wrapped = withOAuthEndpointOverrides(
      passThrough(original),
      () => undefined,
    );
    await expect(wrapped("https://as.example.com/x")).resolves.toBe(original);
  });

  it("leaves an error response alone", async () => {
    const original = jsonResponse(METADATA, { status: 404 });
    const wrapped = withOAuthEndpointOverrides(passThrough(original), () => ({
      tokenUrl: STAGING_TOKEN,
    }));
    await expect(wrapped("https://as.example.com/x")).resolves.toBe(original);
  });

  it("leaves a non-JSON response alone", async () => {
    const original = new Response("<html></html>", {
      headers: { "content-type": "text/html" },
    });
    const wrapped = withOAuthEndpointOverrides(passThrough(original), () => ({
      tokenUrl: STAGING_TOKEN,
    }));
    await expect(wrapped("https://as.example.com/x")).resolves.toBe(original);
  });

  // Everything that is not a metadata document comes back as the caller's own
  // Response — identity, not an equivalent copy — so native properties a
  // synthesized Response cannot carry (`url`, `redirected`, `type`) survive.
  it("returns the original response for a JSON body that is not metadata", async () => {
    const original = jsonResponse({ access_token: "abc" });
    const wrapped = withOAuthEndpointOverrides(passThrough(original), () => ({
      tokenUrl: STAGING_TOKEN,
    }));
    const response = await wrapped("https://as.example.com/token");
    expect(response).toBe(original);
    await expect(response.json()).resolves.toEqual({ access_token: "abc" });
  });

  it("returns the original response when the body is not valid JSON", async () => {
    const original = jsonResponse("not json at all");
    const wrapped = withOAuthEndpointOverrides(passThrough(original), () => ({
      tokenUrl: STAGING_TOKEN,
    }));
    const response = await wrapped("https://as.example.com/x");
    expect(response).toBe(original);
    await expect(response.text()).resolves.toBe("not json at all");
  });

  // Fetch forbids a body on 204/205, so rebuilding one would throw. A JSON
  // content-type on an empty response is unusual but legal, and it must not
  // take down an unrelated transport request.
  it("passes a body-less 204 through untouched", async () => {
    const original = new Response(null, {
      status: 204,
      headers: { "content-type": "application/json" },
    });
    const wrapped = withOAuthEndpointOverrides(passThrough(original), () => ({
      tokenUrl: STAGING_TOKEN,
    }));
    await expect(wrapped("https://as.example.com/x")).resolves.toBe(original);
  });

  it("drops the stale content-length and content-encoding of a rewritten body", async () => {
    const body = JSON.stringify(METADATA);
    const wrapped = withOAuthEndpointOverrides(
      passThrough(
        new Response(body, {
          headers: {
            "content-type": "application/json",
            "content-length": String(body.length),
            "content-encoding": "gzip",
          },
        }),
      ),
      () => ({ tokenUrl: STAGING_TOKEN }),
    );
    const response = await wrapped("https://as.example.com/x");
    expect(response.headers.get("content-length")).toBeNull();
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("content-type")).toBe("application/json");
  });
});
