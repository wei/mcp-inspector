import { useCallback, useRef } from "react";
import type {
  InspectorServerSettings,
  ServerEntry,
} from "@inspector/core/mcp/types.js";

/**
 * Remembers the last server-settings write that is known to have reached disk,
 * so a *later* failed write can be rolled back to what is actually persisted
 * rather than to a `servers` entry that has gone stale (#2089).
 *
 * The `servers` list only advances when a `GET /api/servers` succeeds. Once a
 * list read fails, every entry in it keeps describing disk *as of the last
 * successful read* — while writes issued since then have changed disk. A
 * rollback that reads its baseline from such an entry reverts to a value
 * nothing on disk holds, and the UI contradicts the file until the next
 * successful read. The reproduction is two toggles: the first write lands but
 * its list reload fails, the second write fails outright and reverts to the
 * pre-first-toggle value.
 *
 * The record is not trusted indefinitely. It is paired with the `servers` entry
 * the write was derived from, and a successful list read replaces that entry
 * (the list is re-parsed from the response, so a fresh read always yields fresh
 * objects) — which is the signal that the list has caught up with, or been
 * overtaken by (an edit made outside the Inspector), our write. From there the
 * entry is authoritative again and the record is ignored. The *entry* is the
 * token rather than its `settings` node because a server that has never been
 * configured carries no `settings` at all, and `undefined` cannot distinguish
 * a re-read from a stale one.
 *
 * Kept in a ref rather than state deliberately: nothing renders from it, it is
 * read only inside callbacks at the moment a write is issued, and holding it in
 * state would re-render the whole composition root on every settings save.
 */
export interface LastPersistedSettings {
  /**
   * Record a settings write that reached disk. `entry` is the `servers` entry
   * the write was derived from.
   */
  record: (
    serverId: string,
    written: InspectorServerSettings,
    entry: ServerEntry,
  ) => void;
  /**
   * The best available answer to "what is on disk for this server". Returns the
   * recorded write while `entry` is still the object the write was derived
   * from, and `fallback` (the caller's read of the entry) once a fresh list
   * read has replaced it, or when no write has landed for that server this
   * session.
   */
  resolve: (
    serverId: string,
    entry: ServerEntry,
    fallback: InspectorServerSettings,
  ) => InspectorServerSettings;
}

interface WriteRecord {
  serverId: string;
  written: InspectorServerSettings;
  entry: ServerEntry;
}

export function useLastPersistedSettings(): LastPersistedSettings {
  const recordRef = useRef<WriteRecord | null>(null);

  const record = useCallback(
    (
      serverId: string,
      written: InspectorServerSettings,
      entry: ServerEntry,
    ) => {
      recordRef.current = { serverId, written, entry };
    },
    [],
  );

  const resolve = useCallback(
    (
      serverId: string,
      entry: ServerEntry,
      fallback: InspectorServerSettings,
    ): InspectorServerSettings => {
      const current = recordRef.current;
      if (!current || current.serverId !== serverId) return fallback;
      // Identity, not deep equality: the question is whether the list has been
      // re-read since the write, not whether the values happen to match.
      if (current.entry !== entry) return fallback;
      return current.written;
    },
    [],
  );

  return { record, resolve };
}
