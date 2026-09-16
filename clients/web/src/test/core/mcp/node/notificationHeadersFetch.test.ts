import { describe, it, expect, vi } from "vitest";
import { PROTOCOL_VERSION_META_KEY } from "@modelcontextprotocol/client";
import { createNotificationHeadersFetch } from "@inspector/core/mcp/node/notificationHeadersFetch.js";
import { MODERN_PROTOCOL_VERSION } from "@inspector/core/mcp/types.js";

const URL_ = "https://example.com/mcp";

function cancelled(version: string | undefined): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    method: "notifications/cancelled",
    params: {
      requestId: 7,
      ...(version !== undefined && {
        _meta: { [PROTOCOL_VERSION_META_KEY]: version },
      }),
    },
  };
}

/** Run one call through the wrapper; return the init the base fetch saw. */
async function send(init: RequestInit | undefined): Promise<RequestInit> {
  const baseFetch = vi.fn<typeof fetch>(
    async () => new Response(null, { status: 202 }),
  );
  await createNotificationHeadersFetch(baseFetch)(URL_, init);
  expect(baseFetch).toHaveBeenCalledTimes(1);
  return baseFetch.mock.calls[0]![1] ?? {};
}

function post(body: unknown, headers?: HeadersInit): RequestInit {
  return {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers,
  };
}

describe("createNotificationHeadersFetch", () => {
  it("stamps Mcp-Method and MCP-Protocol-Version on a modern notification", async () => {
    const seen = await send(
      post(cancelled(MODERN_PROTOCOL_VERSION), {
        "content-type": "application/json",
        "mcp-session-id": "abc",
      }),
    );
    const headers = new Headers(seen.headers);
    expect(headers.get("mcp-method")).toBe("notifications/cancelled");
    expect(headers.get("mcp-protocol-version")).toBe(MODERN_PROTOCOL_VERSION);
    // Existing headers and the body survive.
    expect(headers.get("mcp-session-id")).toBe("abc");
    expect(headers.get("content-type")).toBe("application/json");
    expect(seen.body).toBe(JSON.stringify(cancelled(MODERN_PROTOCOL_VERSION)));
    expect(headers.has("mcp-name")).toBe(false);
  });

  it("accepts a Headers instance and a lowercase method", async () => {
    const init = post(
      cancelled(MODERN_PROTOCOL_VERSION),
      new Headers({ accept: "application/json" }),
    );
    const seen = await send({ ...init, method: "post" });
    const headers = new Headers(seen.headers);
    expect(headers.get("mcp-method")).toBe("notifications/cancelled");
    expect(headers.get("accept")).toBe("application/json");
  });

  it("stamps a revision later than 2026-07-28 too", async () => {
    const seen = await send(post(cancelled("2027-01-01")));
    expect(new Headers(seen.headers).get("mcp-protocol-version")).toBe(
      "2027-01-01",
    );
  });

  const untouched: [string, RequestInit | undefined][] = [
    ["no init", undefined],
    ["a GET", { method: "GET" }],
    [
      "a POST with no method",
      { body: JSON.stringify(cancelled("2026-07-28")) },
    ],
    ["a non-string body", { method: "POST", body: new Blob(["{}"]) }],
    ["a non-JSON body", post("not json")],
    ["a JSON non-object body", post([cancelled(MODERN_PROTOCOL_VERSION)])],
    ["a null body", post("null")],
    [
      "a request (has an id)",
      post({ ...cancelled(MODERN_PROTOCOL_VERSION), id: 1 }),
    ],
    ["a response (no method)", post({ jsonrpc: "2.0", result: {} })],
    [
      "a non-string method",
      post({ ...cancelled(MODERN_PROTOCOL_VERSION), method: 5 }),
    ],
    ["a legacy-era notification", post(cancelled("2025-11-25"))],
    ["an unclaimed notification", post(cancelled(undefined))],
    [
      "a notification with no params",
      post({ jsonrpc: "2.0", method: "notifications/initialized" }),
    ],
    [
      "a notification whose _meta is not an object",
      post({ jsonrpc: "2.0", method: "x", params: { _meta: "nope" } }),
    ],
    [
      "a non-string protocol version claim",
      post({
        jsonrpc: "2.0",
        method: "x",
        params: { _meta: { [PROTOCOL_VERSION_META_KEY]: 20260728 } },
      }),
    ],
  ];

  it.each(untouched)("passes %s through untouched", async (_label, init) => {
    const seen = await send(init);
    expect(seen).toEqual(init ?? {});
    expect(new Headers(seen.headers).has("mcp-method")).toBe(false);
  });
});
