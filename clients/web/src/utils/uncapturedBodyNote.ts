// The Network entry's body placeholder for a response whose body was not
// captured (#2318). Pure: a string from the entry alone.

import { isLongLivedStreamResponse } from "@inspector/core/mcp/fetchTracking.js";
import type { FetchRequestEntry } from "@inspector/core/mcp/types.js";

/** Whether the entry is an unbounded server-to-client stream (never buffered). */
export function isLongLivedStreamEntry(entry: FetchRequestEntry): boolean {
  return isLongLivedStreamResponse(
    entry.method,
    entry.responseHeaders?.["content-type"],
  );
}

/**
 * What stands in for a body that was not captured. A long-lived stream is
 * never buffered, so its placeholder reports what the tracker learned by
 * watching it: how many events it delivered and whether it is still open.
 * Before the first update, or for a log restored from a session that
 * predates the field, the note says only that the body was not captured.
 */
export function uncapturedBodyNote(entry: FetchRequestEntry): string {
  if (!isLongLivedStreamEntry(entry)) return "(empty)";
  const stream = entry.stream;
  if (!stream) return "Long-lived stream — body not captured";
  const events = `${stream.eventCount} event${stream.eventCount === 1 ? "" : "s"} delivered`;
  const state = stream.closedAt ? "closed" : "still open";
  return `Long-lived stream — ${events}, ${state}; body not captured`;
}
