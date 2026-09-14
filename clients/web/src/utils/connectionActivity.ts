// Row formatters for the Connection Info modal's Connection Activity section
// (#2318): the same snapshot a request timeout's message is written from,
// rendered while the request is still in flight. Pure functions over the
// snapshot and an explicit clock — the caller decides what "now" is (the
// snapshot's own `capturedAt` on first paint, a ticking clock afterwards; see
// `useTickingClock`), so nothing here reads the wall clock and a render stays
// a pure function of its inputs.

import {
  describeStreamEndpoint,
  formatDuration,
  type ConnectionDiagnostics,
  type NotificationStreamState,
} from "@inspector/core/mcp/connectionDiagnostics.js";
import type { ServerType } from "@inspector/core/mcp/types.js";

export const NO_OUTSTANDING_REQUESTS_LABEL = "None";
export const NO_RESPONSE_YET_LABEL = "None this session";
export const NO_NOTIFICATION_STREAM_LABEL = "Not opened";
export const NO_STREAM_ON_STDIO_LABEL = "N/A (stdio)";

/**
 * One line per unanswered request, oldest first — `tools/list — sent 60s
 * ago`. A request the SDK has already given up on stays listed: it is still
 * unanswered, which is the fact this section reports.
 */
export function formatOutstandingRequests(
  diagnostics: ConnectionDiagnostics,
  now: number,
): string[] {
  return diagnostics.outstandingRequests.map(
    (request) =>
      `${request.method} — sent ${formatDuration(now - request.sentAt)} ago`,
  );
}

export function formatLastResponse(
  diagnostics: ConnectionDiagnostics,
  now: number,
): string {
  const last = diagnostics.lastResponse;
  if (!last) return NO_RESPONSE_YET_LABEL;
  return `${last.method} — ${formatDuration(now - last.receivedAt)} ago`;
}

/**
 * The notification stream row. stdio has no HTTP stream at all, so the row
 * says so rather than "Not opened", which would read as a fault.
 */
export function formatNotificationStream(
  stream: NotificationStreamState | undefined,
  transport: ServerType,
  now: number,
): string {
  if (transport === "stdio") return NO_STREAM_ON_STDIO_LABEL;
  if (!stream) return NO_NOTIFICATION_STREAM_LABEL;
  const endpoint = describeStreamEndpoint(stream.url);
  const events = `${stream.eventCount} event${stream.eventCount === 1 ? "" : "s"} delivered`;
  if (stream.closedAt !== undefined) {
    return `${endpoint} — closed ${formatDuration(now - stream.closedAt)} ago after ${formatDuration(stream.closedAt - stream.openedAt)}, ${events}`;
  }
  return `${endpoint} — open for ${formatDuration(now - stream.openedAt)}, ${events}`;
}
