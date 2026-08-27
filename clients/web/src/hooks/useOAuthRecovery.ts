import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import { notifications } from "@mantine/notifications";
import type { InspectorClient } from "@inspector/core/mcp/index.js";
import type { TypedEvent } from "@inspector/core/mcp/inspectorClientEventTarget.js";
import type {
  ConnectionStatus,
  MCPServerConfig,
  ServerEntry,
} from "@inspector/core/mcp/types.js";
import type { FetchRequestLogState } from "@inspector/core/mcp/state/fetchRequestLogState.js";
import {
  formatOAuthFailureDetail,
  generateOAuthErrorDescription,
  parseOAuthCallbackParams,
  parseOAuthState,
} from "@inspector/core/auth/index.js";
import { RemoteInspectorClientStorage } from "@inspector/core/mcp/remote/index.js";
import { AuthRecoveryRequiredError } from "@inspector/core/auth/challenge.js";
import type {
  AuthChallenge,
  AuthChallengeReason,
} from "@inspector/core/auth/challenge.js";
import { findIssuerBindingFailure } from "@inspector/core/auth/issuerBinding.js";
import {
  emaStepUpFailureMessage,
  emaStepUpInProgressMessage,
  emaStepUpSuccessMessage,
} from "@inspector/core/auth/oauthUx.js";
import { isEmaClientNotConfiguredError } from "@inspector/core/auth/ema/clientConfigError.js";
import type { OAuthDetails } from "../components/groups/ConnectionInfoContent/ConnectionInfoContent";
import { oauthDetailsFromConnectionState } from "../components/groups/ConnectionInfoContent/oauthDetailsFromConnectionState";
import { getWebRemoteOAuthStorage } from "../lib/remoteOAuthStorage";
import { clearServerOAuthState } from "../lib/clearServerOAuthState";
import { getAuthToken } from "../lib/authToken";
import {
  isBrowserTabVisible,
  onBrowserTabVisible,
} from "../lib/browserTabVisibility";
import {
  applyOAuthResumeUi,
  buildTabUiSnapshot,
  clearOAuthResumeSnapshot,
  consumeOAuthResumeSnapshot,
  oauthResumeInsufficientScopeMessage,
  oauthResumeToastMessage,
  writeOAuthResumeSnapshot,
  type OAuthResumeAuthKind,
} from "../lib/oauthResume";
import { OAUTH_CALLBACK_PATH } from "../utils/oauthFlow";
import { INSPECTOR_SERVERS_TAB } from "../utils/inspectorTabs";
import type { PendingReauth } from "../utils/pendingReauth";
import {
  authRecoveryRestoredMessage,
  isReAuthBannerReason,
  issuerBindingFailureCopy,
  lostAuthorizationStateActionLabel,
  oauthPreRedirectToastCopy,
  oauthResumeAbandonedMessage,
  reAuthBannerMessage,
  type OAuthPreRedirectContext,
  type OAuthRecoverySource,
} from "../utils/oauthUx";
import {
  isEmaStepUp,
  isStepUpConfirmation,
  type PendingStepUp,
  type StepUpSource,
} from "../utils/stepUp";
import type { SessionRef } from "./useSessionRef";
import type { TabUiState, TabUiStateSetters } from "./useTabUiState";

/** The banner raised when a session needs the user to authorize again. */
export interface ReAuthBannerState {
  serverId: string;
  message: string;
  /**
   * `lost_authorization_state` marks the SEP-2352 recovery case (#1808): the
   * callback arrived with no recorded discovery state, so the banner offers
   * "Authorize again", which drops the stale/partial OAuth state before
   * starting a fresh authorization.
   */
  kind?: "lost_authorization_state";
  /**
   * Resolved at the point the banner is raised so `issuerBindingFailureCopy`
   * stays the single source of the `kind → copy` mapping; both fall back to
   * `ReAuthBanner`'s own defaults when absent.
   */
  title?: string;
  actionLabel?: string;
}

/** Everything `prepareOAuthRedirect` needs to hand the browser to the AS. */
export interface PrepareOAuthRedirectArgs {
  serverId: string;
  authKind: OAuthResumeAuthKind;
  authorizationUrl: URL;
  authChallenge?: AuthChallenge;
  recoverySource?: OAuthRecoverySource;
  preRedirectContext?: OAuthPreRedirectContext;
  client?: InspectorClient;
}

/** The one thing the `/oauth/callback` rebuild needs from the connect path. */
export type SetupClientForServer = (
  server: ServerEntry,
  sessionId?: string,
) => InspectorClient;

/** The subset of a server entry the OAuth clear path reads. */
export interface ClearableServer {
  id: string;
  name: string;
  config: MCPServerConfig;
}

export interface UseOAuthRecoveryOptions {
  /** The stable session mirror from `useSessionRef` (#2129). */
  sessionRef: SessionRef;
  servers: ServerEntry[];
  activeServerId: string | undefined;
  inspectorClient: InspectorClient | null;
  connectionStatus: ConnectionStatus;
  /** Captured into the resume snapshot so the callback restores the shell. */
  activeTab: string;
  ui: TabUiState;
  setUi: TabUiStateSetters;
  setActiveTab: (next: string) => void;
  /** The live Network log, flushed to session storage before a redirect. */
  fetchLogRef: RefObject<FetchRequestLogState | null>;
  /** Handshake telemetry, cleared/started around the callback's reconnect. */
  connectStartRef: RefObject<number | undefined>;
  /**
   * Resolves once `/api/config` has settled. The callback rebuild waits on it
   * for the same reason the connect path does: whether the client may
   * advertise app-rendered elicitation is fixed at construction.
   */
  initialConfigSettledRef: RefObject<{ promise: Promise<void> } | null>;
  /**
   * Rebuilds the client for the server that started the flow. Injected through
   * a ref rather than as a value because it is declared *after* this hook runs
   * (it reads `onBeforeOAuthRedirect` and `sessionStorageAdapter` from the
   * return below), and it is only ever read from an effect.
   */
  setupClientForServerRef: RefObject<SetupClientForServer | null>;
  setActiveServerId: (id: string | undefined) => void;
  /** Red-borders a server in the list (#1621). */
  setFailedServerId: (id: string | undefined) => void;
  /** Drops the in-flight result panels when the resume snapshot is applied. */
  clearResultPanels: () => void;
  /**
   * Routes a step-up failure/cancellation to the panel that issued the
   * command. A no-op for the sources with no panel (`app`, `ambient`).
   */
  setSourceScopedError: (source: StepUpSource, message: string) => void;
}

export interface OAuthRecovery {
  /** Shared OAuth runtime store (`oauth.json` via `/api/storage/oauth`). */
  webOAuthStorage: ReturnType<typeof getWebRemoteOAuthStorage>;
  /** Backend session storage carrying the Network log across the redirect. */
  sessionStorageAdapter: RemoteInspectorClientStorage;
  onBeforeOAuthRedirect: (authorizationUrl: URL) => void;
  prepareOAuthRedirect: (args: PrepareOAuthRedirectArgs) => void;
  reAuthBanner: ReAuthBannerState | null;
  setReAuthBanner: (next: ReAuthBannerState | null) => void;
  /**
   * Drops the banner and both pending-OAuth slots. Called from the session
   * reset, which runs on every disconnect: an unanswered step-up prompt or a
   * deferred recovery belongs to the session that raised it.
   */
  resetOAuthRecoveryState: () => void;
  pendingStepUp: PendingStepUp | null;
  handleStepUpAuthorize: () => Promise<void>;
  handleStepUpCancel: () => void;
  handleCommandScopedAuthRecovery: (
    error: AuthRecoveryRequiredError,
    options: {
      serverId: string;
      source: StepUpSource;
      retryOperation?: () => Promise<unknown>;
    },
  ) => Promise<boolean>;
  runWithCommandAuthRecovery: <T>(
    operation: () => Promise<T>,
    source: StepUpSource,
  ) => Promise<T | undefined>;
  runCommandInBackground: (
    operation: () => Promise<unknown>,
    source: StepUpSource,
    errorTitle?: string,
  ) => void;
  /** OAuth details for the Connection Info modal, live only while connected. */
  connectionInfoOAuth: OAuthDetails | undefined;
  clearServerOAuthAndDisconnect: (server: ClearableServer) => Promise<void>;
  /** Snapshot cleanup plus shell reset when the user explicitly ends a session. */
  finalizeExplicitDisconnect: () => void;
}

/**
 * Everything the web client does to notice that a session's authorization has
 * lapsed and to get it back — the largest single cluster lifted out of
 * `App.tsx` by the phase-2 decomposition (#2153, under #2129/#2126).
 *
 * The cluster is one hook rather than several because its parts share mutable
 * state that has no meaning apart from them: the step-up slot and its retry
 * operation, the deferred-recovery slot, the re-auth banner, and five
 * once-only latches. Splitting it would mean handing those refs across hook
 * boundaries, which is the coupling the extraction exists to remove.
 *
 * **The latches guard real re-entrancy and are not simplifiable.**
 * `oauthCallbackHandledRef` keeps the single-use authorization code to one
 * exchange across the renders the effect needs to wait for `servers` to
 * hydrate; `staleOAuthCheckedRef` keeps the abandoned-redirect check to one
 * run per load; `oauthResumeUiAppliedRef` keeps the restored shell from being
 * re-applied over the user's own navigation; `reauthResumeInProgressRef` and
 * `stepUpAuthorizeInProgressRef` keep two concurrent triggers (a tab-visible
 * event and a reconnect, a double-click) from starting the same authorization
 * twice. Several of them are also what makes StrictMode's effect replay a
 * no-op rather than a second token exchange.
 *
 * Direction is one-way: this hook reads the session through `sessionRef` and
 * calls back into `App.tsx` only through the callbacks it is handed. It never
 * drives a connect — the connect path consumes `prepareOAuthRedirect`,
 * `onBeforeOAuthRedirect` and `sessionStorageAdapter` from here, not the
 * reverse.
 */
export function useOAuthRecovery({
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
}: UseOAuthRecoveryOptions): OAuthRecovery {
  const [pendingStepUp, setPendingStepUp] = useState<PendingStepUp | null>(
    null,
  );
  const pendingStepUpRetryRef = useRef<(() => Promise<unknown>) | null>(null);
  const [reAuthBanner, setReAuthBanner] = useState<ReAuthBannerState | null>(
    null,
  );
  const [pendingReauth, setPendingReauth] = useState<PendingReauth | null>(
    null,
  );
  const reauthResumeInProgressRef = useRef(false);
  const stepUpAuthorizeInProgressRef = useRef(false);
  // One-shot guard for the `/oauth/callback` handler below. The effect waits
  // for the async `servers` list to hydrate, so it can run on more than one
  // render; this ref ensures the token exchange fires exactly once per load.
  const oauthCallbackHandledRef = useRef(false);
  const staleOAuthCheckedRef = useRef(false);
  /** Guards against applying the same OAuth resume snapshot more than once per load. */
  const oauthResumeUiAppliedRef = useRef(false);

  // This hook owns the two pending-OAuth slots, so it is also what mirrors
  // them into the session ref (#2153) — `useSessionRef` deliberately does not
  // take them. Declared first so every effect below reads the current pair,
  // which is the order that held when App.tsx wrote them.
  useEffect(() => {
    sessionRef.current.pendingStepUp = pendingStepUp;
    sessionRef.current.pendingReauth = pendingReauth;
  });

  useEffect(() => {
    const pending = sessionRef.current.pendingReauth;
    if (pending && pending.serverId !== activeServerId) {
      setPendingReauth(null);
    }
    const stepUp = sessionRef.current.pendingStepUp;
    if (stepUp && stepUp.serverId !== activeServerId) {
      setPendingStepUp(null);
    }
  }, [sessionRef, activeServerId]);

  const trySetPendingStepUp = useCallback(
    (next: PendingStepUp): boolean => {
      if (sessionRef.current.pendingStepUp !== null) {
        notifications.show({
          title: "Step-up authorization in progress",
          message:
            "Complete or cancel the current step-up prompt before starting another.",
          color: "yellow",
          autoClose: 5000,
        });
        return false;
      }
      setPendingStepUp(next);
      return true;
    },
    [sessionRef],
  );

  const showReAuthBanner = useCallback(
    (
      serverId: string,
      detail?: unknown,
      options?: { reason?: AuthChallengeReason },
    ) => {
      const server = sessionRef.current.servers.find((s) => s.id === serverId);
      const message = reAuthBannerMessage({
        serverName: server?.name,
        detail:
          detail !== undefined ? formatOAuthFailureDetail(detail) : undefined,
      });
      const reason = options?.reason;
      if (reason !== undefined && !isReAuthBannerReason(reason)) {
        notifications.show({
          title: "Authorization required",
          message,
          color: "yellow",
          autoClose: false,
        });
        return;
      }
      setReAuthBanner({
        serverId,
        message,
      });
    },
    [sessionRef],
  );

  /** Clears pending OAuth resume state — explicit user disconnect only. */
  const clearOAuthResumeOnExplicitDisconnect = useCallback(() => {
    clearOAuthResumeSnapshot();
    oauthResumeUiAppliedRef.current = false;
  }, []);

  /** Snapshot cleanup plus shell reset when the user explicitly ends a session. */
  const finalizeExplicitDisconnect = useCallback(() => {
    clearOAuthResumeOnExplicitDisconnect();
    setActiveTab(INSPECTOR_SERVERS_TAB);
  }, [clearOAuthResumeOnExplicitDisconnect, setActiveTab]);

  const [
    connectionInfoOAuthWhenConnected,
    setConnectionInfoOAuthWhenConnected,
  ] = useState<OAuthDetails | undefined>(undefined);

  const connectionInfoOAuth =
    connectionStatus === "connected" && inspectorClient
      ? connectionInfoOAuthWhenConnected
      : undefined;

  useEffect(() => {
    if (connectionStatus !== "connected" || !inspectorClient) {
      return;
    }
    let cancelled = false;

    const refresh = (): void => {
      void inspectorClient.getOAuthState().then((state) => {
        if (cancelled) return;
        setConnectionInfoOAuthWhenConnected(
          state ? oauthDetailsFromConnectionState(state) : undefined,
        );
      });
    };

    const onAmbientAuthChallenge = (): void => {
      const name = sessionRef.current.activeServerName;
      notifications.show({
        title: name
          ? `Refreshing authorization for "${name}"`
          : "Refreshing authorization",
        message: "Refreshing authorization…",
        color: "blue",
        autoClose: 4000,
      });
    };

    refresh();
    inspectorClient.addEventListener("oauthComplete", refresh);
    inspectorClient.addEventListener(
      "authChallengeAmbient",
      onAmbientAuthChallenge,
    );
    return () => {
      cancelled = true;
      inspectorClient.removeEventListener("oauthComplete", refresh);
      inspectorClient.removeEventListener(
        "authChallengeAmbient",
        onAmbientAuthChallenge,
      );
    };
  }, [sessionRef, connectionStatus, inspectorClient]);

  // Shared OAuth runtime store (oauth.json via /api/storage/oauth). Memoized so
  // connect, EMA IdP session, and per-server clear share one in-memory view.
  const webOAuthStorage = useMemo(
    () => getWebRemoteOAuthStorage(getAuthToken()),
    [],
  );

  // Backend-backed session storage used to carry the fetch (Network) log
  // across the OAuth full-page redirect. The auth handshake's first half —
  // protected-resource + auth-server discovery and Dynamic Client
  // Registration — happens on the pre-redirect page; without persisting it
  // those `auth` entries would vanish when the browser navigates to the
  // authorization server. `FetchRequestLogState` saves to this on the
  // client's `saveSession` event (fired in `onBeforeOAuthRedirect`) keyed by
  // the OAuth authId, and restores from it when rebuilt on `/oauth/callback`.
  // Created once; `getAuthToken()` is stable for the page's lifetime.
  const sessionStorageAdapter = useMemo(
    () =>
      new RemoteInspectorClientStorage({
        baseUrl:
          typeof window !== "undefined"
            ? window.location.origin
            : "http://localhost",
        authToken: getAuthToken(),
      }),
    [],
  );

  // Flush the pre-redirect Network log to backend storage, keyed by the OAuth
  // authId carried in the authorization URL's `state`. Runs synchronously from
  // `BrowserNavigation` right before `window.location.href`, so the keepalive
  // POST it kicks off outlives the unloading page. The `/oauth/callback`
  // rebuild restores these entries via `FetchRequestLogState`'s `sessionId`.
  // Stable identity: it reads mutable refs, so it never needs to be rebuilt.
  const onBeforeOAuthRedirect = useCallback(
    (authorizationUrl: URL) => {
      const stateParam = authorizationUrl.searchParams.get("state");
      const authId = stateParam
        ? (parseOAuthState(stateParam)?.authId ?? undefined)
        : undefined;
      if (!authId) return;
      const fetchRequests = fetchLogRef.current?.getFetchRequests() ?? [];
      if (fetchRequests.length === 0) return;
      const now = Date.now();
      // Fire-and-forget: the keepalive request inside `saveSession` is
      // dispatched synchronously here, before navigation commits.
      void sessionStorageAdapter
        .saveSession(authId, {
          fetchRequests,
          createdAt: now,
          updatedAt: now,
        })
        .catch(() => {
          // Best-effort; losing the pre-redirect log is non-fatal.
        });
    },
    [sessionStorageAdapter, fetchLogRef],
  );

  const prepareOAuthRedirect = useCallback(
    ({
      serverId,
      authKind,
      authorizationUrl,
      authChallenge,
      recoverySource,
      preRedirectContext,
      client,
    }: PrepareOAuthRedirectArgs) => {
      setReAuthBanner(null);
      const server = sessionRef.current.servers.find((s) => s.id === serverId);
      const preRedirectToast = oauthPreRedirectToastCopy(authKind, {
        serverName: server?.name,
        enterpriseManaged: server?.settings?.enterpriseManaged,
        context: preRedirectContext,
      });
      if (preRedirectToast) {
        notifications.show({
          title: preRedirectToast.title,
          message: preRedirectToast.message,
          color: "blue",
          autoClose: 4000,
        });
      }
      const oauthClient = client ?? inspectorClient;
      const remoteSessionId = oauthClient?.getRemoteBackendSessionId();
      onBeforeOAuthRedirect(authorizationUrl);
      // Write immediately before navigation so implicit client teardown (during
      // connect setup) cannot clear the snapshot after we persist it.
      writeOAuthResumeSnapshot({
        version: 1,
        serverId,
        activeTab,
        authKind,
        tabUi: buildTabUiSnapshot(ui),
        ...(remoteSessionId && { remoteSessionId }),
        ...(authKind === "step_up" && authChallenge && { authChallenge }),
        ...(recoverySource && { recoverySource }),
      });
      void oauthClient?.beginInteractiveAuthorization(authorizationUrl);
    },
    [sessionRef, inspectorClient, activeTab, ui, onBeforeOAuthRedirect],
  );

  const tryApplyStoredAuthRecovery = useCallback(
    async (
      client: InspectorClient,
      challenge: AuthChallenge,
      recoverySource?: OAuthRecoverySource,
    ): Promise<boolean> => {
      if (!(await client.checkAuthChallengeSatisfied(challenge))) {
        return false;
      }
      await client.pushRemoteAuthState();
      notifications.show({
        title: "Authorization restored",
        message: authRecoveryRestoredMessage({ recoverySource }),
        color: "green",
        autoClose: 4000,
      });
      return true;
    },
    [],
  );

  const runVisibleInteractiveAuth = useCallback(
    ({
      serverId,
      challenge,
      authorizationUrl,
      source = "ambient",
    }: {
      serverId: string;
      challenge: AuthChallenge;
      authorizationUrl: URL;
      source?: StepUpSource;
    }) => {
      const server = sessionRef.current.servers.find((s) => s.id === serverId);
      if (isStepUpConfirmation(challenge, server)) {
        trySetPendingStepUp({
          challenge,
          authorizationUrl,
          serverId,
          source,
          enterpriseManaged: isEmaStepUp(challenge, server),
        });
        return;
      }
      prepareOAuthRedirect({
        serverId,
        authKind: "reauth",
        authorizationUrl,
        recoverySource: source,
      });
    },
    [sessionRef, prepareOAuthRedirect, trySetPendingStepUp],
  );

  const deferAmbientReauth = useCallback(
    (pending: PendingReauth) => {
      if (sessionRef.current.pendingReauth) {
        notifications.show({
          title: "Authorization update pending",
          message:
            "A new authorization request replaced the previous deferred recovery.",
          color: "yellow",
          autoClose: 5000,
        });
      } else {
        notifications.show({
          title: "Authorization pending",
          message: "Return to this tab to continue authorization.",
          color: "blue",
          autoClose: 5000,
        });
      }
      setPendingReauth(pending);
    },
    [sessionRef],
  );

  const handleCommandScopedAuthRecovery = useCallback(
    async (
      error: AuthRecoveryRequiredError,
      options: {
        serverId: string;
        source: StepUpSource;
        retryOperation?: () => Promise<unknown>;
      },
    ): Promise<boolean> => {
      if (!inspectorClient) {
        return false;
      }
      const server = sessionRef.current.servers.find(
        (s) => s.id === options.serverId,
      );
      const stepUp =
        error.emaStepUpConfirm ||
        isStepUpConfirmation(error.authChallenge, server);

      if (stepUp) {
        if (
          await tryApplyStoredAuthRecovery(
            inspectorClient,
            error.authChallenge,
            options.source,
          )
        ) {
          return true;
        }
        pendingStepUpRetryRef.current = options.retryOperation ?? null;
        trySetPendingStepUp({
          challenge: error.authChallenge,
          authorizationUrl: error.authorizationUrl,
          serverId: options.serverId,
          source: options.source,
          enterpriseManaged: isEmaStepUp(error.authChallenge, server),
        });
        return false;
      }

      if (
        await tryApplyStoredAuthRecovery(
          inspectorClient,
          error.authChallenge,
          options.source,
        )
      ) {
        return true;
      }

      prepareOAuthRedirect({
        serverId: options.serverId,
        authKind: "reauth",
        authorizationUrl: error.authorizationUrl,
        recoverySource: options.source,
      });
      return false;
    },
    [
      sessionRef,
      inspectorClient,
      prepareOAuthRedirect,
      tryApplyStoredAuthRecovery,
      trySetPendingStepUp,
    ],
  );

  const runWithCommandAuthRecovery = useCallback(
    async <T>(
      operation: () => Promise<T>,
      source: StepUpSource,
    ): Promise<T | undefined> => {
      if (!inspectorClient || !activeServerId) {
        return operation();
      }
      try {
        return await operation();
      } catch (err) {
        if (err instanceof AuthRecoveryRequiredError) {
          const satisfied = await handleCommandScopedAuthRecovery(err, {
            serverId: activeServerId,
            source,
            retryOperation: operation,
          });
          if (satisfied) {
            return operation();
          }
          return undefined;
        }
        throw err;
      }
    },
    [inspectorClient, activeServerId, handleCommandScopedAuthRecovery],
  );

  /**
   * Fire-and-forget form of {@link runWithCommandAuthRecovery}, for a command
   * whose caller has nothing to await (a click handler, a mode toggle).
   *
   * The wrapper rethrows anything that is not an `AuthRecoveryRequiredError`,
   * so a bare `void runWithCommandAuthRecovery(...)` turns every non-auth
   * failure — a transport error, a rejected `tools/list` — into an unhandled
   * rejection in the browser (#2049). Routing every background command through
   * here is what keeps a new call site from reintroducing that gap by
   * omission: there is no `void` to forget.
   *
   * `errorTitle` picks the reporting, and the choice is per call site:
   *
   * - **Omit it** when the operation's own state already renders the failure —
   *   the list loads, whose managed/paged stores record the error and whose
   *   panel shows it with a Retry. A toast there would only duplicate what the
   *   user is already looking at, so the rejection is swallowed deliberately.
   * - **Pass one** when nothing else records the failure, and the user would
   *   otherwise see the command silently do nothing.
   */
  const runCommandInBackground = useCallback(
    (
      operation: () => Promise<unknown>,
      source: StepUpSource,
      errorTitle?: string,
    ): void => {
      void runWithCommandAuthRecovery(operation, source).catch(
        (err: unknown) => {
          if (!errorTitle) return;
          notifications.show({
            title: errorTitle,
            message: err instanceof Error ? err.message : String(err),
            color: "red",
          });
        },
      );
    },
    [runWithCommandAuthRecovery],
  );

  const resumePendingReauth = useCallback(
    async (pending: PendingReauth) => {
      if (reauthResumeInProgressRef.current) {
        return;
      }
      const client = inspectorClient;
      if (!client) {
        return;
      }
      if (connectionStatus !== "connected") {
        return;
      }
      if (pending.serverId !== sessionRef.current.activeServerId) {
        return;
      }

      reauthResumeInProgressRef.current = true;
      setPendingReauth(null);
      try {
        if (
          await tryApplyStoredAuthRecovery(
            client,
            pending.challenge,
            pending.source,
          )
        ) {
          return;
        }

        if (pending.authKind === "step_up") {
          runVisibleInteractiveAuth({
            serverId: pending.serverId,
            challenge: pending.challenge,
            authorizationUrl: pending.authorizationUrl,
            source: pending.source,
          });
          return;
        }

        const outcome = await client.handleAuthChallenge(pending.challenge);
        if (outcome.kind === "satisfied") {
          await client.pushRemoteAuthState();
          notifications.show({
            title: "Authorization restored",
            message: authRecoveryRestoredMessage({
              recoverySource: pending.source,
            }),
            color: "green",
            autoClose: 4000,
          });
          return;
        }
        if (outcome.kind === "interactive") {
          runVisibleInteractiveAuth({
            serverId: pending.serverId,
            challenge: outcome.challenge,
            authorizationUrl: outcome.authorizationUrl,
            source: pending.source,
          });
          return;
        }
        if (outcome.kind === "failed") {
          showReAuthBanner(pending.serverId, outcome.error, {
            reason: pending.challenge.reason,
          });
        }
      } finally {
        reauthResumeInProgressRef.current = false;
      }
    },
    [
      sessionRef,
      inspectorClient,
      connectionStatus,
      tryApplyStoredAuthRecovery,
      runVisibleInteractiveAuth,
      showReAuthBanner,
    ],
  );

  useEffect(() => {
    if (connectionStatus !== "connected" || !inspectorClient) {
      return;
    }

    const onAuthChallengeInteractive = (
      event: TypedEvent<"authChallengeInteractive">,
    ): void => {
      void (async () => {
        const { challenge, authorizationUrl } = event.detail;
        const serverId = sessionRef.current.activeServerId;
        if (!serverId) {
          return;
        }
        const server = sessionRef.current.servers.find(
          (s) => s.id === serverId,
        );
        const authKind: OAuthResumeAuthKind = isStepUpConfirmation(
          challenge,
          server,
        )
          ? "step_up"
          : "reauth";

        if (!isBrowserTabVisible()) {
          deferAmbientReauth({
            serverId,
            challenge,
            authorizationUrl,
            authKind,
            source: "ambient",
          });
          return;
        }

        if (await tryApplyStoredAuthRecovery(inspectorClient, challenge)) {
          return;
        }

        runVisibleInteractiveAuth({
          serverId,
          challenge,
          authorizationUrl,
          source: "ambient",
        });
      })();
    };

    inspectorClient.addEventListener(
      "authChallengeInteractive",
      onAuthChallengeInteractive,
    );
    return () => {
      inspectorClient.removeEventListener(
        "authChallengeInteractive",
        onAuthChallengeInteractive,
      );
    };
  }, [
    sessionRef,
    connectionStatus,
    inspectorClient,
    tryApplyStoredAuthRecovery,
    runVisibleInteractiveAuth,
    deferAmbientReauth,
  ]);

  useEffect(() => {
    return onBrowserTabVisible(() => {
      const pending = sessionRef.current.pendingReauth;
      if (pending) {
        void resumePendingReauth(pending);
      }
    });
  }, [sessionRef, resumePendingReauth]);

  // Resume deferred background-tab recovery once the session reconnects.
  useEffect(() => {
    if (connectionStatus !== "connected" || !inspectorClient) {
      return;
    }
    if (!isBrowserTabVisible()) {
      return;
    }
    const pending = sessionRef.current.pendingReauth;
    if (pending) {
      void resumePendingReauth(pending);
    }
  }, [sessionRef, connectionStatus, inspectorClient, resumePendingReauth]);

  useEffect(() => {
    if (connectionStatus !== "connected" || !inspectorClient) {
      return;
    }

    const onOAuthError = (event: TypedEvent<"oauthError">): void => {
      const serverId = sessionRef.current.activeServerId;
      if (!serverId) {
        return;
      }
      showReAuthBanner(serverId, event.detail.error);
    };

    inspectorClient.addEventListener("oauthError", onOAuthError);
    return () => {
      inspectorClient.removeEventListener("oauthError", onOAuthError);
    };
  }, [sessionRef, connectionStatus, inspectorClient, showReAuthBanner]);

  // Detect an abandoned full-page OAuth redirect (snapshot left, no callback).
  useEffect(() => {
    if (staleOAuthCheckedRef.current) return;
    if (typeof window === "undefined") return;
    if (window.location.pathname === OAUTH_CALLBACK_PATH) return;
    if (servers.length === 0) return;
    staleOAuthCheckedRef.current = true;

    const snapshot = consumeOAuthResumeSnapshot();
    if (!snapshot) {
      return;
    }
    queueMicrotask(() => {
      if (snapshot.authKind === "reauth") {
        showReAuthBanner(
          snapshot.serverId,
          oauthResumeAbandonedMessage(snapshot.authKind),
        );
        return;
      }
      if (snapshot.authKind === "step_up") {
        showReAuthBanner(
          snapshot.serverId,
          oauthResumeAbandonedMessage(snapshot.authKind, {
            recoverySource: snapshot.recoverySource,
          }),
        );
      }
    });
  }, [servers, showReAuthBanner]);

  // Finish the OAuth authorization-code flow when the auth server redirects
  // back to `/oauth/callback`. This runs on a fresh page load (the redirect in
  // `onToggleConnection` unloaded the previous one), so all React state is
  // reset and we recover the initiating server from sessionStorage. We wait for
  // `servers` to hydrate before acting; the ref guard keeps the exchange to a
  // single run. The persisted PKCE verifier + DCR client info live in shared
  // `RemoteOAuthStorage` (`oauth.json`) and survive the redirect, so
  // `completeOAuthFlow` exchanges the code without needing the original
  // in-memory state machine.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.location.pathname !== OAUTH_CALLBACK_PATH) return;
    if (oauthCallbackHandledRef.current) return;
    // `useServers` returns [] until the first fetch resolves; defer until the
    // list is populated so `find` can resolve the pending server.
    if (servers.length === 0) return;
    // The connect path builds the client, and it is declared after this hook
    // runs. Reading it here rather than latching first means a render that
    // somehow arrives with a hydrated list before the assignment simply tries
    // again on the next one, instead of burning the one-shot latch on a run
    // that could not have exchanged anything.
    const setupClientForServer = setupClientForServerRef.current;
    if (!setupClientForServer) return;
    oauthCallbackHandledRef.current = true;

    const params = parseOAuthCallbackParams(window.location.search);
    // The OAuth `state` round-trips the auth session id; the authId is the
    // session key the pre-redirect page saved the fetch log under, so the
    // rebuilt client can restore those `auth` entries. Read it before the
    // URL is cleared below.
    //
    // Defense-in-depth: a `state` that is present but does not parse to our
    // expected 64-char-hex authId shape did not originate from
    // `generateOAuthState`, so reject the callback instead of silently
    // proceeding with an undefined sessionId. This is a shape check, not full
    // state-matching — the primary CSRF protection remains PKCE
    // (`code_verifier`); this layer catches malformed/forged `state` early.
    //
    // Intentional asymmetry: a present-but-malformed `state` (including the
    // empty string `?state=`) is rejected, but a wholly absent `state`
    // (`stateParam === null`) is *not* — it falls through with
    // `sessionId = undefined` and is matched via the OAuth resume snapshot
    // (`resumeSnapshot.serverId`) instead. Rejecting the null case would turn any provider error redirect
    // that omits `state` into a misleading "rejected" toast, hiding the real
    // OAuth error surfaced by the `!params.successful` branch below.
    const stateParam = new URLSearchParams(window.location.search).get("state");
    const parsedState = stateParam ? parseOAuthState(stateParam) : null;
    const stateRejected = stateParam !== null && parsedState === null;
    const sessionId = parsedState?.authId ?? undefined;
    const resumeSnapshot = consumeOAuthResumeSnapshot();

    // Strip the code/state off the URL immediately so a reload can't replay
    // the (now single-use) authorization code through the exchange again.
    window.history.replaceState({}, "", "/");

    if (stateRejected) {
      notifications.show({
        title: "OAuth callback rejected",
        message:
          "OAuth callback carried an unrecognized state parameter that did not originate from this session. Please try connecting again.",
        color: "red",
      });
      return;
    }

    const applyResumeUiOnce = (
      snapshot: NonNullable<typeof resumeSnapshot>,
    ) => {
      if (oauthResumeUiAppliedRef.current) {
        return;
      }
      applyOAuthResumeUi(snapshot, {
        ...setUi,
        setActiveTab,
        // One callback behind all three: `applyOAuthResumeUi` calls them
        // unconditionally and in sequence, so clearing every in-flight result
        // panel per call is the same end state as clearing one each.
        clearToolCallState: clearResultPanels,
        clearGetPromptState: clearResultPanels,
        clearReadResourceState: clearResultPanels,
      });
      oauthResumeUiAppliedRef.current = true;
    };

    if (resumeSnapshot && params.successful) {
      applyResumeUiOnce(resumeSnapshot);
    }

    if (!params.successful) {
      const pendingId = resumeSnapshot?.serverId;
      if (pendingId) {
        // Red border only (#1621), not a sidebar. This arm returns before a
        // client is rebuilt, so the persisted `auth` entries are never
        // restored and the content-gated column stays shut — correctly: the
        // provider's own `error` param is the whole diagnostic, and the
        // re-auth banner below is already showing it. The flag is still right,
        // because the attempt did fail.
        setFailedServerId(pendingId);
        queueMicrotask(() => {
          showReAuthBanner(pendingId, generateOAuthErrorDescription(params));
        });
      } else {
        notifications.show({
          title: "OAuth authorization failed",
          message: generateOAuthErrorDescription(params),
          color: "red",
        });
      }
      return;
    }

    const pendingId = resumeSnapshot?.serverId;
    const server = pendingId
      ? servers.find((s) => s.id === pendingId)
      : undefined;
    if (!server) {
      notifications.show({
        title: "OAuth callback could not be matched",
        message:
          "Could not determine which server started the OAuth flow. Please try connecting again.",
        color: "red",
      });
      return;
    }

    void (async () => {
      // Same reason as the connect path: whether this client may advertise
      // app-rendered elicitation is fixed at construction.
      await initialConfigSettledRef.current?.promise;
      try {
        await webOAuthStorage.load();
      } catch (err) {
        connectStartRef.current = undefined;
        // Red border only, for the same reason as the provider-error arm above
        // — and here the network log would not help anyway: this is a failure
        // to read local OAuth storage, not a request that went out.
        setFailedServerId(server.id);
        queueMicrotask(() => {
          showReAuthBanner(server.id, err instanceof Error ? err : String(err));
        });
        return;
      }
      const client = setupClientForServer(server, sessionId);
      setActiveServerId(server.id);
      try {
        connectStartRef.current = Date.now();
        await client.resumeAfterOAuth(params.code, {
          remoteSessionId: resumeSnapshot?.remoteSessionId,
          iss: params.iss,
        });
      } catch (err) {
        connectStartRef.current = undefined;
        // `resumeAfterOAuth` carries the reconnect, and that reconnect can
        // reject with an auth-recovery error — which holds the status at
        // `"connecting"` instead of moving it to `"error"`. Nothing downstream
        // of here ends the attempt, so without this the toggle is stuck and the
        // active-server lock is never released. Before the EMA guard, since a
        // stuck session is worth clearing whichever way the error classifies.
        await client.disconnect().catch(() => {});
        // `activeServerId` is deliberately NOT cleared here, even though the
        // disconnect above often cannot announce itself: it emits only on a
        // status *change*, and the commonest failure — a rejected token
        // exchange — throws inside `completeOAuthFlow` before the reconnect
        // runs, so this freshly built client is still at its initial
        // `"disconnected"` and the listener that would clear it never fires.
        //
        // That looks like a leak and is not. The next step after a callback
        // failure is the re-auth banner below, and its "Authorize again" hands
        // `clearServerOAuthState` the live client only when the banner's server
        // *is* the active one. Releasing it here would pass `null` instead, and
        // the stale tokens would never be cleared from the client that holds
        // them — the one thing that recovery exists to do.
        if (isEmaClientNotConfiguredError(err)) {
          notifications.show({
            title: `Cannot connect to "${server.name}"`,
            message: err.message,
            color: "red",
            autoClose: false,
          });
          return;
        }
        // The token exchange (or the re-handshake behind it) failed. Flag the
        // server (#1621) so the monitoring sidebar opens onto the OAuth
        // requests that explain it (#2108) — the rebuilt client restored the
        // pre-redirect `auth` fetch entries from the session, so discovery,
        // DCR and the token exchange are all there.
        //
        // Below the EMA guard, not above it: an unconfigured enterprise client
        // is a *configuration* error rather than a failed attempt, and both
        // connect-path arms already return on it without flagging. Flagging it
        // only here would make the three disagree about what the red border
        // means. Above every other arm, so the classification fan-out that
        // follows carries it whichever way it goes.
        setFailedServerId(server.id);
        // SEP-2352 issuer binding (#1808). Two very different failures share
        // one SDK error class, so classify before falling through to the
        // generic re-auth banner (whose detail line would otherwise be the raw
        // "AuthorizationServerMismatchError" text):
        //  - no discovery state was recorded → recoverable bookkeeping loss,
        //    surface the "Authorize again" affordance;
        //  - a *different* issuer answered the callback → security signal, so
        //    no one-click recovery is offered.
        const issuerBindingFailure = findIssuerBindingFailure(err);
        if (issuerBindingFailure) {
          const copy = issuerBindingFailureCopy(issuerBindingFailure, {
            serverName: server.name,
          });
          if (issuerBindingFailure.kind === "lost_authorization_state") {
            setReAuthBanner({
              serverId: server.id,
              message: copy.message,
              kind: "lost_authorization_state",
              title: copy.title,
              actionLabel: lostAuthorizationStateActionLabel(),
            });
          } else {
            notifications.show({
              title: copy.title,
              message: copy.message,
              color: "red",
              autoClose: false,
            });
          }
          return;
        }
        queueMicrotask(() => {
          showReAuthBanner(server.id, err instanceof Error ? err : String(err));
        });
        return;
      }

      setReAuthBanner(null);

      if (resumeSnapshot) {
        const stepUpChallenge =
          resumeSnapshot.authKind === "step_up"
            ? resumeSnapshot.authChallenge
            : undefined;
        const stepUpScopesGranted =
          !stepUpChallenge ||
          (await client.checkAuthChallengeSatisfied(stepUpChallenge));

        if (stepUpChallenge && !stepUpScopesGranted) {
          notifications.show({
            title: "Additional permissions not granted",
            message: oauthResumeInsufficientScopeMessage(stepUpChallenge),
            color: "yellow",
            autoClose: false,
          });
          return;
        }

        notifications.show({
          title: "Authorization complete",
          message: oauthResumeToastMessage(resumeSnapshot.authKind, {
            recoverySource: resumeSnapshot.recoverySource,
          }),
          color: "green",
          autoClose: 6000,
        });
      }
    })();
  }, [
    servers,
    setupClientForServerRef,
    setActiveServerId,
    setFailedServerId,
    connectStartRef,
    initialConfigSettledRef,
    clearResultPanels,
    showReAuthBanner,
    webOAuthStorage,
    setUi,
    setActiveTab,
  ]);

  const clearServerOAuthAndDisconnect = useCallback(
    async (server: ClearableServer) => {
      const isActive = server.id === activeServerId;
      const cleared = await clearServerOAuthState({
        config: server.config,
        inspectorClient: isActive ? inspectorClient : null,
        isActiveConnection: isActive,
        oauthStorage: webOAuthStorage,
      });
      if (!cleared) return;

      if (isActive && inspectorClient) {
        try {
          await inspectorClient.disconnect();
        } finally {
          setConnectionInfoOAuthWhenConnected(undefined);
          finalizeExplicitDisconnect();
        }
      } else {
        clearOAuthResumeOnExplicitDisconnect();
      }

      notifications.show({
        title: "OAuth state cleared",
        message: isActive
          ? "Stored tokens and client registration were removed. Reconnect to run a fresh authorization flow."
          : `Stored OAuth state was removed for "${server.name}". Connect to authorize again.`,
        color: "blue",
      });
    },
    [
      activeServerId,
      inspectorClient,
      webOAuthStorage,
      finalizeExplicitDisconnect,
      clearOAuthResumeOnExplicitDisconnect,
    ],
  );

  const handleStepUpAuthorize = async () => {
    if (!pendingStepUp || stepUpAuthorizeInProgressRef.current) {
      return;
    }
    const stepUp = pendingStepUp;
    const client = inspectorClient;
    if (!client) {
      return;
    }

    if (stepUp.enterpriseManaged) {
      stepUpAuthorizeInProgressRef.current = true;
      setPendingStepUp(null);
      notifications.show({
        title: "Organization permissions",
        message: emaStepUpInProgressMessage(),
        color: "blue",
        autoClose: 4000,
      });
      try {
        const outcome = await client.handleAuthChallenge(stepUp.challenge, {
          confirmedStepUp: true,
        });
        if (outcome.kind === "satisfied") {
          await client.pushRemoteAuthState();
          notifications.show({
            title: "Permissions updated",
            message: emaStepUpSuccessMessage({
              recoverySource: stepUp.source,
            }),
            color: "green",
            autoClose: 5000,
          });
          const retry = pendingStepUpRetryRef.current;
          pendingStepUpRetryRef.current = null;
          if (retry) {
            await retry();
          }
          return;
        }
        if (outcome.kind === "interactive") {
          prepareOAuthRedirect({
            serverId: stepUp.serverId,
            authKind: "step_up",
            authorizationUrl: outcome.authorizationUrl,
            authChallenge: outcome.challenge,
            recoverySource: stepUp.source,
          });
          return;
        }
        if (outcome.kind === "failed") {
          const failureMessage = emaStepUpFailureMessage(outcome.error.message);
          notifications.show({
            title: "Organization permissions",
            message: failureMessage,
            color: "red",
            autoClose: 6000,
          });
          setSourceScopedError(stepUp.source, failureMessage);
        }
      } finally {
        stepUpAuthorizeInProgressRef.current = false;
      }
      return;
    }

    stepUpAuthorizeInProgressRef.current = true;
    prepareOAuthRedirect({
      serverId: stepUp.serverId,
      authKind: "step_up",
      authorizationUrl: stepUp.authorizationUrl,
      authChallenge: stepUp.challenge,
      recoverySource: stepUp.source,
    });
    setPendingStepUp(null);
    pendingStepUpRetryRef.current = null;
    stepUpAuthorizeInProgressRef.current = false;
  };

  const resetOAuthRecoveryState = useCallback(() => {
    setPendingStepUp(null);
    setPendingReauth(null);
    setReAuthBanner(null);
  }, []);

  const handleStepUpCancel = () => {
    const stepUp = sessionRef.current.pendingStepUp;
    setPendingStepUp(null);
    pendingStepUpRetryRef.current = null;
    if (!stepUp) {
      return;
    }
    const cancelled = "Authorization cancelled.";
    setSourceScopedError(stepUp.source, cancelled);
    if (stepUp.source === "app") {
      notifications.show({
        title: "Authorization cancelled",
        message: cancelled,
        color: "gray",
        autoClose: 4000,
      });
    }
  };

  return {
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
  };
}
