/**
 * Cross-process mutual exclusion for the secrets file (#2082).
 *
 * **Why a library and not a hand-rolled election.** #1950 shipped without a
 * lock on purpose. An earlier revision of it *did* take one — a `mkdir`
 * election with an owner stamp, a heartbeat and a stale-takeover — and three
 * consecutive review rounds found a real race in it. The last one is not
 * closable with what Node exposes: claiming a stale lock atomically needs
 * compare-and-swap on a directory entry (`renameat2(RENAME_EXCHANGE)`), and
 * without it a waiter that loses the race can move the winner's *fresh* lock
 * aside and enter alongside it.
 *
 * So the choice #2082 settles is not "lock versus no lock" but "hand-rolled
 * versus borrowed". `proper-lockfile` is the borrowed one: it is what npm
 * itself uses, and stale-takeover is precisely the problem it has already
 * solved — it re-`stat`s the lock directory after claiming it and gives the
 * lock up if the mtime is not the one it wrote, so a loser of the takeover
 * race releases rather than proceeding.
 *
 * **What this does not remove.** The optimistic verify in
 * {@link FileSecretStore.mutate} stays. A lock is an advisory convention
 * between participants that take it, so it orders Inspector against
 * Inspector and says nothing about an editor, a backup restore, or an
 * Inspector old enough to predate this file. The verify is also what covers
 * {@link withSecretFileLock} *declining* — see below.
 *
 * **Degrading rather than failing is deliberate.** The store's whole reason
 * for existing is a box where the usual mechanism is unavailable (no
 * keychain, #1848/#1905), so it must not acquire a *new* way to be
 * unavailable. A directory that cannot hold a lock file — a read-only
 * `$HOME`, a filesystem without `mkdir` semantics, a container mount owned
 * by another uid — would otherwise turn every `set` into a hard failure on
 * exactly the deployments this store was written for. So a lock that cannot
 * be taken runs the body anyway, with the #1950 optimistic behaviour
 * underneath it, and says so once.
 */

import * as path from "node:path";
// CJS-only package. A default import is the shape that survives every
// bundler this repo runs core/ through (tsup for cli/tui, vite's SSR/node
// graph for the web runner); named imports off a CJS module depend on
// lexer detection that esbuild and rollup disagree about.
import properLockfile from "proper-lockfile";

/**
 * How long a lock may go untouched before another process may claim it.
 *
 * `proper-lockfile` refreshes the lock's mtime at `stale / 2` for as long as
 * the holder is alive, so this is not "how long a mutation may take" — it is
 * how long after a holder *dies* the file stays unwritable. 10s is the
 * library's own default and the value npm ships with; a mutation is a read,
 * an scrypt derivation and an atomic write, so the margin is enormous.
 */
const STALE_MS = 10_000;

/**
 * How long a waiter will keep trying before giving up.
 *
 * The retry schedule below tops out around 3s of waiting. That is long
 * enough for any real mutation to finish (see above) and short enough that a
 * pathological case surfaces as a slow save rather than a hung one.
 */
const RETRY = {
  retries: 8,
  factor: 2,
  minTimeout: 20,
  maxTimeout: 1_000,
} as const;

/** Emitted once per process, not once per call — see {@link warnOnce}. */
const warned = new Set<string>();

/**
 * Say why locking is unavailable here, once per reason per process.
 *
 * Once per *reason* rather than once overall: "the directory is read-only"
 * and "the lock is held by something that never releases it" are different
 * problems with different fixes, and collapsing them would print whichever
 * happened first and hide the other for the life of the process. Keyed on
 * the message, which already encodes the reason.
 */
function warnOnce(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(`[mcp-inspector] ${message}`);
}

/** Test seam: forget which warnings have been emitted. */
export function resetFileLockWarnings(): void {
  warned.clear();
}

/**
 * Did `proper-lockfile` decline because someone else holds the lock?
 *
 * A bare cast rather than a guarded narrowing: the only caller is the `catch`
 * around `properLockfile.lock`, and the library rejects with a real `Error`
 * carrying a `code` on every path. Guarding would add branches nothing can
 * exercise, which is a worse trade than an assertion whose one caller is two
 * lines away.
 */
const isHeldElsewhere = (err: unknown): boolean =>
  (err as NodeJS.ErrnoException).code === "ELOCKED";

/**
 * The message from whatever was thrown.
 *
 * Same reasoning as above for the non-`Error` arm — `proper-lockfile` does not
 * reject with one — except that this is used where a thrown non-`Error` would
 * otherwise be reported as `[object Object]`, so the fallback earns its place
 * even though nothing can provoke it.
 */
/* v8 ignore next 2 -- @preserve: the non-Error arm is unreachable via
   proper-lockfile, which rejects only with Errors. */
const describeError = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

/**
 * Run `fn` holding an exclusive cross-process lock on `filePath`.
 *
 * The lock is `<filePath>.lock`, a directory beside the secrets file rather
 * than inside it — `proper-lockfile` never opens or truncates the file it
 * guards, so a lock that outlives its holder can only ever block a write,
 * never damage one.
 *
 * `realpath: false` is load-bearing: by default the library resolves the
 * target through `fs.realpath`, which fails `ENOENT` on a secrets file that
 * does not exist yet — i.e. on the very first `set`, the one call that has
 * nothing to fall back on. Resolving the path lexically instead lets a file
 * be locked into existence. The cost is that two paths reaching one file
 * through different symlinks take different locks; the store resolves its
 * path once at construction and every caller goes through it, so that is a
 * shape this codebase does not produce.
 *
 * Returns whatever `fn` returns. `fn` runs exactly once either way — the
 * lock's absence changes the guarantee, never whether the work happens.
 */
export async function withSecretFileLock<T>(
  filePath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const target = path.resolve(filePath);
  let release: (() => Promise<void>) | undefined;
  try {
    release = await properLockfile.lock(target, {
      realpath: false,
      stale: STALE_MS,
      retries: RETRY,
      // The library's default `onCompromised` *throws* — from a timer, with
      // no caller on the stack, so it lands as an uncaught exception and
      // takes the process down. A compromised lock means someone declared
      // ours stale and took it; the write in flight is at risk, which is
      // worth saying and is not worth killing an Inspector session over.
      onCompromised: (err) =>
        warnOnce(
          `The lock on the secrets file at ${target} was taken over by another process while a write was in progress (${err.message}). If a secret you just saved is missing, save it again.`,
        ),
    });
  } catch (err) {
    warnOnce(
      isHeldElsewhere(err)
        ? `Another process has held the secrets file at ${target} for longer than this write was willing to wait, so the write went ahead without the lock. If two Inspectors are saving secrets at once, one of them may not be saved.`
        : `Could not take a lock on the secrets file at ${target} (${describeError(err)}), so writes to it are not protected against another process writing at the same moment.`,
    );
    return fn();
  }
  try {
    return await fn();
  } finally {
    try {
      await release();
    } catch (err) {
      // The body already ran and its result is being returned; a release
      // that failed means the lock was taken from us (declared stale while
      // we held it) or the directory went away. Neither is worth turning a
      // successful save into a failure, but a silent catch would leave a
      // lock nobody can explain, so say it.
      warnOnce(
        `Could not release the lock on the secrets file at ${target} (${describeError(err)}). It expires on its own after ${STALE_MS / 1000}s.`,
      );
    }
  }
}
