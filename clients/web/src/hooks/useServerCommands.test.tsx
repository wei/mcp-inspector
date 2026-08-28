import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ReactElement } from "react";
import {
  UrlElicitationRequiredError,
  type ServerCapabilities,
  type Tool,
} from "@modelcontextprotocol/client";
import { InspectorClient } from "@inspector/core/mcp/index.js";
import type {
  InspectorServerSettings,
  ServerEntry,
} from "@inspector/core/mcp/types.js";
import { UrlElicitationLoopError } from "@inspector/core/mcp/urlElicitation.js";
import { ToolCallCancelledError } from "@inspector/core/mcp/toolCallCancelledError.js";
import { AuthRecoveryRequiredError } from "@inspector/core/auth/challenge.js";
import { ServerListReloadError } from "@inspector/core/react/useServers.js";
import { renderWithMantine, act, waitFor } from "../test/renderWithMantine";
import { EMPTY_SETTINGS } from "../utils/serverSettingsDefaults";
import { useSessionRef } from "./useSessionRef";
import type { PaginatedListModel } from "./usePaginatedList";
import {
  useResultPanels,
  useServerCommands,
  type ResultPanels,
  type ServerCommands,
} from "./useServerCommands";
import type { ToolsUiState } from "../components/screens/ToolsScreen/ToolsScreen";

// --- Module doubles ---------------------------------------------------------
// Only the toast layer, which every failure path reaches. The client is a bare
// prototype object (below) rather than a mocked module: these commands exist to
// translate a screen's arguments into client calls, so a mocked client module
// would leave that translation unverified.

const { notificationsMock } = vi.hoisted(() => ({
  notificationsMock: { show: vi.fn(), update: vi.fn(), hide: vi.fn() },
}));
vi.mock("@mantine/notifications", () => ({ notifications: notificationsMock }));

// --- Fixtures ---------------------------------------------------------------

/**
 * `Object.create` does not run the constructor, so this is a real
 * `InspectorClient` prototype chain with no transport behind it — enough for a
 * hook that only calls the methods stubbed here.
 */
const client = (over: Record<string, unknown> = {}): InspectorClient =>
  Object.assign(Object.create(InspectorClient.prototype), {
    isTasksExtensionNegotiated: () => false,
    callTool: vi.fn().mockResolvedValue({ success: true, result: {} }),
    callToolStream: vi.fn().mockResolvedValue({ success: true, result: {} }),
    cancelToolCall: vi.fn(),
    cancelRequestorTask: vi.fn().mockResolvedValue(undefined),
    getPrompt: vi.fn().mockResolvedValue({ result: { messages: [] } }),
    readResource: vi
      .fn()
      .mockResolvedValue({ result: { contents: [] }, timestamp: 1 }),
    subscribeToResource: vi.fn().mockResolvedValue(undefined),
    unsubscribeFromResource: vi.fn().mockResolvedValue(undefined),
    getCompletions: vi.fn().mockResolvedValue({ values: ["a"] }),
    setLoggingLevel: vi.fn().mockResolvedValue(undefined),
    setModernLogLevel: vi.fn(),
    setServerSettings: vi.fn(),
    ...over,
  }) as InspectorClient;

/** The empty Tools-tab UI state a change is built from. */
const EMPTY_TOOLS_UI: ToolsUiState = {
  formValues: {},
  search: "",
  runAsTask: false,
};

const tool = (name: string, over: Partial<Tool> = {}): Tool => ({
  name,
  inputSchema: { type: "object" },
  ...over,
});

const entry = (id: string, over: Partial<ServerEntry> = {}): ServerEntry => ({
  id,
  name: `Server ${id}`,
  config: { type: "streamable-http", url: "https://mcp.example/mcp" },
  connection: { status: "disconnected" },
  ...over,
});

/** Capabilities that advertise legacy task tool calls. */
const taskCapabilities: ServerCapabilities = {
  tasks: { requests: { tools: { call: {} } } },
};

/** A promise a test can settle after the session has moved on. */
function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (err: unknown) => void;
} {
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const authError = () =>
  new AuthRecoveryRequiredError(new URL("https://auth.example/authorize"), {
    reason: "unauthorized",
  });

function pagination<T>(
  over: Partial<PaginatedListModel<T>> = {},
): PaginatedListModel<T> {
  return {
    items: [],
    paginated: false,
    canLoadMore: false,
    loadedPages: 1,
    error: null,
    onRefresh: vi.fn().mockResolvedValue(undefined),
    onLoadMore: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
}

interface HarnessProps {
  servers?: ServerEntry[];
  activeServerId?: string;
  activeServer?: ServerEntry;
  client?: InspectorClient | null;
  connected?: boolean;
  capabilities?: ServerCapabilities;
  tools?: Tool[];
  selectedToolKey?: string;
  paginatedLists?: boolean;
  persisted?: Record<string, InspectorServerSettings | undefined>;
  updateServerSettingsImpl?: (
    id: string,
    settings: InspectorServerSettings,
  ) => Promise<void>;
  /** Overrides for the four recovery wrappers `useOAuthRecovery` publishes. */
  recovery?: {
    handleCommandScopedAuthRecovery?: (...args: never[]) => Promise<boolean>;
  };
}

function spies() {
  const landed = vi.fn().mockReturnValue(true);
  const failed = vi.fn();
  return {
    landed,
    failed,
    begin: vi.fn(() => ({ landed, failed })),
    resolveSettings: vi.fn(),
    lastWriteFailed: vi.fn().mockReturnValue(false),
    setToolsUi: vi.fn(),
    setUrlElicitationErrorDetails: vi.fn(),
    setCurrentLogLevel: vi.fn(),
    setModernLogLevel: vi.fn(),
    clearCompletedTasks: vi.fn(),
    refreshTasks: vi.fn().mockResolvedValue(undefined),
    refreshTools: vi.fn().mockResolvedValue(undefined),
    refreshPrompts: vi.fn().mockResolvedValue(undefined),
    refreshResources: vi.fn().mockResolvedValue(undefined),
    refreshResourceTemplates: vi.fn().mockResolvedValue(undefined),
    clearToolsListChanged: vi.fn(),
    clearPromptsListChanged: vi.fn(),
    clearResourcesListChanged: vi.fn(),
    loadToolsPage: vi.fn().mockResolvedValue(undefined),
    loadPromptsPage: vi.fn().mockResolvedValue(undefined),
    loadResourcesPage: vi.fn().mockResolvedValue(undefined),
    record: vi.fn(),
    valueFor: vi.fn(),
    applyLiveServerSettings: vi.fn(),
    updateServerSettings: vi.fn().mockResolvedValue(undefined),
    refreshInitialConfig: vi.fn(),
    handleCommandScopedAuthRecovery: vi.fn().mockResolvedValue(false),
    runCommandInBackgroundErrors: [] as unknown[],
  };
}

type Spies = ReturnType<typeof spies>;

interface Harness {
  api: () => ServerCommands;
  /** The in-flight call's task id, written by App's task-toast listener. */
  taskIdRef: { current: string | undefined };
  panels: () => ResultPanels;
  rerender: (next: HarnessProps) => void;
  spies: Spies;
  toolsPagination: PaginatedListModel<Tool>;
  promptsPagination: PaginatedListModel<unknown>;
  resourcesPagination: PaginatedListModel<unknown>;
}

function harness(initial: HarnessProps = {}): Harness {
  let latest: ServerCommands | undefined;
  let latestPanels: ResultPanels | undefined;
  const s = spies();
  const toolsPagination = pagination<Tool>();
  const promptsPagination = pagination<unknown>();
  const resourcesPagination = pagination<unknown>();
  const activeToolCallTaskIdRef: { current: string | undefined } = {
    current: undefined,
  };

  /**
   * The real wrappers are thin: `runWithCommandAuthRecovery` awaits the
   * operation and retries once through the recovery, and
   * `runCommandInBackground` is its fire-and-forget form. Reproducing that
   * shape here (rather than stubbing them as pass-throughs) is what makes the
   * commands' own auth branches reachable.
   */
  function Probe({ p }: { p: HarnessProps }) {
    const servers = p.servers ?? [];
    const sessionRef = useSessionRef({
      activeServerId: p.activeServerId,
      servers,
      inspectorClient: p.client ?? null,
    });
    const panels = useResultPanels();
    latestPanels = panels;
    const handleCommandScopedAuthRecovery =
      (p.recovery?.handleCommandScopedAuthRecovery as
        | typeof s.handleCommandScopedAuthRecovery
        | undefined) ?? s.handleCommandScopedAuthRecovery;
    const runWithCommandAuthRecovery = async <T,>(
      operation: () => Promise<T>,
    ): Promise<T | undefined> => operation();
    latest = useServerCommands({
      sessionRef,
      servers,
      activeServerId: p.activeServerId,
      activeServer: p.activeServer,
      inspectorClient: p.client ?? null,
      connected: p.connected ?? false,
      capabilities: p.capabilities,
      tools: p.tools ?? [],
      panels,
      selectedToolKey: p.selectedToolKey,
      setToolsUi: s.setToolsUi,
      setUrlElicitationErrorDetails: s.setUrlElicitationErrorDetails,
      setCurrentLogLevel: s.setCurrentLogLevel,
      setModernLogLevel: s.setModernLogLevel,
      activeToolCallTaskIdRef,
      clearCompletedTasks: s.clearCompletedTasks,
      refreshTasks: s.refreshTasks,
      paginatedLists: p.paginatedLists ?? false,
      paginatedListsOverride: { record: s.record, valueFor: s.valueFor },
      toolsPagination,
      promptsPagination,
      resourcesPagination,
      refreshTools: s.refreshTools,
      refreshPrompts: s.refreshPrompts,
      refreshResources: s.refreshResources,
      refreshResourceTemplates: s.refreshResourceTemplates,
      clearToolsListChanged: s.clearToolsListChanged,
      clearPromptsListChanged: s.clearPromptsListChanged,
      clearResourcesListChanged: s.clearResourcesListChanged,
      loadToolsPage: s.loadToolsPage,
      loadPromptsPage: s.loadPromptsPage,
      loadResourcesPage: s.loadResourcesPage,
      lastPersistedSettings: {
        begin: s.begin,
        resolve: (id: string) => p.persisted?.[id] ?? s.resolveSettings(id),
        lastWriteFailed: s.lastWriteFailed,
      },
      applyLiveServerSettings: s.applyLiveServerSettings,
      updateServerSettings:
        p.updateServerSettingsImpl ?? s.updateServerSettings,
      refreshInitialConfig: s.refreshInitialConfig,
      handleCommandScopedAuthRecovery,
      runWithCommandAuthRecovery,
      runCommandInBackground: (operation, _source, errorTitle) => {
        void operation().catch((err: unknown) => {
          s.runCommandInBackgroundErrors.push(err);
          if (errorTitle) {
            notificationsMock.show({ title: errorTitle });
          }
        });
      },
    });
    return null;
  }

  const view = renderWithMantine(<Probe p={initial} />);
  return {
    api: () => {
      if (!latest) throw new Error("hook did not render");
      return latest;
    },
    panels: () => {
      if (!latestPanels) throw new Error("hook did not render");
      return latestPanels;
    },
    rerender: (next) => view.rerender(<Probe p={next} />),
    taskIdRef: activeToolCallTaskIdRef,
    spies: s,
    toolsPagination,
    promptsPagination,
    resourcesPagination,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useResultPanels", () => {
  it("starts with every panel empty and clears them all", async () => {
    const h = harness();
    expect(h.panels().toolCallState).toBeUndefined();
    expect(h.panels().getPromptState).toBeUndefined();
    expect(h.panels().readResourceState).toBeUndefined();

    await act(async () => {
      h.panels().setToolCallState({ status: "pending" });
      h.panels().setGetPromptState({ status: "pending", promptName: "p" });
      h.panels().setReadResourceState({ status: "pending", uri: "u" });
    });
    expect(h.panels().toolCallState).toEqual({ status: "pending" });

    await act(async () => h.panels().clearResultPanels());
    expect(h.panels().toolCallState).toBeUndefined();
    expect(h.panels().getPromptState).toBeUndefined();
    expect(h.panels().readResourceState).toBeUndefined();
  });

  it("routes a step-up error to the panel that issued the command", async () => {
    const h = harness();
    await act(async () => {
      h.panels().setGetPromptState({ status: "pending", promptName: "p" });
      h.panels().setReadResourceState({ status: "pending", uri: "u" });
    });

    await act(async () => h.panels().setSourceScopedError("tool", "nope"));
    expect(h.panels().toolCallState).toEqual({
      status: "error",
      error: "nope",
    });

    await act(async () => h.panels().setSourceScopedError("prompt", "nope"));
    expect(h.panels().getPromptState).toMatchObject({
      status: "error",
      error: "nope",
      promptName: "p",
    });

    await act(async () => h.panels().setSourceScopedError("resource", "nope"));
    expect(h.panels().readResourceState).toMatchObject({
      status: "error",
      error: "nope",
      uri: "u",
    });
  });

  it("leaves a prompt/resource panel alone when it holds nothing", async () => {
    const h = harness();
    await act(async () => {
      h.panels().setSourceScopedError("prompt", "nope");
      h.panels().setSourceScopedError("resource", "nope");
    });
    expect(h.panels().getPromptState).toBeUndefined();
    expect(h.panels().readResourceState).toBeUndefined();
  });

  it("is a no-op for the sources with no panel of their own", async () => {
    const h = harness();
    await act(async () => {
      h.panels().setSourceScopedError("app", "nope");
      h.panels().setSourceScopedError("ambient", "nope");
    });
    expect(h.panels().toolCallState).toBeUndefined();
    expect(h.panels().getPromptState).toBeUndefined();
    expect(h.panels().readResourceState).toBeUndefined();
  });
});

describe("onCallTool", () => {
  it("does nothing without a client", async () => {
    const h = harness({ tools: [tool("echo")] });
    await act(async () => h.api().onCallTool("echo", {}));
    expect(h.panels().toolCallState).toBeUndefined();
  });

  it("does nothing when the named tool is not in the list", async () => {
    const c = client();
    const h = harness({ client: c, tools: [tool("echo")] });
    await act(async () => h.api().onCallTool("missing", {}));
    expect(c.callTool).not.toHaveBeenCalled();
    expect(h.panels().toolCallState).toBeUndefined();
  });

  it("calls the tool and reports the result", async () => {
    const c = client({
      callTool: vi.fn().mockResolvedValue({ success: true, result: { ok: 1 } }),
    });
    const h = harness({ client: c, tools: [tool("echo")] });
    await act(async () => h.api().onCallTool("echo", { a: 1 }));
    expect(c.callTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: "echo" }),
      { a: 1 },
    );
    expect(h.panels().toolCallState).toEqual({
      status: "ok",
      result: { ok: 1 },
      error: undefined,
    });
  });

  it("reports an unsuccessful invocation as an error panel", async () => {
    const c = client({
      callTool: vi
        .fn()
        .mockResolvedValue({ success: false, result: null, error: "boom" }),
    });
    const h = harness({ client: c, tools: [tool("echo")] });
    await act(async () => h.api().onCallTool("echo", {}));
    expect(h.panels().toolCallState).toEqual({
      status: "error",
      result: undefined,
      error: "boom",
    });
  });

  it("routes through the task pipeline when asked and the server allows it", async () => {
    const c = client();
    const h = harness({
      client: c,
      tools: [tool("echo")],
      capabilities: taskCapabilities,
      activeServer: entry("a", {
        settings: { ...EMPTY_SETTINGS, taskTtl: 42 },
      }),
    });
    await act(async () => h.api().onCallTool("echo", {}, true));
    expect(c.callToolStream).toHaveBeenCalledWith(
      expect.objectContaining({ name: "echo" }),
      {},
      undefined,
      undefined,
      { ttl: 42 },
    );
    expect(c.callTool).not.toHaveBeenCalled();
  });

  it("task-routes a tool whose execution requires it", async () => {
    const c = client();
    const h = harness({
      client: c,
      tools: [tool("echo", { execution: { taskSupport: "required" } })],
      capabilities: taskCapabilities,
    });
    await act(async () => h.api().onCallTool("echo", {}));
    expect(c.callToolStream).toHaveBeenCalled();
  });

  it("task-routes when the modern tasks extension is negotiated", async () => {
    const c = client({ isTasksExtensionNegotiated: () => true });
    const h = harness({ client: c, tools: [tool("echo")] });
    await act(async () => h.api().onCallTool("echo", {}, true));
    expect(c.callToolStream).toHaveBeenCalled();
  });

  it("does not task-route when the server advertises no task tool calls", async () => {
    const c = client();
    const h = harness({ client: c, tools: [tool("echo")] });
    await act(async () => h.api().onCallTool("echo", {}, true));
    expect(c.callTool).toHaveBeenCalled();
    expect(c.callToolStream).not.toHaveBeenCalled();
  });

  it("falls back to the default TTL when the server carries none", async () => {
    const c = client();
    const h = harness({
      client: c,
      tools: [tool("echo")],
      capabilities: taskCapabilities,
    });
    await act(async () => h.api().onCallTool("echo", {}, true));
    const call = vi.mocked(c.callToolStream).mock.calls[0];
    expect(call?.[4]).toEqual({ ttl: expect.any(Number) });
  });

  it("clears the panel and recovers on a lapsed authorization", async () => {
    const recover = vi.fn().mockResolvedValue(true);
    const c = client({ callTool: vi.fn().mockRejectedValue(authError()) });
    const h = harness({
      client: c,
      tools: [tool("echo")],
      activeServerId: "a",
      recovery: { handleCommandScopedAuthRecovery: recover },
    });
    await act(async () => h.api().onCallTool("echo", {}));
    expect(recover).toHaveBeenCalledWith(
      expect.any(AuthRecoveryRequiredError),
      { serverId: "a", source: "tool" },
    );
    expect(h.panels().toolCallState).toBeUndefined();
  });

  it("skips the recovery when no server is active", async () => {
    const recover = vi.fn().mockResolvedValue(true);
    const c = client({ callTool: vi.fn().mockRejectedValue(authError()) });
    const h = harness({
      client: c,
      tools: [tool("echo")],
      recovery: { handleCommandScopedAuthRecovery: recover },
    });
    await act(async () => h.api().onCallTool("echo", {}));
    expect(recover).not.toHaveBeenCalled();
    expect(h.panels().toolCallState).toBeUndefined();
  });

  it("clears the panel and toasts on an explicit cancellation", async () => {
    const c = client({
      callTool: vi.fn().mockRejectedValue(new ToolCallCancelledError("gone")),
    });
    const h = harness({ client: c, tools: [tool("echo")] });
    await act(async () => h.api().onCallTool("echo", {}));
    expect(h.panels().toolCallState).toBeUndefined();
    expect(notificationsMock.show).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Tool call cancelled" }),
    );
  });

  it("surfaces a URL elicitation loop as its own error", async () => {
    const c = client({
      callTool: vi
        .fn()
        .mockRejectedValue(
          new UrlElicitationLoopError("https://example/looped"),
        ),
    });
    const h = harness({ client: c, tools: [tool("echo")] });
    await act(async () => h.api().onCallTool("echo", {}));
    expect(h.panels().toolCallState).toMatchObject({
      status: "error",
      error: expect.stringContaining("looped"),
    });
    expect(notificationsMock.show).toHaveBeenCalledWith(
      expect.objectContaining({ title: "URL elicitation loop" }),
    );
  });

  it("surfaces a URLElicitationRequired carrying no elicitations", async () => {
    // The non-spec shape: -32042 with an empty elicitation list, so there is no
    // URL to open and the panel gets a toast linking to the raw error instead.
    const c = client({
      callTool: vi.fn().mockRejectedValue(new UrlElicitationRequiredError([])),
    });
    const h = harness({ client: c, tools: [tool("echo")] });
    await act(async () => h.api().onCallTool("echo", {}));
    expect(h.panels().toolCallState).toMatchObject({ status: "error" });
    const shown = notificationsMock.show.mock.calls.at(-1)?.[0] as {
      title: string;
      message: ReactElement<{ onViewDetails: () => void }>;
    };
    expect(shown.title).toBe("URL elicitation required");
    // The toast's link is what opens the raw-error modal; the details name the
    // tool that failed rather than the message the panel already shows.
    act(() => shown.message.props.onViewDetails());
    expect(h.spies.setUrlElicitationErrorDetails).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "echo" }),
    );
  });

  it("reports any other failure with its code", async () => {
    const err = Object.assign(new Error("bad"), { code: -32603 });
    const c = client({ callTool: vi.fn().mockRejectedValue(err) });
    const h = harness({ client: c, tools: [tool("echo")] });
    await act(async () => h.api().onCallTool("echo", {}));
    expect(h.panels().toolCallState).toMatchObject({
      status: "error",
      error: "bad",
      errorCode: -32603,
    });
  });
});

describe("the tools panel writers", () => {
  it("onClearToolResult drops the result", async () => {
    const h = harness();
    await act(async () => h.panels().setToolCallState({ status: "pending" }));
    await act(async () => h.api().onClearToolResult());
    expect(h.panels().toolCallState).toBeUndefined();
  });

  it("onToolsUiChange drops the result when the selection changes", async () => {
    const h = harness({ selectedToolKey: "a" });
    await act(async () => h.panels().setToolCallState({ status: "pending" }));
    await act(async () =>
      h.api().onToolsUiChange({ ...EMPTY_TOOLS_UI, selectedToolKey: "b" }),
    );
    expect(h.panels().toolCallState).toBeUndefined();
    expect(h.spies.setToolsUi).toHaveBeenCalledWith({
      ...EMPTY_TOOLS_UI,
      selectedToolKey: "b",
    });
  });

  it("onToolsUiChange keeps the result when only the search changed", async () => {
    const h = harness({ selectedToolKey: "a" });
    await act(async () => h.panels().setToolCallState({ status: "pending" }));
    await act(async () =>
      h.api().onToolsUiChange({
        ...EMPTY_TOOLS_UI,
        selectedToolKey: "a",
        search: "e",
      }),
    );
    expect(h.panels().toolCallState).toEqual({ status: "pending" });
  });
});

describe("onGetPrompt", () => {
  it("does nothing without a client", async () => {
    const h = harness();
    await act(async () => h.api().onGetPrompt("p", {}));
    expect(h.panels().getPromptState).toBeUndefined();
  });

  it("tags the result with the prompt name", async () => {
    const c = client({
      getPrompt: vi.fn().mockResolvedValue({ result: { messages: [1] } }),
    });
    const h = harness({ client: c });
    await act(async () => h.api().onGetPrompt("p", { x: "1" }));
    expect(c.getPrompt).toHaveBeenCalledWith("p", { x: "1" });
    expect(h.panels().getPromptState).toEqual({
      status: "ok",
      promptName: "p",
      result: { messages: [1] },
    });
  });

  it("recovers a lapsed authorization", async () => {
    const recover = vi.fn().mockResolvedValue(true);
    const c = client({ getPrompt: vi.fn().mockRejectedValue(authError()) });
    const h = harness({
      client: c,
      activeServerId: "a",
      recovery: { handleCommandScopedAuthRecovery: recover },
    });
    await act(async () => h.api().onGetPrompt("p", {}));
    expect(recover).toHaveBeenCalledWith(
      expect.any(AuthRecoveryRequiredError),
      {
        serverId: "a",
        source: "prompt",
      },
    );
    expect(h.panels().getPromptState).toBeUndefined();
  });

  it("skips the recovery with no active server", async () => {
    const recover = vi.fn().mockResolvedValue(true);
    const c = client({ getPrompt: vi.fn().mockRejectedValue(authError()) });
    const h = harness({
      client: c,
      recovery: { handleCommandScopedAuthRecovery: recover },
    });
    await act(async () => h.api().onGetPrompt("p", {}));
    expect(recover).not.toHaveBeenCalled();
  });

  it("reports any other failure against the prompt name", async () => {
    const c = client({ getPrompt: vi.fn().mockRejectedValue("plain string") });
    const h = harness({ client: c });
    await act(async () => h.api().onGetPrompt("p", {}));
    expect(h.panels().getPromptState).toEqual({
      status: "error",
      promptName: "p",
      error: "plain string",
    });
  });
});

describe("onReadResource", () => {
  it("does nothing without a client", async () => {
    const h = harness();
    await act(async () => h.api().onReadResource("u"));
    expect(h.panels().readResourceState).toBeUndefined();
  });

  it("reports the contents and the read timestamp", async () => {
    const c = client({
      readResource: vi
        .fn()
        .mockResolvedValue({ result: { contents: [1] }, timestamp: 7 }),
    });
    const h = harness({ client: c });
    await act(async () => h.api().onReadResource("u"));
    expect(h.panels().readResourceState).toEqual({
      status: "ok",
      uri: "u",
      result: { contents: [1] },
      lastUpdated: 7,
    });
  });

  it("recovers a lapsed authorization", async () => {
    const recover = vi.fn().mockResolvedValue(true);
    const c = client({ readResource: vi.fn().mockRejectedValue(authError()) });
    const h = harness({
      client: c,
      activeServerId: "a",
      recovery: { handleCommandScopedAuthRecovery: recover },
    });
    await act(async () => h.api().onReadResource("u"));
    expect(recover).toHaveBeenCalledWith(
      expect.any(AuthRecoveryRequiredError),
      {
        serverId: "a",
        source: "resource",
      },
    );
    expect(h.panels().readResourceState).toBeUndefined();
  });

  it("skips the recovery with no active server", async () => {
    const recover = vi.fn().mockResolvedValue(true);
    const c = client({ readResource: vi.fn().mockRejectedValue(authError()) });
    const h = harness({
      client: c,
      recovery: { handleCommandScopedAuthRecovery: recover },
    });
    await act(async () => h.api().onReadResource("u"));
    expect(recover).not.toHaveBeenCalled();
  });

  it("reports any other failure against the uri", async () => {
    const c = client({
      readResource: vi.fn().mockRejectedValue(new Error("nope")),
    });
    const h = harness({ client: c });
    await act(async () => h.api().onReadResource("u"));
    expect(h.panels().readResourceState).toEqual({
      status: "error",
      uri: "u",
      error: "nope",
    });
  });
});

describe("onReadResourceContents", () => {
  it("throws when there is no client", async () => {
    const h = harness();
    await expect(h.api().onReadResourceContents("u")).rejects.toThrow(
      "Client is not connected",
    );
  });

  it("returns the contents directly", async () => {
    const c = client({
      readResource: vi.fn().mockResolvedValue({ result: { contents: [2] } }),
    });
    const h = harness({ client: c });
    await expect(h.api().onReadResourceContents("u")).resolves.toEqual({
      contents: [2],
    });
  });

  it("retries once after a satisfied recovery", async () => {
    const recover = vi.fn().mockResolvedValue(true);
    const readResource = vi
      .fn()
      .mockRejectedValueOnce(authError())
      .mockResolvedValue({ result: { contents: [3] } });
    const h = harness({
      client: client({ readResource }),
      activeServerId: "a",
      recovery: { handleCommandScopedAuthRecovery: recover },
    });
    await expect(h.api().onReadResourceContents("u")).resolves.toEqual({
      contents: [3],
    });
    expect(readResource).toHaveBeenCalledTimes(2);
  });

  it("rethrows when the recovery was not satisfied", async () => {
    const recover = vi.fn().mockResolvedValue(false);
    const h = harness({
      client: client({
        readResource: vi.fn().mockRejectedValue(authError()),
      }),
      activeServerId: "a",
      recovery: { handleCommandScopedAuthRecovery: recover },
    });
    await expect(h.api().onReadResourceContents("u")).rejects.toBeInstanceOf(
      AuthRecoveryRequiredError,
    );
  });

  it("rethrows a non-auth failure untouched", async () => {
    const recover = vi.fn();
    const h = harness({
      client: client({
        readResource: vi.fn().mockRejectedValue(new Error("nope")),
      }),
      activeServerId: "a",
      recovery: { handleCommandScopedAuthRecovery: recover },
    });
    await expect(h.api().onReadResourceContents("u")).rejects.toThrow("nope");
    expect(recover).not.toHaveBeenCalled();
  });
});

describe("subscriptions and completion", () => {
  it("subscribes and unsubscribes through the client", async () => {
    const c = client();
    const h = harness({ client: c });
    await act(async () => {
      h.api().onSubscribeResource("u");
      h.api().onUnsubscribeResource("u");
    });
    expect(c.subscribeToResource).toHaveBeenCalledWith("u");
    expect(c.unsubscribeFromResource).toHaveBeenCalledWith("u");
  });

  it("is a no-op for both without a client", async () => {
    const h = harness();
    await act(async () => {
      h.api().onSubscribeResource("u");
      h.api().onUnsubscribeResource("u");
    });
    // Reaching here without throwing is the assertion.
    expect(h.api().onSubscribeResource).toBeTypeOf("function");
  });

  it("returns the completion values", async () => {
    const c = client();
    const h = harness({ client: c });
    const values = await h
      .api()
      .onCompleteArgument({ type: "ref/prompt", name: "p" }, "arg", "v", {});
    expect(values).toEqual(["a"]);
    expect(c.getCompletions).toHaveBeenCalledWith(
      { type: "ref/prompt", name: "p" },
      "arg",
      "v",
      {},
    );
  });

  it("returns no completions without a client", async () => {
    const h = harness();
    await expect(
      h
        .api()
        .onCompleteArgument({ type: "ref/resource", uri: "u" }, "a", "", {}),
    ).resolves.toEqual([]);
  });

  it("returns no completions when the result carries none", async () => {
    const h = harness({
      client: client({ getCompletions: vi.fn().mockResolvedValue({}) }),
    });
    await expect(
      h
        .api()
        .onCompleteArgument({ type: "ref/prompt", name: "p" }, "a", "", {}),
    ).resolves.toEqual([]);
  });
});

describe("cancellation and tasks", () => {
  it("cancels a task through the client", async () => {
    const c = client();
    const h = harness({ client: c });
    await act(async () => h.api().onCancelTask("t1"));
    expect(c.cancelRequestorTask).toHaveBeenCalledWith("t1");
  });

  it("does nothing without a client", async () => {
    const h = harness();
    await act(async () => h.api().onCancelTask("t1"));
    expect(notificationsMock.show).not.toHaveBeenCalled();
  });

  it("stays silent when the cancel raised a recovery", async () => {
    const h = harness({
      client: client({
        cancelRequestorTask: vi.fn().mockRejectedValue(authError()),
      }),
    });
    await act(async () => h.api().onCancelTask("t1"));
    expect(notificationsMock.show).not.toHaveBeenCalled();
  });

  it("toasts any other cancel failure", async () => {
    const h = harness({
      client: client({
        cancelRequestorTask: vi.fn().mockRejectedValue(new Error("no")),
      }),
    });
    await act(async () => h.api().onCancelTask("t1"));
    expect(notificationsMock.show).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Failed to cancel task" }),
    );
  });

  it("toasts a non-Error cancel rejection as its string form", async () => {
    const h = harness({
      client: client({
        cancelRequestorTask: vi.fn().mockRejectedValue("plain"),
      }),
    });
    await act(async () => h.api().onCancelTask("t1"));
    expect(notificationsMock.show).toHaveBeenCalledWith(
      expect.objectContaining({ message: "plain" }),
    );
  });

  it("aborts an ordinary in-flight call", async () => {
    const c = client();
    const h = harness({ client: c });
    await act(async () => h.api().onCancelToolCall());
    expect(c.cancelToolCall).toHaveBeenCalled();
  });

  it("cancels the task behind a task-augmented call, once", async () => {
    const c = client();
    const h = harness({ client: c, capabilities: taskCapabilities });
    // The ref is written by the task-toast listener in App; set it the way a
    // live task-augmented call would.
    h.taskIdRef.current = "t9";
    await act(async () => h.api().onCancelToolCall());
    expect(c.cancelRequestorTask).toHaveBeenCalledWith("t9");
    // The ref is cleared first, so a second click aborts the call instead of
    // re-cancelling a task that is already terminating.
    expect(h.taskIdRef.current).toBeUndefined();
    await act(async () => h.api().onCancelToolCall());
    expect(c.cancelRequestorTask).toHaveBeenCalledTimes(1);
    expect(c.cancelToolCall).toHaveBeenCalledTimes(1);
  });

  it("is a no-op without a client", async () => {
    const h = harness();
    await act(async () => h.api().onCancelToolCall());
    expect(h.api().onCancelToolCall).toBeTypeOf("function");
  });

  it("clears the completed tasks", async () => {
    const h = harness();
    await act(async () => h.api().onClearCompletedTasks());
    expect(h.spies.clearCompletedTasks).toHaveBeenCalled();
  });

  it("refreshes the task list, reporting a failure", async () => {
    const h = harness();
    await act(async () => h.api().onRefreshTasks());
    expect(h.spies.refreshTasks).toHaveBeenCalled();
  });
});

describe("log levels", () => {
  it("moves the legacy level optimistically and sends it", async () => {
    const c = client();
    const h = harness({ client: c });
    await act(async () => h.api().onSetLogLevel("debug"));
    expect(h.spies.setCurrentLogLevel).toHaveBeenCalledWith("debug");
    expect(c.setLoggingLevel).toHaveBeenCalledWith("debug");
  });

  it("still moves the level with no client to send to", async () => {
    const h = harness();
    await act(async () => h.api().onSetLogLevel("warning"));
    expect(h.spies.setCurrentLogLevel).toHaveBeenCalledWith("warning");
  });

  it("stores the modern level on the client, and opts back out", async () => {
    const c = client();
    const h = harness({ client: c });
    await act(async () => h.api().onSetModernLogLevel("info"));
    expect(c.setModernLogLevel).toHaveBeenCalledWith("info");
    await act(async () => h.api().onSetModernLogLevel(null));
    expect(c.setModernLogLevel).toHaveBeenCalledWith(undefined);
    expect(h.spies.setModernLogLevel).toHaveBeenCalledWith(null);
  });

  it("records the modern level with no client", async () => {
    const h = harness();
    await act(async () => h.api().onSetModernLogLevel("error"));
    expect(h.spies.setModernLogLevel).toHaveBeenCalledWith("error");
  });
});

describe("the refresh handlers", () => {
  it("refresh the aggregates in all-pages mode", async () => {
    const h = harness();
    await act(async () => {
      h.api().onRefreshTools();
      h.api().onRefreshPrompts();
      h.api().onRefreshResources();
    });
    expect(h.spies.refreshTools).toHaveBeenCalled();
    expect(h.spies.refreshPrompts).toHaveBeenCalled();
    expect(h.spies.refreshResources).toHaveBeenCalled();
    expect(h.spies.refreshResourceTemplates).toHaveBeenCalled();
    expect(h.spies.clearToolsListChanged).not.toHaveBeenCalled();
  });

  it("reload page 1 and acknowledge the indicator in paginated mode", async () => {
    const h = harness({ paginatedLists: true });
    await act(async () => {
      h.api().onRefreshTools();
      h.api().onRefreshPrompts();
      h.api().onRefreshResources();
    });
    expect(h.spies.clearToolsListChanged).toHaveBeenCalled();
    expect(h.spies.clearPromptsListChanged).toHaveBeenCalled();
    expect(h.spies.clearResourcesListChanged).toHaveBeenCalled();
    expect(h.toolsPagination.onRefresh).toHaveBeenCalled();
    expect(h.promptsPagination.onRefresh).toHaveBeenCalled();
    expect(h.resourcesPagination.onRefresh).toHaveBeenCalled();
    // Templates always take the aggregate path, both modes.
    expect(h.spies.refreshResourceTemplates).toHaveBeenCalled();
    expect(h.spies.refreshTools).not.toHaveBeenCalled();
  });

  it("page each list forward", async () => {
    const h = harness();
    await act(async () => {
      h.api().onLoadMoreTools();
      h.api().onLoadMorePrompts();
      h.api().onLoadMoreResources();
    });
    expect(h.toolsPagination.onLoadMore).toHaveBeenCalled();
    expect(h.promptsPagination.onLoadMore).toHaveBeenCalled();
    expect(h.resourcesPagination.onLoadMore).toHaveBeenCalled();
  });
});

describe("onTogglePaginatedLists", () => {
  const servers = [entry("a")];

  it("does nothing when there is no matching active server", async () => {
    const h = harness({ servers, activeServerId: "missing" });
    await act(async () => h.api().onTogglePaginatedLists(true));
    expect(h.spies.record).not.toHaveBeenCalled();
    expect(h.spies.updateServerSettings).not.toHaveBeenCalled();
  });

  it("records the override, pushes it live and persists it", async () => {
    const c = client();
    const h = harness({ servers, activeServerId: "a", client: c });
    await act(async () => h.api().onTogglePaginatedLists(true));
    expect(h.spies.record).toHaveBeenCalledWith("a", true);
    expect(c.setServerSettings).toHaveBeenCalledWith(
      expect.objectContaining({ paginatedLists: true }),
    );
    await waitFor(() =>
      expect(h.spies.updateServerSettings).toHaveBeenCalledWith(
        "a",
        expect.objectContaining({ paginatedLists: true }),
      ),
    );
    expect(h.spies.refreshInitialConfig).toHaveBeenCalled();
  });

  it("builds on the last landed write rather than on the list entry", async () => {
    const h = harness({
      servers,
      activeServerId: "a",
      persisted: { a: { ...EMPTY_SETTINGS, maxFetchRequests: 9 } },
    });
    await act(async () => h.api().onTogglePaginatedLists(true));
    await waitFor(() =>
      expect(h.spies.updateServerSettings).toHaveBeenCalledWith("a", {
        ...EMPTY_SETTINGS,
        maxFetchRequests: 9,
        paginatedLists: true,
      }),
    );
  });

  it("pulls page 1 into every paged store when connected and turning on", async () => {
    const h = harness({
      servers,
      activeServerId: "a",
      connected: true,
      client: client(),
    });
    await act(async () => h.api().onTogglePaginatedLists(true));
    expect(h.spies.loadToolsPage).toHaveBeenCalledWith(undefined);
    expect(h.spies.loadPromptsPage).toHaveBeenCalledWith(undefined);
    expect(h.spies.loadResourcesPage).toHaveBeenCalledWith(undefined);
  });

  it("refetches every aggregate when connected and turning off", async () => {
    const h = harness({
      servers,
      activeServerId: "a",
      connected: true,
      client: client(),
    });
    await act(async () => h.api().onTogglePaginatedLists(false));
    expect(h.spies.refreshTools).toHaveBeenCalled();
    expect(h.spies.refreshPrompts).toHaveBeenCalled();
    expect(h.spies.refreshResources).toHaveBeenCalled();
  });

  it("loads nothing while disconnected", async () => {
    const h = harness({ servers, activeServerId: "a" });
    await act(async () => h.api().onTogglePaginatedLists(true));
    expect(h.spies.loadToolsPage).not.toHaveBeenCalled();
    expect(h.spies.refreshTools).not.toHaveBeenCalled();
  });

  it("re-applies the value to the live client once the write settles", async () => {
    const h = harness({
      servers,
      activeServerId: "a",
      client: client(),
    });
    await act(async () => h.api().onTogglePaginatedLists(true));
    await waitFor(() =>
      expect(h.spies.applyLiveServerSettings).toHaveBeenCalledWith(
        expect.objectContaining({ paginatedLists: true }),
      ),
    );
    // The override is re-recorded for this server, whatever is active now.
    expect(h.spies.record).toHaveBeenLastCalledWith("a", true);
  });

  it("does not re-apply when a later write has already settled", async () => {
    const h = harness({ servers, activeServerId: "a", client: client() });
    h.spies.landed.mockReturnValue(false);
    await act(async () => h.api().onTogglePaginatedLists(true));
    await waitFor(() => expect(h.spies.begin).toHaveBeenCalled());
    expect(h.spies.applyLiveServerSettings).not.toHaveBeenCalled();
  });

  it("does not push into a client belonging to another server", async () => {
    // The write is held open so the session can move on before it settles —
    // resolving it inline would settle against the session that issued it.
    const gate = deferred();
    const h = harness({
      servers,
      activeServerId: "a",
      client: client(),
      updateServerSettingsImpl: vi.fn().mockReturnValue(gate.promise),
    });
    await act(async () => h.api().onTogglePaginatedLists(true));
    h.rerender({ servers, activeServerId: "b", client: client() });
    await act(async () => {
      gate.resolve();
      await gate.promise;
    });
    await waitFor(() => expect(h.spies.landed).toHaveBeenCalled());
    expect(h.spies.applyLiveServerSettings).not.toHaveBeenCalled();
    expect(h.spies.record).toHaveBeenLastCalledWith("a", true);
  });

  it("settles a landed write whose list reload failed, and says so", async () => {
    const h = harness({
      servers,
      activeServerId: "a",
      client: client(),
      updateServerSettingsImpl: vi
        .fn()
        .mockRejectedValue(new ServerListReloadError("reload failed")),
    });
    await act(async () => h.api().onTogglePaginatedLists(true));
    await waitFor(() =>
      expect(notificationsMock.show).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Pagination setting saved, but the server list did not reload",
        }),
      ),
    );
    expect(h.spies.landed).toHaveBeenCalledWith(
      expect.objectContaining({ paginatedLists: true }),
    );
    expect(h.spies.failed).not.toHaveBeenCalled();
  });

  it("rolls back to the resolved baseline when the write never landed", async () => {
    const h = harness({
      servers,
      activeServerId: "a",
      client: client(),
      persisted: { a: { ...EMPTY_SETTINGS, paginatedLists: false } },
      updateServerSettingsImpl: vi.fn().mockRejectedValue(new Error("nope")),
    });
    await act(async () => h.api().onTogglePaginatedLists(true));
    await waitFor(() => expect(h.spies.failed).toHaveBeenCalled());
    expect(h.spies.record).toHaveBeenLastCalledWith("a", false);
    expect(h.spies.applyLiveServerSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({ paginatedLists: false }),
    );
    expect(notificationsMock.show).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Failed to save pagination setting" }),
    );
  });

  it("falls back to empty settings when nothing is known about disk", async () => {
    const h = harness({
      servers,
      activeServerId: "a",
      client: client(),
      updateServerSettingsImpl: vi.fn().mockRejectedValue("plain"),
    });
    await act(async () => h.api().onTogglePaginatedLists(true));
    await waitFor(() => expect(h.spies.failed).toHaveBeenCalled());
    expect(h.spies.record).toHaveBeenLastCalledWith("a", false);
    expect(notificationsMock.show).toHaveBeenCalledWith(
      expect.objectContaining({ message: "plain" }),
    );
  });

  it("does not roll the live client back for another server's session", async () => {
    const gate = deferred();
    const h = harness({
      servers,
      activeServerId: "a",
      client: client(),
      updateServerSettingsImpl: vi.fn().mockReturnValue(gate.promise),
    });
    await act(async () => h.api().onTogglePaginatedLists(true));
    h.rerender({ servers, activeServerId: "b", client: client() });
    await act(async () => {
      gate.reject(new Error("nope"));
      await gate.promise.catch(() => undefined);
    });
    await waitFor(() => expect(h.spies.failed).toHaveBeenCalled());
    expect(h.spies.applyLiveServerSettings).not.toHaveBeenCalled();
    expect(h.spies.record).toHaveBeenLastCalledWith("a", false);
  });
});
