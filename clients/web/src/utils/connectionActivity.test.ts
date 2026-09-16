import { describe, expect, it } from "vitest";
import {
  formatLastResponse,
  formatNotificationStream,
  formatOutstandingRequests,
  NO_NOTIFICATION_STREAM_LABEL,
  NO_RESPONSE_YET_LABEL,
  NO_STREAM_ON_STDIO_LABEL,
} from "./connectionActivity";

const NOW = 1_000_000;
const seconds = (n: number) => n * 1000;

describe("formatOutstandingRequests", () => {
  it("renders one line per request, oldest first, against the given clock", () => {
    expect(
      formatOutstandingRequests(
        {
          capturedAt: NOW,
          outstandingRequests: [
            { id: 1, method: "tools/list", sentAt: NOW - seconds(60) },
            { id: 2, method: "ping", sentAt: NOW - seconds(12) },
          ],
        },
        NOW,
      ),
    ).toEqual(["tools/list — sent 1m00s ago", "ping — sent 12s ago"]);
  });

  it("renders nothing when nothing is outstanding", () => {
    expect(
      formatOutstandingRequests(
        { capturedAt: NOW, outstandingRequests: [] },
        NOW,
      ),
    ).toEqual([]);
  });
});

describe("formatLastResponse", () => {
  it("names the method and the age", () => {
    expect(
      formatLastResponse(
        {
          capturedAt: NOW,
          outstandingRequests: [],
          lastResponse: { method: "initialize", receivedAt: NOW - 500 },
        },
        NOW,
      ),
    ).toBe("initialize — 500ms ago");
  });

  it("says none yet before any response", () => {
    expect(
      formatLastResponse({ capturedAt: NOW, outstandingRequests: [] }, NOW),
    ).toBe(NO_RESPONSE_YET_LABEL);
  });
});

describe("the clock argument", () => {
  it("moves every duration with it, so a ticking caller renders live values", () => {
    const diagnostics = {
      capturedAt: NOW,
      outstandingRequests: [
        { id: 1, method: "tools/list", sentAt: NOW - seconds(5) },
      ],
      lastResponse: { method: "initialize", receivedAt: NOW - seconds(6) },
    };
    expect(formatOutstandingRequests(diagnostics, NOW + seconds(55))).toEqual([
      "tools/list — sent 1m00s ago",
    ]);
    expect(formatLastResponse(diagnostics, NOW + seconds(55))).toBe(
      "initialize — 1m01s ago",
    );
  });
});

describe("formatNotificationStream", () => {
  const open = {
    url: "http://h/mcp",
    openedAt: NOW - seconds(252),
    eventCount: 1,
  };

  it("is not applicable on stdio, whatever the snapshot says", () => {
    expect(formatNotificationStream(open, "stdio", NOW)).toBe(
      NO_STREAM_ON_STDIO_LABEL,
    );
  });

  it("says not opened when no stream has been tracked", () => {
    expect(formatNotificationStream(undefined, "sse", NOW)).toBe(
      NO_NOTIFICATION_STREAM_LABEL,
    );
  });

  it("describes an open stream by endpoint, age and event count", () => {
    expect(formatNotificationStream(open, "streamable-http", NOW)).toBe(
      "GET /mcp — open for 4m12s, 1 event delivered",
    );
  });

  it("describes a closed stream by when it closed and how long it lasted", () => {
    expect(
      formatNotificationStream(
        { ...open, eventCount: 2, closedAt: NOW - seconds(5) },
        "streamable-http",
        NOW,
      ),
    ).toBe("GET /mcp — closed 5s ago after 4m07s, 2 events delivered");
  });
});
