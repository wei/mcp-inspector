import { describe, expect, it, vi } from "vitest";
import type { Tool } from "@modelcontextprotocol/client";
import type { InspectorClient } from "@inspector/core/mcp/index.js";
import type { MessageEntry } from "@inspector/core/mcp/types.js";
import { messagesToLogEntries, replayProtocolRequest } from "./protocolReplay";

describe("messagesToLogEntries", () => {
  const notification = (method: string, params: unknown): MessageEntry =>
    ({
      direction: "notification",
      timestamp: 1000,
      message: { jsonrpc: "2.0", method, params },
    }) as unknown as MessageEntry;

  it("keeps only notifications/message and carries the timestamp", () => {
    const entries = messagesToLogEntries([
      notification("notifications/message", { level: "info", data: "hello" }),
      notification("notifications/progress", { progress: 1 }),
    ]);
    expect(entries).toEqual([
      { receivedAt: 1000, params: { level: "info", data: "hello" } },
    ]);
  });

  it("skips requests and responses", () => {
    const request = {
      direction: "request",
      timestamp: 1,
      message: { jsonrpc: "2.0", id: 1, method: "notifications/message" },
    } as unknown as MessageEntry;
    const response = {
      direction: "response",
      timestamp: 2,
      message: { jsonrpc: "2.0", id: 1, result: {} },
    } as unknown as MessageEntry;
    expect(messagesToLogEntries([request, response])).toEqual([]);
  });

  it("skips a notification carrying no method", () => {
    const malformed = {
      direction: "notification",
      timestamp: 3,
      message: { jsonrpc: "2.0", result: {} },
    } as unknown as MessageEntry;
    expect(messagesToLogEntries([malformed])).toEqual([]);
  });
});

describe("replayProtocolRequest", () => {
  const tool = { name: "echo", inputSchema: { type: "object" } } as Tool;

  function makeClient() {
    return {
      callTool: vi.fn().mockResolvedValue({}),
      getPrompt: vi.fn().mockResolvedValue({}),
      readResource: vi.fn().mockResolvedValue({}),
      listTools: vi.fn().mockResolvedValue({}),
      listPrompts: vi.fn().mockResolvedValue({}),
      listResources: vi.fn().mockResolvedValue({}),
      listResourceTemplates: vi.fn().mockResolvedValue({}),
      listRequestorTasks: vi.fn().mockResolvedValue({}),
      ping: vi.fn().mockResolvedValue({}),
    };
  }

  const replay = (
    client: ReturnType<typeof makeClient>,
    method: string,
    params?: Record<string, unknown>,
    tools: Tool[] = [tool],
  ) =>
    replayProtocolRequest(
      client as unknown as InspectorClient,
      method,
      params,
      tools,
    );

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

  it("passes no cursor when the entry carried none", async () => {
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
