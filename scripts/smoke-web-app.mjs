#!/usr/bin/env node
/**
 * Headless-browser MCP Apps smoke for the prod web client (#1859).
 *
 * `smoke:web:browser` proves the bundle boots and paints its first frame. It
 * stops there — it never connects to a server, so everything downstream of the
 * connect (the Apps tab, the sandbox controller, the UI-protocol bridge) is
 * unexercised by any smoke. This closes that gap: it drives the full
 * **connect → open app → widget ready** chain against a real MCP App server.
 *
 * The assertion is the `data-app-status="ready"` contract documented in
 * clients/web/README.md ("MCP Apps screen automation contract"): the renderer
 * only reports `ready` once the widget has loaded inside the sandbox iframe and
 * fired `notifications/initialized` back through the bridge. So a single
 * attribute covers the whole path — sandbox controller serving the proxy page,
 * the proxy loading the UI resource, and the bridge completing its handshake.
 *
 * ── What this does and does NOT catch ───────────────────────────────────────
 *
 * This runs against the **repo build tree**, like every other `smoke:*`. That
 * matters for the bug that motivated it: #1859 was a *packaging* failure —
 * `clients/web/static/sandbox_proxy.html` was missing from the published
 * tarball's "files" allowlist. In the repo that file is always present, so this
 * smoke would have stayed green through that entire bug.
 *
 * The packaging dimension is owned by `npm run pack:verify`, which asserts the
 * file both in the tarball packlist and on disk after a real install. Keep both:
 * pack:verify proves the file *ships*, this proves the App path *works*. Neither
 * subsumes the other, and the failure this one is positioned to catch is a
 * regression in the sandbox/bridge code itself — which pack:verify, driving only
 * `GET /`, would not notice.
 *
 * As a cheap extra, this does assert the proxy page exists at the location the
 * runtime resolves it from (`clients/web/build/../static/…`, see
 * server/sandbox-controller.ts) — which catches the file being *moved or
 * renamed* without its reader being updated, a repo-tree failure pack:verify
 * would only find later.
 *
 * Playwright is resolved with a `createRequire` based at clients/web/package.json
 * rather than a bare `import("playwright")` — a bare ESM specifier resolves
 * relative to scripts/, not the cwd, so `cd clients/web` in the npm script would
 * NOT make it resolvable. Same gotcha as smoke:web:browser; see its header.
 *
 * Expects `clients/web/dist` and `clients/launcher/build` to be built first —
 * the validate / CI ordering guarantees this. `test-servers/build` is built on
 * demand if missing, as in smoke:cli.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { join, resolve } from "node:path";
import { startProdWebServer } from "./lib/prod-web-server.mjs";
import { stopChild } from "./lib/child-cleanup.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const requireFromWeb = createRequire(
  resolve(repoRoot, "clients/web/package.json"),
);

const composableServer = join(
  repoRoot,
  "test-servers",
  "build",
  "server-composable.js",
);
const appConfig = join(
  repoRoot,
  "test-servers",
  "configs",
  "mcp-app-http.json",
);
// The path clients/web/server/sandbox-controller.ts resolves at runtime, from
// the built runner at clients/web/build/. Kept in sync with the `join(__dirname,
// "../static/sandbox_proxy.html")` there.
const sandboxProxyPage = join(
  repoRoot,
  "clients",
  "web",
  "static",
  "sandbox_proxy.html",
);

const HOST = "127.0.0.1";
// Distinct from smoke:web (6299) and smoke:web:browser (6298) so a prior smoke
// whose port is still bound — slow teardown, TIME_WAIT, or a parallel run —
// can't EADDRINUSE this one. The three run back-to-back in `npm run smoke`.
const PORT = process.env.SMOKE_WEB_APP_PORT ?? "6297";
const TOKEN = "smoke-web-app-token";
const APP_TOOL = "mcp_app_demo";
// Console messages that are the async half of the uncaught-crash class (an
// unhandled rejection or a failed dynamic import). Hard failures; every other
// console error is a diagnostic, so benign font-CDN / React-warning noise can't
// flake CI. Kept identical to smoke-web-browser.mjs, which documents the
// reasoning at length.
const FATAL_CONSOLE = /^Uncaught\b|Failed to fetch dynamically imported module/;
// The URL the test server announces on startup. NOT derived from the config's
// port: createTestServerHttp resolves its port with findAvailablePort(), which
// walks UPWARD from the configured value when it's taken — so the config port is
// a starting hint, not a guarantee, and assuming it makes this smoke fail
// whenever anything else holds that port. The announced line is authoritative.
let mcpUrl = null;

let mcpServer = null;
let browser = null;
const server = startProdWebServer({ host: HOST, port: PORT, token: TOKEN });

async function shutdown() {
  if (browser) {
    try {
      await browser.close();
    } catch {
      // best-effort
    }
    browser = null;
  }
  server.stop();
  if (mcpServer) {
    const child = mcpServer;
    mcpServer = null;
    await stopChild(child, { label: "smoke:web:app", what: "MCP test server" });
  }
}

async function fail(message) {
  console.error(`smoke:web:app FAILED — ${message}`);
  await shutdown();
  process.exit(1);
}

/** Build the composable test server bundle if it isn't present yet. */
function ensureTestServer() {
  if (existsSync(composableServer)) return;
  console.log(
    "smoke:web:app — building test-servers (missing build output)...",
  );
  const r = spawnSync("npx", ["tsc", "-p", "test-servers", "--noCheck"], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (r.status !== 0 || !existsSync(composableServer)) {
    throw new Error(
      "could not build the test servers (test-servers/build/server-composable.js). " +
        "Run `npm run test-servers:build` from clients/web.",
    );
  }
}

/**
 * Spawn the MCP App test server and wait for it to announce its URL.
 *
 * Both stdio channels are piped and scanned: server-composable.ts announces
 * readiness with `console.error`, so watching stdout alone never matches and
 * this times out with an empty diagnostic. Piping both also keeps the child's
 * noise out of the smoke's own output while still making it available in the
 * failure message.
 */
async function startMcpServer() {
  const child = spawn(
    process.execPath,
    [composableServer, "--config", appConfig],
    { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] },
  );
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  let exited = false;
  let spawnError = null;
  // A spawn failure (e.g. an unbuilt/renamed entry) emits `error`, NOT `exit` —
  // and with no `error` listener Node throws it uncaught, replacing this smoke's
  // diagnostic with a raw stack. `close` is listened to alongside `exit` for the
  // same reason: it fires in cases `exit` does not, so a child that dies without
  // an exit event can't leave the poll below spinning for the full 30s.
  child.on("error", (err) => (spawnError = err));
  child.on("exit", () => (exited = true));
  child.on("close", () => (exited = true));

  for (let attempt = 0; attempt < 120; attempt++) {
    // Take the port the server actually bound, not the one we asked for.
    const announced = out.match(/listening at (http:\/\/\S+)/i);
    if (announced) return { child, url: announced[1] };
    if (spawnError) {
      throw new Error(
        `could not spawn the MCP test server (${composableServer}): ${spawnError.message}`,
      );
    }
    if (exited) throw new Error(`MCP test server exited early:\n${out}`);
    await delay(250);
  }
  throw new Error(`MCP test server did not start within 30s:\n${out}`);
}

/** base64url(JSON) — the appArgs encoding the deep link expects. */
function encodeAppArgs(args) {
  return Buffer.from(JSON.stringify(args))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function loadChromium() {
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

try {
  // Cheap structural check first: the sandbox proxy page must exist where the
  // runtime looks for it. Fails fast with a clear cause instead of surfacing as
  // an opaque "app never reached ready" 30s timeout below.
  if (!existsSync(sandboxProxyPage)) {
    await fail(
      `sandbox proxy page missing at ${sandboxProxyPage} — clients/web/server/sandbox-controller.ts ` +
        `reads it as \`join(__dirname, "../static/sandbox_proxy.html")\`; if it moved, update both ` +
        `(and the "files" allowlist in the root package.json, see #1859)`,
    );
  }

  ensureTestServer();
  ({ child: mcpServer, url: mcpUrl } = await startMcpServer());
  await server.waitForReady();
  browser = await loadChromium();
  const page = await browser.newPage();

  // Uncaught *synchronous* page errors. Their *async* twin — an unhandled
  // rejection or a failed dynamic import — is not a `pageerror`; Chromium
  // reports it on the console channel instead, so both are captured and both
  // are hard failures. Same split as smoke:web:browser; see FATAL_CONSOLE there.
  const pageErrors = [];
  const consoleErrors = [];
  page.on("pageerror", (err) =>
    pageErrors.push(err instanceof Error ? err.message : String(err)),
  );
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  const fatalConsole = () => consoleErrors.filter((m) => FATAL_CONSOLE.test(m));

  // Deep link: connect, switch to the Apps tab, pre-select the app tool, and
  // fire "Open App". autoConnect/autoOpen must equal the session token (CSRF
  // gate). Shape owned by clients/web/README.md#deep-link-auto-connect.
  const url =
    `${server.baseUrl}/?serverUrl=${encodeURIComponent(mcpUrl)}` +
    `&transport=http&autoConnect=${TOKEN}&openApp=${APP_TOOL}` +
    `&appArgs=${encodeAppArgs({ title: "smoke:web:app" })}&autoOpen=${TOKEN}`;

  const drive = async () => {
    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    if (!response || !response.ok()) {
      throw new Error(
        `GET / returned HTTP ${response ? response.status() : "no response"}`,
      );
    }

    // 1. The deep link must be accepted (not rejected by the token gate).
    const status = page.locator('[data-testid="connection-status"]');
    await status.waitFor({ state: "attached", timeout: 30_000 });
    const deeplink = await status.getAttribute("data-deeplink");
    if (deeplink !== "parsed") {
      throw new Error(
        `deep link was not accepted (data-deeplink="${deeplink}") — expected "parsed"`,
      );
    }

    // 2. Connected to the test server.
    await page
      .locator('[data-testid="connection-status"][data-status="connected"]')
      .waitFor({ state: "attached", timeout: 45_000 });

    // 3. The widget rendered inside the sandbox and completed its handshake.
    //    This is the load-bearing assertion — see the header comment.
    try {
      await page
        .locator('[data-testid="apps-form"][data-app-status="ready"]')
        .waitFor({ state: "attached", timeout: 45_000 });
    } catch {
      const form = page.locator('[data-testid="apps-form"]');
      const appStatus = (await form.count())
        ? await form.getAttribute("data-app-status")
        : "(no apps-form)";
      const appError = (await form.count())
        ? await form.getAttribute("data-app-error")
        : null;
      throw new Error(
        `app never reached data-app-status="ready" (last: "${appStatus}"` +
          `${appError ? `, data-app-error="${appError}"` : ""}) — the sandbox proxy ` +
          `or the UI-protocol bridge failed to complete`,
      );
    }
  };

  // Race against launcher death so a mid-run server crash is reported as the
  // real cause instead of a downstream timeout.
  try {
    await Promise.race([server.whenChildExits(), drive()]);
  } catch (err) {
    const diagnostics = [
      ...pageErrors,
      ...fatalConsole().map((m) => `console: ${m}`),
    ];
    await fail(
      `${err instanceof Error ? err.message : String(err)}${
        diagnostics.length
          ? ` — page diagnostics: ${diagnostics.join("; ")}`
          : ""
      }`,
    );
  }

  // Hard failures: any uncaught sync page error, plus the console errors that
  // are the async half of the same class.
  const fatal = [...pageErrors, ...fatalConsole()];
  if (fatal.length > 0) {
    await fail(`app logged uncaught error(s): ${fatal.join("; ")}`);
  }

  // Non-fatal console errors: surface them so a real problem isn't invisible,
  // without failing on benign subresource/warning noise.
  const benignConsole = consoleErrors.filter((m) => !FATAL_CONSOLE.test(m));
  if (benignConsole.length > 0) {
    console.log(
      `smoke:web:app note — ${benignConsole.length} non-fatal console error(s): ${benignConsole.join("; ")}`,
    );
  }

  console.log(
    `smoke:web:app OK — connected to ${mcpUrl}, opened "${APP_TOOL}", ` +
      `widget reached data-app-status="ready" through the sandbox proxy`,
  );
  await shutdown();
  process.exit(0);
} catch (err) {
  await fail(err instanceof Error ? err.message : String(err));
}
