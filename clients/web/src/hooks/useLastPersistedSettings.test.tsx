import { describe, it, expect } from "vitest";
import type {
  InspectorServerSettings,
  ServerEntry,
} from "@inspector/core/mcp/types.js";
import { renderWithMantine } from "../test/renderWithMantine";
import {
  useLastPersistedSettings,
  type LastPersistedSettings,
} from "./useLastPersistedSettings";

const settings = (
  overrides: Partial<InspectorServerSettings> = {},
): InspectorServerSettings => ({
  headers: [],
  env: [],
  metadata: [],
  connectionTimeout: 0,
  requestTimeout: 0,
  taskTtl: 0,
  autoRefreshOnListChanged: false,
  paginatedLists: false,
  maxFetchRequests: 0,
  roots: [],
  ...overrides,
});

/**
 * One `servers` entry, a fresh object per call — most of these tests turn on
 * object identity, so a shared fixture would defeat them. A list rebuilt from
 * fresh calls is what a successful `GET /api/servers` produces.
 */
const entry = (
  id: string,
  settingsNode?: InspectorServerSettings,
): ServerEntry => ({
  id,
  name: id,
  config: { type: "stdio", command: "node" },
  connection: { status: "disconnected" },
  settings: settingsNode,
});

interface Harness {
  api: LastPersistedSettings;
  /** Deliver a new server list, as a successful list read would. */
  setServers: (next: ServerEntry[]) => void;
}

/**
 * Hands the hook's API back to the test. The hook holds refs, so it has to be
 * read from inside a rendered component; `setServers` re-renders it with a new
 * list the way `useServers` does after a read.
 */
function harness(initial: ServerEntry[]): Harness {
  let api: LastPersistedSettings | undefined;
  function Probe({ servers }: { servers: ServerEntry[] }) {
    api = useLastPersistedSettings(servers);
    return null;
  }
  const { rerender } = renderWithMantine(<Probe servers={initial} />);
  if (!api) throw new Error("hook did not render");
  return {
    api,
    setServers: (next) => rerender(<Probe servers={next} />),
  };
}

describe("useLastPersistedSettings", () => {
  it("falls back to the caller's value when no write has been recorded", () => {
    const { api } = harness([entry("A")]);
    const fallback = settings({ paginatedLists: true });
    expect(api.resolve("A", fallback)).toBe(fallback);
  });

  it("returns the recorded write while the entry has not been re-read", () => {
    const { api } = harness([entry("A")]);
    const written = settings({ paginatedLists: true });
    api.record("A", written);
    expect(api.resolve("A", settings())).toBe(written);
  });

  it("ignores a record made for a different server", () => {
    const { api } = harness([entry("A"), entry("B")]);
    api.record("A", settings({ paginatedLists: true }));
    const fallback = settings();
    expect(api.resolve("B", fallback)).toBe(fallback);
  });

  it("keeps each server's record, so a save on B doesn't discard A's", () => {
    // The settings modal can be opened for any server, connected or not, so
    // this sequence is reachable: A's write lands while list reads are failing,
    // B is saved from the modal, and only then does a write on A fail. A single
    // slot would have lost A's baseline and reproduced #2089.
    const { api } = harness([entry("A"), entry("B")]);
    const writtenA = settings({ paginatedLists: true });
    api.record("A", writtenA);
    api.record("B", settings({ autoRefreshOnListChanged: true }));
    expect(api.resolve("A", settings())).toBe(writtenA);
  });

  it("stops trusting the record once a fresh list read replaces the entry", () => {
    const { api, setServers } = harness([entry("A")]);
    api.record("A", settings({ paginatedLists: true }));
    // A successful `GET /api/servers` rebuilds the list, so the entry is a new
    // object even when its values are unchanged. That is the signal the list
    // has caught up, and it is authoritative again from here.
    const fresh = settings();
    setServers([entry("A", fresh)]);
    expect(api.resolve("A", fresh)).toBe(fresh);
  });

  it("pairs the record with the entry as of the write, not of the render", () => {
    // A list read that lands between a write being issued and completing must
    // not be mistaken for one that happened after it. `record` is called on
    // completion and pairs with the list as it stands then, so the read below
    // — which precedes the write — does not invalidate the record.
    const { api, setServers } = harness([entry("A")]);
    setServers([entry("A")]);
    const written = settings({ paginatedLists: true });
    api.record("A", written);
    expect(api.resolve("A", settings())).toBe(written);
  });

  it("keeps only the most recent write for a server", () => {
    const { api } = harness([entry("A")]);
    api.record("A", settings({ paginatedLists: true }));
    const later = settings({ autoRefreshOnListChanged: true });
    api.record("A", later);
    expect(api.resolve("A", settings())).toBe(later);
  });

  it("falls back when the server has left the list entirely", () => {
    const { api, setServers } = harness([entry("A")]);
    api.record("A", settings({ paginatedLists: true }));
    setServers([]);
    const fallback = settings();
    expect(api.resolve("A", fallback)).toBe(fallback);
  });
});
