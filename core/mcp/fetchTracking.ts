import type { FetchRequestEntryBase, FetchStreamState } from "./types.js";

/**
 * Header names whose values are replaced with `REDACTED_HEADER_VALUE` before a
 * fetch entry is recorded. The recorded entry flows to the in-memory log, the
 * pino logger, and (via session storage) to disk — none of those sinks should
 * ever see a live bearer token or session cookie.
 */
const SENSITIVE_HEADERS: ReadonlySet<string> = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "proxy-authorization",
  "x-api-key",
  // The inspector backend's own bearer (createRemoteFetch stamps this on every
  // proxied request); same exposure as Authorization.
  "x-mcp-remote-auth",
]);

/** Placeholder substituted for sensitive header values in recorded entries. */
export const REDACTED_HEADER_VALUE = "[REDACTED]";

/**
 * Field / query-parameter names whose values are masked in a recorded fetch
 * entry's request body, response body, and URL query string. These are the
 * credentials that ride in OAuth token exchanges (and similar flows): the
 * header slice masks `Authorization`, but the same secrets show up verbatim in
 * the form/JSON body (`client_secret`, `code`, `refresh_token`, …) and are
 * sometimes carried as URL query params. Matching is case-insensitive.
 */
const SENSITIVE_BODY_FIELDS: ReadonlySet<string> = new Set([
  "client_secret",
  "code",
  "refresh_token",
  "access_token",
  "id_token",
  "code_verifier",
  "client_assertion",
  "assertion",
  "password",
  "token",
]);

/**
 * Placeholder substituted for sensitive body / URL values in recorded entries.
 * Deliberately kept separate from {@link REDACTED_HEADER_VALUE} (even though both
 * are `"[REDACTED]"` today) so the header and body/URL redaction paths can evolve
 * their sentinels independently.
 */
export const REDACTED_VALUE = "[REDACTED]";

/** Whether `name` (any casing) is a known-sensitive field / query-param name. */
function isSensitiveField(name: string): boolean {
  return SENSITIVE_BODY_FIELDS.has(name.toLowerCase());
}

/**
 * Returns a copy of `headers` with every {@link SENSITIVE_HEADERS} value
 * replaced by {@link REDACTED_HEADER_VALUE}. Comparison is case-insensitive
 * (HTTP header names are case-insensitive); the original casing of every key is
 * preserved so the recorded entry still shows what the client actually sent.
 */
export function redactSensitiveHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = SENSITIVE_HEADERS.has(key.toLowerCase())
      ? REDACTED_HEADER_VALUE
      : value;
  }
  return out;
}

/**
 * Returns `url` with every {@link SENSITIVE_BODY_FIELDS} query-parameter value
 * replaced by {@link REDACTED_VALUE}. The path and non-sensitive params stay
 * readable. Best-effort: if the URL (or its query string) can't be parsed the
 * original string is returned unchanged. Only the recorded copy is redacted —
 * the live request still uses the original `input`/`init`.
 */
export function redactUrlQuery(url: string): string {
  const queryStart = url.indexOf("?");
  if (queryStart === -1) return url;

  const base = url.slice(0, queryStart);
  const afterQuery = url.slice(queryStart + 1);
  // Preserve a trailing fragment (#…) untouched — it never carries query params.
  const hashStart = afterQuery.indexOf("#");
  const query = hashStart === -1 ? afterQuery : afterQuery.slice(0, hashStart);
  const fragment = hashStart === -1 ? "" : afterQuery.slice(hashStart);

  try {
    const params = new URLSearchParams(query);
    let changed = false;
    for (const key of new Set(params.keys())) {
      if (isSensitiveField(key)) {
        changed = true;
        // Collapse repeated occurrences to a single redacted value.
        params.set(key, REDACTED_VALUE);
      }
    }
    if (!changed) return url;
    return `${base}?${params.toString()}${fragment}`;
  } catch {
    return url;
  }
}

/** Recursively redact sensitive keys in a parsed JSON value (in place). */
function redactJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactJsonValue);
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      // Only STRING values of a sensitive-named field are masked. The secrets
      // this targets (OAuth `code`, `access_token`, `client_secret`, …) are
      // always strings; a non-string is never one of them. This is important
      // for JSON-RPC bodies, whose numeric `error.code` (e.g. -32020) collides
      // with the OAuth authorization-`code` name — masking it would destroy the
      // very field the Network tab classifies the modern spec errors on.
      //
      // Assumes a sensitive value is a scalar or an object (recursed, so an inner
      // sensitive string key is still masked). A sensitive key whose value is an
      // *array of scalars* (e.g. `{ password: ["a", "b"] }`) would recurse
      // element-by-element with no key context and slip through — no OAuth/token
      // payload has that shape, so it is not handled.
      out[key] =
        isSensitiveField(key) && typeof val === "string"
          ? REDACTED_VALUE
          : redactJsonValue(val);
    }
    return out;
  }
  return value;
}

/**
 * Returns `body` with every {@link SENSITIVE_BODY_FIELDS} value masked, for
 * `application/x-www-form-urlencoded` and JSON payloads. The surrounding shape
 * (field order, non-sensitive fields, JSON structure) is preserved — only the
 * values change. Best-effort and never throws: an empty, non-string, or
 * unparseable body is returned unchanged. Only the recorded copy is redacted;
 * the live request body is never touched.
 *
 * Scope is deliberately limited to `application/x-www-form-urlencoded` and JSON:
 * these cover the OAuth token flows this redaction targets. `multipart/form-data`
 * (and other binary/opaque bodies) are passed through verbatim — OAuth never uses
 * multipart, so the risk is low; revisit if a multipart secret path appears.
 */
export function redactBody(
  body: string | undefined,
  contentType: string | null | undefined,
): string | undefined {
  if (!body) return body;

  const type = (contentType ?? "").toLowerCase();

  // Form-encoded bodies (the OAuth token endpoint's request format).
  if (type.includes("application/x-www-form-urlencoded")) {
    try {
      const params = new URLSearchParams(body);
      let changed = false;
      for (const key of new Set(params.keys())) {
        if (isSensitiveField(key)) {
          changed = true;
          params.set(key, REDACTED_VALUE);
        }
      }
      return changed ? params.toString() : body;
    } catch {
      return body;
    }
  }

  // JSON bodies — either explicitly typed, or (when the content-type is
  // missing/other) any string that parses as a JSON object/array. A bare
  // JSON scalar has no field names, so it can't carry a sensitive key.
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed !== null && typeof parsed === "object") {
      return JSON.stringify(redactJsonValue(parsed));
    }
  } catch {
    // Not JSON — fall through and leave as-is.
  }

  return body;
}

/**
 * Case-insensitive lookup of a header value from a plain header record.
 * Exported because a recorded entry's header casing is host-dependent (Node
 * lowercases, happy-dom preserves the wire casing), so any consumer reading
 * one back — the Network UI, the connection diagnostics — needs the same
 * tolerance the tracker itself has.
 */
export function findHeader(
  headers: Record<string, string> | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) return value;
  }
  return undefined;
}

/**
 * Whether a response represents an unbounded (long-lived) HTTP stream
 * whose body cannot be cloned + read to completion. The streamable HTTP
 * spec uses `GET` + `text/event-stream` for the long-lived server-push
 * channel; `POST` SSE replies are bounded (server closes after the
 * JSON-RPC response) and therefore safe to capture. Shared between the
 * fetch tracker (where it decides whether to read the body) and the
 * Network UI (where it decides which placeholder to show).
 */
export function isLongLivedStreamResponse(
  method: string,
  contentType: string | null | undefined,
): boolean {
  if (method !== "GET") return false;
  if (!contentType) return false;
  return (
    contentType.includes("text/event-stream") ||
    contentType.includes("application/x-ndjson")
  );
}

export interface FetchTrackingCallbacks {
  trackRequest?: (entry: FetchRequestEntryBase) => void;
  /**
   * Called after the response body has been read asynchronously. Lets the
   * consumer patch the already-dispatched entry with the body without
   * blocking the transport on body reading. Fires only on success — if the
   * body couldn't be read (long-lived stream, clone failure), this is
   * never invoked and the entry's responseBody stays undefined.
   */
  updateResponseBody?: (id: string, responseBody: string) => void;
  /**
   * Called for a long-lived stream response — the one case `updateResponseBody`
   * never covers — each time an SSE event is delivered on it, and once more
   * when it ends (with `closedAt` set). Lets the consumer show that the stream
   * is open and what it has carried, which is the whole diagnostic when a
   * server serializes requests behind it (#2318).
   */
  updateStream?: (id: string, stream: FetchStreamState) => void;
}

/**
 * The framing a long-lived stream's events arrive in — the two content types
 * `isLongLivedStreamResponse` accepts. SSE dispatches on a blank line;
 * NDJSON dispatches on every line.
 */
export type LongLivedStreamFraming = "sse" | "ndjson";

/** The framing for a long-lived stream's content type. */
export function longLivedStreamFraming(
  contentType: string | null | undefined,
): LongLivedStreamFraming {
  return contentType?.includes("application/x-ndjson") ? "ndjson" : "sse";
}

/**
 * Count the events on a long-lived stream without buffering it, and report
 * when it ends.
 *
 * Reads a `clone()` of the response through a reader and discards the bytes,
 * so the transport keeps consuming the original at its own pace (the same
 * tee the bounded-body path relies on). Counting follows the framing the
 * transport's own parser applies. For SSE a blank line dispatches the block
 * before it, and only a block carrying a `data` field is an event —
 * keepalive comments (`: ping`) and bare `event:`/`id:` lines are not; a
 * partial block at end-of-stream is dropped, exactly as the SSE spec and the
 * SDK's `EventSourceParserStream` (which has no flush) drop it. For NDJSON
 * every non-blank line is one event.
 *
 * Reports once as soon as watching starts (zero events, open), once per event,
 * and once more on every exit from the read loop — a clean end-of-stream, a
 * network error, or the transport aborting the fetch on disconnect (which
 * errors both tee branches) — with `closedAt` set. The reader is never cancelled from here:
 * cancelling one branch of a tee does not release the source, and
 * `ReadableStream.cancel()` adopts the source's promise, which on a teardown
 * path may never settle (the same hazard `core/mcp/remote/node/server.ts`
 * documents at its own `cancel()` call).
 */
function watchLongLivedStream(
  response: Response,
  id: string,
  framing: LongLivedStreamFraming,
  callbacks: FetchTrackingCallbacks,
): void {
  const update = callbacks.updateStream;
  if (!update) return;
  let body: ReadableStream<Uint8Array> | null;
  try {
    body = response.clone().body;
  } catch {
    // Clone failed (consumed body, transport quirks) — there is nothing to
    // watch; the entry stays as tracked with no stream state.
    return;
  }
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let eventCount = 0;
  let pending = "";
  let blockHasData = false;
  // Announce the stream as open before a byte arrives. A stream that never
  // delivers anything is the #2187 tell, and it would otherwise be the one
  // stream with no state to show — the count only moves on an event.
  update(id, { eventCount });

  const consumeLine = (rawLine: string): void => {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (framing === "ndjson") {
      if (line.trim() === "") return;
      eventCount += 1;
      update(id, { eventCount });
      return;
    }
    if (line === "") {
      if (blockHasData) {
        eventCount += 1;
        blockHasData = false;
        update(id, { eventCount });
      }
      return;
    }
    // A field line is `name[:value]`; `data` with no colon is still a data
    // field per the spec, so match the name rather than the `data:` prefix.
    if (line === "data" || line.startsWith("data:")) blockHasData = true;
  };

  const pump = async (): Promise<void> => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });
        let newline = pending.indexOf("\n");
        while (newline !== -1) {
          consumeLine(pending.slice(0, newline));
          pending = pending.slice(newline + 1);
          newline = pending.indexOf("\n");
        }
      }
    } catch {
      // An errored or aborted stream has still ended — fall through to report
      // the close; the entry's `error` field is for a fetch that never got a
      // response, which this one did.
    }
    update(id, { eventCount, closedAt: new Date() });
  };
  // Deliberately not awaited: the fetch wrapper has to return the response
  // now, and this watcher lives as long as the stream does. It owns its own
  // failures — the read loop is wrapped in a `try` that treats an error as a
  // close — so the promise cannot reject.
  void pump();
}

/**
 * Creates a fetch wrapper that tracks HTTP requests and responses
 */
export function createFetchTracker(
  baseFetch: typeof fetch,
  callbacks: FetchTrackingCallbacks,
): typeof fetch {
  return async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const startTime = Date.now();
    const timestamp = new Date();
    const id = `${timestamp.getTime()}-${Math.random().toString(36).slice(2, 11)}`;

    // Extract request information
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const method = init?.method || "GET";

    // Extract headers, redacting sensitive values BEFORE they reach any
    // downstream sink (logger, in-memory list, persisted session storage).
    const rawRequestHeaders: Record<string, string> = {};
    if (input instanceof Request) {
      input.headers.forEach((value, key) => {
        rawRequestHeaders[key] = value;
      });
    }
    if (init?.headers) {
      const headers = new Headers(init.headers);
      headers.forEach((value, key) => {
        rawRequestHeaders[key] = value;
      });
    }
    const requestHeaders = redactSensitiveHeaders(rawRequestHeaders);
    const requestContentType = findHeader(rawRequestHeaders, "content-type");

    // Redact sensitive query params in the recorded URL (live `input` is
    // untouched — only this logged copy is masked).
    const redactedUrl = redactUrlQuery(url);

    // Extract body (if present and readable)
    let requestBody: string | undefined;
    if (init?.body) {
      if (typeof init.body === "string") {
        requestBody = init.body;
      } else {
        // Try to convert to string, but skip if it fails (e.g., ReadableStream)
        try {
          requestBody = String(init.body);
        } catch {
          requestBody = undefined;
        }
      }
    } else if (input instanceof Request && input.body) {
      // Try to clone and read the request body
      // Clone protects the original body from being consumed
      try {
        const cloned = input.clone();
        requestBody = await cloned.text();
      } catch {
        // Can't read body (might be consumed, not readable, or other issue)
        requestBody = undefined;
      }
    }

    // Redact sensitive fields in the recorded request body. The live request
    // body (`init.body` / `input`) is never touched — only this logged string.
    const redactedRequestBody = redactBody(requestBody, requestContentType);

    // Make the actual fetch request
    let response: Response;
    let error: string | undefined;
    try {
      response = await baseFetch(input, init);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      // Create a minimal error entry
      const entry: FetchRequestEntryBase = {
        id,
        timestamp,
        method,
        url: redactedUrl,
        requestHeaders,
        requestBody: redactedRequestBody,
        error,
        duration: Date.now() - startTime,
      };
      callbacks.trackRequest?.(entry);
      throw err;
    }

    // Extract response information
    const responseStatus = response.status;
    const responseStatusText = response.statusText;

    // Extract response headers (redacted — Set-Cookie etc. are credentials too)
    const rawResponseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      rawResponseHeaders[key] = value;
    });
    const responseHeaders = redactSensitiveHeaders(rawResponseHeaders);

    // Skip body reading only for *long-lived* streams. On streamable HTTP,
    // GET /mcp opens an unbounded SSE channel for server-to-client pushes
    // — calling `.text()` on a clone of that would buffer forever. POST
    // responses with the same content-type are bounded: the server emits
    // the JSON-RPC reply (sometimes preceded by progress events) and
    // closes the connection, so cloning + reading is safe and gives the
    // user the raw SSE payload they were missing.
    const isLongLivedStream = isLongLivedStreamResponse(
      method,
      response.headers.get("content-type"),
    );

    const duration = Date.now() - startTime;

    // Create entry and track it immediately. The body is read asynchronously
    // below to avoid blocking the transport — for streaming responses (POST
    // + SSE), the server keeps the connection open until it has delivered
    // every progress notification plus the final reply, so awaiting
    // `.text()` here would force the transport to wait for all events
    // before it could process any of them.
    const entry: FetchRequestEntryBase = {
      id,
      timestamp,
      method,
      url: redactedUrl,
      requestHeaders,
      requestBody: redactedRequestBody,
      responseStatus,
      responseStatusText,
      responseHeaders,
      responseBody: undefined,
      duration,
    };

    callbacks.trackRequest?.(entry);

    // A long-lived stream is watched instead of read: its body never ends,
    // but its event count and its eventual close are exactly the state a
    // stalled connection is diagnosed from (#2318).
    if (isLongLivedStream && response.body && !response.bodyUsed) {
      watchLongLivedStream(
        response,
        id,
        longLivedStreamFraming(response.headers.get("content-type")),
        callbacks,
      );
    }

    // Kick off a fire-and-forget read of the cloned body. The clone is an
    // independent tee'd stream so the transport keeps consuming the
    // original at its own pace. When the read resolves we patch the entry
    // via `updateResponseBody`. Skipped for long-lived streams (GET +
    // SSE / ndjson) because `.text()` would never resolve on those.
    if (!isLongLivedStream && response.body && !response.bodyUsed) {
      const responseContentType = response.headers.get("content-type");
      try {
        const cloned = response.clone();
        cloned
          .text()
          .then((body) => {
            // Mask token-endpoint secrets (access_token, refresh_token, …)
            // before the body reaches any sink.
            callbacks.updateResponseBody?.(
              id,
              redactBody(body, responseContentType) ?? body,
            );
          })
          .catch(() => {
            // Stream errored after clone — leave the body undefined.
          });
      } catch {
        // Clone failed (consumed body, transport quirks). Leave body
        // undefined; the entry is already dispatched.
      }
    }

    return response;
  };
}
