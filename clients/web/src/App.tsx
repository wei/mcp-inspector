import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import type {
  CreateMessageResult,
  ElicitResult,
  InitializeResult,
  LoggingLevel,
  Tool,
} from "@modelcontextprotocol/client";
import { InspectorClient } from "@inspector/core/mcp/index.js";
import { getServerType } from "@inspector/core/mcp/config.js";
import type { JsonValue } from "@inspector/core/mcp/index.js";

import {
  getUrlElicitationsFromError,
  UrlElicitationLoopError,
} from "@inspector/core/mcp/urlElicitation.js";
import { ToolCallCancelledError } from "@inspector/core/mcp/toolCallCancelledError.js";
import type { TypedEventGeneric } from "@inspector/core/mcp/typedEventTarget.js";
import type {
  InspectorServerSettings,
  MCPServerConfig,
  ServerEntry,
  ServerType,
} from "@inspector/core/mcp/types.js";
import {
  DEFAULT_TASK_TTL_MS,
  resolveModernLogLevel,
} from "@inspector/core/mcp/types.js";
import {
  cleanRoots,
  serializeMcpConfig,
} from "@inspector/core/mcp/serverList.js";
import type { ClientConfig } from "@inspector/core/client/types.js";
import {
  loadClientConfigRemote,
  saveClientConfigRemote,
} from "@inspector/core/client/remote.js";
import { formatClientConfigLoadError } from "@inspector/core/client/config-parse.js";
import type { FetchRequestLogStateEventMap } from "@inspector/core/mcp/state/fetchRequestLogState.js";
import { useInspectorClient } from "@inspector/core/react/useInspectorClient.js";
import {
  ServerListReloadError,
  useServers,
} from "@inspector/core/react/useServers.js";
import { useSettingsDraft } from "@inspector/core/react/useSettingsDraft.js";
import { useClientSettingsDraft } from "@inspector/core/react/useClientSettingsDraft.js";
import { useEmaIdpLoginState } from "@inspector/core/react/useEmaIdpLoginState.js";
import { useLastPersistedSettings } from "./hooks/useLastPersistedSettings";
import { usePaginatedListsOverride } from "./hooks/usePaginatedListsOverride";
import { useValueChange } from "./hooks/useValueChange";
import { useThemeToggle } from "./hooks/useThemeToggle";
import { useTabUiState } from "./hooks/useTabUiState";
import { useSessionRef } from "./hooks/useSessionRef";
import {
  useOAuthRecovery,
  type SetupClientForServer,
} from "./hooks/useOAuthRecovery";
import { useInspectorStores } from "./hooks/useInspectorStores";
import {
  useConnectionLifecycle,
  useHandshakeTelemetry,
} from "./hooks/useConnectionLifecycle";
import { useMcpApps } from "./hooks/useMcpApps";
import { useExportActions } from "./hooks/useExportActions";
import { useProgressToasts } from "./hooks/useProgressToasts";
import { useTaskToasts } from "./hooks/useTaskToasts";
import type { ListPaginationControlsProps } from "./components/elements/ListPaginationControls/ListPaginationControls";
import { useInitialConfig } from "@inspector/core/react/useInitialConfig.js";
import { refreshingPersist } from "./lib/refreshingPersist";
import { usePendingClientRequests } from "@inspector/core/react/usePendingClientRequests.js";
import { InspectorView } from "./components/views/InspectorView/InspectorView";
import type {
  ToolCallState,
  ToolsUiState,
} from "./components/screens/ToolsScreen/ToolsScreen";
import type { GetPromptState } from "./components/screens/PromptsScreen/PromptsScreen";
import type { ReadResourceState } from "./components/screens/ResourcesScreen/ResourcesScreen";
import { AppElicitationHost } from "./components/elements/AppElicitation/AppElicitationHost";
import type { LogEntryData } from "./components/elements/LogEntry/LogEntry";
import {
  ServerConfigModal,
  type ServerConfigModalMode,
} from "./components/groups/ServerConfigModal/ServerConfigModal";
import { ServerSettingsModal } from "./components/groups/ServerSettingsModal/ServerSettingsModal";
import { ClientSettingsModal } from "./components/groups/ClientSettingsModal/ClientSettingsModal";
import {
  canPersistClientSettingsDraft,
  clientConfigToFormValues,
  EMPTY_CLIENT_SETTINGS,
  formValuesToClientConfig,
} from "./components/groups/ClientSettingsForm/clientSettingsValues";
import { ServerImportConfigModal } from "./components/groups/ServerImportConfigModal/ServerImportConfigModal";
import { ServerImportJsonModal } from "./components/groups/ServerImportJsonModal/ServerImportJsonModal";
import { ConnectionInfoModal } from "./components/groups/ConnectionInfoModal/ConnectionInfoModal";
import { OutputValidationModal } from "./components/groups/OutputValidationModal/OutputValidationModal";
import { UrlElicitationErrorModal } from "./components/groups/UrlElicitationErrorModal/UrlElicitationErrorModal";
import { ServerRemoveConfirmModal } from "./components/groups/ServerRemoveConfirmModal/ServerRemoveConfirmModal";
import { StepUpAuthModal } from "./components/groups/StepUpAuthModal/StepUpAuthModal";
import { ReAuthBanner } from "./components/groups/ReAuthBanner/ReAuthBanner";
import {
  PendingClientRequestModal,
  type PendingClientRequestContent,
} from "./components/groups/PendingClientRequestModal/PendingClientRequestModal";
import { downloadJsonFile } from "./lib/downloadFile";
import { enrichProtocolEntries } from "./utils/correlateTransportErrors";
import { visibleMalformedListItems } from "./utils/malformedListReport";
import { parseDeepLink, deepLinkParseStatus } from "./utils/deepLink";
import type { DeepLink, DeepLinkParseStatus } from "./utils/deepLink";
import { AuthRecoveryRequiredError } from "@inspector/core/auth/challenge.js";
import { getAuthToken } from "./lib/authToken";
import { messagesToLogEntries } from "./lib/protocolReplay";
import {
  errorCodeOf,
  errorMessage,
  formatErrorDetails,
} from "./utils/errorFormat";
import { EMPTY_SETTINGS } from "./utils/serverSettingsDefaults";
import type { StepUpSource } from "./utils/stepUp";
import {
  bodyDroppedToastId,
  CLIENT_CONFIG_LOAD_ERROR_NOTIFICATION_ID,
} from "./utils/toasts/toastIds";
import { FetchBodyDroppedToastMessage } from "./components/elements/Toasts/FetchBodyDroppedToastMessage";
import { OutputValidationToastMessage } from "./components/elements/Toasts/OutputValidationToastMessage";
import { UrlElicitationErrorToastMessage } from "./components/elements/Toasts/UrlElicitationErrorToastMessage";
import { ReAuthBannerBar } from "./components/groups/ReAuthBanner/ReAuthBannerBar";

function App() {
  const { onToggleTheme } = useThemeToggle();

  // Server list — sourced from ~/.mcp-inspector/mcp.json via the backend's
  // `/api/servers` routes. First-launch seeds are written by the backend when
  // the file is absent, so this hook returns a non-empty list on first load.
  const {
    servers,
    addServer,
    updateServer,
    updateServerSettings,
    removeServer,
    reorderServers,
    importSource,
  } = useServers({
    baseUrl:
      typeof window !== "undefined"
        ? window.location.origin
        : "http://localhost",
    authToken: getAuthToken(),
  });

  // CRUD-modal state. `configModal` drives Add / Edit / Clone via a single
  // shared form modal; `removeTarget` drives the remove-confirmation modal.
  const [configModal, setConfigModal] = useState<{
    mode: ServerConfigModalMode;
    targetId?: string;
  } | null>(null);
  // Import-flow modals (#1348): "Import from client config" (other-client
  // config merge) and "Import from registry config" (registry single-server
  // import).
  const [importConfigOpen, setImportConfigOpen] = useState(false);
  const [importJsonOpen, setImportJsonOpen] = useState(false);
  // Ids of freshly-added servers (manual or import) — their cards draw an
  // animated border (and the first scrolls into view) until clicked. A batch
  // import accumulates all of its ids here; opening an add/import modal starts a
  // fresh batch. (#1348)
  const [highlightedServerIds, setHighlightedServerIds] = useState<string[]>(
    [],
  );
  const clearHighlight = useCallback(
    (id: string) =>
      setHighlightedServerIds((ids) => ids.filter((x) => x !== id)),
    [],
  );
  const [settingsModalTargetId, setSettingsModalTargetId] = useState<
    string | undefined
  >(undefined);
  const [clientSettingsOpen, setClientSettingsOpen] = useState(false);
  const [connectionInfoModalOpen, setConnectionInfoModalOpen] = useState(false);
  const closeConnectionInfoModal = useCallback(
    () => setConnectionInfoModalOpen(false),
    [],
  );
  const [removeTarget, setRemoveTarget] = useState<ServerEntry | null>(null);
  // Details for the output-schema-mismatch modal opened from the warning toast.
  const [outputValidationDetails, setOutputValidationDetails] = useState<{
    toolName: string;
    message: string;
  } | null>(null);
  // Raw body for the non-spec URLElicitationRequired (-32042, no elicitations)
  // modal opened from its warning toast.
  const [urlElicitationErrorDetails, setUrlElicitationErrorDetails] = useState<{
    toolName: string;
    details: string;
  } | null>(null);

  // The active connection target. `null` between sessions; set as soon as
  // the user toggles a server card on. Drives state-manager lifetime.
  const [activeServerId, setActiveServerId] = useState<string | undefined>(
    undefined,
  );

  // Id of the server whose last connection attempt failed (#1621). Drives the
  // red border on that ServerCard. It is deliberately NOT reset by
  // `resetSessionScopedUiState` (a failed connect fires the `disconnect` event,
  // which would otherwise clear the flag the same tick we set it); instead it is
  // cleared when a new connection attempt starts, and re-set if that attempt
  // also fails.
  const [failedServerId, setFailedServerId] = useState<string | undefined>(
    undefined,
  );

  // InspectorClient + per-primitive state managers. All recreated together
  // whenever the user switches active servers, then destroyed when the
  // next switch happens (or when the component unmounts).
  const [inspectorClient, setInspectorClient] =
    useState<InspectorClient | null>(null);

  const configBaseUrl =
    typeof window !== "undefined" ? window.location.origin : "http://localhost";
  // One `GET /api/config` fetch recovers every static payload field the app
  // reads: the MCP Apps `sandboxUrl`, the session's `writable` flag (read-only
  // `--config` / ad-hoc sessions hide catalog CRUD; the default catalog and
  // `--catalog` stay writable), and the Inspector `version` shown in the
  // lower-right corner (the browser can't read it off disk).
  const {
    sandboxUrl,
    writable: serverListWritable,
    version: inspectorVersion,
    secretStorage,
    refresh: refreshInitialConfig,
    loading: initialConfigLoading,
  } = useInitialConfig({
    baseUrl: configBaseUrl,
    authToken: getAuthToken(),
  });

  const [clientConfig, setClientConfig] = useState<ClientConfig>({});
  useEffect(() => {
    if (typeof window === "undefined") return;
    void loadClientConfigRemote({
      baseUrl: configBaseUrl,
      authToken: getAuthToken(),
    })
      .then(setClientConfig)
      .catch((err) => {
        setClientConfig({});
        notifications.show({
          id: CLIENT_CONFIG_LOAD_ERROR_NOTIFICATION_ID,
          title: "Could not load Client Settings",
          message: `${formatClientConfigLoadError(err)}\n\nCheck ~/.mcp-inspector/storage/client.json or re-enter settings in Client Settings.`,
          color: "red",
          autoClose: false,
        });
      });
  }, [configBaseUrl]);

  // the answer is baked into the client at construction (it decides whether the
  // nested MCP Apps `elicitation` capability is advertised). So a connect waits
  // for it rather than guessing: guessing "available" over-claims a capability
  // we may not have, and guessing "unavailable" strands the whole session on
  // the native form despite having a sandbox. The wait is a local fetch already
  // in flight since mount.
  const initialConfigSettledRef = useRef<{
    promise: Promise<void>;
    resolve: () => void;
  }>(null);
  initialConfigSettledRef.current ??= (() => {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    return { promise, resolve };
  })();
  useEffect(() => {
    if (!initialConfigLoading) initialConfigSettledRef.current?.resolve();
  }, [initialConfigLoading]);

  // Optimistic log level — `logging/setLevel` has no echo notification, so
  // the parent keeps the current value locally.
  const [currentLogLevel, setCurrentLogLevel] = useState<LoggingLevel>("info");

  // Modern-era per-request log level (#1629). `null` = not opted in (the modern
  // default: logs stay absent until the user picks a level, which the client
  // then stamps on every request's `_meta`). Separate from `currentLogLevel`
  // because the modern control has an "off" state legacy doesn't.
  const [modernLogLevel, setModernLogLevel] = useState<LoggingLevel | null>(
    null,
  );

  // In-flight call panel state. Tracked here (rather than inside the
  // respective screens) so the panels can reflect pending → ok/error
  // transitions and so `onClear*` handlers can reset the panel without
  // remounting the screen.
  const [toolCallState, setToolCallState] = useState<ToolCallState | undefined>(
    undefined,
  );
  const [getPromptState, setGetPromptState] = useState<
    GetPromptState | undefined
  >(undefined);
  const [readResourceState, setReadResourceState] = useState<
    ReadResourceState | undefined
  >(undefined);

  // Per-screen selection / search / filter state, one object per screen. Lifted
  // here (out of the individual screens) so it persists across tab navigation
  // within a live session — the screens unmount on tab switch, so screen-local
  // state would be lost. Cleared only on disconnect (via
  // `resetSessionScopedUiState`) or an explicit user action, never on plain
  // navigation (#1414/#1417). The in-flight result panels (`toolCallState` /
  // `getPromptState` / `readResourceState`) stay separate — they're written by
  // the async action handlers below, not by the screens.
  const {
    ui,
    setUi,
    activeTab,
    setActiveTab,
    pinnedProtocolIds,
    setPinnedProtocolIds,
    togglePinProtocol,
    resetTabUiState,
  } = useTabUiState();
  // One stable ref mirroring every session value a long-lived callback needs
  // to read *currently* rather than as of the render that created it. Declared
  // here — ahead of its first reader — because a hook return is not provably
  // stable to `react-hooks/exhaustive-deps`, so consumers list it and would hit
  // the temporal dead zone if it came later. The two pending-OAuth slots are
  // written into it by `useOAuthRecovery`, which owns them (#2153).
  const sessionRef = useSessionRef({
    activeServerId,
    servers,
    inspectorClient,
  });

  // The narrow reset surface `useConnectionLifecycle` drops session-scoped UI
  // state through on disconnect — one entry per owner, rather than that
  // owner's individual setters (#2129). The log-level pair stays here because
  // it is App-owned state the connect path also seeds.
  const resetLogLevels = useCallback(() => {
    setCurrentLogLevel("info");
    // Re-seed rather than blank: the client restores its own opt-in from the
    // server setting at connect (`resetSessionState`), so blanking here would
    // leave the control reading Off while every modern request still carries
    // the level — visible on the auth-recovery path, which reconnects the same
    // client instance rather than rebuilding it (#1629, #1797).
    // The session ref is synced in a passive effect, so it still holds the
    // outgoing server's id when this runs from `onDisconnect` — which is what
    // lets the re-seed find its settings. Clearing that ref eagerly would take
    // the no-server branch below and silently drop this to Off.
    // Branch on the *server*, not its settings: an entry with no settings node
    // is the common case (`mcp.json` written by hand, never opened in Server
    // Settings), and there the default is right — it is what the seed and the
    // client both use. Only "no server at all" means Off.
    const outgoing = sessionRef.current.servers.find(
      (s) => s.id === sessionRef.current.activeServerId,
    );
    setModernLogLevel(
      outgoing ? (resolveModernLogLevel(outgoing.settings) ?? null) : null,
    );
  }, [sessionRef]);
  // #1629: seed the live modern per-request log level from the server setting
  // so the Logs-tab control reflects what the client stamps by default (the
  // client is seeded the same way in its constructor). "off" means not opted
  // in (null). Only affects modern connections.
  const seedModernLogLevel = useCallback(
    (settings: InspectorServerSettings | undefined) => {
      setModernLogLevel(resolveModernLogLevel(settings) ?? null);
    },
    [],
  );

  // Progress and task-status toasts, and the taskId → progress map the Tasks
  // screen renders from. Both hooks subscribe to the live client's events and
  // own their own toast-id bookkeeping.
  useProgressToasts(inspectorClient);
  const { progressByTaskId, resetTaskProgress, activeToolCallTaskIdRef } =
    useTaskToasts(inspectorClient);

  // Hook layer. Each hook subscribes to its respective event source and
  // re-renders the App on change. When `inspectorClient` / state managers
  // are null, the hooks degrade to empty results.
  const {
    status: connectionStatus,
    capabilities,
    clientCapabilities,
    serverInfo,
    instructions,
    protocolVersion,
    protocolEra,
    discoverResult,
    excludedTools,
    malformedListItems,
    lastError,
  } = useInspectorClient(inspectorClient);
  // What every settings write that landed on disk actually wrote, so a later
  // failed write can be rolled back to that rather than to a `servers` entry
  // frozen at the last successful list read (#2089).
  const lastPersistedSettings = useLastPersistedSettings(servers);
  // The active server's persisted paginated setting drives the display mode.
  // The sidebar toggle edits it (optimistically, below) and persists it.
  const activeServerEntry = servers.find((s) => s.id === activeServerId);
  const persistedPaginatedLists =
    activeServerEntry?.settings?.paginatedLists ?? false;
  // The optimistic override, held per server and superseded by the first
  // successful list read that rebuilds that server's entry. Per server rather
  // than one app-wide slot cleared on every active-entry change: the previous
  // shape dropped the override on a plain server switch, so an A → B → A round
  // trip fell back to A's stale entry and showed a value neither disk nor the
  // live client held (#2095).
  const paginatedListsOverride = usePaginatedListsOverride(servers);
  const paginatedLists =
    paginatedListsOverride.valueFor(activeServerId) ?? persistedPaginatedLists;
  const connected = connectionStatus === "connected";

  // Handshake telemetry. `connectStartRef` is stamped at the "connecting" edge
  // and consumed at the "connected" edge — a ref (not state) so the
  // intervening rerenders don't reset it. Declared here rather than inside
  // `useConnectionLifecycle` because `useOAuthRecovery`, which runs first,
  // stamps it too (#2154).
  const { connectStartRef, latencyMs } =
    useHandshakeTelemetry(connectionStatus);

  // The per-session state managers and the finished lists they feed. Owns the
  // create / destroy lifecycle, so the connection code below sees two stable
  // callbacks rather than twelve state slots.
  const {
    stores,
    createStores,
    destroyStores,
    fetchLogRef,
    refreshTools,
    refreshPrompts,
    refreshResources,
    loadToolsPage,
    loadPromptsPage,
    loadResourcesPage,
    toolsListChanged,
    clearToolsListChanged,
    promptsListChanged,
    clearPromptsListChanged,
    resourcesListChanged,
    clearResourcesListChanged,
    resourceTemplates,
    resourceTemplatesLoadError,
    refreshResourceTemplates,
    toolsPagination,
    promptsPagination,
    resourcesPagination,
    tasks,
    refreshTasks,
    clearCompletedTasks,
    subscriptions,
    subscriptionStreamState,
    messages,
    fetchRequests,
    stderrLogs,
  } = useInspectorStores({ inspectorClient, connected, paginatedLists });

  /** Drops every in-flight result panel; see `clearResultPanels` below. */
  const clearResultPanels = useCallback(() => {
    setToolCallState(undefined);
    setGetPromptState(undefined);
    setReadResourceState(undefined);
  }, []);

  /**
   * Routes a step-up failure or cancellation to the panel that issued the
   * command. `app` and `ambient` have no panel of their own — the App bridge
   * surfaces its own message and an ambient challenge was never user-initiated
   * — so they fall through to the no-op arm.
   */
  const setSourceScopedError = useCallback(
    (source: StepUpSource, message: string) => {
      switch (source) {
        case "tool":
          setToolCallState({ status: "error", error: message });
          break;
        case "prompt":
          setGetPromptState((prev) =>
            prev ? { ...prev, status: "error", error: message } : prev,
          );
          break;
        case "resource":
          setReadResourceState((prev) =>
            prev ? { ...prev, status: "error", error: message } : prev,
          );
          break;
        default:
          break;
      }
    },
    [],
  );

  /**
   * Published below, once the connect path's `setupClientForServer` exists —
   * it reads `onBeforeOAuthRedirect` and `sessionStorageAdapter` out of the
   * hook we are about to call, so it cannot be declared before it.
   */
  const setupClientForServerRef = useRef<SetupClientForServer | null>(null);

  // Every path by which a lapsed authorization is noticed and recovered: the
  // re-auth banner, step-up, deferred background-tab recovery, the
  // `/oauth/callback` completion, and the redirect plumbing the connect path
  // below consumes (#2153).
  const {
    webOAuthStorage,
    sessionStorageAdapter,
    onBeforeOAuthRedirect,
    prepareOAuthRedirect,
    reAuthBanner,
    setReAuthBanner,
    resetOAuthRecoveryState,
    pendingStepUp,
    handleStepUpAuthorize,
    handleStepUpCancel,
    handleCommandScopedAuthRecovery,
    runWithCommandAuthRecovery,
    runCommandInBackground,
    connectionInfoOAuth,
    clearServerOAuthAndDisconnect,
    finalizeExplicitDisconnect,
  } = useOAuthRecovery({
    sessionRef,
    servers,
    activeServerId,
    inspectorClient,
    connectionStatus,
    activeTab,
    ui,
    setUi,
    setActiveTab,
    fetchLogRef,
    connectStartRef,
    initialConfigSettledRef,
    setupClientForServerRef,
    setActiveServerId,
    setFailedServerId,
    clearResultPanels,
    setSourceScopedError,
  });

  // The malformed-entry report is written by the aggregate walk's salvage. In
  // paginated mode the tools/prompts/resources panels render the paged stores
  // instead, which never write or clear it — so it would linger above a page it
  // does not describe. See `visibleMalformedListItems` (#1909 + #1721).
  const shownMalformedListItems = useMemo(
    () => visibleMalformedListItems(malformedListItems, paginatedLists),
    [malformedListItems, paginatedLists],
  );
  const tools = toolsPagination.items;
  const prompts = promptsPagination.items;
  const resources = resourcesPagination.items;

  // The session-scoped state each owner drops on disconnect. One `reset()`
  // per owner, handed to `useConnectionLifecycle` as a single object so the
  // connection hook does not take a dependency on every phase-1 hook (#2129).
  const sessionReset = useMemo(
    () => ({
      clearResultPanels,
      resetTabUiState,
      resetTaskProgress,
      resetOAuthRecoveryState,
      resetLogLevels,
      closeConnectionInfoModal,
    }),
    [
      clearResultPanels,
      resetTabUiState,
      resetTaskProgress,
      resetOAuthRecoveryState,
      resetLogLevels,
      closeConnectionInfoModal,
    ],
  );

  // MCP Apps runtime wiring (#2156): the sandbox bridge factories, the renderer
  // handle, and the app-rendered elicitation controller. Called here rather
  // than beside the other client-scoped hooks above because it reads the
  // resource listing, which is only derived at this point.
  const {
    appRendererRef,
    sandboxBridgeFactory,
    elicitationBridgeFactory,
    appElicitations,
    newAppElicitationSession,
    handleAppElicitationSettle,
    handleAppElicitationFail,
  } = useMcpApps({ inspectorClient, configBaseUrl, resources });

  // Deep-link parameters parsed once from the initial URL. Security gating
  // (auth-token match, http(s)-only serverUrl) happens inside `parseDeepLink`,
  // so a `DeepLink` value here is already validated. The parse status is
  // surfaced as `data-deeplink` so an automated driver can tell "no deep link"
  // from "deep link present but rejected" — both leave `data-status` idle.
  const [deepLink, deepLinkStatus] = useMemo<
    [DeepLink | undefined, DeepLinkParseStatus]
  >(() => {
    /* v8 ignore next -- SSR guard: happy-dom always defines window in tests */
    if (typeof window === "undefined") return [undefined, "none"];
    const search = window.location.search;
    const parsed = parseDeepLink(search, getAuthToken());
    return [parsed, deepLinkParseStatus(search, parsed)];
  }, []);

  // Everything about bringing a session up and taking it down: building the
  // client for a server, connecting, disconnecting, the effects that observe
  // those transitions, and the session-scoped reset a disconnect triggers
  // (#2154).
  const {
    connectedServerId,
    connectErrorMessage,
    onToggleConnection,
    onDisconnect,
    onReauthenticateFromBanner,
  } = useConnectionLifecycle({
    sessionRef,
    servers,
    activeServerId,
    inspectorClient,
    connectionStatus,
    addServer,
    updateServer,
    setActiveServerId,
    setFailedServerId,
    setInspectorClient,
    createStores,
    destroyStores,
    lastPersistedSettings,
    clientConfig,
    newAppElicitationSession,
    sandboxUrl,
    initialConfigSettledRef,
    connectStartRef,
    setupClientForServerRef,
    deepLink,
    webOAuthStorage,
    sessionStorageAdapter,
    onBeforeOAuthRedirect,
    prepareOAuthRedirect,
    finalizeExplicitDisconnect,
    reAuthBanner,
    setReAuthBanner,
    sessionReset,
    seedModernLogLevel,
  });

  // Fold the transport errors the SDK throws rather than delivers (e.g. -32601
  // on HTTP 404) onto their still-pending Protocol requests, by correlating with
  // the Network log via JSON-RPC id. Returns `messages` unchanged when nothing
  // matched, so the Protocol view only re-renders when an enrichment applies.
  const protocolEntries = useMemo(
    () => enrichProtocolEntries(messages, fetchRequests),
    [messages, fetchRequests],
  );

  // Surface the otherwise-invisible "response body dropped after rotation" case
  // (#1390) as a deduped toast that links to this server's Network Log Size
  // setting. The state manager only emits this when the drop is genuinely due
  // to rotation (log at capacity), not for benign post-clear stragglers.
  useEffect(() => {
    const fetchRequestLogState = stores?.fetchRequestLogState;
    if (!fetchRequestLogState || activeServerId === undefined) return;
    const onBodyDropped = (
      event: TypedEventGeneric<
        FetchRequestLogStateEventMap,
        "fetchRequestBodyDropped"
      >,
    ) => {
      notifications.show({
        id: bodyDroppedToastId(activeServerId),
        title: "Network log: response body dropped",
        color: "yellow",
        // Stays until dismissed (or the user opens settings via the link) so a
        // single toast represents an ongoing condition rather than flashing per
        // drop; the stable id dedupes a storm into this one toast.
        autoClose: false,
        message: (
          <FetchBodyDroppedToastMessage
            maxFetchRequests={event.detail.maxFetchRequests}
            onAdjust={() => {
              notifications.hide(bodyDroppedToastId(activeServerId));
              setSettingsModalTargetId(activeServerId);
            }}
          />
        ),
      });
    };
    fetchRequestLogState.addEventListener(
      "fetchRequestBodyDropped",
      onBodyDropped,
    );
    return () => {
      fetchRequestLogState.removeEventListener(
        "fetchRequestBodyDropped",
        onBodyDropped,
      );
    };
  }, [stores, activeServerId]);

  // Server-initiated sampling / elicitation requests. These arrive while a call
  // (e.g. a tool execution) is in flight and block it until the user responds.
  const { pendingSamples, pendingElicitations } =
    usePendingClientRequests(inspectorClient);

  // The Server Info modal needs the active server's transport and (optional)
  // OAuth details — both are co-located here so the modal opens against the
  // same connection snapshot the header is reading. Also feeds the
  // `initializeResult` serverInfo fallback below.
  const activeServer = useMemo<ServerEntry | undefined>(
    () => servers.find((s) => s.id === activeServerId),
    [servers, activeServerId],
  );

  // Whether the server actually reported `serverInfo`, vs. the catalog-name
  // fallback synthesized below. Threaded to the Connection Info modal so it can
  // show "not reported" instead of an inferred name that looks server-sent.
  const serverInfoReported = serverInfo !== undefined;

  // Build the InitializeResult the connected ViewHeader / Connection Info
  // modal expect from the hook's split fields. `protocolVersion` is the value
  // the InspectorClient negotiated during initialize (#1324); it's dispatched
  // alongside serverInfo, so in practice it's present whenever we're connected.
  // We gate only on `connectionStatus`, never on serverInfo or protocolVersion:
  // this object also drives the connected header (and its whole tab bar) and the
  // Connection Info modal, so a missing field must not hide those.
  //
  // A modern-era server's `server/discover` makes `serverInfo` OPTIONAL (SHOULD,
  // not MUST — it's stamped in `_meta["io.modelcontextprotocol/serverInfo"]`), so
  // a conforming modern server may omit it and `serverInfo` stays undefined even
  // while connected. Falling back to the catalog name (rather than returning
  // `undefined`) keeps the header + tabs rendered for those servers (#1772). It
  // fires for such a modern server — and, harmlessly, in the batched instant on
  // any connect (legacy included) between the `connected` status dispatch and the
  // `serverInfo` dispatch, which land in a single React render. The modal uses
  // `serverInfoReported` (above), not this name, to stay faithful.
  //
  // This `??` only covers an *absent* serverInfo. A server that *reports* a
  // blank name (`{ name: "" }`) is degraded for display a layer below, in
  // InspectorView's `resolveHeaderServerInfo` (#1774) — kept there so this
  // faithful object (and thus the modal) never carries a borrowed name.
  const initializeResult = useMemo<InitializeResult | undefined>(() => {
    if (connectionStatus !== "connected") return undefined;
    const resolvedServerInfo = serverInfo ?? {
      name: activeServer?.name ?? "",
      version: "",
    };
    return {
      protocolVersion: protocolVersion ?? "",
      capabilities: capabilities ?? {},
      serverInfo: resolvedServerInfo,
      ...(instructions ? { instructions } : {}),
    };
  }, [
    connectionStatus,
    capabilities,
    serverInfo,
    instructions,
    protocolVersion,
    activeServer,
  ]);

  // Surface a mid-session transport failure (stdio crash, SSE drop, HTTP 5xx)
  // as a toast. The handshake case is handled in `onToggleConnection`'s catch;
  // this covers the `status: connected → error` transition that fires the
  // client's `error` event without rejecting any awaited promise (#1323).
  // `lastError` clears at the next connecting edge, so each failure toasts once.
  useEffect(() => {
    if (!lastError) return;
    const name = sessionRef.current.activeServerName;
    notifications.show({
      title: name ? `Connection to "${name}" lost` : "Connection lost",
      message: lastError,
      color: "red",
    });
  }, [sessionRef, lastError]);

  // `config.type` is optional in the schema (a bare `command: ...`
  // entry implies stdio), so we materialize the default here rather
  // than at the render site — the modal's `transport` prop is a
  // required `ServerType`, and we only render the modal once we know
  // there's an active server (see the `{initializeResult && activeServer && …}`
  // guard below).
  const connectionInfoTransport: ServerType =
    activeServer?.config.type ?? "stdio";

  const connectionInfoCanClearOAuth =
    connectionStatus === "connected" &&
    !!inspectorClient &&
    (connectionInfoTransport === "streamable-http" ||
      connectionInfoTransport === "sse");

  // Derive log entries from the message log. Filters for
  // `notifications/message` (the response to `logging/setLevel`).
  const logs = useMemo<LogEntryData[]>(
    () => messagesToLogEntries(messages),
    [messages],
  );

  // Make the live client reflect one settings value, in full. Every path that
  // decides what the active server's settings *are* goes through this: the
  // settings modal's close (#1444), and each write's settled / rolled-back
  // reconciliation (#2089). It is one function because the live surface is more
  // than `setServerSettings` — a partial re-application would leave the Network
  // log sized for, and the server advertised roots from, a value that is not on
  // disk. Reads the client through its ref so a write outliving a reconnect
  // applies to the instance that exists now.
  const applyLiveServerSettings = useCallback(
    (settings: InspectorServerSettings) => {
      const client = sessionRef.current.inspectorClient;
      if (!client) return;
      // Settings the managed state reads at notification time
      // (auto-refresh-on-list-changed) take effect without a reconnect (#1444).
      // Connection-time inputs (transport, OAuth, timeouts) still only apply on
      // the next connect.
      client.setServerSettings(settings);
      // Resize the Network log buffer live so a maxFetchRequests edit takes
      // effect without a reconnect (shrinking trims immediately).
      fetchLogRef.current?.setMaxFetchRequests(settings.maxFetchRequests);
      // Root edits are diffed against what the client currently advertises
      // (both cleaned) and notified only when they differ: `setRoots` fires
      // `notifications/roots/list_changed`, which makes the server re-request
      // `roots/list`.
      const nextRoots = cleanRoots(settings.roots);
      const currentRoots = cleanRoots(client.getRoots());
      if (JSON.stringify(nextRoots) !== JSON.stringify(currentRoots)) {
        void client.setRoots(nextRoots).catch(() => {
          // setRoots swallows notification failures internally; a throw here
          // only means the client is mid-teardown — the persisted roots will
          // re-advertise on the next connect, so nothing to surface.
        });
      }
    },
    [sessionRef, fetchLogRef],
  );

  // --- Action handlers that route directly to the InspectorClient. ---

  const onCallTool = useCallback(
    async (
      name: string,
      args: Record<string, unknown>,
      runAsTask?: boolean,
    ) => {
      if (!inspectorClient) return;
      const tool = tools.find((t: Tool) => t.name === name);
      if (!tool) return;
      // Route through the task pipeline when the caller asked to (or the tool
      // requires it) — but only if the server advertises task tool calls. Per
      // spec a tool's `taskSupport` is considered only when the server declares
      // `tasks.requests.tools.call`, so without it we never task-augment (even a
      // "required" tool, which then surfaces callTool's "requires task support"
      // error). The created task shows up on the Tasks screen via the
      // `requestorTaskUpdated` events callToolStream dispatches, and its live
      // status/progress surface as toasts + progress bar.
      // Legacy servers advertise task tool calls via
      // `tasks.requests.tools.call`. Modern servers (SEP-2663) instead negotiate
      // the `io.modelcontextprotocol/tasks` extension and are server-directed:
      // task creation is decided per-request by the server, so declaring the
      // extension on the call (which the task path does) is what makes a returned
      // task handle legal ("unsolicited handles"). Either era routes the flagged
      // call through the streaming task pipeline.
      const serverSupportsTaskToolCalls =
        !!capabilities?.tasks?.requests?.tools?.call ||
        inspectorClient.isTasksExtensionNegotiated();
      const asTask =
        serverSupportsTaskToolCalls &&
        (runAsTask || tool.execution?.taskSupport === "required");
      // Drop any prior call's task id before starting; a task-augmented call
      // repopulates it via the `toolCallTaskUpdated` listener below, an ordinary
      // call leaves it cleared (#1455).
      activeToolCallTaskIdRef.current = undefined;
      setToolCallState({ status: "pending" });
      try {
        // ToolsScreen types the args as `Record<string, unknown>` (it accepts
        // anything the user types into the schema form). `callTool` requires
        // `Record<string, JsonValue>` — narrow at the boundary instead of
        // claiming the object is empty (which the previous `as Record<string,
        // never>` cast did, misleadingly).
        const invocation = asTask
          ? await inspectorClient.callToolStream(
              tool,
              args as Record<string, JsonValue>,
              undefined,
              undefined,
              { ttl: activeServer?.settings?.taskTtl || DEFAULT_TASK_TTL_MS },
            )
          : await inspectorClient.callTool(
              tool,
              args as Record<string, JsonValue>,
            );
        setToolCallState({
          status: invocation.success ? "ok" : "error",
          result: invocation.result ?? undefined,
          error: invocation.error,
        });
      } catch (err) {
        if (err instanceof AuthRecoveryRequiredError) {
          setToolCallState(undefined);
          if (activeServerId) {
            await handleCommandScopedAuthRecovery(err, {
              serverId: activeServerId,
              source: "tool",
            });
          }
          return;
        }
        // The user cancelled the in-flight call (Cancel button → cancelToolCall).
        // The cancellation notification was already sent to the server, so just
        // clear the executing state — surfacing it as an error would read as a
        // failure rather than the deliberate cancel it was (#1458).
        if (err instanceof ToolCallCancelledError) {
          setToolCallState(undefined);
          notifications.show({
            title: "Tool call cancelled",
            message: "A cancellation request was sent to the server.",
            color: "gray",
            autoClose: 3000,
          });
          return;
        }
        // The server kept asking for a URL the user already completed this call,
        // so callTool aborted to avoid an endless re-prompt loop. Surface that
        // explicitly rather than as a generic failure.
        if (err instanceof UrlElicitationLoopError) {
          setToolCallState({ status: "error", error: err.message });
          notifications.show({
            autoClose: false,
            title: "URL elicitation loop",
            color: "yellow",
            message: (
              <Text size="sm">
                The server requested the same URL again after you completed it (
                {err.url}), so the call was cancelled to avoid an endless loop.
              </Text>
            ),
          });
          return;
        }
        // A URLElicitationRequired (-32042) error that reaches here carried no
        // elicitations (a non-spec response — the with-list case is handled and
        // retried inside callTool). There's no URL to open, so surface a short
        // toast that links to the raw error rather than a bare error panel.
        const urlElicitations = getUrlElicitationsFromError(err);
        if (urlElicitations !== null && urlElicitations.length === 0) {
          const details = {
            toolName: name,
            details: formatErrorDetails(err),
          };
          setToolCallState({ status: "error", error: errorMessage(err) });
          notifications.show({
            autoClose: false,
            title: "URL elicitation required",
            color: "yellow",
            message: (
              <UrlElicitationErrorToastMessage
                onViewDetails={() => setUrlElicitationErrorDetails(details)}
              />
            ),
          });
          return;
        }
        setToolCallState({
          status: "error",
          error: errorMessage(err),
          errorCode: errorCodeOf(err),
        });
      }
    },
    [
      inspectorClient,
      tools,
      activeServer,
      capabilities,
      activeServerId,
      handleCommandScopedAuthRecovery,
      activeToolCallTaskIdRef,
    ],
  );

  const onClearToolResult = useCallback(() => {
    setToolCallState(undefined);
  }, []);

  // Tools UI changes flow through here so selecting a *different* tool also
  // drops the previous tool's result — the result panel renders `toolCallState`
  // regardless of selection, so without this a stale result would linger under
  // the newly-selected tool (which has no result of its own yet). Search and
  // form edits keep `selectedToolKey` unchanged, so they leave the result be.
  // Depends on `selectedToolKey` only (not the whole `toolsUi`), so a search
  // keystroke doesn't churn the callback identity.
  const onToolsUiChange = useCallback(
    (next: ToolsUiState) => {
      if (next.selectedToolKey !== ui.toolsUi.selectedToolKey) {
        setToolCallState(undefined);
      }
      setUi.setToolsUi(next);
    },
    [ui.toolsUi.selectedToolKey, setUi],
  );

  // --- MCP Apps handlers. Unlike onCallTool (which feeds the Tools panel),
  // these route the tool input/result into the running app via the renderer's
  // imperative handle. ---

  // Surfaces bridge/runtime failures (factory throw — e.g. no client after a
  // disconnect — late bridge rejection, or a failed tools/call) that would
  // otherwise leave a silently blank app iframe.
  const onAppError = useCallback((err: Error) => {
    notifications.show({
      title: "MCP App error",
      message: err.message,
      color: "red",
    });
  }, []);

  // Selection is owned by AppsScreen's local state; App.tsx has nothing to do
  // on select, but the prop is required so the screen stays prop-driven.
  const onSelectApp = useCallback(() => {}, []);

  const onOpenApp = useCallback(
    async (name: string, args: Record<string, unknown>) => {
      if (!inspectorClient) return;
      const tool = tools.find((t: Tool) => t.name === name);
      if (!tool) return;
      // AppsScreen flips `running` -> mounts AppRenderer in the same tick it
      // calls this, so the renderer handle isn't wired yet. Yield one microtask
      // (after React commits the mount) before pushing input; the renderer then
      // buffers it until the view's `initialized` event, releasing input before
      // result.
      await Promise.resolve();
      void appRendererRef.current?.sendToolInput(args);
      try {
        // skipOutputValidation: the result is forwarded verbatim to the running
        // app (the real consumer), so the host must not reject it on its own
        // outputSchema validation — that would deny the app a result the server
        // actually returned and legacy hosts render fine.
        const invocation = await inspectorClient.callTool(
          tool,
          args as Record<string, JsonValue>,
          undefined,
          undefined,
          undefined,
          { skipOutputValidation: true },
        );
        if (invocation.success && invocation.result) {
          void appRendererRef.current?.sendToolResult(invocation.result);
        }
        // Leniency above keeps the app rendering, but surface the schema
        // mismatch so a server developer knows strict MCP clients may refuse
        // to render this app. The full validation error is too long for a
        // toast, so summarize and link to a modal with the details.
        if (invocation.outputValidationError) {
          const details = {
            toolName: tool.name,
            message: invocation.outputValidationError,
          };
          notifications.show({
            // Don't auto-dismiss: the message is advisory and the details modal
            // is one click away — let the user close it when they've read it.
            autoClose: false,
            title: "App output doesn't match its schema",
            color: "yellow",
            message: (
              <OutputValidationToastMessage
                onViewDetails={() => setOutputValidationDetails(details)}
              />
            ),
          });
        }
      } catch (err) {
        if (err instanceof AuthRecoveryRequiredError) {
          if (activeServerId) {
            const satisfied = await handleCommandScopedAuthRecovery(err, {
              serverId: activeServerId,
              source: "app",
            });
            if (!satisfied) {
              onAppError(
                new Error(
                  "Authorization required. Complete sign-in, then reopen the app.",
                ),
              );
            }
          }
          return;
        }
        // Transport-level failure (the call never returned a result). Surface it
        // so the user isn't left staring at a blank/partial app frame.
        onAppError(err instanceof Error ? err : new Error(String(err)));
      }
    },
    [
      inspectorClient,
      tools,
      onAppError,
      activeServerId,
      handleCommandScopedAuthRecovery,
      appRendererRef,
    ],
  );

  const onCloseApp = useCallback(() => {
    void appRendererRef.current?.teardown();
  }, [appRendererRef]);

  const onGetPrompt = useCallback(
    async (name: string, args: Record<string, string>) => {
      if (!inspectorClient) return;
      // Tag the in-flight + final state with the prompt name so the
      // PromptsScreen can guard against showing a stale result for a
      // prompt the user has already navigated away from.
      setGetPromptState({ status: "pending", promptName: name });
      try {
        const invocation = await inspectorClient.getPrompt(name, args);
        setGetPromptState({
          status: "ok",
          promptName: name,
          result: invocation.result,
        });
      } catch (err) {
        if (err instanceof AuthRecoveryRequiredError) {
          setGetPromptState(undefined);
          if (activeServerId) {
            await handleCommandScopedAuthRecovery(err, {
              serverId: activeServerId,
              source: "prompt",
            });
          }
          return;
        }
        setGetPromptState({
          status: "error",
          promptName: name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [inspectorClient, activeServerId, handleCommandScopedAuthRecovery],
  );

  const onReadResource = useCallback(
    async (uri: string) => {
      if (!inspectorClient) return;
      setReadResourceState({ status: "pending", uri });
      try {
        const invocation = await inspectorClient.readResource(uri);
        setReadResourceState({
          status: "ok",
          uri,
          result: invocation.result,
          lastUpdated: invocation.timestamp,
        });
      } catch (err) {
        if (err instanceof AuthRecoveryRequiredError) {
          setReadResourceState(undefined);
          if (activeServerId) {
            await handleCommandScopedAuthRecovery(err, {
              serverId: activeServerId,
              source: "resource",
            });
          }
          return;
        }
        setReadResourceState({
          status: "error",
          uri,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [inspectorClient, activeServerId, handleCommandScopedAuthRecovery],
  );

  // Read-on-demand handler for `resource_link` blocks in a tool result. Unlike
  // `onReadResource` (which drives the Resources screen's preview panel via
  // shared state), this returns the contents directly so each ResourceLink can
  // own and inline its own fetched content.
  const onReadResourceContents = useCallback(
    async (uri: string) => {
      if (!inspectorClient) throw new Error("Client is not connected");
      const read = () => inspectorClient.readResource(uri);
      try {
        const invocation = await read();
        return invocation.result;
      } catch (err) {
        if (err instanceof AuthRecoveryRequiredError && activeServerId) {
          const satisfied = await handleCommandScopedAuthRecovery(err, {
            serverId: activeServerId,
            source: "resource",
          });
          if (satisfied) {
            const retry = await read();
            return retry.result;
          }
        }
        throw err;
      }
    },
    [inspectorClient, activeServerId, handleCommandScopedAuthRecovery],
  );

  const onSubscribeResource = useCallback(
    (uri: string) => {
      if (!inspectorClient) return;
      void inspectorClient.subscribeToResource(uri);
    },
    [inspectorClient],
  );

  const onUnsubscribeResource = useCallback(
    (uri: string) => {
      if (!inspectorClient) return;
      void inspectorClient.unsubscribeFromResource(uri);
    },
    [inspectorClient],
  );

  const onCompleteArgument = useCallback(
    async (
      ref:
        | { type: "ref/resource"; uri: string }
        | { type: "ref/prompt"; name: string },
      argumentName: string,
      argumentValue: string,
      context: Record<string, string>,
    ): Promise<string[]> => {
      if (!inspectorClient) return [];
      const result = await runWithCommandAuthRecovery(
        () =>
          inspectorClient.getCompletions(
            ref,
            argumentName,
            argumentValue,
            context,
          ),
        "tool",
      );
      return result?.values ?? [];
    },
    [inspectorClient, runWithCommandAuthRecovery],
  );

  const onCancelTask = useCallback(
    async (taskId: string) => {
      if (!inspectorClient) return;
      try {
        await runWithCommandAuthRecovery(
          () => inspectorClient.cancelRequestorTask(taskId),
          "tool",
        );
      } catch (err) {
        if (err instanceof AuthRecoveryRequiredError) {
          return;
        }
        notifications.show({
          title: "Failed to cancel task",
          message: err instanceof Error ? err.message : String(err),
          color: "red",
        });
      }
    },
    [inspectorClient, runWithCommandAuthRecovery],
  );

  // Cancel the in-flight tool call. A task-augmented call (run-as-task) has a
  // server-side task, so cancel that via the tasks API (#1455) — the cancelled
  // status then flows back through the managed task store and toasts, the same
  // as cancelling from the Tasks screen. An ordinary call has no task, so abort
  // its request: the SDK sends a `notifications/cancelled` to the server (the
  // MCP cancellation flow) and the pending call rejects with a
  // ToolCallCancelledError that `onCallTool` clears as a cancellation (#1458).
  const onCancelToolCall = useCallback(() => {
    if (!inspectorClient) return;
    const taskId = activeToolCallTaskIdRef.current;
    if (taskId) {
      // Clear the ref before the call resolves so a rapid second Cancel click
      // doesn't re-cancel the now-terminating task (which would surface a
      // spurious "Failed to cancel task" toast).
      activeToolCallTaskIdRef.current = undefined;
      void onCancelTask(taskId);
      return;
    }
    inspectorClient.cancelToolCall();
  }, [inspectorClient, onCancelTask, activeToolCallTaskIdRef]);

  const onClearCompletedTasks = useCallback(() => {
    clearCompletedTasks();
  }, [clearCompletedTasks]);

  const onSetLogLevel = useCallback(
    (level: LoggingLevel) => {
      setCurrentLogLevel(level);
      if (!inspectorClient) return;
      // Nothing else records a `logging/setLevel` failure, and the optimistic
      // level above already moved — so report it, or the selector would sit on
      // a level the server never accepted with no explanation.
      runCommandInBackground(
        () => inspectorClient.setLoggingLevel(level),
        "ambient",
        "Failed to set log level",
      );
    },
    [inspectorClient, runCommandInBackground],
  );

  // Modern era (#1629): no request is sent — the client stores the level and
  // stamps it on every subsequent request's `_meta`. `null` opts back out.
  const onSetModernLogLevel = useCallback(
    (level: LoggingLevel | null) => {
      setModernLogLevel(level);
      inspectorClient?.setModernLogLevel(level ?? undefined);
    },
    [inspectorClient],
  );

  // Refresh acts per pagination mode: in paginated mode reload page 1 (the
  // paged state); in all-pages mode re-fetch the whole aggregate with auth
  // recovery (the pre-existing path). See usePaginatedList / #1721.
  const onRefreshTools = useCallback(() => {
    if (paginatedLists) {
      // Paginated refresh reloads page 1 of the paged store, bypassing the
      // managed hook's refresh — so acknowledge the list-changed indicator here
      // (the managed state lit it on `list_changed`; nothing else clears it in
      // paginated mode) (#1721).
      clearToolsListChanged();
      runCommandInBackground(() => toolsPagination.onRefresh(), "ambient");
    } else {
      runCommandInBackground(() => refreshTools(), "ambient");
    }
  }, [
    paginatedLists,
    toolsPagination,
    refreshTools,
    clearToolsListChanged,
    runCommandInBackground,
  ]);
  const onRefreshPrompts = useCallback(() => {
    if (paginatedLists) {
      clearPromptsListChanged();
      runCommandInBackground(() => promptsPagination.onRefresh(), "ambient");
    } else {
      runCommandInBackground(() => refreshPrompts(), "ambient");
    }
  }, [
    paginatedLists,
    promptsPagination,
    refreshPrompts,
    clearPromptsListChanged,
    runCommandInBackground,
  ]);
  const onRefreshResources = useCallback(() => {
    if (paginatedLists) {
      clearResourcesListChanged();
      runCommandInBackground(() => resourcesPagination.onRefresh(), "ambient");
      // Resource templates always use the managed (aggregate) path.
      runCommandInBackground(() => refreshResourceTemplates(), "ambient");
    } else {
      runCommandInBackground(async () => {
        await refreshResources();
        await refreshResourceTemplates();
      }, "ambient");
    }
  }, [
    paginatedLists,
    resourcesPagination,
    refreshResources,
    refreshResourceTemplates,
    clearResourcesListChanged,
    runCommandInBackground,
  ]);
  // The per-list sidebar toggle edits the server-wide `paginatedLists` setting:
  // optimistic override for an instant flip, live push so the managed state's
  // gating reads it now, and a persisted PUT so it survives reconnects (#1721).
  const onTogglePaginatedLists = useCallback(
    (value: boolean) => {
      const current = servers.find((s) => s.id === activeServerId);
      if (!current || activeServerId === undefined) return;
      // Recorded against this server rather than app-wide, so it survives a
      // switch away and back (#2095). Ordered after the id guard because the
      // record is keyed by that id; with no active server there is nothing the
      // toggle could have been flipped for.
      paginatedListsOverride.record(activeServerId, value);
      // Not `current.settings` directly: that entry only advances on a
      // successful list read, so once one has failed it describes disk as it
      // was *before* the writes made since. Build on the last write known to
      // have landed while that is the fresher account (#2089).
      const next: InspectorServerSettings = {
        ...(lastPersistedSettings.resolve(activeServerId) ?? EMPTY_SETTINGS),
        paginatedLists: value,
      };
      inspectorClient?.setServerSettings(next);
      // Drive the load that the mode change implies (data-loading stays out of
      // React effects; the paged stores own only the connect-time load). To
      // paginated: pull page 1 into each paged store. To all-pages: refetch
      // each managed aggregate that was gated off. Only when connected.
      if (connected) {
        // Wrap in ambient auth recovery so a mid-session 401 triggers re-auth
        // rather than surfacing raw, matching the all-pages refresh path.
        if (value) {
          runCommandInBackground(() => loadToolsPage(undefined), "ambient");
          runCommandInBackground(() => loadPromptsPage(undefined), "ambient");
          runCommandInBackground(() => loadResourcesPage(undefined), "ambient");
        } else {
          runCommandInBackground(() => refreshTools(), "ambient");
          runCommandInBackground(() => refreshPrompts(), "ambient");
          runCommandInBackground(() => refreshResources(), "ambient");
        }
      }
      // Refreshed like every other secret-store mutation: this resends the
      // server's rehydrated secrets, so it can trigger the pending
      // plaintext-to-encrypted upgrade even though the user only toggled
      // pagination (#1950 review r22).
      // Announced before the request goes out, so two toggles in flight at once
      // are ordered by when they were issued rather than by which one's list
      // reload finished first (#2089).
      const write = lastPersistedSettings.begin(activeServerId);
      // This value is on disk now. Remember it as the rollback baseline for
      // whatever is written next, since the `servers` entry it was derived
      // from will keep describing the old value if the reload behind this
      // write — or any later one — fails (#2089).
      //
      // Re-apply it when this write is the settled one: an overlapping toggle
      // that failed *first* rolled the UI and the live client back to a
      // baseline this write has since replaced, and if the list read behind
      // this write failed too, nothing else would ever correct them. Through
      // the *current* client, not this continuation's closure: a reconnect to
      // the same server passes the id check while the captured instance is
      // already destroyed.
      const settlePaginationWrite = () => {
        const settled = write.landed(next);
        if (!settled) return;
        // The override is keyed by server, so it is re-applied whatever is
        // active now — it is this server's value and is only ever displayed
        // while this server is the active one. The live client is not: it
        // belongs to whichever server is connected (#2095).
        paginatedListsOverride.record(
          activeServerId,
          next.paginatedLists ?? false,
        );
        if (sessionRef.current.activeServerId === activeServerId) {
          applyLiveServerSettings(next);
        }
      };
      void refreshingPersist(updateServerSettings, refreshInitialConfig)(
        activeServerId,
        next,
      )
        .then(settlePaginationWrite)
        .catch((err: unknown) => {
          // A `ServerListReloadError` means the PUT landed and only reading the
          // list back failed, so the new setting IS on disk (#1914). That is a
          // landed write, not a failed one: rolling back would put the UI and
          // the live client on the *old* value and contradict disk. Settle it
          // exactly as the success path does and report only the failed reload.
          if (err instanceof ServerListReloadError) {
            settlePaginationWrite();
            notifications.show({
              title:
                "Pagination setting saved, but the server list did not reload",
              message: err.message,
              color: "red",
            });
            return;
          }
          // This write is over and never reached disk, so it stops counting as
          // in flight: an earlier write still running is the settled state once
          // it lands, and is what re-applies the UI this rollback is about to
          // set (#2089).
          write.failed();
          // Persist failed: revert the optimistic override and roll the live
          // client setting back, so the UI and client reflect the value that's
          // actually on disk rather than the failed edit (#1721).
          //
          // The baseline is resolved *here*, not captured when this write was
          // issued: another toggle can land in between, and its value is what
          // disk holds by the time this one fails. The override is set to that
          // baseline rather than cleared, because clearing it falls back to
          // `persistedPaginatedLists` — read from a `servers` entry that may be
          // stale, showing the same wrong value from the other side (#2089).
          //
          // The override is recorded whatever is active by the time this
          // rejection arrives: it is keyed by this write's server and is only
          // ever displayed while that server is the active one, so a switch in
          // between costs nothing and dropping it would leave the stale entry
          // to answer for A the next time it comes back (#2095).
          //
          // The live client is the half that stays gated — it belongs to
          // whichever server is connected now, so pushing this server's value
          // into it after a switch would apply it to another one. It is taken
          // from the ref for the same reason the success path does: a reconnect
          // to the same server passes the id check while this continuation's
          // captured instance is already destroyed.
          const baseline =
            lastPersistedSettings.resolve(activeServerId) ?? EMPTY_SETTINGS;
          paginatedListsOverride.record(
            activeServerId,
            baseline.paginatedLists ?? false,
          );
          if (sessionRef.current.activeServerId === activeServerId) {
            applyLiveServerSettings(baseline);
          }
          notifications.show({
            title: "Failed to save pagination setting",
            message: err instanceof Error ? err.message : String(err),
            color: "red",
          });
        });
    },
    [
      sessionRef,
      servers,
      activeServerId,
      lastPersistedSettings,
      paginatedListsOverride,
      applyLiveServerSettings,
      inspectorClient,
      updateServerSettings,
      refreshInitialConfig,
      connected,
      loadToolsPage,
      loadPromptsPage,
      loadResourcesPage,
      refreshTools,
      refreshPrompts,
      refreshResources,
      runCommandInBackground,
    ],
  );
  // Wrap Load-next-page in ambient auth recovery too, so a paginated
  // paginated fetch that hits a 401 recovers like the all-pages path (#1721).
  const onLoadMoreTools = useCallback(
    () => runCommandInBackground(() => toolsPagination.onLoadMore(), "ambient"),
    [toolsPagination, runCommandInBackground],
  );
  const onLoadMorePrompts = useCallback(
    () =>
      runCommandInBackground(() => promptsPagination.onLoadMore(), "ambient"),
    [promptsPagination, runCommandInBackground],
  );
  const onLoadMoreResources = useCallback(
    () =>
      runCommandInBackground(() => resourcesPagination.onLoadMore(), "ambient"),
    [resourcesPagination, runCommandInBackground],
  );
  const toolsPaginationControls: ListPaginationControlsProps = {
    paginated: toolsPagination.paginated,
    onPaginatedChange: onTogglePaginatedLists,
    canLoadMore: toolsPagination.canLoadMore,
    loadedPages: toolsPagination.loadedPages,
    onLoadMore: onLoadMoreTools,
  };
  const promptsPaginationControls: ListPaginationControlsProps = {
    paginated: promptsPagination.paginated,
    onPaginatedChange: onTogglePaginatedLists,
    canLoadMore: promptsPagination.canLoadMore,
    loadedPages: promptsPagination.loadedPages,
    onLoadMore: onLoadMorePrompts,
  };
  const resourcesPaginationControls: ListPaginationControlsProps = {
    paginated: resourcesPagination.paginated,
    onPaginatedChange: onTogglePaginatedLists,
    canLoadMore: resourcesPagination.canLoadMore,
    loadedPages: resourcesPagination.loadedPages,
    onLoadMore: onLoadMoreResources,
  };
  const onRefreshTasks = useCallback(() => {
    runCommandInBackground(
      () => refreshTasks(),
      "ambient",
      "Failed to refresh tasks",
    );
  }, [refreshTasks, runCommandInBackground]);

  // Clear / Export / Replay for the four log-ish views (Logs, Protocol,
  // Network, Console), plus the Protocol per-section variants.
  const {
    onClearLogs,
    onClearProtocol,
    onClearNetwork,
    onClearConsole,
    onExportLogs,
    onExportProtocol,
    onExportNetwork,
    onExportConsole,
    onClearProtocolSection,
    onExportProtocolSection,
    onReplayProtocol,
  } = useExportActions({
    activeServerId,
    messageLogState: stores?.messageLogState ?? null,
    fetchRequestLogState: stores?.fetchRequestLogState ?? null,
    stderrLogState: stores?.stderrLogState ?? null,
    messages,
    fetchRequests,
    logs,
    stderrLogs,
    pinnedProtocolIds,
    setPinnedProtocolIds,
    inspectorClient,
    tools,
  });

  // Download the current server list as a canonical mcp.json file. Uses the
  // in-memory `servers` list (kept in sync with disk by useServers' refresh-
  // after-mutate flow) so there's no extra HTTP roundtrip. Serialization
  // format (2-space indent) lives in serializeMcpConfig so the export
  // matches what serializeStore writes on the backend. The button is
  // disabled when the list is empty, but the guard here keeps the handler
  // locally correct against any future programmatic caller.
  const onServerExport = useCallback(() => {
    if (servers.length === 0) return;
    downloadJsonFile("mcp.json", serializeMcpConfig(servers));
  }, [servers]);

  // Remove handler — runs after the user confirms in the modal. When removing
  // the active server, also tear down the session in-place so the client and
  // its 9 state managers can be GC'd now instead of lingering until the next
  // server switch. Mirrors the destroy sequence at the top of
  // `setupClientForServer` (lines ~304-312) but additionally nulls every ref.
  const onConfirmRemove = useCallback(async () => {
    if (!removeTarget) return;
    const id = removeTarget.id;
    if (id === activeServerId) {
      if (inspectorClient) {
        await inspectorClient.disconnect();
      }
      destroyStores();
      setInspectorClient(null);
      setActiveServerId(undefined);
    }
    // Deleting sweeps the server's secrets from the store, which for a
    // file-backed store is a write — and a write is what performs the pending
    // plaintext-to-encrypted upgrade (#1950 review r22).
    await refreshingPersist(removeServer, refreshInitialConfig)(id);
    setRemoveTarget(null);
  }, [
    removeTarget,
    activeServerId,
    inspectorClient,
    destroyStores,
    removeServer,
    refreshInitialConfig,
  ]);

  // Submit handler for the Add / Edit / Clone modal. Add and Clone both go
  // through addServer; Edit uses updateServer (which supports id rename).
  // Add a server, then mark it as the freshly-added one so the list scrolls to
  // it and highlights it. Used by manual add/clone and both import flows; edits
  // and conflict-overwrites (updateServer) intentionally don't highlight.
  // Accumulates into the current highlight batch (a multi-server import adds
  // each id), deduped. The batch is reset to empty when an add/import modal
  // opens (see the menu handlers).
  const addServerHighlighted = useCallback(
    async (id: string, config: MCPServerConfig) => {
      const markAdded = () =>
        setHighlightedServerIds((ids) =>
          ids.includes(id) ? ids : [...ids, id],
        );
      try {
        await addServer(id, config);
      } catch (err) {
        // A failed list reload still means the row is on disk, so it belongs
        // in the highlight batch — the next successful refresh is what
        // renders it, and it would otherwise arrive unmarked (#1914 r2).
        if (err instanceof ServerListReloadError) markAdded();
        throw err;
      }
      markAdded();
    },
    [addServer],
  );

  // On rename of the active server, keep activeServerId pointed at the new id.
  const onConfigSubmit = useCallback(
    async (id: string, config: MCPServerConfig) => {
      if (configModal?.mode === "edit" && configModal.targetId) {
        const originalId = configModal.targetId;
        const followRename = () => {
          if (originalId === activeServerId && id !== originalId) {
            setActiveServerId(id);
          }
        };
        try {
          await updateServer(originalId, id, config);
        } catch (err) {
          // A `ServerListReloadError` means the PUT landed and only reading
          // the list back failed — the rename IS on disk. The active
          // selection has to follow it anyway, or the next successful
          // refresh leaves `activeServerId` pointing at an id that no longer
          // exists (#1914 r2). Still rethrow, so the modal shows the reload
          // error rather than closing as if nothing happened.
          if (err instanceof ServerListReloadError) followRename();
          throw err;
        }
        followRename();
        return;
      }
      // add or clone
      await addServerHighlighted(id, config);
    },
    [configModal, addServerHighlighted, updateServer, activeServerId],
  );

  // Derive the existingIds list the modal uses for uniqueness validation.
  // In edit mode the target's own id must be excluded so saving without
  // renaming doesn't trip the "already exists" check.
  const existingIds = useMemo(() => {
    const ids = servers.map((s) => s.id);
    if (configModal?.mode === "edit" && configModal.targetId) {
      return ids.filter((id) => id !== configModal.targetId);
    }
    return ids;
  }, [servers, configModal]);

  const configModalTarget = useMemo(() => {
    if (!configModal?.targetId) return undefined;
    return servers.find((s) => s.id === configModal.targetId);
  }, [configModal, servers]);

  // An edit/clone modal whose target has left the list can no longer render a
  // coherent form: `initialId`/`initialConfig` go undefined, and
  // ServerConfigModal's own `useValueChange` reset then blanks the open form
  // *and* clears the error it is showing.
  //
  // Only reachable since #1914 made the modal stay open on a failed post-write
  // reload: rename A → B, the PUT lands, the reload fails, and the modal sits
  // there targeting A. The write itself is what triggers the backend's change
  // broadcast, so the SSE-driven background refresh that lands B (and drops A)
  // is the *likely* next event, not a remote one. Closing is right — the edit
  // is on disk and the list now agrees — and it covers the ordinary case too,
  // where an external mcp.json edit removes the server being edited.
  //
  // Adjusted during render rather than in an effect (see `useValueChange`), so
  // no frame ever paints the blanked form.
  useValueChange(
    configModal?.mode === "add" || configModal?.targetId === undefined
      ? true
      : servers.some((s) => s.id === configModal.targetId),
    (targetPresent) => {
      if (!targetPresent) setConfigModal(null);
    },
  );

  const settingsModalTarget = useMemo(() => {
    if (!settingsModalTargetId) return undefined;
    return servers.find((s) => s.id === settingsModalTargetId);
  }, [settingsModalTargetId, servers]);

  const settingsModalServerType = settingsModalTarget
    ? getServerType(settingsModalTarget.config)
    : "stdio";

  // The settings modal is fully controlled — every input change fires
  // `onSettingsChange` back up here, and the input's `value` prop only
  // updates when this component re-renders with a new `settings` prop.
  // We hold the in-progress draft in `useSettingsDraft` so every change
  // re-renders synchronously; the hook also debounces the PUT and
  // exposes `flush` for the close handler to call. The draft is
  // (re)initialized only when the modal opens to a *different* server,
  // which is why a background refresh of `servers` can run without
  // clobbering in-progress edits.
  //
  // `resolveInitial` reads `servers` from this render's closure — that
  // works because the settings entry point is the "Settings" button on
  // a rendered server card, so `servers` is always non-empty by the
  // time this hook is called. A future caller that opens the modal
  // from elsewhere (e.g. a keyboard shortcut on initial load) would
  // need a different initialization path; the empty-shell fallback at
  // least keeps the form renderable while `servers` hydrates.
  const {
    draft: settingsDraft,
    onChange: onSettingsChange,
    flush: flushSettingsDraft,
  } = useSettingsDraft<InspectorServerSettings>({
    targetId: settingsModalTargetId,
    // Through the tracker rather than off `servers` directly: after a write
    // lands whose list reload failed, that entry still describes the previous
    // value, so seeding from it and saving an unrelated field would write the
    // superseded value straight back to disk (#2089). `resolve` falls back to
    // the entry when nothing has landed, so the ordinary case is unchanged.
    resolveInitial: (id) => lastPersistedSettings.resolve(id) ?? EMPTY_SETTINGS,
    // The saved settings may include an OAuth client secret or a stdio `env:`
    // value, and writing one can change what the secrets file *is* — the first
    // save under a newly-set passphrase re-encrypts a pre-existing plaintext
    // file. `refreshingPersist` re-asks the backend afterwards; it is a named
    // unit rather than an inline `await …; refresh()` because this file is
    // outside the coverage gate, so wiring written here is tested by nothing
    // (#1950 review r17).
    onPersist: async (id: string, value: InspectorServerSettings) => {
      // Announced before the request, like the toggle's own write: the debounced
      // flush can put two saves for one server in flight, and the later-issued
      // one describes disk however the two happen to finish (#2089).
      const write = lastPersistedSettings.begin(id);
      const settleSettingsWrite = () => {
        const settled = write.landed(value);
        if (!settled) return;
        paginatedListsOverride.record(id, value.paginatedLists ?? false);
        if (sessionRef.current.activeServerId === id) {
          applyLiveServerSettings(value);
        }
      };
      try {
        await refreshingPersist(updateServerSettings, refreshInitialConfig)(
          id,
          value,
        );
      } catch (err) {
        // A `ServerListReloadError` means the PUT landed and only reading the
        // list back failed, so this write did reach disk (#1914): record it
        // like the success path below instead of rolling anything back, and
        // rethrow so `onError` can say the reload — not the save — failed.
        if (err instanceof ServerListReloadError) {
          settleSettingsWrite();
          throw err;
        }
        // Stop counting as in flight before the rejection goes on to
        // `onError` — an earlier write still running settles the state once it
        // lands, and cannot know that while this one looks pending (#2089).
        write.failed();
        // A write that landed while this one was pending was told it was not
        // settled and so applied nothing; this save never reached disk, so that
        // write is the account of it and nothing else will re-apply it. Same
        // reconciliation the toggle's own failure path does.
        const baseline = lastPersistedSettings.resolve(id);
        if (baseline) {
          paginatedListsOverride.record(id, baseline.paginatedLists ?? false);
          if (sessionRef.current.activeServerId === id) {
            applyLiveServerSettings(baseline);
          }
        }
        throw err;
      }
      // Recorded for the same reason the pagination toggle records its own
      // write: this is what disk holds now, and the `servers` entry it was
      // edited from will keep describing the previous value for as long as list
      // reads keep failing. Both settings writers feed the same per-server
      // record, so a rollback in either takes the most recent write for that
      // server, not just the most recent write *of its own kind*.
      //
      // And the reconciliation is shared too, for the mixed-writer overlap: a
      // toggle failing while this save is in flight rolls the UI and the live
      // client back to a baseline this save then replaces on disk, so a settled
      // save has to re-apply itself exactly as a settled toggle does (#2089).
      settleSettingsWrite();
    },
    // Surface failures via toast — the modal usually closes
    // immediately on user dismiss, so a silent fail-on-flush would
    // leave the user thinking their last edits saved when they
    // didn't (especially painful for the OAuth client secret).
    onError: (id, err) => {
      notifications.show({
        // A `ServerListReloadError` means the PUT landed and only reading the
        // list back failed, so "Failed to save" would be false — and this
        // toast is the user's only signal here, since the modal has usually
        // closed by the time a flush rejects (#1914 r3).
        title:
          err instanceof ServerListReloadError
            ? `Saved settings for "${id}", but the server list did not reload`
            : `Failed to save settings for "${id}"`,
        message: err instanceof Error ? err.message : String(err),
        color: "red",
      });
    },
  });

  const settingsModalValue: InspectorServerSettings =
    settingsDraft ?? EMPTY_SETTINGS;

  const {
    draft: clientSettingsDraft,
    onChange: onClientSettingsChange,
    flush: flushClientSettingsDraft,
  } = useClientSettingsDraft({
    opened: clientSettingsOpen,
    resolveInitial: () => clientConfigToFormValues(clientConfig),
    // Wrapped for the same reason as the server-settings persist above: this
    // one can carry the enterprise IdP client secret, and that write is what
    // flips a pending-encryption file to encrypted.
    onPersist: refreshingPersist(async (values) => {
      if (!canPersistClientSettingsDraft(values)) return;
      const next = formValuesToClientConfig(values);
      await saveClientConfigRemote(next, {
        baseUrl: configBaseUrl,
        authToken: getAuthToken(),
      });
      setClientConfig(next);
    }, refreshInitialConfig),
    onError: (err) => {
      notifications.show({
        title: "Failed to save client settings",
        message: formatClientConfigLoadError(err),
        color: "red",
      });
    },
  });

  const clientSettingsModalValue = clientSettingsDraft ?? EMPTY_CLIENT_SETTINGS;

  const { loginState: emaIdpLoginState, logout: logoutEmaIdp } =
    useEmaIdpLoginState(
      webOAuthStorage,
      clientSettingsModalValue.emaEnabled
        ? clientSettingsModalValue.issuer
        : undefined,
      clientSettingsOpen,
    );

  const onClientSettingsModalClose = useCallback(() => {
    // Only fires when ClientSettingsModal allows the close (it blocks on an
    // invalid issuer and reveals the error instead). The implicit "save" is the
    // flush below; the persist gate drops anything still incomplete.
    flushClientSettingsDraft();
    setClientSettingsOpen(false);
  }, [flushClientSettingsDraft]);

  // Gate the stdio-only Working Directory / Environment Variables controls in
  // the settings modal. Derived from the resolved target server's transport
  // (see `settingsModalServerType` above), which defaults to "stdio" when the
  // target isn't resolvable.
  const settingsModalIsStdio = settingsModalServerType === "stdio";

  const handleClearConnectionOAuth = useCallback(() => {
    if (!activeServer) return;
    void clearServerOAuthAndDisconnect(activeServer);
  }, [activeServer, clearServerOAuthAndDisconnect]);

  const handleClearStoredOAuthFromSettings = useCallback(() => {
    if (!settingsModalTarget) return;
    void clearServerOAuthAndDisconnect(settingsModalTarget);
  }, [settingsModalTarget, clearServerOAuthAndDisconnect]);

  const onSettingsModalClose = useCallback(() => {
    flushSettingsDraft();
    // Apply root edits to the live client once, on close — not on every
    // keystroke. `setRoots` fires `notifications/roots/list_changed`, which
    // makes the server re-request `roots/list`; doing that per character while
    // the user types a URI would flood the wire. We diff the final draft roots
    // against what the client currently advertises (both cleaned) and notify
    // only when they actually differ, and only for the connected server.
    if (
      inspectorClient &&
      settingsModalTargetId !== undefined &&
      settingsModalTargetId === activeServerId &&
      settingsDraft
    ) {
      // Normally the draft is what the user just saved, so it is also what is
      // on disk. When this server's last write *rejected* it is not: the draft
      // still holds the failed edit, and applying it here would contradict disk
      // and undo the rollback that reported the failure — so apply what landed
      // instead. `EMPTY_SETTINGS`, not the draft, when nothing has ever landed
      // for this server: falling back to the draft would re-apply the very
      // values that failed (#2089).
      const applied = lastPersistedSettings.lastWriteFailed(
        settingsModalTargetId,
      )
        ? (lastPersistedSettings.resolve(settingsModalTargetId) ??
          EMPTY_SETTINGS)
        : settingsDraft;
      applyLiveServerSettings(applied);
    }
    setSettingsModalTargetId(undefined);
  }, [
    flushSettingsDraft,
    inspectorClient,
    settingsModalTargetId,
    activeServerId,
    settingsDraft,
    lastPersistedSettings,
    applyLiveServerSettings,
  ]);

  // The Resources screen needs `isSubscribed` to flip the Subscribe button
  // label to "Unsubscribe". Derive it from the live subscriptions list rather
  // than threading it through every setReadResourceState site — that way the
  // button reflects state changes from any source (preview panel, subscribed
  // tile, or future server-initiated subscribe notifications).
  const effectiveReadResourceState = useMemo<
    ReadResourceState | undefined
  >(() => {
    if (!readResourceState) return undefined;
    if (!readResourceState.uri) return readResourceState;
    const isSubscribed = subscriptions.some(
      (s) => s.resource.uri === readResourceState.uri,
    );
    return { ...readResourceState, isSubscribed };
  }, [readResourceState, subscriptions]);

  // Surface one pending server-initiated request at a time in the modal,
  // sampling-first. Responding (below) removes it from the client's queue,
  // which re-renders this with the next request or closes the modal.
  const totalPendingRequests =
    pendingSamples.length + pendingElicitations.length;

  // Derive the head request inside the memo (depending on the source arrays)
  // so the memo actually caches — an inline `activeElicitation` would have a
  // fresh identity every render and defeat it.
  const pendingRequestContent =
    useMemo<PendingClientRequestContent | null>(() => {
      const activeSample = pendingSamples[0];
      if (activeSample) {
        return {
          kind: "sampling",
          id: activeSample.id,
          request: activeSample.request.params,
          origin: activeSample.origin,
        };
      }
      const activeElicitation = pendingElicitations[0];
      if (activeElicitation) {
        const params = activeElicitation.request.params;
        if ("url" in params) {
          return {
            kind: "elicitation-url",
            id: activeElicitation.id,
            message: params.message,
            url: params.url,
            origin: activeElicitation.origin,
          };
        }
        return {
          kind: "elicitation-form",
          id: activeElicitation.id,
          request: params,
          origin: activeElicitation.origin,
        };
      }
      return null;
    }, [pendingSamples, pendingElicitations]);

  // A remaining-count hint shown only when more than the displayed head is
  // queued. The modal always shows the head, so a "1 of N" position would be
  // misleading — the leading "1" never changes.
  const queueLabel =
    totalPendingRequests > 1 ? `${totalPendingRequests} pending` : "";

  const onSamplingRespond = useCallback(
    (result: CreateMessageResult) => {
      void pendingSamples[0]?.respond(result);
    },
    [pendingSamples],
  );

  const onSamplingReject = useCallback(() => {
    void pendingSamples[0]?.reject(
      new Error("Sampling request rejected by user."),
    );
  }, [pendingSamples]);

  const onElicitationRespond = useCallback(
    (result: ElicitResult) => {
      const pending = pendingElicitations[0];
      if (!pending) return;
      // "Cancel" on a MODERN task's input_required request means "give up on the
      // task" — not "send a cancel answer" (which a non-advancing server would
      // just re-prompt on). Cancel the underlying task instead; that aborts the
      // pending request, closes this modal, and lets the poll settle as
      // cancelled (#1631). Submit/Decline still answer the task normally.
      if (
        result.action === "cancel" &&
        pending.origin === "task-input-required" &&
        pending.taskId &&
        inspectorClient
      ) {
        void inspectorClient.cancelRequestorTask(pending.taskId);
        return;
      }
      void pending.respond(result);
    },
    [pendingElicitations, inspectorClient],
  );

  return (
    <>
      <Box>
        {reAuthBanner ? (
          <ReAuthBannerBar>
            <ReAuthBanner
              message={reAuthBanner.message}
              title={reAuthBanner.title}
              actionLabel={reAuthBanner.actionLabel}
              onReauthenticate={onReauthenticateFromBanner}
              onDismiss={() => setReAuthBanner(null)}
            />
          </ReAuthBannerBar>
        ) : null}
        <InspectorView
          deepLink={deepLink}
          deepLinkStatus={deepLinkStatus}
          servers={servers}
          serverListWritable={serverListWritable}
          activeServer={activeServerId}
          erroredServerId={failedServerId}
          connectedServerId={connectedServerId}
          version={inspectorVersion}
          connectionStatus={connectionStatus}
          connectErrorMessage={connectErrorMessage}
          initializeResult={initializeResult}
          latencyMs={latencyMs}
          tools={tools}
          excludedTools={excludedTools}
          malformedListItems={shownMalformedListItems}
          prompts={prompts}
          resources={resources}
          resourceTemplates={resourceTemplates}
          toolsListChanged={toolsListChanged}
          promptsListChanged={promptsListChanged}
          resourcesListChanged={resourcesListChanged}
          toolsLoadError={toolsPagination.error}
          promptsLoadError={promptsPagination.error}
          resourcesLoadError={
            resourcesPagination.error ?? resourceTemplatesLoadError
          }
          subscriptions={subscriptions}
          subscriptionStreamState={subscriptionStreamState}
          logs={logs}
          tasks={tasks}
          progressByTaskId={progressByTaskId}
          protocol={protocolEntries}
          protocolEra={protocolEra}
          network={fetchRequests}
          stderrLogs={stderrLogs}
          toolCallState={toolCallState}
          getPromptState={getPromptState}
          readResourceState={effectiveReadResourceState}
          toolsUi={ui.toolsUi}
          promptsUi={ui.promptsUi}
          resourcesUi={ui.resourcesUi}
          appsUi={ui.appsUi}
          tasksUi={ui.tasksUi}
          logsUi={ui.logsUi}
          protocolUi={ui.protocolUi}
          networkUi={ui.networkUi}
          consoleUi={ui.consoleUi}
          activeTab={activeTab}
          onActiveTabChange={setActiveTab}
          currentLogLevel={currentLogLevel}
          sandboxPath={sandboxUrl}
          bridgeFactory={sandboxBridgeFactory}
          appRendererRef={appRendererRef}
          onToggleTheme={onToggleTheme}
          onOpenClientSettings={() => setClientSettingsOpen(true)}
          onToggleConnection={(id) => {
            void onToggleConnection(id);
          }}
          onDisconnect={() => {
            void onDisconnect();
          }}
          onServerAdd={() => {
            setHighlightedServerIds([]);
            setConfigModal({ mode: "add" });
          }}
          onServerImportConfig={() => {
            setHighlightedServerIds([]);
            setImportConfigOpen(true);
          }}
          onServerImportJson={() => {
            setHighlightedServerIds([]);
            setImportJsonOpen(true);
          }}
          onServerExport={onServerExport}
          onConnectionInfo={() => setConnectionInfoModalOpen(true)}
          onServerSettings={(id) => setSettingsModalTargetId(id)}
          onServerEdit={(id) => setConfigModal({ mode: "edit", targetId: id })}
          onServerClone={(id) => {
            setHighlightedServerIds([]);
            setConfigModal({ mode: "clone", targetId: id });
          }}
          onServerRemove={(id) => {
            const target = servers.find((s) => s.id === id);
            if (target) setRemoveTarget(target);
          }}
          onServerReorder={(orderedIds) => {
            // reorderServers reverts the optimistic order via an internal
            // refresh() and re-throws on failure (409 from a racing external
            // edit, or a network error). Surface that to the user so the drag
            // doesn't silently bounce back — matching the toast pattern every
            // other mutation here uses.
            reorderServers(orderedIds).catch((err: unknown) => {
              notifications.show({
                title: "Failed to reorder servers",
                message: err instanceof Error ? err.message : String(err),
                color: "red",
              });
            });
          }}
          highlightedServerIds={highlightedServerIds}
          onClearHighlight={clearHighlight}
          serverSupportsTaskToolCalls={
            !!capabilities?.tasks?.requests?.tools?.call ||
            (inspectorClient?.isTasksExtensionNegotiated() ?? false)
          }
          onToolsUiChange={onToolsUiChange}
          onCallTool={(name, args, runAsTask) => {
            void onCallTool(name, args, runAsTask);
          }}
          onCancelToolCall={onCancelToolCall}
          onClearToolResult={onClearToolResult}
          onReadResourceContents={onReadResourceContents}
          onRefreshTools={onRefreshTools}
          toolsPagination={toolsPaginationControls}
          promptsPagination={promptsPaginationControls}
          resourcesPagination={resourcesPaginationControls}
          onPromptsUiChange={setUi.setPromptsUi}
          onGetPrompt={(name, args) => {
            void onGetPrompt(name, args);
          }}
          onRefreshPrompts={onRefreshPrompts}
          onResourcesUiChange={setUi.setResourcesUi}
          onReadResource={(uri) => {
            void onReadResource(uri);
          }}
          onSubscribeResource={onSubscribeResource}
          onUnsubscribeResource={onUnsubscribeResource}
          onRefreshResources={onRefreshResources}
          onCompleteArgument={onCompleteArgument}
          completionsSupported={capabilities?.completions !== undefined}
          subscriptionsSupported={capabilities?.resources?.subscribe === true}
          onTasksUiChange={setUi.setTasksUi}
          onCancelTask={(taskId) => {
            void onCancelTask(taskId);
          }}
          onClearCompletedTasks={onClearCompletedTasks}
          onRefreshTasks={onRefreshTasks}
          onSetLogLevel={onSetLogLevel}
          modernLogLevel={modernLogLevel}
          onSetModernLogLevel={onSetModernLogLevel}
          onLogsUiChange={setUi.setLogsUi}
          onClearLogs={onClearLogs}
          onExportLogs={onExportLogs}
          onProtocolUiChange={setUi.setProtocolUi}
          onClearProtocol={onClearProtocol}
          onExportProtocol={onExportProtocol}
          onClearProtocolSection={onClearProtocolSection}
          onExportProtocolSection={onExportProtocolSection}
          onReplayProtocol={onReplayProtocol}
          onTogglePinProtocol={togglePinProtocol}
          pinnedProtocolIds={pinnedProtocolIds}
          onNetworkUiChange={setUi.setNetworkUi}
          onClearNetwork={onClearNetwork}
          onExportNetwork={onExportNetwork}
          onConsoleUiChange={setUi.setConsoleUi}
          onClearConsole={onClearConsole}
          onExportConsole={onExportConsole}
          onAppsUiChange={setUi.setAppsUi}
          onSelectApp={onSelectApp}
          onOpenApp={(name, args) => {
            void onOpenApp(name, args);
          }}
          onCloseApp={onCloseApp}
          onAppError={onAppError}
          onRefreshApps={onRefreshTools}
        />
      </Box>
      <AppElicitationHost
        entries={appElicitations}
        sandboxPath={sandboxUrl}
        bridgeFactory={elicitationBridgeFactory}
        onSettle={handleAppElicitationSettle}
        onFail={handleAppElicitationFail}
      />
      <ServerConfigModal
        opened={configModal !== null}
        mode={configModal?.mode ?? "add"}
        initialId={configModalTarget?.id}
        initialConfig={configModalTarget?.config}
        existingIds={existingIds}
        onClose={() => setConfigModal(null)}
        // Wrapped like the settings persists: this submit carries stdio `env`
        // values, so it can perform the pending plaintext-to-encrypted
        // upgrade and change the descriptor the footer reports.
        onSubmit={refreshingPersist(onConfigSubmit, refreshInitialConfig)}
        secretStorage={secretStorage}
      />
      <ServerImportConfigModal
        opened={importConfigOpen}
        existingIds={existingIds}
        // Refreshed once per import batch, not per entry. `useImportClientConfig`
        // applies every addition and conflict sequentially, and on an encrypted
        // file store each `/api/config` authenticates the whole file with a
        // scrypt derivation — so wrapping the per-entry callbacks made a
        // 20-server import pay 20 serialized KDFs and round trips. Closing is
        // the batch boundary: the modal must be dismissed before the settings
        // footer that reads this descriptor can be reached, and closing also
        // covers a partially-failed batch (#1950 review r26).
        onClose={() => {
          setImportConfigOpen(false);
          refreshInitialConfig();
        }}
        onFetchSource={importSource}
        onAddServer={addServerHighlighted}
        onUpdateServer={updateServer}
      />
      <ServerImportJsonModal
        opened={importJsonOpen}
        existingIds={existingIds}
        onClose={() => setImportJsonOpen(false)}
        onAddServer={refreshingPersist(
          addServerHighlighted,
          refreshInitialConfig,
        )}
      />
      <ServerSettingsModal
        // Remount per open (and per target server) so the accordion resets to
        // its initial "options" section — the body-dropped toast deep-links
        // here expecting the Network Log Size control to be visible.
        key={settingsModalTargetId ?? "server-settings-closed"}
        opened={settingsModalTargetId !== undefined}
        settings={settingsModalValue}
        serverType={settingsModalServerType}
        isStdio={settingsModalIsStdio}
        // The negotiated era only applies when this settings modal targets the
        // live-connected server; otherwise the server isn't connected and the
        // era is unknown (#1629). Lets the form hide the modern log-level control
        // once an `auto` server resolves to legacy.
        negotiatedEra={
          connectionStatus === "connected" &&
          settingsModalTargetId === activeServerId
            ? protocolEra
            : undefined
        }
        onClose={onSettingsModalClose}
        onSettingsChange={onSettingsChange}
        onClearStoredOAuth={
          settingsModalIsStdio ? undefined : handleClearStoredOAuthFromSettings
        }
        secretStorage={secretStorage}
      />
      <ClientSettingsModal
        key={
          clientSettingsOpen ? "client-settings-open" : "client-settings-closed"
        }
        opened={clientSettingsOpen}
        settings={clientSettingsModalValue}
        onClose={onClientSettingsModalClose}
        onSettingsChange={onClientSettingsChange}
        emaIdpLoginState={emaIdpLoginState}
        onEmaIdpLogout={logoutEmaIdp}
        secretStorage={secretStorage}
      />
      {initializeResult && activeServer && (
        <ConnectionInfoModal
          opened={connectionInfoModalOpen}
          onClose={() => setConnectionInfoModalOpen(false)}
          initializeResult={initializeResult}
          serverInfoReported={serverInfoReported}
          clientCapabilities={clientCapabilities}
          transport={connectionInfoTransport}
          protocolEra={protocolEra}
          discoverResult={discoverResult}
          oauth={connectionInfoOAuth}
          onClearOAuth={
            connectionInfoCanClearOAuth ? handleClearConnectionOAuth : undefined
          }
        />
      )}
      <ServerRemoveConfirmModal
        opened={removeTarget !== null}
        target={removeTarget}
        onCancel={() => setRemoveTarget(null)}
        onConfirm={onConfirmRemove}
      />
      <OutputValidationModal
        opened={outputValidationDetails !== null}
        toolName={outputValidationDetails?.toolName}
        message={outputValidationDetails?.message}
        onClose={() => setOutputValidationDetails(null)}
      />
      <UrlElicitationErrorModal
        opened={urlElicitationErrorDetails !== null}
        toolName={urlElicitationErrorDetails?.toolName}
        details={urlElicitationErrorDetails?.details}
        onClose={() => setUrlElicitationErrorDetails(null)}
      />
      <PendingClientRequestModal
        request={pendingRequestContent}
        serverName={activeServer?.name ?? "this server"}
        queuePosition={queueLabel}
        onSamplingRespond={onSamplingRespond}
        onSamplingReject={onSamplingReject}
        onElicitationRespond={onElicitationRespond}
      />
      <StepUpAuthModal
        opened={
          pendingStepUp !== null && pendingStepUp.serverId === activeServerId
        }
        challenge={pendingStepUp?.challenge ?? null}
        authorizationScopes={pendingStepUp?.challenge?.authorizationScopes}
        enterpriseManaged={pendingStepUp?.enterpriseManaged}
        onAuthorize={handleStepUpAuthorize}
        onCancel={handleStepUpCancel}
      />
    </>
  );
}

export default App;
