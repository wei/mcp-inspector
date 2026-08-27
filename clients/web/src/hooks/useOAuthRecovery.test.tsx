import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { AuthorizationServerMismatchError } from "@modelcontextprotocol/client";
import { InspectorClient } from "@inspector/core/mcp/index.js";
import type {
  ConnectionStatus,
  FetchRequestEntry,
  ServerEntry,
} from "@inspector/core/mcp/types.js";
import type { AuthChallenge } from "@inspector/core/auth/challenge.js";
import { AuthRecoveryRequiredError } from "@inspector/core/auth/challenge.js";
import { EmaClientNotConfiguredError } from "@inspector/core/auth/ema/clientConfigError.js";
import { useLayoutEffect, useRef } from "react";
import { renderWithMantine, act, waitFor } from "../test/renderWithMantine";
import {
  OAUTH_RESUME_KEY,
  writeOAuthResumeSnapshot,
  type OAuthResumeSnapshot,
} from "../lib/oauthResume";
import type { StepUpSource } from "../utils/stepUp";
import { EMPTY_SETTINGS } from "../utils/serverSettingsDefaults";
import { useSessionRef } from "./useSessionRef";
import { useTabUiState } from "./useTabUiState";
import {
  useOAuthRecovery,
  type FetchRequestSource,
  type OAuthRecovery,
  type SetupClientForServer,
} from "./useOAuthRecovery";

// --- Module doubles ---------------------------------------------------------
// Everything the hook reaches outside React: the toast layer, the two storage
// adapters, and the tab-visibility listener. `lib/oauthResume` is deliberately
// NOT mocked — it is a thin sessionStorage round-trip, and driving the real one
// is what proves the snapshot the redirect writes is the snapshot the callback
// reads back.

const { notificationsMock } = vi.hoisted(() => ({
  notificationsMock: { show: vi.fn(), update: vi.fn(), hide: vi.fn() },
}));
vi.mock("@mantine/notifications", () => ({ notifications: notificationsMock }));

const { oauthStorageMock } = vi.hoisted(() => ({
  oauthStorageMock: { load: vi.fn(), clear: vi.fn() },
}));
vi.mock("../lib/remoteOAuthStorage", () => ({
  getWebRemoteOAuthStorage: () => oauthStorageMock,
}));

const { clearServerOAuthStateMock } = vi.hoisted(() => ({
  clearServerOAuthStateMock: vi.fn(),
}));
vi.mock("../lib/clearServerOAuthState", () => ({
  clearServerOAuthState: clearServerOAuthStateMock,
}));

const { saveSessionMock } = vi.hoisted(() => ({ saveSessionMock: vi.fn() }));
vi.mock("@inspector/core/mcp/remote/index.js", () => ({
  RemoteInspectorClientStorage: class {
    saveSession = saveSessionMock;
  },
}));

vi.mock("../lib/authToken", () => ({ getAuthToken: () => "test-token" }));

const { visibility } = vi.hoisted(() => ({
  visibility: {
    visible: true,
    listeners: new Set<() => void>(),
  },
}));
vi.mock("../lib/browserTabVisibility", () => ({
  isBrowserTabVisible: () => visibility.visible,
  onBrowserTabVisible: (cb: () => void) => {
    visibility.listeners.add(cb);
    return () => visibility.listeners.delete(cb);
  },
}));

/** Fire the tab-became-visible signal the deferred-recovery path waits on. */
function becomeVisible(): void {
  visibility.visible = true;
  for (const cb of visibility.listeners) cb();
}

// --- Fixtures ---------------------------------------------------------------

const AUTH_URL = new URL("https://as.example/authorize");
/** A 64-char-hex authId, the only `state` shape the callback path accepts. */
const AUTH_ID = "a".repeat(64);

const entry = (
  id: string,
  over: Partial<ServerEntry> = {},
  enterpriseManaged?: boolean,
): ServerEntry => ({
  id,
  name: `Server ${id}`,
  config: { type: "streamable-http", url: "https://mcp.example/mcp" },
  connection: { status: "disconnected" },
  ...(enterpriseManaged !== undefined && {
    settings: { ...EMPTY_SETTINGS, enterpriseManaged },
  }),
  ...over,
});

const challenge = (
  reason: AuthChallenge["reason"] = "unauthorized",
): AuthChallenge => ({ reason });

/** One Network-log row, as the pre-redirect flush would find it. */
const fetchEntry = (id: string): FetchRequestEntry => ({
  id,
  timestamp: new Date(0),
  method: "POST",
  url: "https://as.example/token",
  requestHeaders: {},
  category: "auth",
});

/**
 * A stand-in `InspectorClient`.
 *
 * Built on the real prototype (`Object.create`) so the cast is a single one
 * rather than an `as unknown as`: the object genuinely is an `InspectorClient`
 * by prototype, and the assignment below overrides the handful of members the
 * hook calls. The event surface delegates to a real `EventTarget`, since the
 * native one cannot be inherited without running its constructor.
 */
function fakeClient(over: Partial<Record<string, unknown>> = {}) {
  const bus = new EventTarget();
  const client = Object.create(InspectorClient.prototype) as InspectorClient;
  return Object.assign(client, {
    addEventListener: bus.addEventListener.bind(bus),
    removeEventListener: bus.removeEventListener.bind(bus),
    emit: (type: string, detail: unknown) =>
      bus.dispatchEvent(new CustomEvent(type, { detail })),
    getOAuthState: vi.fn().mockResolvedValue(null),
    getRemoteBackendSessionId: vi.fn().mockReturnValue("remote-1"),
    beginInteractiveAuthorization: vi.fn().mockResolvedValue(undefined),
    checkAuthChallengeSatisfied: vi.fn().mockResolvedValue(false),
    pushRemoteAuthState: vi.fn().mockResolvedValue(undefined),
    handleAuthChallenge: vi.fn().mockResolvedValue({ kind: "failed" }),
    disconnect: vi.fn().mockResolvedValue(undefined),
    resumeAfterOAuth: vi.fn().mockResolvedValue(undefined),
    ...over,
  });
}

type FakeClient = ReturnType<typeof fakeClient>;

interface HarnessProps {
  servers?: ServerEntry[];
  activeServerId?: string;
  client?: FakeClient | null;
  connectionStatus?: ConnectionStatus;
  /** Left null to exercise the "connect path not wired yet" callback arm. */
  setupClient?: (server: ServerEntry) => InspectorClient;
  fetchRequests?: FetchRequestEntry[];
  /** Set to drop the Network log entirely, as before the first connect. */
  noFetchLog?: boolean;
}

interface Harness {
  api: () => OAuthRecovery;
  rerender: (next: HarnessProps) => void;
  spies: {
    setActiveServerId: ReturnType<typeof vi.fn>;
    setFailedServerId: ReturnType<typeof vi.fn>;
    clearResultPanels: ReturnType<typeof vi.fn>;
    setSourceScopedError: ReturnType<typeof vi.fn>;
    setupClient: ReturnType<typeof vi.fn>;
  };
}

function harness(initial: HarnessProps = {}): Harness {
  let latest: OAuthRecovery | undefined;
  const spies = {
    setActiveServerId: vi.fn(),
    setFailedServerId: vi.fn(),
    clearResultPanels: vi.fn(),
    setSourceScopedError: vi.fn(),
    setupClient: vi.fn(),
  };

  function Probe({ p }: { p: HarnessProps }) {
    const client = p.client ?? null;
    const sessionRef = useSessionRef({
      activeServerId: p.activeServerId,
      servers: p.servers ?? [],
      inspectorClient: client,
    });
    const { ui, setUi, activeTab, setActiveTab } = useTabUiState();
    const fetchLogRef = useRef<FetchRequestSource | null>(null);
    // Both refs are held across renders and published from a layout effect,
    // exactly as App.tsx does — a fresh object per render would give the
    // callback effect a changing dependency the real one never has, and the
    // deferred-publication test below would then be passing for the wrong
    // reason.
    const setupClientForServerRef = useRef<SetupClientForServer | null>(null);
    useLayoutEffect(() => {
      fetchLogRef.current = p.noFetchLog
        ? null
        : { getFetchRequests: () => p.fetchRequests ?? [] };
      setupClientForServerRef.current = p.setupClient
        ? (server: ServerEntry) => {
            spies.setupClient(server);
            return p.setupClient!(server);
          }
        : null;
    });
    latest = useOAuthRecovery({
      sessionRef,
      servers: p.servers ?? [],
      activeServerId: p.activeServerId,
      inspectorClient: client,
      connectionStatus: p.connectionStatus ?? "connected",
      activeTab,
      ui,
      setUi,
      setActiveTab,
      fetchLogRef,
      connectStartRef: { current: undefined },
      initialConfigSettledRef: { current: { promise: Promise.resolve() } },
      setupClientForServerRef,
      setActiveServerId: spies.setActiveServerId,
      setFailedServerId: spies.setFailedServerId,
      clearResultPanels: spies.clearResultPanels,
      setSourceScopedError: spies.setSourceScopedError,
    });
    return null;
  }

  const { rerender } = renderWithMantine(<Probe p={initial} />);
  return {
    api: () => {
      if (!latest) throw new Error("hook did not render");
      return latest;
    },
    rerender: (next) => rerender(<Probe p={next} />),
    spies,
  };
}

/** Every toast title raised so far, for order-insensitive assertions. */
const toastTitles = (): string[] =>
  notificationsMock.show.mock.calls.map((c) => String(c[0]?.title));

const toastWith = (fragment: string) =>
  notificationsMock.show.mock.calls.find((c) =>
    String(c[0]?.message ?? "").includes(fragment),
  );

/** Put the page on `/oauth/callback` with the given query. */
function onCallbackUrl(search: string): void {
  window.history.replaceState({}, "", `/oauth/callback${search}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  visibility.visible = true;
  visibility.listeners.clear();
  window.sessionStorage.clear();
  window.history.replaceState({}, "", "/");
  oauthStorageMock.load.mockResolvedValue(undefined);
  clearServerOAuthStateMock.mockResolvedValue(true);
  saveSessionMock.mockResolvedValue(undefined);
});

afterEach(() => {
  window.history.replaceState({}, "", "/");
});

describe("useOAuthRecovery", () => {
  describe("pending slots", () => {
    it("mirrors the step-up slot into the session ref and clears it on a server switch", async () => {
      const client = fakeClient();
      const servers = [entry("a"), entry("b")];
      const h = harness({ servers, activeServerId: "a", client });

      await act(async () => {
        await h
          .api()
          .handleCommandScopedAuthRecovery(
            new AuthRecoveryRequiredError(
              AUTH_URL,
              challenge("insufficient_scope"),
            ),
            { serverId: "a", source: "tool" },
          );
      });
      expect(h.api().pendingStepUp?.serverId).toBe("a");

      h.rerender({ servers, activeServerId: "b", client });
      await waitFor(() => expect(h.api().pendingStepUp).toBeNull());
    });

    it("drops a deferred recovery when the user switches server", async () => {
      visibility.visible = false;
      const client = fakeClient();
      const servers = [entry("a"), entry("b")];
      const h = harness({ servers, activeServerId: "a", client });
      await act(async () => {
        client.emit("authChallengeInteractive", {
          challenge: challenge(),
          authorizationUrl: AUTH_URL,
        });
      });
      h.rerender({ servers, activeServerId: "b", client });
      await act(async () => {
        becomeVisible();
      });
      // Cleared rather than resumed against the server the user left.
      expect(client.handleAuthChallenge).not.toHaveBeenCalled();
    });

    it("refuses a second step-up while one is open", async () => {
      const client = fakeClient();
      const h = harness({ servers: [entry("a")], activeServerId: "a", client });
      const raise = () =>
        h
          .api()
          .handleCommandScopedAuthRecovery(
            new AuthRecoveryRequiredError(
              AUTH_URL,
              challenge("insufficient_scope"),
            ),
            { serverId: "a", source: "tool" },
          );

      await act(async () => {
        await raise();
      });
      const first = h.api().pendingStepUp;
      await act(async () => {
        await raise();
      });
      expect(h.api().pendingStepUp).toBe(first);
      expect(toastTitles()).toContain("Step-up authorization in progress");
    });

    it("resets the banner and both slots on a session reset", async () => {
      const client = fakeClient();
      const h = harness({ servers: [entry("a")], activeServerId: "a", client });
      await act(async () => {
        await h
          .api()
          .handleCommandScopedAuthRecovery(
            new AuthRecoveryRequiredError(
              AUTH_URL,
              challenge("insufficient_scope"),
            ),
            { serverId: "a", source: "tool" },
          );
      });
      act(() => h.api().resetOAuthRecoveryState());
      expect(h.api().pendingStepUp).toBeNull();
      expect(h.api().reAuthBanner).toBeNull();
    });
  });

  describe("connection-info OAuth details", () => {
    it("loads details while connected and refreshes on oauthComplete", async () => {
      const client = fakeClient({
        getOAuthState: vi
          .fn()
          .mockResolvedValue({ tokens: { access_token: "t" } }),
      });
      const h = harness({ servers: [entry("a")], activeServerId: "a", client });
      await waitFor(() => expect(h.api().connectionInfoOAuth).toBeDefined());
      expect(client.getOAuthState).toHaveBeenCalledTimes(1);

      await act(async () => {
        client.emit("oauthComplete", {});
      });
      await waitFor(() =>
        expect(client.getOAuthState).toHaveBeenCalledTimes(2),
      );
    });

    it("clears the details when the state read comes back empty", async () => {
      const client = fakeClient();
      const h = harness({ servers: [entry("a")], activeServerId: "a", client });
      await waitFor(() => expect(client.getOAuthState).toHaveBeenCalled());
      expect(h.api().connectionInfoOAuth).toBeUndefined();
    });

    it("drops a state read that lands after the session ended", async () => {
      let settle: (value: unknown) => void = () => {};
      const client = fakeClient({
        getOAuthState: vi.fn(
          () =>
            new Promise((resolve) => {
              settle = resolve;
            }),
        ),
      });
      const props: HarnessProps = {
        servers: [entry("a")],
        activeServerId: "a",
        client,
      };
      const h = harness(props);
      h.rerender({ ...props, connectionStatus: "disconnected" });
      await act(async () => {
        settle({ tokens: { access_token: "t" } });
      });
      expect(h.api().connectionInfoOAuth).toBeUndefined();
    });

    it("stays undefined while disconnected", async () => {
      const client = fakeClient();
      const h = harness({
        servers: [entry("a")],
        activeServerId: "a",
        client,
        connectionStatus: "disconnected",
      });
      expect(h.api().connectionInfoOAuth).toBeUndefined();
      expect(client.getOAuthState).not.toHaveBeenCalled();
    });

    it("toasts an ambient refresh, naming the active server", async () => {
      const client = fakeClient();
      const h = harness({ servers: [entry("a")], activeServerId: "a", client });
      await waitFor(() => expect(client.getOAuthState).toHaveBeenCalled());
      await act(async () => {
        client.emit("authChallengeAmbient", {});
      });
      expect(toastTitles()).toContain(
        'Refreshing authorization for "Server a"',
      );
      h.rerender({ servers: [], activeServerId: undefined, client });
    });

    it("falls back to the unnamed ambient copy with no active server", async () => {
      const client = fakeClient();
      harness({ servers: [], activeServerId: undefined, client });
      await waitFor(() => expect(client.getOAuthState).toHaveBeenCalled());
      await act(async () => {
        client.emit("authChallengeAmbient", {});
      });
      expect(toastTitles()).toContain("Refreshing authorization");
    });
  });

  describe("onBeforeOAuthRedirect", () => {
    it("saves the pre-redirect fetch log under the authorization state's authId", () => {
      const entries = [fetchEntry("f1")];
      const h = harness({ fetchRequests: entries });
      const url = new URL(`https://as.example/authorize?state=${AUTH_ID}`);
      act(() => h.api().onBeforeOAuthRedirect(url));
      expect(saveSessionMock).toHaveBeenCalledWith(
        AUTH_ID,
        expect.objectContaining({ fetchRequests: entries }),
      );
    });

    it("does nothing without a parseable state parameter", () => {
      const h = harness({ fetchRequests: [fetchEntry("f1")] });
      act(() => h.api().onBeforeOAuthRedirect(new URL(AUTH_URL)));
      act(() =>
        h
          .api()
          .onBeforeOAuthRedirect(
            new URL("https://as.example/authorize?state=nope"),
          ),
      );
      expect(saveSessionMock).not.toHaveBeenCalled();
    });

    it("does nothing when the log is empty", () => {
      const h = harness({ fetchRequests: [] });
      act(() =>
        h
          .api()
          .onBeforeOAuthRedirect(
            new URL(`https://as.example/authorize?state=${AUTH_ID}`),
          ),
      );
      expect(saveSessionMock).not.toHaveBeenCalled();
    });

    it("does nothing before the Network log exists", () => {
      const h = harness({ noFetchLog: true });
      act(() =>
        h
          .api()
          .onBeforeOAuthRedirect(
            new URL(`https://as.example/authorize?state=${AUTH_ID}`),
          ),
      );
      expect(saveSessionMock).not.toHaveBeenCalled();
    });

    it("swallows a failed save", async () => {
      saveSessionMock.mockRejectedValue(new Error("offline"));
      const h = harness({ fetchRequests: [fetchEntry("f1")] });
      act(() =>
        h
          .api()
          .onBeforeOAuthRedirect(
            new URL(`https://as.example/authorize?state=${AUTH_ID}`),
          ),
      );
      await waitFor(() => expect(saveSessionMock).toHaveBeenCalled());
    });
  });

  describe("prepareOAuthRedirect", () => {
    it("writes the resume snapshot and starts the authorization", () => {
      const client = fakeClient();
      const h = harness({ servers: [entry("a")], activeServerId: "a", client });
      act(() =>
        h.api().prepareOAuthRedirect({
          serverId: "a",
          authKind: "reauth",
          authorizationUrl: AUTH_URL,
          recoverySource: "tool",
        }),
      );
      const raw = window.sessionStorage.getItem(OAUTH_RESUME_KEY);
      expect(raw).toBeTruthy();
      const snapshot = JSON.parse(String(raw)) as OAuthResumeSnapshot;
      expect(snapshot).toMatchObject({
        serverId: "a",
        authKind: "reauth",
        remoteSessionId: "remote-1",
        recoverySource: "tool",
      });
      expect(client.beginInteractiveAuthorization).toHaveBeenCalledWith(
        AUTH_URL,
      );
    });

    it("carries the step-up challenge and prefers an explicitly passed client", () => {
      const active = fakeClient();
      const explicit = fakeClient();
      const h = harness({
        servers: [entry("a")],
        activeServerId: "a",
        client: active,
      });
      const stepUpChallenge = challenge("insufficient_scope");
      act(() =>
        h.api().prepareOAuthRedirect({
          serverId: "a",
          authKind: "step_up",
          authorizationUrl: AUTH_URL,
          authChallenge: stepUpChallenge,
          client: explicit,
          preRedirectContext: "connect",
        }),
      );
      const snapshot = JSON.parse(
        String(window.sessionStorage.getItem(OAUTH_RESUME_KEY)),
      ) as OAuthResumeSnapshot;
      expect(snapshot.authChallenge).toMatchObject({
        reason: "insufficient_scope",
      });
      expect(explicit.beginInteractiveAuthorization).toHaveBeenCalled();
      expect(active.beginInteractiveAuthorization).not.toHaveBeenCalled();
    });

    it("tolerates having no client at all", () => {
      const h = harness({ servers: [entry("a")], client: null });
      act(() =>
        h.api().prepareOAuthRedirect({
          serverId: "a",
          authKind: "reauth",
          authorizationUrl: AUTH_URL,
        }),
      );
      expect(window.sessionStorage.getItem(OAUTH_RESUME_KEY)).toBeTruthy();
    });
  });

  describe("command-scoped recovery", () => {
    const recoveryError = (reason: AuthChallenge["reason"] = "unauthorized") =>
      new AuthRecoveryRequiredError(AUTH_URL, challenge(reason));

    it("returns false with no live client", async () => {
      const h = harness({ servers: [entry("a")], client: null });
      await act(async () => {
        await expect(
          h.api().handleCommandScopedAuthRecovery(recoveryError(), {
            serverId: "a",
            source: "tool",
          }),
        ).resolves.toBe(false);
      });
    });

    it("reports a stored token that already satisfies the challenge", async () => {
      const client = fakeClient({
        checkAuthChallengeSatisfied: vi.fn().mockResolvedValue(true),
      });
      const h = harness({ servers: [entry("a")], activeServerId: "a", client });
      await act(async () => {
        await expect(
          h.api().handleCommandScopedAuthRecovery(recoveryError(), {
            serverId: "a",
            source: "tool",
          }),
        ).resolves.toBe(true);
      });
      expect(client.pushRemoteAuthState).toHaveBeenCalled();
      expect(toastTitles()).toContain("Authorization restored");
    });

    it("short-circuits an EMA step-up whose scopes are already stored", async () => {
      const client = fakeClient({
        checkAuthChallengeSatisfied: vi.fn().mockResolvedValue(true),
      });
      const h = harness({
        servers: [entry("a", {}, true)],
        activeServerId: "a",
        client,
      });
      await act(async () => {
        await expect(
          h.api().handleCommandScopedAuthRecovery(
            new AuthRecoveryRequiredError(AUTH_URL, challenge("unauthorized"), {
              emaStepUpConfirm: true,
            }),
            { serverId: "a", source: "tool" },
          ),
        ).resolves.toBe(true);
      });
      expect(h.api().pendingStepUp).toBeNull();
    });

    it("redirects for a plain re-auth challenge", async () => {
      const client = fakeClient();
      const h = harness({ servers: [entry("a")], activeServerId: "a", client });
      await act(async () => {
        await expect(
          h.api().handleCommandScopedAuthRecovery(recoveryError(), {
            serverId: "a",
            source: "prompt",
          }),
        ).resolves.toBe(false);
      });
      expect(client.beginInteractiveAuthorization).toHaveBeenCalled();
    });

    it("runs an operation unchanged when there is no session to recover", async () => {
      const h = harness({ servers: [entry("a")], client: null });
      const op = vi.fn().mockResolvedValue("value");
      await act(async () => {
        await expect(
          h.api().runWithCommandAuthRecovery(op, "tool"),
        ).resolves.toBe("value");
      });
      expect(op).toHaveBeenCalledTimes(1);
    });

    it("retries the operation once recovery is satisfied", async () => {
      const client = fakeClient({
        checkAuthChallengeSatisfied: vi.fn().mockResolvedValue(true),
      });
      const h = harness({ servers: [entry("a")], activeServerId: "a", client });
      const op = vi
        .fn()
        .mockRejectedValueOnce(recoveryError())
        .mockResolvedValue("second");
      await act(async () => {
        await expect(
          h.api().runWithCommandAuthRecovery(op, "tool"),
        ).resolves.toBe("second");
      });
      expect(op).toHaveBeenCalledTimes(2);
    });

    it("gives up quietly when recovery is not satisfied", async () => {
      const client = fakeClient();
      const h = harness({ servers: [entry("a")], activeServerId: "a", client });
      const op = vi.fn().mockRejectedValue(recoveryError());
      await act(async () => {
        await expect(
          h.api().runWithCommandAuthRecovery(op, "tool"),
        ).resolves.toBeUndefined();
      });
      expect(op).toHaveBeenCalledTimes(1);
    });

    it("rethrows anything that is not an auth-recovery error", async () => {
      const client = fakeClient();
      const h = harness({ servers: [entry("a")], activeServerId: "a", client });
      await act(async () => {
        await expect(
          h
            .api()
            .runWithCommandAuthRecovery(
              () => Promise.reject(new Error("boom")),
              "tool",
            ),
        ).rejects.toThrow("boom");
      });
    });

    it("toasts a background failure only when given a title", async () => {
      const client = fakeClient();
      const h = harness({ servers: [entry("a")], activeServerId: "a", client });
      await act(async () => {
        h.api().runCommandInBackground(
          () => Promise.reject(new Error("boom")),
          "ambient",
          "Refresh failed",
        );
        await Promise.resolve();
      });
      await waitFor(() => expect(toastTitles()).toContain("Refresh failed"));

      notificationsMock.show.mockClear();
      await act(async () => {
        h.api().runCommandInBackground(
          () => Promise.reject("plain string"),
          "ambient",
        );
        await Promise.resolve();
      });
      expect(notificationsMock.show).not.toHaveBeenCalled();
    });

    it("stringifies a non-Error background failure into the toast", async () => {
      const client = fakeClient();
      const h = harness({ servers: [entry("a")], activeServerId: "a", client });
      await act(async () => {
        h.api().runCommandInBackground(
          () => Promise.reject("plain string"),
          "ambient",
          "Refresh failed",
        );
        await Promise.resolve();
      });
      await waitFor(() => expect(toastWith("plain string")).toBeDefined());
    });
  });

  describe("ambient challenges", () => {
    it("defers recovery while the tab is hidden, then resumes when it returns", async () => {
      visibility.visible = false;
      const client = fakeClient({
        checkAuthChallengeSatisfied: vi.fn().mockResolvedValue(true),
      });
      harness({ servers: [entry("a")], activeServerId: "a", client });

      await act(async () => {
        client.emit("authChallengeInteractive", {
          challenge: challenge(),
          authorizationUrl: AUTH_URL,
        });
      });
      expect(toastTitles()).toContain("Authorization pending");

      await act(async () => {
        becomeVisible();
      });
      await waitFor(() =>
        expect(client.checkAuthChallengeSatisfied).toHaveBeenCalled(),
      );
      expect(toastTitles()).toContain("Authorization restored");
    });

    it("warns when a second deferral replaces the first", async () => {
      visibility.visible = false;
      const client = fakeClient();
      harness({ servers: [entry("a")], activeServerId: "a", client });
      const fire = () =>
        client.emit("authChallengeInteractive", {
          challenge: challenge(),
          authorizationUrl: AUTH_URL,
        });
      await act(async () => {
        fire();
      });
      await act(async () => {
        fire();
      });
      expect(toastTitles()).toContain("Authorization update pending");
    });

    it("ignores an ambient challenge with no active server", async () => {
      const client = fakeClient();
      harness({ servers: [], activeServerId: undefined, client });
      await act(async () => {
        client.emit("authChallengeInteractive", {
          challenge: challenge(),
          authorizationUrl: AUTH_URL,
        });
      });
      expect(client.checkAuthChallengeSatisfied).not.toHaveBeenCalled();
    });

    it("redirects immediately for a visible ambient challenge", async () => {
      const client = fakeClient();
      harness({ servers: [entry("a")], activeServerId: "a", client });
      await act(async () => {
        client.emit("authChallengeInteractive", {
          challenge: challenge(),
          authorizationUrl: AUTH_URL,
        });
      });
      await waitFor(() =>
        expect(client.beginInteractiveAuthorization).toHaveBeenCalled(),
      );
    });

    it("opens the step-up prompt instead of redirecting for a scope challenge", async () => {
      const client = fakeClient();
      const h = harness({ servers: [entry("a")], activeServerId: "a", client });
      await act(async () => {
        client.emit("authChallengeInteractive", {
          challenge: challenge("insufficient_scope"),
          authorizationUrl: AUTH_URL,
        });
      });
      await waitFor(() => expect(h.api().pendingStepUp).not.toBeNull());
      expect(client.beginInteractiveAuthorization).not.toHaveBeenCalled();
    });

    it("does nothing when the stored token already satisfies it", async () => {
      const client = fakeClient({
        checkAuthChallengeSatisfied: vi.fn().mockResolvedValue(true),
      });
      harness({ servers: [entry("a")], activeServerId: "a", client });
      await act(async () => {
        client.emit("authChallengeInteractive", {
          challenge: challenge(),
          authorizationUrl: AUTH_URL,
        });
      });
      await waitFor(() =>
        expect(toastTitles()).toContain("Authorization restored"),
      );
      expect(client.beginInteractiveAuthorization).not.toHaveBeenCalled();
    });

    it("raises the banner on an oauthError event", async () => {
      const client = fakeClient();
      const h = harness({ servers: [entry("a")], activeServerId: "a", client });
      await act(async () => {
        client.emit("oauthError", { error: new Error("token endpoint 500") });
      });
      await waitFor(() => expect(h.api().reAuthBanner?.serverId).toBe("a"));
    });

    it("ignores an oauthError with no active server", async () => {
      const client = fakeClient();
      const h = harness({ servers: [], activeServerId: undefined, client });
      await act(async () => {
        client.emit("oauthError", { error: new Error("nope") });
      });
      expect(h.api().reAuthBanner).toBeNull();
    });
  });

  describe("resuming a deferred recovery", () => {
    const defer = async (client: FakeClient, h: Harness) => {
      visibility.visible = false;
      await act(async () => {
        client.emit("authChallengeInteractive", {
          challenge: challenge(),
          authorizationUrl: AUTH_URL,
        });
      });
      expect(h.api()).toBeDefined();
    };

    it("re-runs the challenge and reports a satisfied outcome", async () => {
      const client = fakeClient({
        handleAuthChallenge: vi.fn().mockResolvedValue({ kind: "satisfied" }),
      });
      const h = harness({ servers: [entry("a")], activeServerId: "a", client });
      await defer(client, h);
      await act(async () => {
        becomeVisible();
      });
      await waitFor(() =>
        expect(client.handleAuthChallenge).toHaveBeenCalled(),
      );
      expect(toastTitles()).toContain("Authorization restored");
    });

    it("redirects on an interactive outcome", async () => {
      const client = fakeClient({
        handleAuthChallenge: vi.fn().mockResolvedValue({
          kind: "interactive",
          challenge: challenge(),
          authorizationUrl: AUTH_URL,
        }),
      });
      const h = harness({ servers: [entry("a")], activeServerId: "a", client });
      await defer(client, h);
      await act(async () => {
        becomeVisible();
      });
      await waitFor(() =>
        expect(client.beginInteractiveAuthorization).toHaveBeenCalled(),
      );
    });

    it("raises the banner on a failed outcome", async () => {
      const client = fakeClient({
        handleAuthChallenge: vi
          .fn()
          .mockResolvedValue({ kind: "failed", error: new Error("nope") }),
      });
      const h = harness({ servers: [entry("a")], activeServerId: "a", client });
      await defer(client, h);
      await act(async () => {
        becomeVisible();
      });
      await waitFor(() => expect(h.api().reAuthBanner?.serverId).toBe("a"));
    });

    it("goes back through the step-up prompt when that is what was deferred", async () => {
      const client = fakeClient();
      const h = harness({
        servers: [entry("a")],
        activeServerId: "a",
        client,
      });
      visibility.visible = false;
      await act(async () => {
        client.emit("authChallengeInteractive", {
          challenge: challenge("insufficient_scope"),
          authorizationUrl: AUTH_URL,
        });
      });
      await act(async () => {
        becomeVisible();
      });
      await waitFor(() => expect(h.api().pendingStepUp).not.toBeNull());
      expect(client.handleAuthChallenge).not.toHaveBeenCalled();
    });

    it("does nothing when the tab returns with nothing deferred", async () => {
      const client = fakeClient();
      harness({ servers: [entry("a")], activeServerId: "a", client });
      await act(async () => {
        becomeVisible();
      });
      expect(client.handleAuthChallenge).not.toHaveBeenCalled();
    });

    it("does nothing once the client is gone", async () => {
      const client = fakeClient({
        handleAuthChallenge: vi.fn().mockResolvedValue({ kind: "satisfied" }),
      });
      const props: HarnessProps = {
        servers: [entry("a")],
        activeServerId: "a",
        client,
      };
      const h = harness(props);
      await defer(client, h);
      h.rerender({ ...props, client: null });
      await act(async () => {
        becomeVisible();
      });
      expect(client.handleAuthChallenge).not.toHaveBeenCalled();
    });

    it("runs one resume at a time", async () => {
      const client = fakeClient({
        handleAuthChallenge: vi.fn().mockResolvedValue({ kind: "satisfied" }),
      });
      const h = harness({ servers: [entry("a")], activeServerId: "a", client });
      await defer(client, h);
      // Both fire before the first resume's `await` settles, so the second one
      // still sees the deferred slot in the session ref — which is exactly the
      // re-entrancy `reauthResumeInProgressRef` exists to stop.
      await act(async () => {
        becomeVisible();
        becomeVisible();
      });
      expect(client.handleAuthChallenge).toHaveBeenCalledTimes(1);
    });

    it("does not resume while disconnected, and resumes on the reconnect", async () => {
      const client = fakeClient({
        handleAuthChallenge: vi.fn().mockResolvedValue({ kind: "satisfied" }),
      });
      const props: HarnessProps = {
        servers: [entry("a")],
        activeServerId: "a",
        client,
      };
      const h = harness(props);
      await defer(client, h);

      h.rerender({ ...props, connectionStatus: "disconnected" });
      await act(async () => {
        becomeVisible();
      });
      expect(client.handleAuthChallenge).not.toHaveBeenCalled();

      h.rerender({ ...props, connectionStatus: "connected" });
      await waitFor(() =>
        expect(client.handleAuthChallenge).toHaveBeenCalled(),
      );
    });
  });

  describe("abandoned redirect", () => {
    it("raises the banner for an abandoned re-auth", async () => {
      writeOAuthResumeSnapshot({
        version: 1,
        serverId: "a",
        activeTab: "tools",
        authKind: "reauth",
        tabUi: {},
      });
      const h = harness({ servers: [entry("a")], activeServerId: "a" });
      await waitFor(() => expect(h.api().reAuthBanner?.serverId).toBe("a"));
      expect(window.sessionStorage.getItem(OAUTH_RESUME_KEY)).toBeNull();
    });

    it("raises the banner for an abandoned step-up", async () => {
      writeOAuthResumeSnapshot({
        version: 1,
        serverId: "a",
        activeTab: "tools",
        authKind: "step_up",
        tabUi: {},
        recoverySource: "tool",
      });
      const h = harness({ servers: [entry("a")], activeServerId: "a" });
      await waitFor(() => expect(h.api().reAuthBanner?.serverId).toBe("a"));
    });

    it("does nothing without a snapshot, or before the list hydrates", async () => {
      const h = harness({ servers: [] });
      await waitFor(() => expect(h.api().reAuthBanner).toBeNull());
      h.rerender({ servers: [entry("a")] });
      await waitFor(() => expect(h.api().reAuthBanner).toBeNull());
    });

    it("checks once per load", async () => {
      writeOAuthResumeSnapshot({
        version: 1,
        serverId: "a",
        activeTab: "tools",
        authKind: "reauth",
        tabUi: {},
      });
      const h = harness({ servers: [entry("a")], activeServerId: "a" });
      await waitFor(() => expect(h.api().reAuthBanner).not.toBeNull());
      act(() => h.api().setReAuthBanner(null));
      h.rerender({ servers: [entry("a"), entry("b")], activeServerId: "a" });
      await waitFor(() => expect(h.api().reAuthBanner).toBeNull());
    });

    it("skips the check on the callback path", async () => {
      onCallbackUrl("");
      writeOAuthResumeSnapshot({
        version: 1,
        serverId: "a",
        activeTab: "tools",
        authKind: "reauth",
        tabUi: {},
      });
      const h = harness({ servers: [entry("a")] });
      await waitFor(() => expect(h.api().reAuthBanner).toBeNull());
      expect(window.sessionStorage.getItem(OAUTH_RESUME_KEY)).toBeTruthy();
    });
  });

  describe("/oauth/callback", () => {
    const snapshot = (over: Partial<OAuthResumeSnapshot> = {}) =>
      writeOAuthResumeSnapshot({
        version: 1,
        serverId: "a",
        activeTab: "tools",
        authKind: "reauth",
        tabUi: {},
        ...over,
      } as OAuthResumeSnapshot);

    const callbackHarness = (
      search: string,
      over: Partial<HarnessProps> = {},
      client = fakeClient(),
    ) => {
      onCallbackUrl(search);
      return harness({
        servers: [entry("a")],
        setupClient: () => client,
        ...over,
      });
    };

    it("keeps the code unspent when no client builder has been published", async () => {
      onCallbackUrl(`?code=abc&state=${AUTH_ID}`);
      snapshot();
      const client = fakeClient();
      // App.tsx publishes the builder from a layout effect, so this arm is
      // defensive rather than reachable there. What it has to guarantee is
      // that the guard returns *before* the one-shot latch: a run that cannot
      // exchange must not spend the single-use authorization code.
      const h = harness({ servers: [entry("a")] });
      await waitFor(() =>
        expect(window.location.pathname).toBe("/oauth/callback"),
      );
      expect(client.resumeAfterOAuth).not.toHaveBeenCalled();

      // The next `servers` change — the same dependency the hydration wait
      // rides in production — still finds the latch open.
      h.rerender({
        servers: [entry("a"), entry("b")],
        setupClient: () => client,
      });
      await waitFor(() => expect(client.resumeAfterOAuth).toHaveBeenCalled());
    });

    it("exchanges the single-use code exactly once", async () => {
      snapshot();
      const client = fakeClient();
      const h = callbackHarness(`?code=abc&state=${AUTH_ID}`, {}, client);
      await waitFor(() => expect(client.resumeAfterOAuth).toHaveBeenCalled());
      h.rerender({
        servers: [entry("a"), entry("b")],
        setupClient: () => client,
      });
      await waitFor(() => expect(h.spies.setupClient).toHaveBeenCalledTimes(1));
      expect(client.resumeAfterOAuth).toHaveBeenCalledTimes(1);
    });

    it("rejects a state parameter that did not originate here", async () => {
      snapshot();
      const client = fakeClient();
      callbackHarness("?code=abc&state=forged", {}, client);
      await waitFor(() =>
        expect(toastTitles()).toContain("OAuth callback rejected"),
      );
      expect(client.resumeAfterOAuth).not.toHaveBeenCalled();
    });

    it("flags the server and banners a provider error", async () => {
      snapshot();
      const h = callbackHarness("?error=access_denied");
      await waitFor(() => expect(h.api().reAuthBanner?.serverId).toBe("a"));
      expect(h.spies.setFailedServerId).toHaveBeenCalledWith("a");
    });

    it("toasts a provider error that cannot be matched to a server", async () => {
      callbackHarness("?error=access_denied");
      await waitFor(() =>
        expect(toastTitles()).toContain("OAuth authorization failed"),
      );
    });

    it("toasts a success that cannot be matched to a server", async () => {
      callbackHarness(`?code=abc&state=${AUTH_ID}`);
      await waitFor(() =>
        expect(toastTitles()).toContain("OAuth callback could not be matched"),
      );
    });

    it("restores the shell, rebuilds the client and completes", async () => {
      snapshot({ remoteSessionId: "remote-9" });
      const client = fakeClient();
      const h = callbackHarness(`?code=abc&state=${AUTH_ID}`, {}, client);
      await waitFor(() => expect(client.resumeAfterOAuth).toHaveBeenCalled());
      expect(client.resumeAfterOAuth).toHaveBeenCalledWith(
        "abc",
        expect.objectContaining({ remoteSessionId: "remote-9" }),
      );
      expect(h.spies.setActiveServerId).toHaveBeenCalledWith("a");
      expect(h.spies.clearResultPanels).toHaveBeenCalled();
      await waitFor(() =>
        expect(toastTitles()).toContain("Authorization complete"),
      );
    });

    it("banners a failure to read the OAuth store", async () => {
      snapshot();
      oauthStorageMock.load.mockRejectedValue(new Error("disk gone"));
      const h = callbackHarness(`?code=abc&state=${AUTH_ID}`);
      await waitFor(() => expect(h.api().reAuthBanner?.serverId).toBe("a"));
      expect(h.spies.setFailedServerId).toHaveBeenCalledWith("a");
    });

    it("reports an unconfigured enterprise client without flagging the server", async () => {
      snapshot();
      const client = fakeClient({
        resumeAfterOAuth: vi
          .fn()
          .mockRejectedValue(new EmaClientNotConfiguredError("disabled")),
      });
      const h = callbackHarness(`?code=abc&state=${AUTH_ID}`, {}, client);
      await waitFor(() =>
        expect(toastTitles()).toContain('Cannot connect to "Server a"'),
      );
      expect(client.disconnect).toHaveBeenCalled();
      expect(h.spies.setFailedServerId).not.toHaveBeenCalled();
    });

    it("offers one-click recovery when the authorization state was lost", async () => {
      snapshot();
      const client = fakeClient({
        resumeAfterOAuth: vi
          .fn()
          .mockRejectedValue(
            new AuthorizationServerMismatchError(
              "discoveryState was not available on the callback leg",
              "https://as.example",
            ),
          ),
      });
      const h = callbackHarness(`?code=abc&state=${AUTH_ID}`, {}, client);
      await waitFor(() =>
        expect(h.api().reAuthBanner?.kind).toBe("lost_authorization_state"),
      );
      expect(h.api().reAuthBanner?.actionLabel).toBeTruthy();
    });

    it("refuses one-click recovery on a genuine issuer mismatch", async () => {
      snapshot();
      const client = fakeClient({
        resumeAfterOAuth: vi
          .fn()
          .mockRejectedValue(
            new AuthorizationServerMismatchError(
              "https://recorded.example",
              "https://other.example",
            ),
          ),
      });
      const h = callbackHarness(`?code=abc&state=${AUTH_ID}`, {}, client);
      await waitFor(() => expect(notificationsMock.show).toHaveBeenCalled());
      expect(h.api().reAuthBanner).toBeNull();
    });

    it("banners any other exchange failure", async () => {
      snapshot();
      const client = fakeClient({
        resumeAfterOAuth: vi.fn().mockRejectedValue("token endpoint said no"),
      });
      const h = callbackHarness(`?code=abc&state=${AUTH_ID}`, {}, client);
      await waitFor(() => expect(h.api().reAuthBanner?.serverId).toBe("a"));
    });

    it("reports a step-up whose extra scopes were not granted", async () => {
      snapshot({
        authKind: "step_up",
        authChallenge: challenge("insufficient_scope"),
      });
      const client = fakeClient({
        checkAuthChallengeSatisfied: vi.fn().mockResolvedValue(false),
      });
      callbackHarness(`?code=abc&state=${AUTH_ID}`, {}, client);
      await waitFor(() =>
        expect(toastTitles()).toContain("Additional permissions not granted"),
      );
    });

    it("completes a step-up whose extra scopes were granted", async () => {
      snapshot({
        authKind: "step_up",
        authChallenge: challenge("insufficient_scope"),
      });
      const client = fakeClient({
        checkAuthChallengeSatisfied: vi.fn().mockResolvedValue(true),
      });
      callbackHarness(`?code=abc&state=${AUTH_ID}`, {}, client);
      await waitFor(() =>
        expect(toastTitles()).toContain("Authorization complete"),
      );
    });
  });

  describe("clearing stored OAuth state", () => {
    it("says nothing when there was nothing to clear", async () => {
      clearServerOAuthStateMock.mockResolvedValue(false);
      const h = harness({ servers: [entry("a")], activeServerId: "a" });
      await act(async () => {
        await h.api().clearServerOAuthAndDisconnect(entry("a"));
      });
      expect(notificationsMock.show).not.toHaveBeenCalled();
    });

    it("disconnects the active session and resets the shell", async () => {
      const client = fakeClient();
      const h = harness({ servers: [entry("a")], activeServerId: "a", client });
      await act(async () => {
        await h.api().clearServerOAuthAndDisconnect(entry("a"));
      });
      expect(client.disconnect).toHaveBeenCalled();
      expect(
        toastWith("Reconnect to run a fresh authorization flow."),
      ).toBeDefined();
    });

    it("leaves a live session alone when clearing another server", async () => {
      const client = fakeClient();
      const h = harness({ servers: [entry("a")], activeServerId: "a", client });
      await act(async () => {
        await h.api().clearServerOAuthAndDisconnect(entry("b"));
      });
      expect(client.disconnect).not.toHaveBeenCalled();
      expect(
        toastWith('Stored OAuth state was removed for "Server b"'),
      ).toBeDefined();
    });

    it("clears the resume snapshot on an explicit disconnect", () => {
      writeOAuthResumeSnapshot({
        version: 1,
        serverId: "a",
        activeTab: "tools",
        authKind: "reauth",
        tabUi: {},
      });
      const h = harness({ servers: [entry("a")] });
      act(() => h.api().finalizeExplicitDisconnect());
      expect(window.sessionStorage.getItem(OAUTH_RESUME_KEY)).toBeNull();
    });
  });

  describe("step-up prompt", () => {
    const openStepUp = async (
      h: Harness,
      source: StepUpSource = "tool",
      retryOperation?: () => Promise<unknown>,
    ) => {
      await act(async () => {
        await h
          .api()
          .handleCommandScopedAuthRecovery(
            new AuthRecoveryRequiredError(
              AUTH_URL,
              challenge("insufficient_scope"),
            ),
            { serverId: "a", source, retryOperation },
          );
      });
    };

    it("does nothing with no prompt open", async () => {
      const client = fakeClient();
      const h = harness({ servers: [entry("a")], activeServerId: "a", client });
      await act(async () => {
        await h.api().handleStepUpAuthorize();
      });
      expect(client.beginInteractiveAuthorization).not.toHaveBeenCalled();
    });

    it("does nothing once the client is gone", async () => {
      const client = fakeClient();
      const props = { servers: [entry("a")], activeServerId: "a", client };
      const h = harness(props);
      await openStepUp(h);
      h.rerender({ ...props, client: null });
      await act(async () => {
        await h.api().handleStepUpAuthorize();
      });
      expect(client.beginInteractiveAuthorization).not.toHaveBeenCalled();
    });

    it("redirects for a standard step-up", async () => {
      const client = fakeClient();
      const h = harness({ servers: [entry("a")], activeServerId: "a", client });
      await openStepUp(h);
      await act(async () => {
        await h.api().handleStepUpAuthorize();
      });
      expect(client.beginInteractiveAuthorization).toHaveBeenCalled();
      expect(h.api().pendingStepUp).toBeNull();
    });

    it("runs the stored retry when an EMA step-up is satisfied in place", async () => {
      const client = fakeClient({
        handleAuthChallenge: vi.fn().mockResolvedValue({ kind: "satisfied" }),
      });
      const h = harness({
        servers: [entry("a", {}, true)],
        activeServerId: "a",
        client,
      });
      const retry = vi.fn().mockResolvedValue(undefined);
      await openStepUp(h, "tool", retry);
      await act(async () => {
        await h.api().handleStepUpAuthorize();
      });
      expect(retry).toHaveBeenCalledTimes(1);
      expect(toastTitles()).toContain("Permissions updated");
    });

    it("completes an EMA step-up with no operation to retry", async () => {
      const client = fakeClient({
        handleAuthChallenge: vi.fn().mockResolvedValue({ kind: "satisfied" }),
      });
      const h = harness({
        servers: [entry("a", {}, true)],
        activeServerId: "a",
        client,
      });
      await openStepUp(h, "ambient");
      await act(async () => {
        await h.api().handleStepUpAuthorize();
      });
      expect(toastTitles()).toContain("Permissions updated");
    });

    it("redirects when an EMA step-up needs the browser", async () => {
      const client = fakeClient({
        handleAuthChallenge: vi.fn().mockResolvedValue({
          kind: "interactive",
          challenge: challenge("insufficient_scope"),
          authorizationUrl: AUTH_URL,
        }),
      });
      const h = harness({
        servers: [entry("a", {}, true)],
        activeServerId: "a",
        client,
      });
      await openStepUp(h);
      await act(async () => {
        await h.api().handleStepUpAuthorize();
      });
      expect(client.beginInteractiveAuthorization).toHaveBeenCalled();
    });

    it("routes an EMA step-up failure back to the panel that asked", async () => {
      const client = fakeClient({
        handleAuthChallenge: vi
          .fn()
          .mockResolvedValue({ kind: "failed", error: new Error("denied") }),
      });
      const h = harness({
        servers: [entry("a", {}, true)],
        activeServerId: "a",
        client,
      });
      await openStepUp(h, "prompt");
      await act(async () => {
        await h.api().handleStepUpAuthorize();
      });
      expect(h.spies.setSourceScopedError).toHaveBeenCalledWith(
        "prompt",
        expect.stringContaining("denied"),
      );
    });

    it("cancels back to the panel that asked", async () => {
      const client = fakeClient();
      const h = harness({ servers: [entry("a")], activeServerId: "a", client });
      await openStepUp(h, "resource");
      act(() => h.api().handleStepUpCancel());
      expect(h.spies.setSourceScopedError).toHaveBeenCalledWith(
        "resource",
        "Authorization cancelled.",
      );
      expect(h.api().pendingStepUp).toBeNull();
    });

    it("toasts a cancel that came from an App", async () => {
      const client = fakeClient();
      const h = harness({ servers: [entry("a")], activeServerId: "a", client });
      await openStepUp(h, "app");
      act(() => h.api().handleStepUpCancel());
      expect(toastTitles()).toContain("Authorization cancelled");
    });

    it("is a no-op with no prompt open", () => {
      const h = harness({ servers: [entry("a")], activeServerId: "a" });
      act(() => h.api().handleStepUpCancel());
      expect(h.spies.setSourceScopedError).not.toHaveBeenCalled();
    });
  });
});
