/**
 * Shared helper for the remote relay's progress-aware request-response waits
 * (#2028). Pure and browser-safe, so both the browser `RemoteClientTransport`
 * and the Node `RemoteSession` import it rather than each carrying a copy.
 */

import type { JSONRPCMessage } from "@modelcontextprotocol/client";

/**
 * The id of the request a `notifications/progress` belongs to, or `undefined`
 * for any other message. The SDK stamps `progressToken: messageId` on the
 * outbound request, so a progress notification's `progressToken` is the id of
 * the request whose wait should be re-armed. A JSON-RPC progress token is a
 * string or a number; anything else is ignored so a malformed token can't be
 * coerced into a map key.
 */
export function progressTokenOf(
  message: JSONRPCMessage,
): string | number | undefined {
  if (
    "method" in message &&
    message.method === "notifications/progress" &&
    "params" in message &&
    typeof message.params === "object" &&
    message.params !== null
  ) {
    const token = (message.params as { progressToken?: unknown }).progressToken;
    if (typeof token === "string" || typeof token === "number") {
      return token;
    }
  }
  return undefined;
}
