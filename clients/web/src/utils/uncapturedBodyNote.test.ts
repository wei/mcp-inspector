import { describe, expect, it } from "vitest";
import type { FetchRequestEntry } from "@inspector/core/mcp/types.js";
import {
  isLongLivedStreamEntry,
  uncapturedBodyNote,
} from "./uncapturedBodyNote";

const streamEntry: FetchRequestEntry = {
  id: "n-1",
  timestamp: new Date("2026-03-17T10:00:00Z"),
  method: "GET",
  url: "https://example.com/mcp",
  requestHeaders: {},
  responseStatus: 200,
  responseHeaders: { "content-type": "text/event-stream" },
  category: "transport",
};

describe("isLongLivedStreamEntry", () => {
  it("is true for a GET answered with an event stream and false otherwise", () => {
    expect(isLongLivedStreamEntry(streamEntry)).toBe(true);
    expect(isLongLivedStreamEntry({ ...streamEntry, method: "POST" })).toBe(
      false,
    );
    expect(
      isLongLivedStreamEntry({ ...streamEntry, responseHeaders: undefined }),
    ).toBe(false);
  });
});

describe("uncapturedBodyNote", () => {
  it("says (empty) for a bounded response", () => {
    expect(uncapturedBodyNote({ ...streamEntry, method: "POST" })).toBe(
      "(empty)",
    );
  });

  it("says only that the body was not captured before the stream is watched", () => {
    expect(uncapturedBodyNote(streamEntry)).toBe(
      "Long-lived stream — body not captured",
    );
  });

  it("reports the event count and open state, with the singular for one event", () => {
    expect(
      uncapturedBodyNote({ ...streamEntry, stream: { eventCount: 3 } }),
    ).toBe(
      "Long-lived stream — 3 events delivered, still open; body not captured",
    );
    expect(
      uncapturedBodyNote({
        ...streamEntry,
        stream: { eventCount: 1, closedAt: new Date() },
      }),
    ).toBe("Long-lived stream — 1 event delivered, closed; body not captured");
  });
});
