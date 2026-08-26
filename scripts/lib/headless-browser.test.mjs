/**
 * Unit tests for the headless-browser engine selection (#2086).
 *
 * The smokes cannot check this themselves: each one resolves exactly one engine
 * per process and then spends its whole run inside the happy path, so the branch
 * that matters most — an unrecognized `SMOKE_BROWSER` — is dead code from their
 * point of view. It is also the branch whose failure is silent rather than loud:
 * a fallback to Chromium there would report a green run under a job labelled
 * "webkit", claiming coverage that never ran.
 *
 * `loadBrowser`'s own launch path is deliberately not covered here — it takes a
 * real browser binary, which is what the smokes are for. Only its argument
 * validation, which fails before any of that, is.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BROWSER_ENV_VAR,
  DEFAULT_BROWSER,
  SUPPORTED_BROWSERS,
  attachPageDiagnostics,
  loadBrowser,
  resolveBrowserName,
} from "./headless-browser.mjs";

describe("resolveBrowserName", () => {
  it("defaults to chromium when the variable is unset", () => {
    assert.equal(resolveBrowserName({}), DEFAULT_BROWSER);
  });

  it("treats an empty or whitespace-only value as unset", () => {
    // A CI expression that resolves to nothing (`SMOKE_BROWSER: ${{ … }}` with
    // an undefined matrix key) sets the variable to "" rather than removing it.
    for (const raw of ["", "   "]) {
      assert.equal(
        resolveBrowserName({ [BROWSER_ENV_VAR]: raw }),
        DEFAULT_BROWSER,
      );
    }
  });

  it("accepts every supported engine", () => {
    for (const name of SUPPORTED_BROWSERS) {
      assert.equal(resolveBrowserName({ [BROWSER_ENV_VAR]: name }), name);
    }
  });

  it("normalizes surrounding whitespace and case", () => {
    assert.equal(
      resolveBrowserName({ [BROWSER_ENV_VAR]: " WebKit " }),
      "webkit",
    );
  });

  it("rejects an unrecognized engine rather than falling back", () => {
    assert.throws(
      () => resolveBrowserName({ [BROWSER_ENV_VAR]: "safari" }),
      // The message must quote what was asked for AND list what is accepted —
      // "safari" is the most likely typo here and its fix is not guessable.
      (err) =>
        /safari/.test(err.message) &&
        SUPPORTED_BROWSERS.every((name) => err.message.includes(name)),
    );
  });
});

describe("loadBrowser", () => {
  it("rejects an unsupported engine before touching Playwright", async () => {
    await assert.rejects(
      // A repo root that does not exist: reaching the `createRequire` would
      // throw a different (resolution) error, so this also pins the ORDER —
      // validation first, so the message names the real mistake.
      () => loadBrowser("/nonexistent-repo-root", "safari"),
      /unsupported browser "safari"/,
    );
  });
});

describe("attachPageDiagnostics", () => {
  /** Minimal Playwright `page` stand-in: records handlers, replays events. */
  function fakePage() {
    const handlers = {};
    return {
      on: (event, fn) => {
        (handlers[event] ??= []).push(fn);
      },
      emit: (event, arg) => handlers[event]?.forEach((fn) => fn(arg)),
    };
  }

  const consoleMessage = (type, text) => ({
    type: () => type,
    text: () => text,
  });

  it("splits fatal console errors from benign noise", () => {
    const page = fakePage();
    const diagnostics = attachPageDiagnostics(page);

    page.emit("console", consoleMessage("error", "Uncaught (in promise) boom"));
    page.emit(
      "console",
      consoleMessage("error", "Failed to fetch dynamically imported module x"),
    );
    // The two shapes that used to flake CI, and must stay diagnostics.
    page.emit(
      "console",
      consoleMessage("error", "Failed to load resource: net::ERR_FAILED"),
    );
    page.emit(
      "console",
      consoleMessage("error", "Warning: each child needs a key"),
    );
    // Non-error console output is ignored entirely.
    page.emit("console", consoleMessage("log", "Uncaught looking but a log"));

    assert.deepEqual(diagnostics.fatalConsole(), [
      "Uncaught (in promise) boom",
      "Failed to fetch dynamically imported module x",
    ]);
    assert.deepEqual(diagnostics.benignConsole(), [
      "Failed to load resource: net::ERR_FAILED",
      "Warning: each child needs a key",
    ]);
  });

  it("counts every pageerror as fatal, whatever it was thrown as", () => {
    const page = fakePage();
    const diagnostics = attachPageDiagnostics(page);

    page.emit("pageerror", new Error("sync boom"));
    page.emit("pageerror", "thrown as a string");
    page.emit("console", consoleMessage("error", "benign"));

    assert.deepEqual(diagnostics.pageErrors, [
      "sync boom",
      "thrown as a string",
    ]);
    assert.deepEqual(diagnostics.fatal(), ["sync boom", "thrown as a string"]);
  });

  it("reports nothing on a clean page", () => {
    const diagnostics = attachPageDiagnostics(fakePage());
    assert.deepEqual(diagnostics.fatal(), []);
    assert.deepEqual(diagnostics.benignConsole(), []);
  });
});
