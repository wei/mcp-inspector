import { describe, it, expect, vi } from "vitest";
import { createSuppressNotificationStreamFetch } from "@inspector/core/mcp/node/suppressNotificationStreamFetch.js";

const URL_ = "https://example.com/mcp";

function setup() {
  const baseFetch = vi.fn(async () => new Response("ok", { status: 200 }));
  return {
    baseFetch,
    fetchFn: createSuppressNotificationStreamFetch(baseFetch),
  };
}

describe("createSuppressNotificationStreamFetch (#2317)", () => {
  it("answers a standalone GET with a local 405 and never sends it", async () => {
    const { baseFetch, fetchFn } = setup();
    const res = await fetchFn(URL_, {
      method: "GET",
      headers: new Headers({ accept: "text/event-stream" }),
    });
    expect(res.status).toBe(405);
    expect(baseFetch).not.toHaveBeenCalled();
  });

  it("treats a GET with no init at all as the standalone stream", async () => {
    const { baseFetch, fetchFn } = setup();
    expect((await fetchFn(URL_)).status).toBe(405);
    expect(baseFetch).not.toHaveBeenCalled();
  });

  it("reads the method and headers off a Request input", async () => {
    const { baseFetch, fetchFn } = setup();
    expect((await fetchFn(new Request(URL_))).status).toBe(405);
    const resume = new Request(URL_, { headers: { "Last-Event-ID": "7" } });
    expect((await fetchFn(resume)).status).toBe(200);
    const post = new Request(URL_, { method: "POST", body: "{}" });
    expect((await fetchFn(post)).status).toBe(200);
    expect(baseFetch).toHaveBeenCalledTimes(2);
  });

  it("passes a resumption GET (Last-Event-ID) through", async () => {
    const { baseFetch, fetchFn } = setup();
    const init = { method: "get", headers: { "last-event-id": "42" } };
    expect((await fetchFn(URL_, init)).status).toBe(200);
    expect(baseFetch).toHaveBeenCalledWith(URL_, init);
  });

  it.each(["POST", "DELETE"])("passes %s through", async (method) => {
    const { baseFetch, fetchFn } = setup();
    const init = { method };
    expect((await fetchFn(URL_, init)).status).toBe(200);
    expect(baseFetch).toHaveBeenCalledWith(URL_, init);
  });
});
