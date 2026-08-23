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
 * versus borrowed". `proper-lockfile` is the borrowed one — what npm itself
 * locks with — and it is worth being exact about what it does and does not
 * buy, because the temptation is to overclaim it.
 *
 * **What it makes exclusive.** `mkdir` is atomic, and a live holder refreshes
 * the lock's mtime at `stale / 2` for as long as it lives, so its lock never
 * becomes eligible for takeover. Two running Inspectors are therefore
 * genuinely serialized: one holds, the other waits. That is the case #1950
 * lost updates in, and it is closed.
 *
 * **What it does not.** Stale takeover is still not single-winner. Reading
 * `lib/lockfile.js@4.1.2`: on `EEXIST` it `stat`s, and if stale it `rmdir`s
 * and re-`mkdir`s — without checking that the directory it removed is the
 * one it found stale. So a slow waiter can delete a fast waiter's *fresh*
 * lock and claim a replacement, and both proceed. That is the identical race
 * the hand-rolled version could not close, and it cannot be closed with what
 * Node exposes (`renameat2(RENAME_EXCHANGE)`).
 *
 * The library detects it only on its refresh tick — `updateLock` compares
 * the lock's mtime against the value recorded at acquire and fires
 * `onCompromised`. That tick runs at `stale / 2`, i.e. every 5s here, while
 * an ordinary mutation is a read, an scrypt derivation and an atomic write:
 * comfortably under a second. **So in the common case the tick never runs
 * and the library tells nobody.** Worse, its `release` path calls `rmdir`
 * unconditionally, with no ownership check — so a holder whose lock was
 * replaced goes on to delete the *winner's* lock on the way out, silently
 * ending the winner's exclusion too.
 *
 * {@link withSecretFileLock} therefore guards every removal the library makes
 * on its behalf — see `guardedFs`, which sits in `options.fs` so it covers
 * the release path *and* the `signal-exit` handler. It refuses to delete a
 * directory that is no longer the one we created, and surfaces the compromise
 * in the fast-mutation case the tick misses.
 *
 * **That narrows the destructive window; it does not close it.** The guard is
 * a `statSync` immediately followed by an `rmdirSync`, so nothing in this
 * process can interleave — but it is still check-then-act against other
 * processes, and closing that needs the same compare-and-swap Node does not
 * expose. It also rests on inode and birth-time identity, which some
 * filesystems do not report. Best-effort throughout: it makes the destructive
 * case rare, not impossible.
 *
 * The window is at least narrow and conditional: it opens only after a
 * holder *dies without releasing*, since nothing else lets a lock go stale.
 *
 * **Which is why the optimistic verify in {@link FileSecretStore.mutate}
 * stays, and is not belt-and-braces.** It is what still catches a clobber
 * inside that window. It also covers what no lock can: an advisory
 * convention orders Inspector against Inspector and says nothing about an
 * editor, a backup restore, or an Inspector old enough to predate this file
 * — and it covers {@link withSecretFileLock} being unable to lock at all,
 * see below.
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

import nodeFs, { statSync, rmdirSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
// CJS-only package. A default import is the shape that survives every
// bundler this repo runs core/ through (tsup for cli/tui, vite's SSR/node
// graph for the web runner); named imports off a CJS module depend on
// lexer detection that esbuild and rollup disagree about.
import properLockfile from "proper-lockfile";
import { SecretStoreUnavailableError } from "./secret-store.js";

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
 * How long a waiter keeps trying before giving up.
 *
 * This schedule sums to roughly 15s, and the number that matters is that it
 * is comfortably **longer than {@link STALE_MS}**. A waiter that gives up
 * first would abandon the save while the lock still belonged to a process
 * that had already died — the takeover that resolves it becomes possible
 * only once the lock goes stale, so a budget under 10s would turn a crashed
 * Inspector into a failed save for every other one on the box.
 *
 * An uncontended acquire is one `mkdir` and pays none of this; the first
 * retries are tens of milliseconds, so ordinary contention (a mutation is a
 * read, an scrypt derivation and an atomic write) resolves imperceptibly.
 */
const RETRY = {
  retries: 20,
  factor: 2,
  minTimeout: 20,
  maxTimeout: 1_000,
} as const;

/**
 * What {@link RETRY} actually sums to, in milliseconds.
 *
 * Computed rather than written down. `retries * maxTimeout` overstates it by
 * a third — the early attempts are the exponential ramp, not the cap — and a
 * hand-maintained constant is one edit away from disagreeing with the
 * schedule it describes, in a message whose whole job is to tell a user how
 * long the Inspector waited. `retry` applies no jitter by default
 * (`randomize` is off), so this is exact rather than an estimate.
 *
 * It must stay **above {@link STALE_MS}**: see {@link RETRY}.
 */
const RETRY_BUDGET_MS = ((): number => {
  let total = 0;
  let delay = RETRY.minTimeout;
  for (let i = 0; i < RETRY.retries; i++) {
    total += Math.min(delay, RETRY.maxTimeout);
    delay *= RETRY.factor;
  }
  return total;
})();

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

/** Where `proper-lockfile` puts the lock for `target` — its documented default. */
const lockPathOf = (target: string): string => `${target}.lock`;

/** A lock directory's identity: what changes on delete-and-recreate. */
interface LockIdentity {
  ino: number;
  birthtimeMs: number;
}

/**
 * Identify a lock directory, or `null` if it cannot be read.
 *
 * `ino` and `birthtimeMs` together, and **not the mtime** the library
 * compares: a lock held longer than one refresh tick has its mtime rewritten
 * by `utimes` legitimately, so an mtime comparison would call our own healthy
 * lock compromised. Both of these survive `utimes` and both change when a
 * directory is removed and recreated, which is the event to detect.
 *
 * Not every filesystem reports either (Windows shares, some network mounts,
 * older kernels report `0`). There the comparison trivially succeeds and the
 * guard below concludes the lock is ours — the behaviour without the guard at
 * all, which is the right way to fail: best-effort, never a false alarm on a
 * healthy lock.
 */
function identifySync(lockPath: string): LockIdentity | null {
  try {
    const stat = statSync(lockPath);
    return { ino: stat.ino, birthtimeMs: stat.birthtimeMs };
  } catch {
    return null;
  }
}

/**
 * A `proper-lockfile` `fs` shim whose directory removal refuses to delete a
 * lock that is no longer the one we created.
 *
 * **Why this sits in `options.fs` rather than in a check before `release()`.**
 * Every deletion the library performs on our behalf goes through this object
 * — the `release()` path (`removeLock` → `fs.rmdir`) *and* its `signal-exit`
 * handler (`rmdirSync` over every registered lock, with no ownership check of
 * its own). A check placed before `release()` covers only the first, and
 * leaves the second free to delete the winner's lock if the process exits at
 * the wrong moment. Guarding at the single point where a directory is
 * actually removed covers both, and there is nowhere narrower to put it.
 *
 * **It narrows the window; it does not close it.** The guard is
 * `statSync` immediately followed by `rmdirSync`, with no `await` between
 * them — so nothing else *in this process* can interleave, and the gap is as
 * small as this platform allows. It is still a check-then-act against other
 * processes, and closing that needs compare-and-swap on a directory entry
 * (`renameat2(RENAME_EXCHANGE)`), which is exactly what Node does not expose
 * and what the whole stale-takeover problem reduces to. Treat this as making
 * the destructive case rare, not impossible.
 *
 * `owned.id` stays `null` until we have acquired, which is deliberate: during
 * `acquireLock` the library removes *another* holder's stale directory
 * through this same seam, and that removal must go through untouched.
 */
function guardedFs(
  lockPath: string,
  owned: { id: LockIdentity | null },
  onRefused: () => void,
): unknown {
  const mine = (): boolean => {
    if (owned.id === null) return true; // Not ours yet — see above.
    const now = identifySync(lockPath);
    if (now === null) return false; // Already gone; nothing of ours to remove.
    return now.ino === owned.id.ino && now.birthtimeMs === owned.id.birthtimeMs;
  };
  const removeIfMine = (): void => {
    if (!mine()) {
      onRefused();
      return;
    }
    rmdirSync(lockPath);
  };
  return {
    ...nodeFs,
    // Reported as success when refused: the library's bookkeeping should
    // forget this lock either way. Leaving it registered would hand the
    // `signal-exit` handler a record pointing at the winner's directory.
    rmdir: (_p: string, cb: (err: NodeJS.ErrnoException | null) => void) => {
      try {
        removeIfMine();
        cb(null);
      } catch (err) {
        cb(err as NodeJS.ErrnoException);
      }
    },
    /* v8 ignore next 3 -- @preserve: only reachable from proper-lockfile's
       signal-exit handler, i.e. at real process exit, which no in-process
       test can drive. Its logic is `removeIfMine`, covered via `rmdir`. */
    rmdirSync: () => {
      removeIfMine();
    },
  };
}

/**
 * What to tell an operator about a lock we could not remove.
 *
 * The blanket "it expires on its own" is **false for `ENOTEMPTY`**, and that
 * is the reachable case rather than a hypothetical: stale takeover reclaims a
 * lock through the same `rmdir`, which also cannot remove a non-empty
 * directory. So a lock directory with anything inside it is not cleaned up by
 * the staleness mechanism, by us, or by the next writer — it stays until
 * somebody deletes it, and every later save fails `ELOCKED` against it.
 *
 * Any other failure leaves a directory the refresher has stopped touching, so
 * the stale path really does reclaim it after {@link STALE_MS}.
 */
function releaseAdvice(err: unknown, target: string): string {
  const code = (err as NodeJS.ErrnoException).code;
  return code === "ENOTEMPTY"
    ? `It has something inside it, which stale takeover cannot clear either, so saves will keep failing until you remove ${lockPathOf(target)} by hand.`
    : `It expires on its own after ${STALE_MS / 1000}s.`;
}

/**
 * One `proper-lockfile` acquire against `target`, with the given retry policy.
 *
 * `realpath: false` is load-bearing: by default the library resolves the
 * target through `fs.realpath`, which fails `ENOENT` on a secrets file that
 * does not exist yet — i.e. on the very first `set`, the one call that has
 * nothing to fall back on. Resolving the path lexically instead lets a file
 * be locked into existence. The cost is that two paths reaching one file
 * through different symlinks take different locks; the store resolves its
 * path once at construction and every caller goes through it, so that is a
 * shape this codebase does not produce.
 */
function acquire(
  target: string,
  retries: number | typeof RETRY,
  fsShim: unknown,
): Promise<() => Promise<void>> {
  return properLockfile.lock(target, {
    realpath: false,
    stale: STALE_MS,
    retries,
    // Every directory removal the library performs — on release and from its
    // exit handler — routes through here. See `guardedFs`.
    fs: fsShim,
    // The library's default `onCompromised` *throws* — from a timer, with no
    // caller on the stack, so it lands as an uncaught exception and takes the
    // process down. This is also the library's *only* signal for the
    // stale-takeover race described at the top of this file — someone
    // declared our lock stale and replaced it — so it is the one place a user
    // learns the guarantee was lost. Worth saying; not worth killing an
    // Inspector session over.
    onCompromised: (err) =>
      warnOnce(
        `The lock on the secrets file at ${target} was taken over by another process while a write was in progress (${err.message}). If a secret you just saved is missing, save it again.`,
      ),
  });
}

/**
 * Run `fn` holding an exclusive cross-process lock on `filePath`.
 *
 * The lock is `<filePath>.lock`, a directory beside the secrets file rather
 * than inside it — `proper-lockfile` never opens or truncates the file it
 * guards, so a lock that outlives its holder can only ever block a write,
 * never damage one.
 *
 * Returns whatever `fn` returns. `fn` runs exactly once either way — the
 * lock's absence changes the guarantee, never whether the work happens.
 */
export async function withSecretFileLock<T>(
  filePath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const target = path.resolve(filePath);
  // Create the parent directory before locking, not after. `writeStoreFile`
  // creates it on the way to writing the secrets file, but that runs *inside*
  // the locked section — so on a fresh install, where `~/.mcp-inspector` does
  // not exist yet, `proper-lockfile` would fail `ENOENT` and every first save
  // would degrade to an unlocked write with a warning. That is the one save
  // most likely to be racing another: two Inspectors started together both
  // reach it, and it is exactly the interleaving this lock exists to close.
  //
  // Failure is deliberately swallowed rather than reported here. A directory
  // that cannot be created is the same condition as a lock that cannot be
  // taken, and the catch below already says so with the right message — one
  // that mentions the lock rather than a `mkdir` the caller never asked for.
  await fs.mkdir(path.dirname(target), { recursive: true }).catch(() => {});
  // Filled in once we actually hold the lock; see `guardedFs`.
  const owned: { id: LockIdentity | null } = { id: null };
  const fsShim = guardedFs(lockPathOf(target), owned, () =>
    warnOnce(
      `The lock on the secrets file at ${target} was taken over by another process while a write was in progress, so it was left alone rather than removed. If a secret you just saved is missing, save it again.`,
    ),
  );
  let release: (() => Promise<void>) | undefined;
  try {
    release = await acquire(target, 0, fsShim).catch((err: unknown) => {
      // **Retries are for contention, and only for contention.**
      // `proper-lockfile` drives its whole acquire through `retry`, which
      // re-attempts on *any* error — so a read-only `$HOME` would spend the
      // full ~15s budget re-issuing an `mkdir` that fails identically every
      // time, on every save, before degrading. Probing once with no retries
      // separates the two answers at the cost of one syscall: `ELOCKED` is
      // worth waiting out, an infrastructure failure is not.
      if (!isHeldElsewhere(err)) throw err;
      return acquire(target, RETRY, fsShim);
    });
  } catch (err) {
    // **`ELOCKED` is not a reason to degrade — it is the opposite.** It means
    // the lock is working and something else demonstrably holds it right now,
    // so running the body anyway would write alongside a *known* concurrent
    // writer: the precise interleaving this exists to prevent, entered
    // deliberately. Having already waited past the stale window (see
    // {@link RETRY}), a holder still there is not one that crashed; it is one
    // that is stuck. Refusing loses nothing — `set` reports it and the user
    // retries — whereas proceeding can lose a secret while reporting success.
    if (isHeldElsewhere(err)) {
      throw new SecretStoreUnavailableError(
        `Could not save to the secrets file at ${target}: another process has held the lock on it for the ${Math.round(RETRY_BUDGET_MS / 1000)} seconds this save waited. Its secrets are intact; the value you just entered was not saved. If no other Inspector is running, remove ${target}.lock and try again.`,
      );
    }
    // Everything else is the lock being *unavailable* rather than held — a
    // read-only `$HOME`, a mount owned by another uid, a filesystem without
    // `mkdir` semantics. There the choice is between degrading and refusing
    // every save on a box that has no other way to keep a secret, and this
    // store exists for exactly those boxes (#1848, #1905).
    warnOnce(
      `Could not take a lock on the secrets file at ${target} (${describeError(err)}), so writes to it are not protected against another process writing at the same moment.`,
    );
    return fn();
  }
  // Now that we hold it, record which directory is ours so the guard above
  // can refuse to delete anyone else's.
  owned.id = identifySync(lockPathOf(target));
  try {
    return await fn();
  } finally {
    try {
      await release();
    } catch (err) {
      // The body already ran and its result is being returned; turning a
      // completed save into a failure at teardown would be the wrong trade.
      // But a lock left behind is worth explaining, and the two reasons need
      // different advice — see `releaseAdvice`.
      warnOnce(
        `Could not release the lock on the secrets file at ${target} (${describeError(err)}). ${releaseAdvice(err, target)}`,
      );
    }
  }
}
