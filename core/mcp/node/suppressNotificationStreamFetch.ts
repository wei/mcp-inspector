/**
 * Suppress the Streamable HTTP client's standalone `GET` notification stream
 * (#2317).
 *
 * The SDK's `StreamableHTTPClientTransport` opens a long-lived `GET` SSE stream
 * as soon as `notifications/initialized` is accepted, and exposes no option to
 * skip it. Against a server that can serve only one request per client at a
 * time, that stream occupies the only slot: `initialize` succeeds and every
 * later request hangs until the per-request timeout fires (#2187).
 *
 * The transport already treats `405 Method Not Allowed` on that `GET` as "this
 * server offers no standalone stream" and carries on with POST-only traffic, so
 * answering the `GET` locally with a synthetic 405 — without sending it —
 * reuses the SDK's own spec-conformant path (the client MAY open the stream;
 * it is never required to).
 *
 * Only the *standalone* stream is suppressed, and the match is deliberately
 * narrow because the SDK routes more than MCP traffic through this fetch:
 *
 * - **OAuth discovery.** The transport hands the same fetch to protected
 *   resource and authorization server metadata discovery, which are plain
 *   `GET`s to other URLs. Suppressing those would break SDK-managed auth.
 *   So the request must target the MCP endpoint itself and ask for
 *   `text/event-stream`.
 * - **Resumption.** A `GET` carrying `Last-Event-ID` is the transport resuming
 *   a POST response stream that dropped mid-request. That belongs to
 *   request/response traffic and must keep reaching the server.
 *
 * Only the legacy (initialize-handshake) era opens this stream. A modern-era
 * connection never sends it, so the wrapper is inert there.
 */
export function createSuppressNotificationStreamFetch(
  baseFetch: typeof fetch,
  endpoint: URL,
): typeof fetch {
  return async (input, init) => {
    if (isStandaloneStreamRequest(input, init, endpoint)) {
      return new Response(null, {
        status: 405,
        statusText: "Method Not Allowed",
      });
    }
    return baseFetch(input, init);
  };
}

function requestUrl(input: Parameters<typeof fetch>[0]): URL | undefined {
  const raw =
    input instanceof Request
      ? input.url
      : input instanceof URL
        ? input.href
        : input;
  try {
    return new URL(raw);
  } catch {
    return undefined;
  }
}

function isStandaloneStreamRequest(
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1],
  endpoint: URL,
): boolean {
  const request = input instanceof Request ? input : undefined;
  const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
  if (method !== "GET") return false;
  const url = requestUrl(input);
  if (
    !url ||
    url.origin !== endpoint.origin ||
    url.pathname !== endpoint.pathname ||
    url.search !== endpoint.search
  ) {
    return false;
  }
  const headers = new Headers(init?.headers ?? request?.headers);
  const accept = headers.get("accept")?.toLowerCase() ?? "";
  return accept.includes("text/event-stream") && !headers.has("last-event-id");
}
