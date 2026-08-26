/**
 * The headless browser the web smokes drive: which engine, how it is launched,
 * and the two error channels a page reports on (#2086).
 *
 * All three smokes (`smoke:web:browser`, `smoke:web:app`, `smoke:web:elicit`)
 * and `pack:verify` go through here, so the engine is a parameter in exactly
 * one place and the diagnostics split is stated once rather than hand-rolled
 * four times.
 *
 * Every browser-driven check in this repo used to be Chromium-only. That is
 * fine for most of the web client, whose behavior is React and Mantine — and it
 * is NOT fine for the MCP Apps sandbox, which is built out of exactly the
 * primitives that diverge between engines: a CSP `<meta>` injected into a
 * `srcdoc` document, a nested sandboxed iframe, a `Permissions-Policy` `allow`
 * attribute, and `postMessage` origin discipline across those two frames. A
 * regression in any of those is invisible unless it also reproduces in Chromium.
 *
 * The unit tests cannot cover it either: `sandbox-csp.test.ts` asserts which
 * policy STRING is built, which would pass identically on an engine that
 * ignores `<meta>` CSP entirely. And no Storybook story reaches the sandbox at
 * all — all three App stories point the iframe at a `data:` placeholder and hand
 * the renderer a mock bridge. So the smokes are the only place the sandbox is
 * genuinely exercised, and this module is what lets them be pointed at another
 * engine.
 *
 * ⚠️ Playwright's WebKit is a WebKit build, not Safari. It is close enough to
 * catch engine-level CSP and iframe divergence, and not close enough to certify
 * Safari specifically — a green run here is not a Safari guarantee.
 *
 * **And that cuts both ways: a RED run here is not a Safari indictment.** #2132
 * was written up as a Safari bug on the strength of a failure in this build
 * alone; a manual check in Safari did not reproduce it. The divergence is widest
 * in the networking layer, which is exactly where that failure lives. Reproduce
 * in the real browser before describing a finding as one users hit.
 *
 * Playwright is resolved with a `createRequire` based at
 * clients/web/package.json rather than a bare `import("playwright")`: a bare ESM
 * specifier resolves relative to `scripts/`, not the cwd, so a `cd clients/web`
 * in the npm script would NOT make it resolvable. See smoke-web-browser.mjs's
 * header for the full gotcha.
 */

import { createRequire } from "node:module";
import { join } from "node:path";

/**
 * Console messages that are the async half of the uncaught-crash class (an
 * unhandled rejection or a failed dynamic import). Hard failures; every other
 * console error is a diagnostic, so benign font-CDN / React-warning noise can't
 * flake CI. smoke-web-browser.mjs's header documents the reasoning at length.
 */
export const FATAL_CONSOLE =
  /^Uncaught\b|Failed to fetch dynamically imported module/;

/**
 * Attach the two error channels a headless page reports on.
 *
 * An uncaught *synchronous* page error fires `pageerror`; its async twin — an
 * unhandled rejection or a failed dynamic import — is not a `pageerror` at all
 * and arrives on the console channel instead. Both are captured, and both are
 * read on every engine rather than branching per browser: which channel an
 * engine picks is exactly the kind of detail that differs between them, and
 * reading both makes that difference irrelevant. Only `fatal()` is a failure, so
 * ordinary console noise stays a diagnostic.
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

/** The supported engine set. Anything else is a typo, not a request. */
export const SUPPORTED_BROWSERS = ["chromium", "firefox", "webkit"];

/** The engine used when nothing asks for another one. */
export const DEFAULT_BROWSER = "chromium";

/** The env var each smoke reads to pick its engine. */
export const BROWSER_ENV_VAR = "SMOKE_BROWSER";

/**
 * Resolve the engine name from the environment, deny-by-default.
 *
 * An unrecognized value FAILS rather than falling back to Chromium: a silent
 * fallback would report a green Chromium run under a job labelled "webkit",
 * which is worse than no coverage — it claims coverage that never ran.
 */
export function resolveBrowserName(env = process.env) {
  const raw = env[BROWSER_ENV_VAR];
  if (raw === undefined || raw.trim() === "") return DEFAULT_BROWSER;
  const name = raw.trim().toLowerCase();
  if (!SUPPORTED_BROWSERS.includes(name)) {
    throw new Error(
      `${BROWSER_ENV_VAR}="${raw}" is not a supported browser — expected one of ${SUPPORTED_BROWSERS.join(", ")}`,
    );
  }
  return name;
}

/**
 * Launch a headless browser of `browserName`, resolved from the web client's
 * install.
 *
 * The launch-failure message names the engine that failed and the
 * `playwright install` invocation that fixes it — naming "chromium" while
 * WebKit was the thing missing sends the reader off to install a browser they
 * already have.
 */
export async function loadBrowser(repoRoot, browserName = DEFAULT_BROWSER) {
  if (!SUPPORTED_BROWSERS.includes(browserName)) {
    throw new Error(
      `unsupported browser "${browserName}" — expected one of ${SUPPORTED_BROWSERS.join(", ")}`,
    );
  }
  const requireFromWeb = createRequire(
    join(repoRoot, "clients", "web", "package.json"),
  );
  let playwright;
  try {
    playwright = requireFromWeb("playwright");
  } catch (err) {
    // Not resolvable means devDependencies are missing — fixed by `npm install`
    // at the repo root, NOT by `playwright install` (which fetches binaries).
    throw new Error(
      `could not resolve the Playwright package from clients/web — run \`npm install\` at the repo root (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  try {
    return await playwright[browserName].launch({ headless: true });
  } catch (err) {
    throw new Error(
      `${browserName} failed to launch — run \`npx playwright install --with-deps ${browserName}\`, ` +
        `which fetches the browser and (on a bare Linux box) its system libraries ` +
        `(${err instanceof Error ? err.message : String(err)})`,
    );
  }
}
