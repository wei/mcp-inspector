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
 * Only the *standalone* stream is suppressed. A `GET` carrying
 * `Last-Event-ID` is the transport resuming a POST response stream that
 * dropped mid-request, which is part of request/response traffic and has to
 * keep reaching the server.
 */
export function createSuppressNotificationStreamFetch(
  baseFetch: typeof fetch,
): typeof fetch {
  return async (input, init) => {
    if (isStandaloneStreamRequest(input, init)) {
      return new Response(null, {
        status: 405,
        statusText: "Method Not Allowed",
      });
    }
    return baseFetch(input, init);
  };
}

function isStandaloneStreamRequest(
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1],
): boolean {
  const request = input instanceof Request ? input : undefined;
  const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
  if (method !== "GET") return false;
  const headers = new Headers(init?.headers ?? request?.headers);
  return !headers.has("last-event-id");
}
