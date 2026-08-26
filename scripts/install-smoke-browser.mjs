#!/usr/bin/env node
/**
 * Fetch the Playwright browser binary a headless web smoke is about to launch
 * (#2086).
 *
 * This replaces the `cd clients/web && npx playwright install chromium` prefix
 * each smoke's npm script used to carry. Two reasons it is a script rather than
 * a longer npm-script line:
 *
 *   - The engine is now a variable. `npx playwright install ${SMOKE_BROWSER:-…}`
 *     is a POSIX-shell expansion that does not expand under Windows' `cmd.exe`,
 *     which npm uses there — it would silently try to install a browser named
 *     `${SMOKE_BROWSER:-chromium}`.
 *   - `npx` is a `.cmd` shim on Windows, which a shell-free spawn cannot start.
 *     `resolveNodeBin` walks to the JS entry behind the package's `bin` and runs
 *     it with `process.execPath` instead — the same fix #1939 made for the
 *     verify scripts, and it keeps the resolution pinned to the repo's own
 *     Playwright rather than whatever `npx` might fetch.
 *
 * Usage: `node scripts/install-smoke-browser.mjs [engine]`. With no argument the
 * engine comes from `SMOKE_BROWSER` (default `chromium`); pass one explicitly
 * where the consumer's engine is fixed regardless of that variable, as
 * `pack:verify` does.
 */

import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import {
  SUPPORTED_BROWSERS,
  resolveBrowserName,
} from "./lib/headless-browser.mjs";
import { resolveNodeBin } from "./lib/resolve-node-bin.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const webDir = join(repoRoot, "clients", "web");

const requested = process.argv[2];
let browserName;
try {
  if (requested === undefined) {
    browserName = resolveBrowserName();
  } else if (SUPPORTED_BROWSERS.includes(requested)) {
    browserName = requested;
  } else {
    throw new Error(
      `unsupported browser "${requested}" — expected one of ${SUPPORTED_BROWSERS.join(", ")}`,
    );
  }
} catch (err) {
  console.error(
    `install-smoke-browser: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
}

let cli;
try {
  cli = resolveNodeBin("playwright", "playwright", webDir);
} catch (err) {
  console.error(
    "install-smoke-browser: could not resolve the Playwright CLI from clients/web — " +
      `run \`npm install\` at the repo root (${err instanceof Error ? err.message : String(err)})`,
  );
  process.exit(1);
}

// `install` is a no-op when the binary is already present, so this is cheap on
// a warm machine and on a CI runner whose Playwright cache was restored.
const result = spawnSync(process.execPath, [cli, "install", browserName], {
  cwd: webDir,
  stdio: "inherit",
});
if (result.error) {
  console.error(
    `install-smoke-browser: could not run the Playwright CLI: ${result.error.message}`,
  );
  process.exit(1);
}
if (result.status !== 0) {
  console.error(
    `install-smoke-browser: \`playwright install ${browserName}\` exited ${result.status}`,
  );
  process.exit(result.status ?? 1);
}
