/**
 * Per-server authorization/token endpoint overrides (#1906).
 *
 * The Inspector deliberately has no fields for the authorization and token URLs
 * — they are resolved by authorization-server metadata discovery (RFC 8414 /
 * OpenID Connect Discovery), exactly as a real MCP host resolves them. But a
 * server under development often advertises its *production* authorization
 * server while the person debugging it wants the staging one, and discovery
 * gives them no way to say so.
 *
 * These overrides are that affordance: when set, they replace whatever the
 * authorization server's metadata document returned.
 *
 * ## Why this is a fetch wrapper and not a provider hook
 *
 * Both endpoints reach the flow through exactly one path in SDK v2: `auth()`
 * discovers the metadata document and then reads `metadata.authorization_endpoint`
 * (in `startAuthorization`) and `metadata.token_endpoint` (in `fetchToken`).
 * Neither is routed through `OAuthClientProvider`, and `AuthOptions` has no
 * `metadata` field — so the provider seam that carries the custom authorization
 * parameters (#2018) cannot reach the token endpoint at all. The one seam that
 * sees both is the `fetchFn` the SDK uses for discovery, so the override is
 * applied to the metadata document in flight.
 *
 * Three consequences worth knowing:
 *
 * - **A metadata document is required.** When discovery returns nothing, the SDK
 *   falls back to `/authorize` and `/token` on the authorization server's origin
 *   and there is no document to patch. That matches the feature as asked for —
 *   overriding "whatever urls the authorization server returns" — and a server
 *   publishing no metadata is already on a path where the endpoints are not
 *   being advertised in the first place.
 * - **They do not apply to the enterprise-managed (EMA) leg.** That flow
 *   authorizes against the enterprise IdP — a different authorization server —
 *   and its OIDC discovery runs through this same fetch, so `OAuthManager`
 *   suppresses the overrides when the server is enterprise-managed. This mirrors
 *   `redirectToExternalAuthorization` skipping the custom authorization
 *   parameters (#2018).
 * - **The Network tab shows the patched document.** The wrapper is applied to the
 *   base fetch, inside the request tracker, so what the tab renders is the
 *   metadata as the flow consumed it. That is the useful reading: it explains why
 *   the subsequent authorize/token requests went where they did.
 */

/**
 * Per-server overrides for the two endpoints an authorization server publishes.
 * Both are optional and independent — overriding only the token URL is a valid
 * configuration.
 */
export interface OAuthEndpointOverrides {
  /** Replaces `authorization_endpoint` in the discovered metadata. */
  authorizationUrl?: string;
  /** Replaces `token_endpoint` in the discovered metadata. */
  tokenUrl?: string;
}

/** Field name on the metadata document each override replaces. */
const OVERRIDE_FIELDS = {
  authorizationUrl: "authorization_endpoint",
  tokenUrl: "token_endpoint",
} as const;

/**
 * Validation message for one configured endpoint URL, or `undefined` when the
 * value is acceptable. A blank value is not an error — it means "no override".
 *
 * Only absolute `http:`/`https:` URLs are accepted: the value is written
 * straight into the metadata document, where the SDK passes it to `new URL(...)`
 * with no base — so a relative path would throw deep inside the flow, far from
 * the setting that caused it. `http:` is allowed because the whole point is
 * reaching a local or staging authorization server.
 *
 * The settings form renders this message against the field, so the form and the
 * runtime cannot disagree about which values are usable.
 */
export function oauthEndpointUrlError(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return `"${trimmed}" is not an absolute URL.`;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return `"${trimmed}" is not an http(s) URL.`;
  }
  return undefined;
}

/**
 * The trimmed value, or `undefined` when it is blank or unusable. A rejected
 * value warns and is dropped rather than throwing, so one bad field cannot make
 * an otherwise-working server unconnectable.
 */
function normalizeEndpointUrl(
  value: string | undefined,
  field: keyof OAuthEndpointOverrides,
): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  const error = oauthEndpointUrlError(trimmed);
  if (error) {
    console.warn(`[oauth] Ignoring \`${field}\`: ${error}`);
    return undefined;
  }
  return trimmed;
}

/**
 * Normalize the configured overrides, dropping blank and malformed values.
 * Returns `undefined` when nothing usable remains, which is the signal callers
 * use to skip wrapping their fetch at all.
 */
export function normalizeOAuthEndpointOverrides(
  overrides: OAuthEndpointOverrides | undefined,
): OAuthEndpointOverrides | undefined {
  if (!overrides) return undefined;
  const authorizationUrl = normalizeEndpointUrl(
    overrides.authorizationUrl,
    "authorizationUrl",
  );
  const tokenUrl = normalizeEndpointUrl(overrides.tokenUrl, "tokenUrl");
  if (!authorizationUrl && !tokenUrl) return undefined;
  return {
    ...(authorizationUrl && { authorizationUrl }),
    ...(tokenUrl && { tokenUrl }),
  };
}

/**
 * Whether a parsed JSON body is an authorization-server metadata document.
 *
 * The wrapper sees every JSON response on the connection, so this has to be
 * narrow enough not to rewrite an unrelated body that happens to carry a
 * similarly-named field. RFC 8414 §2 makes `issuer` REQUIRED and it appears in
 * no other document the flow fetches (protected-resource metadata has
 * `authorization_servers`, not `issuer`), so requiring `issuer` alongside at
 * least one of the two endpoints is a precise test.
 */
export function isAuthorizationServerMetadata(
  value: unknown,
): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const doc = value as Record<string, unknown>;
  if (typeof doc.issuer !== "string") return false;
  return (
    typeof doc.authorization_endpoint === "string" ||
    typeof doc.token_endpoint === "string"
  );
}

/**
 * Return a copy of an authorization-server metadata document with the
 * configured endpoints replaced.
 *
 * An override is written even when the document does not advertise that
 * endpoint: a metadata document missing `authorization_endpoint` already fails
 * the flow (`new URL(undefined)` throws), so supplying the missing value is
 * strictly better than leaving the hole.
 */
export function applyOAuthEndpointOverrides(
  metadata: Record<string, unknown>,
  overrides: OAuthEndpointOverrides,
): Record<string, unknown> {
  const patched = { ...metadata };
  for (const [key, field] of Object.entries(OVERRIDE_FIELDS) as [
    keyof OAuthEndpointOverrides,
    (typeof OVERRIDE_FIELDS)[keyof OAuthEndpointOverrides],
  ][]) {
    const override = overrides[key];
    if (override) patched[field] = override;
  }
  return patched;
}

/** Rebuild a response around a replacement body, preserving status/headers. */
function responseWithBody(response: Response, body: string): Response {
  const headers = new Headers(response.headers);
  // The body length changes when an override is applied, and a stale
  // `content-length` on a synthesized `Response` is worse than none — consumers
  // read the body we hand them, not the header.
  headers.delete("content-length");
  // `fetch` already decoded the body, so the replacement is plain text and an
  // inherited `content-encoding` would describe an encoding it no longer has.
  headers.delete("content-encoding");
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Wrap a `fetch` so authorization-server metadata responses carry the
 * configured endpoint overrides.
 *
 * `getOverrides` is called per request rather than captured once: the OAuth
 * config is mutable (a settings edit can change it without rebuilding the
 * client), and reading it lazily means a wrapped fetch never serves a stale
 * override. When it returns nothing the response is passed through untouched,
 * so the wrapper is inert for the overwhelmingly common unconfigured case.
 */
export function withOAuthEndpointOverrides(
  fetchFn: typeof fetch,
  getOverrides: () => OAuthEndpointOverrides | undefined,
): typeof fetch {
  // Normalization is memoized on the raw pair rather than run per request: it
  // warns about a malformed value, and every request on the connection passes
  // through here — so without this a single typo would log on every call.
  let lastKey: string | undefined;
  let lastNormalized: OAuthEndpointOverrides | undefined;

  const resolveOverrides = (): OAuthEndpointOverrides | undefined => {
    const raw = getOverrides();
    const key = JSON.stringify([raw?.authorizationUrl, raw?.tokenUrl]);
    if (key !== lastKey) {
      lastKey = key;
      lastNormalized = normalizeOAuthEndpointOverrides(raw);
    }
    return lastNormalized;
  };

  return async (input, init) => {
    const response = await fetchFn(input, init);
    const overrides = resolveOverrides();
    if (!overrides) return response;
    if (!response.ok) return response;
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("json")) return response;

    const body = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      // Not JSON despite the header. The body is already consumed, so hand back
      // an equivalent response rather than the drained original.
      return responseWithBody(response, body);
    }
    if (!isAuthorizationServerMetadata(parsed)) {
      return responseWithBody(response, body);
    }
    return responseWithBody(
      response,
      JSON.stringify(applyOAuthEndpointOverrides(parsed, overrides)),
    );
  };
}
