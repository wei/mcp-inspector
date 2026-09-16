/**
 * Request classification for `createSuppressNotificationStreamFetch` (#2317).
 *
 * The wrapper sits on a fetch the SDK uses for more than the MCP endpoint —
 * OAuth metadata discovery shares it — so the cost of a loose predicate is
 * broken auth, not merely a missing stream. These cases pin the match to
 * exactly the standalone SSE `GET`: every other request, including the
 * near-misses (another path, a non-SSE `Accept`, a `Last-Event-ID`
 * resumption), must reach the network. The live-transport half — that the SDK
 * really accepts the synthetic 405 and carries on — is
 * `integration/mcp/suppress-notification-stream.test.ts`.
 */
import { describe, it, expect, vi } from "vitest";
import { createSuppressNotificationStreamFetch } from "@inspector/core/mcp/node/suppressNotificationStreamFetch.js";

const ENDPOINT = "https://example.com/mcp";
const SSE = { accept: "text/event-stream" };

function setup() {
  const baseFetch = vi.fn(async () => new Response("ok", { status: 200 }));
  return {
    baseFetch,
    fetchFn: createSuppressNotificationStreamFetch(
      baseFetch,
      new URL(ENDPOINT),
    ),
  };
}

describe("createSuppressNotificationStreamFetch (#2317)", () => {
  it("answers the standalone SSE GET with a local 405 and never sends it", async () => {
    const { baseFetch, fetchFn } = setup();
    const res = await fetchFn(ENDPOINT, {
      method: "GET",
      headers: new Headers({ accept: "application/json, text/event-stream" }),
    });
    expect(res.status).toBe(405);
    expect(baseFetch).not.toHaveBeenCalled();
  });

  it("matches a URL input and a Request input for the endpoint", async () => {
    const { baseFetch, fetchFn } = setup();
    expect((await fetchFn(new URL(ENDPOINT), { headers: SSE })).status).toBe(
      405,
    );
    expect(
      (await fetchFn(new Request(ENDPOINT, { headers: SSE }))).status,
    ).toBe(405);
    expect(baseFetch).not.toHaveBeenCalled();
  });

  it.each([
    [
      "an OAuth protected-resource metadata GET",
      "https://example.com/.well-known/oauth-protected-resource/mcp",
      { accept: "application/json" },
    ],
    [
      "an authorization-server metadata GET on another origin",
      "https://auth.example.com/.well-known/oauth-authorization-server",
      { accept: "application/json" },
    ],
    ["an SSE GET to another path", "https://example.com/other", SSE],
    ["an SSE GET with a different query", `${ENDPOINT}?x=1`, SSE],
    ["a non-SSE GET to the endpoint", ENDPOINT, { accept: "application/json" }],
    ["a GET to the endpoint with no Accept", ENDPOINT, {}],
    ["an unparseable URL", "not a url", SSE],
  ])("passes %s through", async (_label, url, headers) => {
    const { baseFetch, fetchFn } = setup();
    const init = { method: "GET", headers };
    expect((await fetchFn(url, init)).status).toBe(200);
    expect(baseFetch).toHaveBeenCalledWith(url, init);
  });

  it("passes a resumption GET (Last-Event-ID) through", async () => {
    const { baseFetch, fetchFn } = setup();
    const init = {
      method: "get",
      headers: { ...SSE, "last-event-id": "42" },
    };
    expect((await fetchFn(ENDPOINT, init)).status).toBe(200);
    expect(baseFetch).toHaveBeenCalledWith(ENDPOINT, init);
  });

  it.each(["POST", "DELETE"])("passes %s through", async (method) => {
    const { baseFetch, fetchFn } = setup();
    const init = { method, headers: SSE };
    expect((await fetchFn(ENDPOINT, init)).status).toBe(200);
    expect(baseFetch).toHaveBeenCalledWith(ENDPOINT, init);
  });

  it("reads the method off a Request input", async () => {
    const { baseFetch, fetchFn } = setup();
    const post = new Request(ENDPOINT, {
      method: "POST",
      headers: SSE,
      body: "{}",
    });
    expect((await fetchFn(post)).status).toBe(200);
    expect(baseFetch).toHaveBeenCalledTimes(1);
  });
});
