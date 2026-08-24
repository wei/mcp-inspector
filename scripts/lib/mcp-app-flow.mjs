/**
 * The MCP Apps drive-the-App-flow half of `smoke:web:app`, extracted so
 * `pack:verify` can run the same flow against the **installed tarball** (#2003).
 *
 * Two checks bracketed the bug that motivated all of this (#1859, the missing
 * `clients/web/static/sandbox_proxy.html`) without either one catching it:
 *
 *   | check           | runs against       | drives the App path? |
 *   | --------------- | ------------------ | -------------------- |
 *   | `smoke:web:app` | the repo build tree | yes                 |
 *   | `pack:verify`   | the installed tarball | no — only `GET /` |
 *
 * So a packaging regression that leaves the file present-but-unreachable — a
 * rename with a stale reader, a wrong relative position, a future `.npmignore`
 * or `"files"` edit — passes both: the smoke never installs, and `pack:verify`
 * only asserted the path *exists*. Sharing the flow is what closes it, and it
 * has to be *shared* rather than copied: the deep-link shape is the part that
 * silently rots, and two copies would drift without either failing.
 *
 * Note the split of responsibilities that survives here. The **client** under
 * test comes from wherever the caller booted it (repo tree or install); the
 * **test server** is always a repo fixture — it is not in the tarball and
 * should not be.
 *
 * Playwright is resolved with a `createRequire` based at
 * clients/web/package.json rather than a bare `import("playwright")`: a bare ESM
 * specifier resolves relative to `scripts/`, not the cwd, so a `cd clients/web`
 * in the npm script would NOT make it resolvable. Same gotcha as
 * smoke-web-browser.mjs; see its header.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { startAnnouncedChild } from "./announced-child.mjs";
import { resolveNodeBin } from "./resolve-node-bin.mjs";

/** The App tool the `mcp-app-http.json` fixture serves. */
export const APP_TOOL = "mcp_app_demo";

/**
 * Console messages that are the async half of the uncaught-crash class (an
 * unhandled rejection or a failed dynamic import). Hard failures; every other
 * console error is a diagnostic, so benign font-CDN / React-warning noise can't
 * flake CI. Kept identical to smoke-web-browser.mjs, which documents the
 * reasoning at length.
 */
export const FATAL_CONSOLE =
  /^Uncaught\b|Failed to fetch dynamically imported module/;

/** Path to the composable test server build, relative to the repo root. */
export function composableServerPath(repoRoot) {
  return join(repoRoot, "test-servers", "build", "server-composable.js");
}

/** Path to a `test-servers/configs/<name>.json` fixture. */
export function testServerConfigPath(repoRoot, name) {
  return join(repoRoot, "test-servers", "configs", `${name}.json`);
}

/**
 * The path `clients/web/server/sandbox-controller.ts` resolves at runtime, given
 * the directory holding the built web runner. Kept in sync with the
 * `join(__dirname, "../static/sandbox_proxy.html")` there — the position
 * *relative to* the runner is what matters, which is why callers pass the
 * runner dir rather than a package root.
 */
export function sandboxProxyPageFor(webBuildDir) {
  return join(webBuildDir, "..", "static", "sandbox_proxy.html");
}

/**
 * Build the composable test server bundle if it isn't present yet.
 *
 * The root-installed tsc is run via this Node — `npx` is a `.cmd` shim on
 * Windows that a shell-free spawnSync can't start (ENOENT — #1939).
 */
export function ensureComposableTestServer(repoRoot, label) {
  const entry = composableServerPath(repoRoot);
  if (existsSync(entry)) return entry;
  console.log(`${label} — building test-servers (missing build output)...`);
  const r = spawnSync(
    process.execPath,
    [
      resolveNodeBin("typescript", "tsc", repoRoot),
      "-p",
      "test-servers",
      "--noCheck",
    ],
    { cwd: repoRoot, stdio: "inherit" },
  );
  if (r.status !== 0 || !existsSync(entry)) {
    throw new Error(
      "could not build the test servers (test-servers/build/server-composable.js). " +
        "Run `npm run test-servers:build` from clients/web.",
    );
  }
  return entry;
}

/**
 * Spawn a composable test server and wait for it to announce its URL.
 *
 * The announced line is authoritative rather than the config's port:
 * `createTestServerHttp` resolves through `findAvailablePort()`, which walks
 * upward when the configured value is taken — so the config port is a starting
 * hint, not a guarantee, and assuming it fails whenever anything else holds it.
 * The announcement goes to **stderr** (`console.error` in
 * server-composable.ts), which is why `startAnnouncedChild` scans both channels.
 *
 * `onSpawn` publishes the child before the readiness wait, so the caller's
 * teardown reaches it on every throw path — the timeout included (#2000).
 */
export async function startMcpAppServer({
  repoRoot,
  config = "mcp-app-http",
  onSpawn,
  label,
}) {
  const entry = ensureComposableTestServer(repoRoot, label);
  const { match } = await startAnnouncedChild({
    command: process.execPath,
    args: [entry, "--config", testServerConfigPath(repoRoot, config)],
    cwd: repoRoot,
    pattern: /listening at (http:\/\/\S+)/i,
    onSpawn,
    what: `MCP test server (${entry})`,
  });
  return match[1];
}

/** base64url(JSON) — the `appArgs` encoding the deep link expects. */
export function encodeAppArgs(args) {
  return Buffer.from(JSON.stringify(args))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * The deep link that connects, switches to the Apps tab, pre-selects the app
 * tool, and fires "Open App". `autoConnect`/`autoOpen` must equal the session
 * token (CSRF gate). Shape owned by clients/web/README.md#deep-link-auto-connect.
 */
export function buildAppDeepLink({
  baseUrl,
  mcpUrl,
  token,
  appTool = APP_TOOL,
  appArgs = {},
}) {
  return (
    `${baseUrl}/?serverUrl=${encodeURIComponent(mcpUrl)}` +
    `&transport=http&autoConnect=${token}&openApp=${appTool}` +
    `&appArgs=${encodeAppArgs(appArgs)}&autoOpen=${token}`
  );
}

/**
 * Attach the two error channels a headless page reports on.
 *
 * An uncaught *synchronous* page error fires `pageerror`; its async twin — an
 * unhandled rejection or a failed dynamic import — is not a `pageerror` at all,
 * Chromium reports it on the console channel instead. Both are captured; only
 * `fatal()` is a failure, so ordinary console noise stays a diagnostic.
 */
export function attachPageDiagnostics(page) {
  const pageErrors = [];
  const consoleErrors = [];
  page.on("pageerror", (err) =>
    pageErrors.push(err instanceof Error ? err.message : String(err)),
  );
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  return {
    pageErrors,
    consoleErrors,
    fatalConsole: () => consoleErrors.filter((m) => FATAL_CONSOLE.test(m)),
    benignConsole: () => consoleErrors.filter((m) => !FATAL_CONSOLE.test(m)),
    fatal: () => [
      ...pageErrors,
      ...consoleErrors.filter((m) => FATAL_CONSOLE.test(m)),
    ],
  };
}

/** Launch headless Chromium, resolved from the web client's install. */
export async function loadChromium(repoRoot) {
  const requireFromWeb = createRequire(
    join(repoRoot, "clients", "web", "package.json"),
  );
  let chromium;
  try {
    ({ chromium } = requireFromWeb("playwright"));
  } catch (err) {
    // Not resolvable means devDependencies are missing — fixed by `npm install`
    // at the repo root, NOT by `playwright install` (which fetches binaries).
    throw new Error(
      `could not resolve the Playwright package from clients/web — run \`npm install\` at the repo root (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  try {
    return await chromium.launch({ headless: true });
  } catch (err) {
    throw new Error(
      `chromium failed to launch — on a bare Linux box run \`npx playwright install --with-deps chromium\` for the system libraries (${err instanceof Error ? err.message : String(err)})`,
    );
  }
}

/**
 * Drive **connect → open app → widget ready** on an already-open page.
 *
 * The load-bearing assertion is the `data-app-status="ready"` contract
 * documented in clients/web/README.md ("MCP Apps screen automation contract"):
 * the renderer reports `ready` only once the widget has loaded inside the
 * sandbox iframe *and* fired `notifications/initialized` back through the
 * bridge. So one attribute covers the whole path — the sandbox controller
 * serving the proxy page, the proxy loading the UI resource, and the bridge
 * completing its handshake.
 *
 * Throws with the last observed `data-app-status` / `data-app-error` rather than
 * a bare timeout, so a failure names its stage.
 *
 * Three knobs exist for `smoke:web:app`'s second phase (#2056), which
 * re-navigates the *same* page to a second server declaring `_meta.ui.domain`:
 *
 *   - `expectDeepLink` — the token gate is only worth asserting on the first
 *     navigate. A re-navigate that were rejected fails at the connect wait
 *     anyway, and phase 2's real subject is the origin, not the gate.
 *   - `what` — the noun in the ready-failure message, so a phase-2 timeout does
 *     not read as a phase-1 one.
 *   - `extraDiagnostics` — appended to that message. Phase 2 lists the page's
 *     frames, which is what distinguishes "the app never rendered" from "it
 *     rendered at the wrong origin".
 *
 * Takes only the small slice of Playwright's `page` it uses (`goto`, `locator`
 * → `waitFor`/`getAttribute`/`count`), which is what lets its failure paths be
 * unit-tested against a stand-in — a smoke only ever exercises its happy path.
 */
export async function driveAppFlow({
  page,
  url,
  expectDeepLink = true,
  what = "app",
  extraDiagnostics = null,
  gotoTimeoutMs = 30_000,
  connectTimeoutMs = 45_000,
  readyTimeoutMs = 45_000,
}) {
  const response = await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: gotoTimeoutMs,
  });
  if (!response || !response.ok()) {
    throw new Error(
      `GET / returned HTTP ${response ? response.status() : "no response"}`,
    );
  }

  // 1. The deep link must be accepted (not rejected by the token gate).
  if (expectDeepLink) {
    const status = page.locator('[data-testid="connection-status"]');
    await status.waitFor({ state: "attached", timeout: gotoTimeoutMs });
    const deeplink = await status.getAttribute("data-deeplink");
    if (deeplink !== "parsed") {
      throw new Error(
        `deep link was not accepted (data-deeplink="${deeplink}") — expected "parsed"`,
      );
    }
  }

  // 2. Connected to the test server.
  await page
    .locator('[data-testid="connection-status"][data-status="connected"]')
    .waitFor({ state: "attached", timeout: connectTimeoutMs });

  // 3. The widget rendered inside the sandbox and completed its handshake.
  try {
    await page
      .locator('[data-testid="apps-form"][data-app-status="ready"]')
      .waitFor({ state: "attached", timeout: readyTimeoutMs });
  } catch {
    const form = page.locator('[data-testid="apps-form"]');
    const present = (await form.count()) > 0;
    const appStatus = present
      ? await form.getAttribute("data-app-status")
      : "(no apps-form)";
    const appError = present ? await form.getAttribute("data-app-error") : null;
    const extra = extraDiagnostics ? await extraDiagnostics() : "";
    throw new Error(
      `${what} never reached data-app-status="ready" (last: "${appStatus}"` +
        `${appError ? `, data-app-error="${appError}"` : ""}) — the sandbox proxy ` +
        `or the UI-protocol bridge failed to complete${extra ? ` — ${extra}` : ""}`,
    );
  }
}
