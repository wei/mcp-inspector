/**
 * Spawn a child process and wait for it to announce readiness on its output.
 *
 * Extracted from `scripts/smoke-web-app.mjs` so the failure path can be tested
 * (#2000). A smoke script only ever exercises its own happy path: the real MCP
 * test server always announces, so nothing in `npm run local:gate` proved that a child
 * which stays alive *through* the readiness timeout is still reachable by the
 * caller's teardown. That is precisely the case that used to orphan a live
 * server holding its port, and it is invisible to the smoke itself.
 *
 * The ownership rule this encodes: the child is handed to `onSpawn` the moment
 * it exists, **before** the readiness wait, so every throw path below leaves
 * the caller holding a stoppable handle. Returning it only on success is what
 * made the timeout leak — `spawnError` and `exited` were never affected (the
 * child is already gone there), but they cost nothing to cover the same way.
 *
 * Both stdio channels are piped and scanned: a child that announces with
 * `console.error` is missed entirely by a stdout-only scan, which then times
 * out with an empty diagnostic. Piping both also keeps the child's noise out of
 * the caller's output while still making it available in the failure message.
 */

import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

/**
 * @param {object} opts
 * @param {string} opts.command       Executable to spawn.
 * @param {string[]} opts.args        Arguments for it.
 * @param {string} [opts.cwd]         Working directory.
 * @param {RegExp} opts.pattern       Matched against the accumulated output;
 *                                    the first match ends the wait.
 * @param {(child: import("node:child_process").ChildProcess) => void} opts.onSpawn
 *   Called synchronously with the child immediately after spawn, before any
 *   waiting. This is the caller's teardown handle.
 * @param {string} opts.what          Noun used in error messages ("MCP test server").
 * @param {number} [opts.timeoutMs]   Readiness budget (default 30s).
 * @param {number} [opts.pollMs]      Poll interval (default 250ms).
 * @returns {Promise<{ child: import("node:child_process").ChildProcess, match: RegExpMatchArray }>}
 */
export async function startAnnouncedChild({
  command,
  args,
  cwd,
  pattern,
  onSpawn,
  what,
  timeoutMs = 30_000,
  pollMs = 250,
}) {
  const child = spawn(command, args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Publish before waiting — this is the whole point of the helper.
  onSpawn(child);

  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  let exited = false;
  let spawnError = null;
  // A spawn failure (e.g. an unbuilt/renamed entry) emits `error`, NOT `exit` —
  // and with no `error` listener Node throws it uncaught, replacing the caller's
  // diagnostic with a raw stack. `close` is listened to alongside `exit` for the
  // same reason: it fires in cases `exit` does not, so a child that dies without
  // an exit event can't leave the poll below spinning for the full budget.
  child.on("error", (err) => (spawnError = err));
  child.on("exit", () => (exited = true));
  child.on("close", () => (exited = true));

  // A deadline loop, not a fixed attempt count: state is re-read *after* every
  // wait, including the last one. Counting attempts and throwing straight after
  // the final `delay` leaves the whole last polling interval unobserved, so an
  // announcement landing at 29.9s of a 30s budget is reported as a timeout —
  // and a spawn error or early exit in that window is misattributed the same
  // way. The final wait is also clamped to the deadline so the budget is a
  // real bound rather than one poll longer.
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const match = out.match(pattern);
    if (match) return { child, match };
    if (spawnError) {
      throw new Error(`could not spawn the ${what}: ${spawnError.message}`);
    }
    if (exited) throw new Error(`${what} exited early:\n${out}`);
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await delay(Math.min(pollMs, remaining));
  }
  throw new Error(
    `${what} did not start within ${Math.round(timeoutMs / 1000)}s:\n${out}`,
  );
}
