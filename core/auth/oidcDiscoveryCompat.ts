/**
 * Compatibility shim for a plain OAuth 2.0 authorization server that publishes
 * its RFC 8414 metadata at the OpenID Connect well-known path (#2172).
 *
 * ## The upstream defect
 *
 * Filed as modelcontextprotocol/typescript-sdk#2733.
 *
 * `discoverAuthorizationServerMetadata` in `@modelcontextprotocol/client@2.0.0`
 * tries a fixed list of well-known URLs (`buildDiscoveryUrls`) and picks the
 * validation schema from the **filename that resolved**, not from the document
 * that came back:
 *
 * ```js
 * const parsed = type === "oauth"
 *   ? OAuthMetadataSchema.parse(body)
 *   : OpenIdProviderDiscoveryMetadataSchema.parse(body);
 * ```
 *
 * `type` is `"oidc"` for every `openid-configuration` candidate, so a document
 * served there is required to carry `jwks_uri`, `subject_types_supported` and
 * `id_token_signing_alg_values_supported` — three fields OpenID Connect
 * Discovery 1.0 requires and RFC 8414 does not. A plain OAuth 2.0 authorization
 * server — no ID tokens, no JWKS, no `sub` — that publishes at that path is
 * therefore rejected with a `ZodError`, and because the parse **throws** rather
 * than continuing the loop, discovery aborts outright: the connection fails and
 * no later candidate is tried.
 *
 * RFC 8414 §5 explicitly anticipates this deployment. `openid-configuration` is
 * a permitted location for general OAuth authorization server metadata, and the
 * OIDC-only fields are not part of the RFC 8414 document. So the server in
 * #2172 is conforming and the client is wrong.
 *
 * ## What this wrapper does
 *
 * It never fabricates a field. It changes *which candidate URL* the document is
 * handed back on, so the SDK validates it under the schema that actually
 * describes it:
 *
 * 1. It watches only for the RFC 8414 candidate,
 *    `/.well-known/oauth-authorization-server[<path>]`, and only when that
 *    request came back with a status the SDK treats as "try the next
 *    candidate" (4xx, or 502).
 * 2. It then fetches the OIDC candidates the SDK would try next — derived from
 *    the request URL by the same rule `buildDiscoveryUrls` uses, which
 *    `oidcDiscoveryCandidates` mirrors and a test pins against the SDK's own
 *    exported function so the two cannot drift.
 * 3. If one of them returns a document that satisfies `OAuthMetadataSchema` but
 *    **fails** `OpenIdProviderDiscoveryMetadataSchema` — i.e. it is RFC 8414
 *    metadata and is not an OpenID provider document — that body is returned as
 *    the response to the RFC 8414 request. The SDK parses it with
 *    `OAuthMetadataSchema`, which is the correct schema for it, and discovery
 *    succeeds.
 *
 * A document that *does* satisfy the OIDC schema is left alone: the original
 * response is returned unchanged and the SDK proceeds to its own OIDC candidate
 * as usual. That costs one duplicate request on a genuine OIDC server, which is
 * the price of not changing behavior for the case that already works.
 *
 * ## What it deliberately does not do
 *
 * - **It does not weaken issuer validation.** The substituted document is the
 *   one the server actually published, `issuer` included, so the SDK's RFC 8414
 *   §3.3 issuer-echo check runs on it exactly as before. A document whose
 *   `issuer` does not match is still rejected.
 * - **It does not invent `jwks_uri` (or any other field).** Back-filling the
 *   three OIDC-required fields would also make the parse succeed, but the
 *   Inspector would then be displaying, in the Auth and Network tabs, a
 *   metadata document the server never published — which is the one thing a
 *   debugging tool must not do.
 * - **It does not hide the real traffic.** It is installed *above* the fetch
 *   tracker (`InspectorClient.effectiveAuthFetch`), so the Network tab records
 *   the genuine 404 on the RFC 8414 path and the genuine request to the OIDC
 *   path. The substitution is visible only to the SDK's parse.
 *
 * ## Removing this
 *
 * This is a workaround for an upstream bug, not a feature. When
 * modelcontextprotocol/typescript-sdk#2733 lands — the SDK selecting the schema
 * from the document rather than from the filename, or treating a schema failure
 * as a candidate to skip rather than as fatal — delete this module and its
 * wiring in `core/mcp/inspectorClient.ts`.
 */

import {
  OAuthMetadataSchema,
  OpenIdProviderDiscoveryMetadataSchema,
} from "@modelcontextprotocol/core";

/** The RFC 8414 well-known path, which every OAuth-typed candidate starts with. */
const RFC8414_WELL_KNOWN = "/.well-known/oauth-authorization-server";

/** The OpenID Connect Discovery well-known path. */
const OIDC_WELL_KNOWN = "/.well-known/openid-configuration";

/**
 * The OIDC discovery candidates the SDK would try after the RFC 8414 candidate
 * `rfc8414Url` failed, in the SDK's own order.
 *
 * Derived from the RFC 8414 URL rather than from the authorization-server URL
 * because that is all a `fetch` wrapper sees. The two are equivalent: the SDK
 * builds the RFC 8414 candidate as
 * `${origin}/.well-known/oauth-authorization-server${path}` with the
 * authorization server's (trailing-slash-stripped) pathname as `path`, so
 * recovering `path` recovers everything `buildDiscoveryUrls` keyed off.
 *
 * Returns an empty array when the URL is not an RFC 8414 candidate at all.
 */
export function oidcDiscoveryCandidates(rfc8414Url: string): string[] {
  let url: URL;
  try {
    url = new URL(rfc8414Url);
  } catch {
    return [];
  }
  if (!url.pathname.startsWith(RFC8414_WELL_KNOWN)) return [];
  const path = url.pathname.slice(RFC8414_WELL_KNOWN.length);
  // A bare prefix match would also claim `/.well-known/oauth-authorization-server-backup`
  // — a path this wrapper has no business rewriting, and one whose failed
  // response it would replace with a document fetched from somewhere else
  // entirely (Copilot). The SDK appends the authorization server's pathname,
  // which always begins with `/`, so requiring the exact path or a `/`
  // boundary is precisely the set it can emit.
  if (path !== "" && !path.startsWith("/")) return [];
  // The authorization server had no path, so the SDK emitted a single OIDC
  // candidate at the origin.
  if (path === "") return [new URL(OIDC_WELL_KNOWN, url.origin).href];
  // A path-suffixed RFC 8414 candidate always has two OIDC siblings: the
  // path-suffixed form and the path-prefixed ("appended") form.
  return [
    new URL(`${OIDC_WELL_KNOWN}${path}`, url.origin).href,
    new URL(`${path}${OIDC_WELL_KNOWN}`, url.origin).href,
  ];
}

/**
 * Whether a status makes the SDK move on to the next discovery candidate.
 *
 * Mirrors `discoverAuthorizationServerMetadata`: a 4xx or a 502 continues the
 * loop, anything else throws. Probing on a status the SDK will not walk past
 * would be wasted work — the flow is already over.
 */
function continuesDiscovery(status: number): boolean {
  return (status >= 400 && status < 500) || status === 502;
}

/**
 * Whether a `content-type` names a whole JSON document.
 *
 * An exact media-type test rather than a substring search for "json", for the
 * same reason `endpointOverrides.ts` uses one: a streaming media type would be
 * read to completion and never resolve.
 */
function isJsonDocumentResponse(contentType: string | null): boolean {
  if (!contentType) return false;
  const mediaType = contentType.split(";")[0].trim().toLowerCase();
  return mediaType === "application/json" || mediaType.endsWith("+json");
}

/**
 * Whether a parsed body is RFC 8414 authorization-server metadata that is *not*
 * a valid OpenID provider document — the exact shape the upstream schema
 * selection rejects.
 *
 * Both halves matter. Without the first, any JSON body would be substituted;
 * without the second, a genuine OIDC document would be diverted onto the RFC
 * 8414 path and silently change behavior for servers that work today.
 */
export function isRfc8414OnlyMetadata(value: unknown): boolean {
  if (!OAuthMetadataSchema.safeParse(value).success) return false;
  return !OpenIdProviderDiscoveryMetadataSchema.safeParse(value).success;
}

/** The request URL a `fetch` call was made with, in any of its three forms. */
function requestUrlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/**
 * The headers the failed discovery request carried, so the probe is answered
 * the same way the SDK's own request would have been (it sends
 * `MCP-Protocol-Version` and `Accept`). Copied from the request rather than
 * reconstructed, so a header the SDK adds later is carried without this module
 * needing to know about it.
 */
function discoveryHeaders(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
): Headers {
  if (init?.headers) return new Headers(init.headers);
  if (typeof input !== "string" && !(input instanceof URL)) {
    return new Headers(input.headers);
  }
  return new Headers();
}

/**
 * Wrap a `fetch` so a plain OAuth 2.0 authorization server publishing RFC 8414
 * metadata at `/.well-known/openid-configuration` is discoverable.
 *
 * Inert for every request that is not a *failed* RFC 8414 discovery request, so
 * the overwhelmingly common case costs one status check and one string
 * comparison.
 */
export function withRfc8414OidcCompat(fetchFn: typeof fetch): typeof fetch {
  return async (input, init) => {
    const response = await fetchFn(input, init);
    if (response.ok) return response;
    if (!continuesDiscovery(response.status)) return response;

    const candidates = oidcDiscoveryCandidates(requestUrlOf(input));
    if (candidates.length === 0) return response;

    const headers = discoveryHeaders(input, init);
    for (const candidate of candidates) {
      let probe: Response;
      try {
        probe = await fetchFn(candidate, { headers });
      } catch {
        // A network or CORS failure on a URL the SDK had not asked for yet is
        // not this wrapper's to report — the SDK will make the same request and
        // handle it. Try the next candidate.
        continue;
      }
      if (!probe.ok) continue;
      if (!isJsonDocumentResponse(probe.headers.get("content-type"))) continue;

      let parsed: unknown;
      let body: string;
      try {
        body = await probe.text();
        parsed = JSON.parse(body);
      } catch {
        continue;
      }
      if (!isRfc8414OnlyMetadata(parsed)) {
        // Either not metadata at all, or a genuine OpenID provider document the
        // SDK can already read. Stop looking: this is the document discovery
        // would have used, and it needs no help.
        return response;
      }

      console.warn(
        `[oauth] ${candidate} returned RFC 8414 OAuth 2.0 authorization server ` +
          `metadata, not an OpenID provider document. The MCP TypeScript SDK ` +
          `validates that path as OpenID Connect Discovery and would reject it ` +
          `(modelcontextprotocol/typescript-sdk#2733), so the Inspector is ` +
          `handing it to discovery as the RFC 8414 document it is.`,
      );
      return new Response(body, {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json" },
      });
    }

    return response;
  };
}
