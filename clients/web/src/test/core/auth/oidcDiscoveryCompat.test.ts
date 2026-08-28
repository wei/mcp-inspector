import { describe, it, expect, vi, afterEach } from "vitest";
import { buildDiscoveryUrls } from "@modelcontextprotocol/client";
import {
  oidcDiscoveryCandidates,
  isRfc8414OnlyMetadata,
  withRfc8414OidcCompat,
} from "@inspector/core/auth/oidcDiscoveryCompat.js";

/** Minimal RFC 8414 authorization-server metadata — no OIDC-only fields. */
const RFC8414_DOC = {
  issuer: "https://as.example.com/tenant",
  authorization_endpoint: "https://as.example.com/tenant/authorize",
  token_endpoint: "https://as.example.com/tenant/token",
  response_types_supported: ["code"],
};

/** The same document plus the three fields OpenID Connect Discovery requires. */
const OIDC_DOC = {
  ...RFC8414_DOC,
  jwks_uri: "https://as.example.com/tenant/jwks",
  subject_types_supported: ["public"],
  id_token_signing_alg_values_supported: ["RS256"],
};

const RFC8414_URL =
  "https://as.example.com/.well-known/oauth-authorization-server/tenant";
const OIDC_SUFFIXED =
  "https://as.example.com/.well-known/openid-configuration/tenant";
const OIDC_APPENDED =
  "https://as.example.com/tenant/.well-known/openid-configuration";

function json(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function notFound(): Response {
  return new Response("nope", { status: 404 });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("oidcDiscoveryCandidates", () => {
  // The derivation is a hand-written mirror of the SDK's `buildDiscoveryUrls`,
  // which a fetch wrapper cannot call (it sees a request URL, not the
  // authorization-server URL). Pinning it against the SDK's own export is what
  // keeps the two from drifting when the SDK changes its candidate list.
  it.each([
    "https://as.example.com",
    "https://as.example.com/",
    "https://as.example.com/tenant",
    "https://as.example.com/tenant/",
    "https://misc.poodll.com/mod/minilesson/mcp.php",
  ])("matches the SDK's OIDC candidates for %s", (authServerUrl) => {
    const sdkUrls = buildDiscoveryUrls(authServerUrl);
    const rfc8414 = sdkUrls.find((entry) => entry.type === "oauth");
    expect(rfc8414).toBeDefined();
    const expected = sdkUrls
      .filter((entry) => entry.type === "oidc")
      .map((entry) => entry.url.href);
    expect(oidcDiscoveryCandidates(rfc8414!.url.href)).toEqual(expected);
  });

  it("returns nothing for a URL that is not an RFC 8414 candidate", () => {
    expect(oidcDiscoveryCandidates("https://as.example.com/tokens")).toEqual(
      [],
    );
  });

  it("returns nothing for an unparseable URL", () => {
    expect(oidcDiscoveryCandidates("not a url")).toEqual([]);
  });

  it("does not claim a path that merely shares the well-known prefix", () => {
    // A bare prefix match would treat this as a discovery request and replace
    // its failed response with a document from a derived URL (Copilot).
    expect(
      oidcDiscoveryCandidates(
        "https://as.example.com/.well-known/oauth-authorization-server-backup",
      ),
    ).toEqual([]);
  });
});

describe("isRfc8414OnlyMetadata", () => {
  it("accepts plain RFC 8414 metadata", () => {
    expect(isRfc8414OnlyMetadata(RFC8414_DOC)).toBe(true);
  });

  it("rejects a document that is a valid OpenID provider document", () => {
    expect(isRfc8414OnlyMetadata(OIDC_DOC)).toBe(false);
  });

  it("rejects a body that is not authorization-server metadata at all", () => {
    expect(isRfc8414OnlyMetadata({ hello: "world" })).toBe(false);
  });
});

describe("withRfc8414OidcCompat", () => {
  it("passes a successful response through untouched", async () => {
    const original = json(RFC8414_DOC);
    const base = vi.fn<typeof fetch>().mockResolvedValue(original);
    const wrapped = withRfc8414OidcCompat(base);

    await expect(wrapped(RFC8414_URL)).resolves.toBe(original);
    expect(base).toHaveBeenCalledTimes(1);
  });

  it("passes a status the SDK will not walk past through untouched", async () => {
    const original = new Response("boom", { status: 500 });
    const base = vi.fn<typeof fetch>().mockResolvedValue(original);
    const wrapped = withRfc8414OidcCompat(base);

    await expect(wrapped(RFC8414_URL)).resolves.toBe(original);
    expect(base).toHaveBeenCalledTimes(1);
  });

  it("does not probe when the failed request is not a discovery request", async () => {
    const original = notFound();
    const base = vi.fn<typeof fetch>().mockResolvedValue(original);
    const wrapped = withRfc8414OidcCompat(base);

    await expect(wrapped("https://as.example.com/tokens")).resolves.toBe(
      original,
    );
    expect(base).toHaveBeenCalledTimes(1);
  });

  it("serves an RFC 8414 document found on the appended OIDC path", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const base = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url === OIDC_APPENDED) return json(RFC8414_DOC);
      return notFound();
    });
    const wrapped = withRfc8414OidcCompat(base);

    const response = await wrapped(RFC8414_URL);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    await expect(response.json()).resolves.toEqual(RFC8414_DOC);
    // The failed original, then both OIDC candidates.
    expect(base).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(OIDC_APPENDED));
  });

  it("serves an RFC 8414 document found on the path-suffixed OIDC path", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const base = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url === OIDC_SUFFIXED) return json(RFC8414_DOC);
      return notFound();
    });
    const wrapped = withRfc8414OidcCompat(base);

    await expect((await wrapped(RFC8414_URL)).json()).resolves.toEqual(
      RFC8414_DOC,
    );
    // The failed original, then the first OIDC candidate — no need for a second.
    expect(base).toHaveBeenCalledTimes(2);
  });

  it("leaves a genuine OpenID provider document to the SDK's own OIDC leg", async () => {
    const original = notFound();
    const base = vi.fn<typeof fetch>(async (input) => {
      if (String(input) === OIDC_SUFFIXED) return json(OIDC_DOC);
      return original;
    });
    const wrapped = withRfc8414OidcCompat(base);

    await expect(wrapped(RFC8414_URL)).resolves.toBe(original);
    // Stops at the document discovery would have used; the appended candidate
    // is never probed.
    expect(base).toHaveBeenCalledTimes(2);
  });

  it("skips a candidate that is not JSON and keeps looking", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const base = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url === OIDC_SUFFIXED) {
        return new Response("<html>login</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }
      if (url === OIDC_APPENDED) return json(RFC8414_DOC);
      return notFound();
    });
    const wrapped = withRfc8414OidcCompat(base);

    await expect((await wrapped(RFC8414_URL)).json()).resolves.toEqual(
      RFC8414_DOC,
    );
  });

  it("skips a candidate whose JSON body will not parse", async () => {
    const original = notFound();
    const base = vi.fn<typeof fetch>(async (input) => {
      if (String(input).includes("openid-configuration")) {
        return new Response("{ not json", {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return original;
    });
    const wrapped = withRfc8414OidcCompat(base);

    await expect(wrapped(RFC8414_URL)).resolves.toBe(original);
    expect(base).toHaveBeenCalledTimes(3);
  });

  it("skips a candidate that itself fails", async () => {
    const original = notFound();
    const base = vi.fn<typeof fetch>().mockResolvedValue(original);
    const wrapped = withRfc8414OidcCompat(base);

    await expect(wrapped(RFC8414_URL)).resolves.toBe(original);
    expect(base).toHaveBeenCalledTimes(3);
  });

  it("treats a probe that throws as a candidate to skip", async () => {
    const original = notFound();
    const base = vi.fn<typeof fetch>(async (input) => {
      if (String(input).includes("openid-configuration")) {
        throw new TypeError("Failed to fetch");
      }
      return original;
    });
    const wrapped = withRfc8414OidcCompat(base);

    await expect(wrapped(RFC8414_URL)).resolves.toBe(original);
    expect(base).toHaveBeenCalledTimes(3);
  });

  it("probes on a 502, which the SDK also walks past", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const base = vi.fn<typeof fetch>(async (input) => {
      if (String(input) === OIDC_APPENDED) return json(RFC8414_DOC);
      return new Response("bad gateway", { status: 502 });
    });
    const wrapped = withRfc8414OidcCompat(base);

    await expect((await wrapped(RFC8414_URL)).json()).resolves.toEqual(
      RFC8414_DOC,
    );
  });

  it("carries the discovery headers from the failed request onto the probe", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const seen: Headers[] = [];
    const base = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.includes("openid-configuration")) {
        seen.push(new Headers(init?.headers));
        return json(RFC8414_DOC);
      }
      return notFound();
    });
    const wrapped = withRfc8414OidcCompat(base);

    await wrapped(RFC8414_URL, {
      headers: {
        "MCP-Protocol-Version": "2025-11-25",
        Accept: "application/json",
      },
    });
    expect(seen[0]?.get("mcp-protocol-version")).toBe("2025-11-25");
    expect(seen[0]?.get("accept")).toBe("application/json");
  });

  it("reads the headers off a Request input when there is no init", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const seen: Headers[] = [];
    const base = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("openid-configuration")) {
        seen.push(new Headers(init?.headers));
        return json(RFC8414_DOC);
      }
      return notFound();
    });
    const wrapped = withRfc8414OidcCompat(base);

    await wrapped(
      new Request(RFC8414_URL, {
        headers: { "MCP-Protocol-Version": "2025-11-25" },
      }),
    );
    expect(seen[0]?.get("mcp-protocol-version")).toBe("2025-11-25");
  });

  it("accepts a URL instance as the request input", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const base = vi.fn<typeof fetch>(async (input) => {
      if (String(input) === OIDC_APPENDED) return json(RFC8414_DOC);
      return notFound();
    });
    const wrapped = withRfc8414OidcCompat(base);

    await expect((await wrapped(new URL(RFC8414_URL))).json()).resolves.toEqual(
      RFC8414_DOC,
    );
  });

  it("handles a root authorization server, which has a single OIDC candidate", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const rootDoc = {
      issuer: "https://as.example.com",
      authorization_endpoint: "https://as.example.com/authorize",
      token_endpoint: "https://as.example.com/token",
      response_types_supported: ["code"],
    };
    const base = vi.fn<typeof fetch>(async (input) => {
      if (
        String(input) ===
        "https://as.example.com/.well-known/openid-configuration"
      ) {
        return json(rootDoc);
      }
      return notFound();
    });
    const wrapped = withRfc8414OidcCompat(base);

    await expect(
      (
        await wrapped(
          "https://as.example.com/.well-known/oauth-authorization-server",
        )
      ).json(),
    ).resolves.toEqual(rootDoc);
    expect(base).toHaveBeenCalledTimes(2);
  });
});
