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
 * ## Which of two overlapping writes wins
 *
 * A write is announced with `begin` when it is *issued* and confirmed with
 * `landed` when it completes, and a confirmation is ignored if a later-issued
 * write for that server has already confirmed. Completion order cannot be used
 * for this: `updateServerSettings` waits for a list read after its PUT, so an
 * older write with a slow read can finish last and would otherwise overwrite
 * the record with a value that is no longer on disk.
 *
 * Issue order is a proxy for disk order, not a proof of it — HTTP does not
 * promise that two in-flight PUTs arrive in the order they were sent. It is the
 * best signal available on this side: the backend serializes writes to the
 * catalog, but neither the route nor `useServers` returns a revision the client
 * could order by. If one is added later, this is where it replaces the counter.
 *
 * ## When a record stops being believed
 *
 * A record is paired with the `servers` entry for that server **as of when the
 * write completed**, and is dropped once the list carries a different entry
 * object: a successful read rebuilds the list, so a fresh object is the signal
 * that the entry has caught up with — or been overtaken by (an edit made
 * outside the Inspector) — our write, and from there the entry is authoritative
 * again. The pairing is taken at completion rather than at issue because a read
 * that lands *while the write is in flight* would otherwise be mistaken for one
 * that happened after it.
 *
 * One case the client cannot decide is left: a background read whose response
 * was generated before the write landed but which arrives after it still looks
 * newer here, and the record is dropped in its favour. That needs the same
 * missing revision as above. What the fallback yields in that case is the
 * freshest successful read — the same value the rest of the UI renders from —
 * rather than an arbitrary one.
 *
 * The list and the records are held in refs rather than state deliberately:
 * nothing renders from either, they are read only inside callbacks at the
 * moment a write is issued, completes, or fails, and holding them in state
 * would re-render the whole composition root on every settings save.
 */
export interface LastPersistedSettings {
  /**
   * Announce a settings write for `serverId` at the moment it is **issued**.
   * Confirm it with the returned handle once it completes.
   */
  begin: (serverId: string) => SettingsWrite;
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

export interface SettingsWrite {
  /**
   * Record that this write reached disk. A no-op if a write issued after this
   * one has already been confirmed for the same server.
   */
  landed: (written: InspectorServerSettings) => void;
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
  const nextSequenceRef = useRef(0);
  // Highest issue order confirmed per server. Kept apart from the records so a
  // record dropped by `resolve` can't be resurrected by a straggler that was
  // issued earlier: the high-water mark outlives the record it produced.
  const confirmedRef = useRef<Map<string, number>>(new Map());
  // Read the list through a ref so a write pairs with the entry as it stands
  // when it finishes, not the one captured when it was issued. Mirrored in an
  // effect rather than assigned during render: writing a ref mid-render is an
  // error under `react-hooks/refs`, and every reader runs from a settled
  // promise or an event handler, long after the commit.
  const serversRef = useRef(servers);
  useEffect(() => {
    serversRef.current = servers;
  }, [servers]);

  const begin = useCallback((serverId: string): SettingsWrite => {
    const sequence = ++nextSequenceRef.current;
    return {
      landed: (written: InspectorServerSettings) => {
        const confirmed = confirmedRef.current.get(serverId) ?? 0;
        // A write issued after this one already reported; it describes disk
        // more recently, whichever of the two happened to finish first.
        if (confirmed > sequence) return;
        confirmedRef.current.set(serverId, sequence);
        const entry = serversRef.current.find((s) => s.id === serverId);
        recordsRef.current.set(serverId, { written, entry });
      },
    };
  }, []);

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

  return { begin, resolve };
}
