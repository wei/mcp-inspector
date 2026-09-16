import { describe, it, expect, afterEach } from "vitest";
import { InspectorClient } from "@inspector/core/mcp/inspectorClient.js";
import { createTransportNode } from "@inspector/core/mcp/node/transport.js";
import type { InspectorServerSettings } from "@inspector/core/mcp/types.js";
import {
  createTestServerHttp,
  type TestServerHttp,
  createTestServerInfo,
  createNumberedTools,
} from "@modelcontextprotocol/inspector-test-server";

/**
 * Live coverage of the `suppressNotificationStream` setting (#2317) through
 * the real SDK transport: `createSuppressNotificationStreamFetch` is only
 * useful if the transport really does treat the synthetic 405 as "no
 * standalone stream" and carry on, which a unit test of the wrapper cannot
 * show. The control arm proves the recorder would have seen the GET.
 */
describe("suppressNotificationStream (#2317)", () => {
  let client: InspectorClient | null = null;
  let server: TestServerHttp | null = null;

  afterEach(async () => {
    await client?.disconnect().catch(() => {});
    client = null;
    await server?.stop().catch(() => {});
    server = null;
  });

  function settings(suppress: boolean): InspectorServerSettings {
    return {
      headers: [],
      metadata: {},
      env: [],
      connectionTimeout: 0,
      requestTimeout: 0,
      taskTtl: 60000,
      maxFetchRequests: 1000,
      roots: [],
      ...(suppress && { suppressNotificationStream: true }),
    };
  }

  async function connectRecording(suppress: boolean) {
    server = createTestServerHttp({
      serverInfo: createTestServerInfo("suppress-stream-test", "1.0.0"),
      tools: createNumberedTools(2),
    });
    await server.start();
    const methods: string[] = [];
    const recordingFetch: typeof fetch = (input, init) => {
      methods.push((init?.method ?? "GET").toUpperCase());
      return fetch(input, init);
    };
    client = new InspectorClient(
      { type: "streamable-http", url: server.url },
      {
        environment: { transport: createTransportNode, fetch: recordingFetch },
        serverSettings: settings(suppress),
      },
    );
    await client.connect();
    return { client, methods };
  }

  it("opens the standalone GET stream by default (control)", async () => {
    const { client: connected, methods } = await connectRecording(false);
    await expect.poll(() => methods.includes("GET")).toBe(true);
    expect((await connected.listTools()).tools).toHaveLength(2);
  });

  it("never sends the GET when suppressed, and requests still work", async () => {
    const { client: connected, methods } = await connectRecording(true);
    expect((await connected.listTools()).tools).toHaveLength(2);
    expect(methods).toContain("POST");
    expect(methods).not.toContain("GET");
  });
});
