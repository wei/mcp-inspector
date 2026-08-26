import { describe, expect, it, vi } from "vitest";
import type { Tool } from "@modelcontextprotocol/client";
import type { MessageEntry } from "@inspector/core/mcp/types.js";
import {
  messagesToLogEntries,
  replayProtocolRequest,
  type ReplayClient,
} from "./protocolReplay";

describe("messagesToLogEntries", () => {
  const at = new Date("2026-01-01T00:00:00Z");

  const notification = (
    method: string,
    params: Record<string, unknown>,
  ): MessageEntry => ({
    id: `n-${method}`,
    timestamp: at,
    direction: "notification",
    message: { jsonrpc: "2.0", method, params },
  });

  it("keeps only notifications/message and carries the timestamp", () => {
    const entries = messagesToLogEntries([
      notification("notifications/message", { level: "info", data: "hello" }),
      notification("notifications/progress", { progress: 1 }),
    ]);
    expect(entries).toEqual([
      { receivedAt: at, params: { level: "info", data: "hello" } },
    ]);
  });

  it("skips requests and responses", () => {
    const request: MessageEntry = {
      id: "r-1",
      timestamp: at,
      direction: "request",
      // A request frame carrying the same method — only `direction` should
      // decide, so this must still be skipped.
      message: { jsonrpc: "2.0", id: 1, method: "notifications/message" },
    };
    const response: MessageEntry = {
      id: "r-2",
      timestamp: at,
      direction: "response",
      message: { jsonrpc: "2.0", id: 1, result: {} },
    };
    expect(messagesToLogEntries([request, response])).toEqual([]);
  });

  it("skips a frame labelled a notification that carries no method", () => {
    // `direction` and the frame shape can disagree — the log records what
    // arrived, so the `"method" in message` guard has to hold on its own.
    const malformed: MessageEntry = {
      id: "m-1",
      timestamp: at,
      direction: "notification",
      message: { jsonrpc: "2.0", id: 1, result: {} },
    };
    expect(messagesToLogEntries([malformed])).toEqual([]);
  });
});

describe("replayProtocolRequest", () => {
  const tool: Tool = { name: "echo", inputSchema: { type: "object" } };

  // Typed against `ReplayClient`, so the mock has to satisfy the same contract
  // the function declares rather than being cast into a whole InspectorClient.
  // Each mock is typed against the real method signature, so a drift in
  // `InspectorClient` surfaces here rather than being absorbed by a cast. None
  // of them needs a resolved value: `replayProtocolRequest` awaits the call and
  // discards the result, so what is asserted is the dispatch, not the payload.
  function makeClient() {
    return {
      callTool: vi.fn<ReplayClient["callTool"]>(),
      getPrompt: vi.fn<ReplayClient["getPrompt"]>(),
      readResource: vi.fn<ReplayClient["readResource"]>(),
      listTools: vi.fn<ReplayClient["listTools"]>(),
      listPrompts: vi.fn<ReplayClient["listPrompts"]>(),
      listResources: vi.fn<ReplayClient["listResources"]>(),
      listResourceTemplates: vi.fn<ReplayClient["listResourceTemplates"]>(),
      listRequestorTasks: vi.fn<ReplayClient["listRequestorTasks"]>(),
      ping: vi.fn<ReplayClient["ping"]>(),
    } satisfies ReplayClient;
  }

  const replay = (
    client: ReturnType<typeof makeClient>,
    method: string,
    params?: Record<string, unknown>,
    tools: Tool[] = [tool],
  ) => replayProtocolRequest(client, method, params, tools);

  it("refuses a method outside the shared replayable set", async () => {
    const client = makeClient();
    await expect(replay(client, "initialize")).resolves.toBe(
      'Replay isn\'t supported for "initialize".',
    );
  });

  it("replays tools/call with the recorded arguments", async () => {
    const client = makeClient();
    await expect(
      replay(client, "tools/call", { name: "echo", arguments: { a: 1 } }),
    ).resolves.toBeNull();
    expect(client.callTool).toHaveBeenCalledWith(tool, { a: 1 });
  });

  it("defaults tools/call arguments to an empty object", async () => {
    const client = makeClient();
    await expect(
      replay(client, "tools/call", { name: "echo" }),
    ).resolves.toBeNull();
    expect(client.callTool).toHaveBeenCalledWith(tool, {});
  });

  it("explains when the tool is gone, and when the name is missing", async () => {
    const client = makeClient();
    await expect(
      replay(client, "tools/call", { name: "vanished" }),
    ).resolves.toBe('Tool "vanished" is no longer available to replay.');
    await expect(replay(client, "tools/call", {})).resolves.toBe(
      'Tool "?" is no longer available to replay.',
    );
    expect(client.callTool).not.toHaveBeenCalled();
  });

  it("replays prompts/get, and explains a missing name", async () => {
    const client = makeClient();
    await expect(
      replay(client, "prompts/get", { name: "p", arguments: { x: 1 } }),
    ).resolves.toBeNull();
    expect(client.getPrompt).toHaveBeenCalledWith("p", { x: 1 });

    await expect(
      replay(client, "prompts/get", { name: "p" }),
    ).resolves.toBeNull();
    expect(client.getPrompt).toHaveBeenLastCalledWith("p", {});

    await expect(replay(client, "prompts/get", {})).resolves.toBe(
      "Prompt name is missing; cannot replay.",
    );
  });

  it("replays resources/read, and explains a missing uri", async () => {
    const client = makeClient();
    await expect(
      replay(client, "resources/read", { uri: "file:///a" }),
    ).resolves.toBeNull();
    expect(client.readResource).toHaveBeenCalledWith("file:///a");

    await expect(replay(client, "resources/read", {})).resolves.toBe(
      "Resource URI is missing; cannot replay.",
    );
  });

  it.each([
    ["tools/list", "listTools"],
    ["prompts/list", "listPrompts"],
    ["resources/list", "listResources"],
    ["resources/templates/list", "listResourceTemplates"],
    ["tasks/list", "listRequestorTasks"],
  ] as const)("replays %s on the recorded page", async (method, fn) => {
    const client = makeClient();
    await expect(
      replay(client, method, { cursor: "page-2" }),
    ).resolves.toBeNull();
    expect(client[fn]).toHaveBeenCalledWith("page-2");
  });

  it("passes no cursor when the entry carried none, or carried a non-string", async () => {
    const client = makeClient();
    await expect(replay(client, "tools/list", undefined)).resolves.toBeNull();
    expect(client.listTools).toHaveBeenCalledWith(undefined);

    await expect(
      replay(client, "tools/list", { cursor: 7 }),
    ).resolves.toBeNull();
    expect(client.listTools).toHaveBeenLastCalledWith(undefined);
  });

  it("replays ping", async () => {
    const client = makeClient();
    await expect(replay(client, "ping")).resolves.toBeNull();
    expect(client.ping).toHaveBeenCalled();
  });
});
