/**
 * Wrap a command so it runs attached to a pseudoterminal (#2147).
 *
 * `smoke:tui` spawns the Ink TUI with `stdio: ["ignore", …]`, which makes the
 * child's stdin `/dev/null`. Ink mounts `useInput`, `useInput` needs raw mode,
 * and raw mode is a property of the *file descriptor* — so the child threw
 * "Raw mode is not supported on the current process.stdin" and exited 1 about
 * 40ms after painting its first frame, on every machine, TTY or not. A parent
 * cannot assert raw mode on a child's behalf; the fd has to be a terminal.
 *
 * `script(1)` allocates one, with no dependency to install. Measured here on
 * darwin: without it the TUI paints at ~400ms and is dead at ~440ms; with it
 * the same TUI is still running at 6s and never logs the raw-mode error.
 *
 * The invocation differs by flavor, which is why this is a module rather than
 * a string literal at the call site:
 *
 *   BSD (macOS)   script -q /dev/null <cmd> <args...>       argv, no shell
 *   util-linux    script -qec "<cmd args...>" /dev/null     ONE shell string
 *   busybox       script -qc  "<cmd args...>" /dev/null     as above, no -e
 *
 * The `-c` flavors take a single command *string* that the child shell parses,
 * so every word has to be quoted on the way in — an unquoted temp path with a
 * space would otherwise split into two arguments.
 *
 * `-e` (util-linux) makes `script` exit with the child's status rather than its
 * own. busybox has no such flag, so under it a crashed child reports 0. That is
 * survivable and deliberately not worked around: the smoke's assertion is the
 * child's `exit` *event*, not its code — the code only sharpens the diagnostic.
 */

import { spawnSync } from "node:child_process";

/** Platforms whose `script` takes the BSD argv form. */
const BSD_PLATFORMS = new Set(["darwin", "freebsd", "openbsd", "netbsd"]);

/**
 * Quote one argument for a POSIX shell command string.
 *
 * Single quotes are literal for everything except a single quote itself, which
 * has to leave the quoted run, emit an escaped quote, and re-enter it.
 *
 * @param {string} arg
 * @returns {string}
 */
export function shellQuote(arg) {
  return `'${String(arg).replaceAll("'", `'\\''`)}'`;
}

/**
 * Decide which `script` flavor to build for.
 *
 * The version output is consulted first because it is the only *evidence*:
 * "linux" does not imply util-linux (Alpine ships busybox, whose `script`
 * rejects `-e`). Platform is the fallback for the case where `script --version`
 * tells us nothing, which is itself informative — BSD `script` has no
 * `--version` and fails the probe.
 *
 * @param {object} opts
 * @param {string} opts.platform          `process.platform`.
 * @param {string} [opts.versionOutput]   Combined stdout+stderr of `script --version`.
 * @returns {"bsd" | "util-linux" | "busybox" | null} null when unsupported.
 */
export function scriptFlavorFor({ platform, versionOutput = "" }) {
  if (/util-linux/i.test(versionOutput)) return "util-linux";
  if (/busybox/i.test(versionOutput)) return "busybox";
  if (BSD_PLATFORMS.has(platform)) return "bsd";
  // Linux with an unidentifiable `script` is overwhelmingly util-linux; guess
  // it rather than skip the smoke. A wrong guess fails loudly with `script`'s
  // own usage error in the captured output, which is diagnosable — silently
  // skipping is the outcome this issue exists to stop rewarding.
  if (platform === "linux") return "util-linux";
  // win32 and anything else: no `script(1)`. `node-pty` is the portable answer
  // if this smoke ever has to run there.
  return null;
}

/**
 * Build the PTY-wrapped spawn arguments for a command.
 *
 * @param {object} opts
 * @param {string} opts.command
 * @param {string[]} [opts.args]
 * @param {"bsd" | "util-linux" | "busybox"} opts.flavor
 * @returns {{ command: string, args: string[] }}
 */
export function ptyCommand({ command, args = [], flavor }) {
  if (flavor === "bsd") {
    return { command: "script", args: ["-q", "/dev/null", command, ...args] };
  }
  if (flavor === "util-linux" || flavor === "busybox") {
    const line = [command, ...args].map(shellQuote).join(" ");
    const flags = flavor === "util-linux" ? "-qec" : "-qc";
    return { command: "script", args: [flags, line, "/dev/null"] };
  }
  throw new Error(`unknown script(1) flavor: ${flavor}`);
}

/**
 * Probe the local `script(1)` for its flavor.
 *
 * @param {(cmd: string, args: string[]) => { stdout?: string, stderr?: string }} [runner]
 *   Injected for tests; defaults to a real `spawnSync`.
 * @returns {string} Combined output, or "" if `script` could not be run at all.
 */
export function probeScriptVersion(
  runner = (cmd, args) =>
    spawnSync(cmd, args, { encoding: "utf8", timeout: 5000 }),
) {
  try {
    const r = runner("script", ["--version"]) ?? {};
    return `${r.stdout ?? ""}${r.stderr ?? ""}`;
  } catch {
    return "";
  }
}

/**
 * Resolve a PTY wrapper for this machine, or null if none is available.
 *
 * @param {object} [opts]
 * @param {string} [opts.platform]
 * @param {() => string} [opts.probe]
 * @returns {{ flavor: string, wrap: (spec: { command: string, args?: string[] }) => { command: string, args: string[] } } | null}
 */
export function resolvePtyWrapper({
  platform = process.platform,
  probe = probeScriptVersion,
} = {}) {
  const flavor = scriptFlavorFor({ platform, versionOutput: probe() });
  if (!flavor) return null;
  return {
    flavor,
    wrap: ({ command, args = [] }) => ptyCommand({ command, args, flavor }),
  };
}
