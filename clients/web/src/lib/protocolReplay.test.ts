import { describe, expect, it, vi } from "vitest";
import type { Tool } from "@modelcontextprotocol/client";
import type { MessageEntry } from "@inspector/core/mcp/types.js";
import {
  messagesToLogEntries,
  replayProtocolRequest,
  replayableParams,
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

// The projection the Edit-and-replay editor seeds from. It is the other half
// of the dispatch switch: replay re-issues through the typed client methods
// rather than re-sending the frame, so anything those signatures have no room
// for is dropped — and an editor that offered it would invite an edit that Send
// silently discards.
describe("replayableParams", () => {
  it("keeps the name and arguments of a tool call, and drops _meta", () => {
    expect(
      replayableParams("tools/call", {
        name: "get_weather",
        arguments: { city: "Boston" },
        _meta: { progressToken: 2 },
      }),
    ).toEqual({
      params: { name: "get_weather", arguments: { city: "Boston" } },
      dropped: ["_meta"],
    });
  });

  it("keeps the name and arguments of a prompt get", () => {
    expect(
      replayableParams("prompts/get", { name: "greet", arguments: { a: 1 } }),
    ).toEqual({
      params: { name: "greet", arguments: { a: 1 } },
      dropped: [],
    });
  });

  it("keeps only the uri of a resource read", () => {
    expect(
      replayableParams("resources/read", { uri: "file:///a", _meta: {} }),
    ).toEqual({ params: { uri: "file:///a" }, dropped: ["_meta"] });
  });

  it("keeps only a string cursor on a list request", () => {
    expect(
      replayableParams("tools/list", { cursor: "abc", _meta: {} }),
    ).toEqual({ params: { cursor: "abc" }, dropped: ["_meta"] });
  });

  // The dispatcher ignores a non-string cursor, so keeping it would put a value
  // in the editor that changes nothing about what is sent.
  it("drops a cursor that is not a string", () => {
    expect(replayableParams("resources/list", { cursor: 7 })).toEqual({
      params: undefined,
      dropped: ["cursor"],
    });
  });

  it("keeps nothing for ping", () => {
    expect(replayableParams("ping", { _meta: {} })).toEqual({
      params: undefined,
      dropped: ["_meta"],
    });
  });

  it("reports no params for a request that carried none", () => {
    expect(replayableParams("tools/list", undefined)).toEqual({
      params: undefined,
      dropped: [],
    });
  });

  // A name only counts as dropped if it was there: an absent `arguments` is not
  // something the user is being told they will lose.
  it("does not report absent names as dropped", () => {
    expect(replayableParams("tools/call", { name: "echo" })).toEqual({
      params: { name: "echo" },
      dropped: [],
    });
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
