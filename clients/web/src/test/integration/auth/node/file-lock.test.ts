/**
 * `withSecretFileLock` against a real filesystem and a real second process
 * (#2082).
 *
 * The property under test is cross-process mutual exclusion, and the
 * existing suite structurally cannot reach it: `FileSecretStore.serialize`
 * is one process-wide queue per path, so two in-process callers are ordered
 * before the lock ever sees them. A child process is not scaffolding here —
 * it is the only participant that can produce the interleaving.
 */
import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  type MockInstance,
} from "vitest";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import {
  withSecretFileLock,
  resetFileLockWarnings,
} from "@inspector/core/auth/node/file-lock.js";
import { FileSecretStore } from "@inspector/core/auth/node/file-secret-store.js";

const run = promisify(execFile);
const require_ = createRequire(import.meta.url);
/**
 * Resolved in the parent and handed to the child. The child's cwd is not
 * this repo, and `proper-lockfile` lives in the *root* install rather than
 * `clients/web`'s, so a bare `require("proper-lockfile")` there resolves
 * against whatever happens to be above the temp directory — usually nothing.
 */
const LOCKFILE_MODULE = require_.resolve("proper-lockfile");

let tmpDir: string;
let warn: MockInstance<typeof console.warn>;
const filePath = (): string => path.join(tmpDir, "secrets.json");

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "inspector-lock-"));
  resetFileLockWarnings();
  // These paths warn by design; asserting on the text is the point, and
  // letting it reach the real console would bury the suite's output.
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  warn.mockRestore();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/** Everything `console.warn` was handed this test, as one string. */
const warnings = (): string =>
  warn.mock.calls.map((c) => String(c[0])).join("\n");

/**
 * Hold the lock on `target` in a **real second process** for `holdMs`, and
 * resolve once that child confirms it has it.
 *
 * Resolving on the child's confirmation rather than on a sleep is what makes
 * the ordering assertions below meaningful: the parent starts contending
 * only once the lock is provably held elsewhere, so a pass cannot come from
 * the parent simply getting there first.
 */
async function holdLockInChildProcess(
  target: string,
  holdMs: number,
  /**
   * Secrets the child writes *while holding the lock*, before it announces
   * itself. A parent that honours the lock therefore reads a map that already
   * contains them, which is what lets the caller assert on the merged result
   * rather than only on timing.
   */
  writeWhileHeld?: Record<string, string>,
): Promise<{ ready: Promise<void>; done: Promise<void> }> {
  const script = `
    const lockfile = require(${JSON.stringify(LOCKFILE_MODULE)});
    const fs = require("node:fs");
    const path = require("node:path");
    // A second Inspector reaches the lock through \`withSecretFileLock\`, which
    // creates the storage directory first. Mirror that, or the fresh-install
    // case below would be testing the child's omission rather than the parent.
    fs.mkdirSync(path.dirname(${JSON.stringify(target)}), { recursive: true });
    lockfile
      .lock(${JSON.stringify(target)}, { realpath: false, stale: 10000 })
      .then(async (release) => {
        const secrets = ${JSON.stringify(writeWhileHeld ?? null)};
        if (secrets) {
          fs.writeFileSync(
            ${JSON.stringify(target)},
            JSON.stringify({ version: 1, encryption: "none", secrets }),
          );
        }
        process.stdout.write("acquired\\n");
        await new Promise((r) => setTimeout(r, ${holdMs}));
        await release();
        process.stdout.write("released\\n");
      })
      .catch((err) => {
        process.stdout.write("failed:" + err.code + "\\n");
        process.exitCode = 1;
      });
  `;
  const child = run(process.execPath, ["-e", script]);
  let seenReady = false;
  const done = child.then(({ stdout }) => {
    expect(stdout).toContain("acquired");
    expect(stdout).toContain("released");
  });
  // `execFile` buffers, so the "acquired" line is only readable off the
  // stream. Subscribe before awaiting anything, or the line is missed.
  const ready = new Promise<void>((resolve, reject) => {
    child.child.stdout?.on("data", (chunk: Buffer) => {
      if (!seenReady && chunk.toString().includes("acquired")) {
        seenReady = true;
        resolve();
      }
    });
    child.catch(reject);
  });
  return { ready, done };
}

describe("withSecretFileLock across processes", () => {
  it("waits for a lock another process holds, then runs", async () => {
    const target = filePath();
    const { ready, done } = await holdLockInChildProcess(target, 400);
    await ready;

    const startedAt = Date.now();
    let ranAt = 0;
    await withSecretFileLock(target, async () => {
      ranAt = Date.now();
    });

    // It waited rather than barging in. The child holds for 400ms and the
    // retry schedule's first sleeps are tens of milliseconds, so anything
    // above a floor well under 400 proves contention without pinning the
    // assertion to the scheduler's exact wake-up.
    expect(ranAt - startedAt).toBeGreaterThan(200);
    // …and having waited, it did not report a degraded write.
    expect(warnings()).toBe("");
    await done;
  }, 20_000);

  it("locks a file that does not exist yet", async () => {
    // The first `set` on a fresh install has no `secrets.json` — and
    // `proper-lockfile` resolves its target through `fs.realpath` by
    // default, which is `ENOENT` there. `realpath: false` is what makes the
    // very first write lockable; without it the one call with nothing to
    // fall back on is the one that runs unprotected.
    const target = filePath();
    await expect(fs.stat(target)).rejects.toThrow();

    let ran = false;
    await withSecretFileLock(target, async () => {
      ran = true;
    });

    expect(ran).toBe(true);
    expect(warnings()).toBe("");
  });

  it("makes FileSecretStore.set wait on a lock another process holds", async () => {
    // The end-to-end shape from the issue: a CLI run beside a web session.
    //
    // Deliberately asserts that the parent's `set` has *not finished* while
    // the child holds the lock. A test that only checks both keys survive
    // afterwards passes with the lock removed from `mutate` entirely — the
    // optimistic verify would repair the clobber and hide the regression.
    // Not-yet-resolved is the observation only a real lock can produce.
    const target = filePath();
    const { ready, done } = await holdLockInChildProcess(target, 700, {
      "srv:env:FROM_CHILD": "1",
    });
    await ready;

    let settled = false;
    const store = new FileSecretStore({ filePath: target });
    const pending = store.set("srv", "env:FROM_PARENT", "2").then(() => {
      settled = true;
    });

    // Comfortably inside the child's hold, and comfortably outside the few
    // milliseconds an unlocked read-modify-write would take.
    await new Promise((r) => setTimeout(r, 300));
    expect(settled).toBe(false);

    await done;
    await pending;

    // Having waited, the parent read the map the child left, so its own entry
    // landed *on top of* the child's rather than replacing it.
    const reader = new FileSecretStore({ filePath: target });
    expect(await reader.get("srv", "env:FROM_CHILD")).toBe("1");
    expect(await reader.get("srv", "env:FROM_PARENT")).toBe("2");
    expect(warnings()).toBe("");
  }, 20_000);

  it("creates the storage directory so the very first save is locked too", async () => {
    // `writeStoreFile` creates the parent directory, but from *inside* the
    // locked section — so without the `mkdir` in `withSecretFileLock` the
    // first save on a fresh install fails `ENOENT` on the lock and degrades
    // to an unlocked write. That is the save most likely to be racing
    // another, since two Inspectors started together both reach it.
    const target = path.join(tmpDir, "fresh-install", "secrets.json");
    const { ready, done } = await holdLockInChildProcess(target, 700);
    await ready;

    let settled = false;
    const store = new FileSecretStore({ filePath: target });
    const pending = store.set("srv", "env:FIRST_EVER", "1").then(() => {
      settled = true;
    });

    await new Promise((r) => setTimeout(r, 300));
    expect(settled).toBe(false);

    await done;
    await pending;

    const reader = new FileSecretStore({ filePath: target });
    expect(await reader.get("srv", "env:FIRST_EVER")).toBe("1");
    // No degrade warning: the lock was genuinely held, not skipped.
    expect(warnings()).toBe("");
  }, 20_000);
});

describe("withSecretFileLock degrades rather than failing", () => {
  it("runs the body anyway when the lock cannot be created, and says so once", async () => {
    // A path whose parent is a *file* stands in for every real variant —
    // read-only `$HOME`, a mount owned by another uid, a filesystem without
    // `mkdir` semantics — and unlike a permissions-based setup it fails the
    // same way for root, so it cannot pass locally and flake in a container.
    // Note a merely *missing* directory is no longer this case:
    // `withSecretFileLock` creates it. This store exists for boxes where the
    // usual mechanism is missing, so it must not gain a new way to be
    // unavailable.
    await fs.writeFile(path.join(tmpDir, "not-a-dir"), "", "utf-8");
    const target = path.join(tmpDir, "not-a-dir", "secrets.json");

    let ran = 0;
    await withSecretFileLock(target, async () => {
      ran += 1;
    });
    await withSecretFileLock(target, async () => {
      ran += 1;
    });

    expect(ran).toBe(2);
    expect(warnings()).toContain("Could not take a lock on the secrets file");
    // Once per reason per process — a warning on every save would be noise
    // on precisely the deployment that cannot act on it.
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("still saves the secret when no lock can be taken", async () => {
    // The degrade has to be end-to-end, not just in the helper: `set` on a
    // lock-hostile directory must persist, falling back to the #1950
    // optimistic behaviour.
    const target = filePath();
    const lockPath = `${target}.lock`;
    // Occupy the lock's own path with a *file*, so `mkdir` fails EEXIST
    // forever and no takeover can succeed — a permanent, non-ELOCKED
    // failure rather than contention.
    await fs.writeFile(lockPath, "not a lock directory", "utf-8");

    const store = new FileSecretStore({ filePath: target });
    await store.set("srv", "env:MINE", "1");

    const reader = new FileSecretStore({ filePath: target });
    expect(await reader.get("srv", "env:MINE")).toBe("1");
    expect(warnings()).toMatch(
      /Could not take a lock|has held the secrets file/,
    );
  }, 20_000);

  it("gives up waiting on a holder that never releases, and proceeds", async () => {
    // Holding it from *this* process: `proper-lockfile` is not reentrant, so
    // a second `lock()` on the same path fails `ELOCKED` exactly as a remote
    // holder's would — the difference the in-process queue exists to keep
    // out of the lock's way.
    const target = filePath();
    const lockfile = require_(LOCKFILE_MODULE) as {
      lock: (f: string, o: object) => Promise<() => Promise<void>>;
    };
    const release = await lockfile.lock(target, {
      realpath: false,
      stale: 60_000,
    });

    let ran = false;
    await withSecretFileLock(target, async () => {
      ran = true;
    });
    await release();

    // Proceeding is the lesser evil: refusing would lose the value outright,
    // whereas proceeding falls back to the residual #1950 behaviour — and it
    // says which of the two happened.
    expect(ran).toBe(true);
    expect(warnings()).toContain("without the lock");
  }, 20_000);
});

describe("withSecretFileLock reports what it cannot clean up", () => {
  it("warns rather than crashing the process when the lock is taken over", async () => {
    // `proper-lockfile`'s default `onCompromised` *throws*, from a timer
    // with no caller on the stack — an uncaught exception that takes an
    // Inspector session down. Driven for real: the lock directory is removed
    // while held, which is what an operator "clearing a stuck lock" does,
    // and the library's own refresh tick (`stale / 2`) notices.
    const target = filePath();
    const result = await withSecretFileLock(target, async () => {
      await fs.rm(`${target}.lock`, { recursive: true, force: true });
      await vi.waitFor(
        () => expect(warnings()).toContain("was taken over by another process"),
        { timeout: 20_000, interval: 250 },
      );
      return "saved";
    });

    // The body's result is returned regardless. A compromised lock means the
    // guarantee was lost, not that the work did not happen, and the release
    // that then fails (`ELOCKNOTHELD`, since the library has already given
    // the lock up) must not turn a completed save into a thrown error.
    expect(result).toBe("saved");
    expect(warnings()).toContain("Could not release the lock");
  }, 30_000);
});
