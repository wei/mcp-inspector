import { useCallback, useEffect, useRef } from "react";
import type {
  InspectorServerSettings,
  ServerEntry,
} from "@inspector/core/mcp/types.js";

/**
 * Remembers, per server, the last settings write known to have reached disk, so
 * a *later* failed write can be rolled back to what is actually persisted
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
 * Records are kept **per server id**, not in a single slot. The settings modal
 * can be opened for any server, independently of which one is connected, so a
 * single slot would let a save on B discard the baseline a later failed write
 * on A still needs — reproducing the very bug this hook exists to prevent.
 *
 * A record is not trusted indefinitely. It is paired with the `servers` entry
 * for that server **as of when the write completed**, and is dropped once the
 * list carries a different entry object: a successful read rebuilds the list,
 * so a fresh object is the signal that the entry has caught up with — or been
 * overtaken by (an edit made outside the Inspector) — our write, and from there
 * the entry is authoritative again. The pairing is taken at completion rather
 * than at scheduling because a read that lands *while the write is in flight*
 * would otherwise be mistaken for one that happened after it.
 *
 * One case the client cannot decide is left: a background read whose response
 * was generated before the write landed but which arrives after it still looks
 * newer here, and the record is dropped in its favour. Ordering that reliably
 * needs a revision or ETag on `GET /api/servers` that `useServers` does not
 * expose today. What the fallback yields in that case is the freshest
 * successful read — the same value the rest of the UI renders from — rather
 * than an arbitrary one.
 *
 * The list and the records are held in refs rather than state deliberately:
 * nothing renders from either, they are read only inside callbacks at the
 * moment a write completes or fails, and holding them in state would re-render
 * the whole composition root on every settings save.
 */
export interface LastPersistedSettings {
  /**
   * Record a settings write that reached disk. Call it when the write
   * *completes*, not when it is issued.
   */
  record: (serverId: string, written: InspectorServerSettings) => void;
  /**
   * The best available answer to "what is on disk for this server". Returns the
   * recorded write while the list still carries the entry that write was paired
   * with, and `fallback` (the caller's read of the entry) once a fresh list read
   * has replaced it, or when no write has landed for that server this session.
   */
  resolve: (
    serverId: string,
    fallback: InspectorServerSettings,
  ) => InspectorServerSettings;
}

interface WriteRecord {
  written: InspectorServerSettings;
  entry: ServerEntry | undefined;
}

/**
 * @param servers the current server list, as rendered
 */
export function useLastPersistedSettings(
  servers: ServerEntry[],
): LastPersistedSettings {
  const recordsRef = useRef<Map<string, WriteRecord>>(new Map());
  // Read the list through a ref so `record` pairs with the entry as it stands
  // when the write finishes, not the one captured when the write was issued.
  // Mirrored in an effect rather than assigned during render: writing a ref
  // mid-render is an error under `react-hooks/refs`, and the callbacks that
  // read it all run from settled promises, long after the commit.
  const serversRef = useRef(servers);
  useEffect(() => {
    serversRef.current = servers;
  }, [servers]);

  const record = useCallback(
    (serverId: string, written: InspectorServerSettings) => {
      const entry = serversRef.current.find((s) => s.id === serverId);
      recordsRef.current.set(serverId, { written, entry });
    },
    [],
  );

  const resolve = useCallback(
    (
      serverId: string,
      fallback: InspectorServerSettings,
    ): InspectorServerSettings => {
      const current = recordsRef.current.get(serverId);
      if (!current) return fallback;
      const entry = serversRef.current.find((s) => s.id === serverId);
      // Identity, not deep equality: the question is whether the list has been
      // re-read since the write, not whether the values happen to match.
      if (current.entry !== entry) {
        // Superseded — drop it rather than re-checking a dead record on every
        // later write for this server.
        recordsRef.current.delete(serverId);
        return fallback;
      }
      return current.written;
    },
    [],
  );

  return { record, resolve };
}
