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
 * One `servers` entry, as a fresh object each call — the point of most of these
 * tests is object identity, so a shared fixture would defeat them.
 */
const entry = (settingsNode?: InspectorServerSettings): ServerEntry => ({
  id: "A",
  name: "PlotRocket",
  config: { type: "stdio", command: "node" },
  connection: { status: "disconnected" },
  settings: settingsNode,
});

/**
 * Hands the hook's API back to the test. The hook holds a ref, so the value has
 * to be read from inside a rendered component.
 */
function harness(): LastPersistedSettings {
  let api: LastPersistedSettings | undefined;
  function Probe() {
    api = useLastPersistedSettings();
    return null;
  }
  renderWithMantine(<Probe />);
  if (!api) throw new Error("hook did not render");
  return api;
}

describe("useLastPersistedSettings", () => {
  it("falls back to the caller's value when no write has been recorded", () => {
    const { resolve } = harness();
    const fallback = settings({ paginatedLists: true });
    expect(resolve("A", entry(), fallback)).toBe(fallback);
  });

  it("returns the recorded write while the entry has not been re-read", () => {
    const { record, resolve } = harness();
    const seen = entry();
    const written = settings({ paginatedLists: true });
    record("A", written, seen);
    expect(resolve("A", seen, settings())).toBe(written);
  });

  it("ignores a record made for a different server", () => {
    const { record, resolve } = harness();
    const seen = entry();
    record("A", settings({ paginatedLists: true }), seen);
    const fallback = settings();
    expect(resolve("B", seen, fallback)).toBe(fallback);
  });

  it("stops trusting the record once a fresh list read replaces the entry", () => {
    const { record, resolve } = harness();
    record("A", settings({ paginatedLists: true }), entry());
    // A successful `GET /api/servers` rebuilds the list, so the entry is a new
    // object even when its values are unchanged. That is the signal the list
    // has caught up, and it is authoritative again from here.
    const fresh = settings();
    expect(resolve("A", entry(fresh), fresh)).toBe(fresh);
  });

  it("keeps only the most recent write", () => {
    const { record, resolve } = harness();
    const seen = entry();
    record("A", settings({ paginatedLists: true }), seen);
    const later = settings({ autoRefreshOnListChanged: true });
    record("A", later, seen);
    expect(resolve("A", seen, settings())).toBe(later);
  });
});
