import { PROTOCOL_VERSION_META_KEY } from "@modelcontextprotocol/client";
import { MODERN_PROTOCOL_VERSION } from "../types.js";

/**
 * Wrap fetch so a modern-era JSON-RPC **notification** POST carries the
 * SEP-2243 standard headers the SDK only stamps on requests (#2385).
 *
 * This is a compatibility workaround, not a protocol mandate. The 2026-07-28
 * Streamable HTTP spec defines no client-to-server notifications — closing the
 * SSE stream is the cancellation signal, and "header requirements for
 * notification POSTs are not defined by this revision". The SDK nonetheless
 * POSTs a `notifications/cancelled` whenever a `subscriptions/listen` stream
 * closes (every resource unsubscribe re-listens), and its
 * `_applyBodyDerivedHeaders` stamps nothing on a non-request. Servers that
 * apply their request-header validation to every POST — as SEP-2243's draft
 * example did for notifications — refused it `400 Header mismatch: Mcp-Method
 * is required`, failing the unsubscribe. Stamping the headers is harmless to a
 * server that ignores them.
 *
 * This mirrors the SDK's own request rule exactly, so the two cannot disagree
 * about era: the message's `_meta` protocol-version claim is the signal, and a
 * message without a modern claim is passed through untouched — a legacy
 * exchange never gains a 2026 header. `Mcp-Name` is not added: the spec
 * defines it only for `tools/call`, `resources/read` and `prompts/get`
 * requests.
 *
 * Remove once the SDK stops POSTing that notification on Streamable HTTP, or
 * stamps it itself.
 */
export function createNotificationHeadersFetch(
  baseFetch: typeof fetch,
): typeof fetch {
  return (input, init) => {
    const method = modernNotificationMethod(init);
    if (method === undefined) return baseFetch(input, init);
    const headers = new Headers(init?.headers);
    headers.set("mcp-protocol-version", method.version);
    headers.set("mcp-method", method.method);
    return baseFetch(input, { ...init, headers });
  };
}

/**
 * The method and modern protocol version of a single JSON-RPC notification in
 * a POST body, or `undefined` for anything else (a request, a response, a
 * batch, a legacy or unclaimed message, a non-string or non-JSON body).
 */
function modernNotificationMethod(
  init: RequestInit | undefined,
): { method: string; version: string } | undefined {
  if (init?.method?.toUpperCase() !== "POST") return undefined;
  if (typeof init.body !== "string") return undefined;
  let message: unknown;
  try {
    message = JSON.parse(init.body);
  } catch {
    return undefined;
  }
  if (!isRecord(message) || "id" in message) return undefined;
  if (typeof message.method !== "string") return undefined;
  const meta = isRecord(message.params) ? message.params._meta : undefined;
  const version = isRecord(meta) ? meta[PROTOCOL_VERSION_META_KEY] : undefined;
  // Dated revision tokens order lexically — the SDK's own era test.
  if (typeof version !== "string" || version < MODERN_PROTOCOL_VERSION) {
    return undefined;
  }
  return { method: message.method, version };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
