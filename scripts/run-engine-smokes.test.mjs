/**
 * The engine-smoke runner's list (#2086).
 *
 * `ENGINE_SMOKES` is the single home for "which smokes are engine-sensitive",
 * and the thing that can silently rot about it is a smoke going missing — the
 * suite still passes, just covering less. Nothing at runtime notices, because a
 * shorter list is a *successful* run.
 *
 * Importing the module must not spawn anything; `main()` is behind an entrypoint
 * guard, and this test would catch that regressing by running three browser
 * smokes the moment the suite imported it.
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ENGINE_SMOKES } from "./run-engine-smokes.mjs";

const scriptDir = import.meta.dirname;

describe("ENGINE_SMOKES", () => {
  it("names every browser-driven smoke, and each one exists", () => {
    // Deliberately spelled out rather than derived: this list IS the coverage
    // claim, so a test that computed it from disk would agree with any mistake.
    assert.deepEqual(ENGINE_SMOKES, [
      "smoke-web-browser.mjs",
      "smoke-web-app.mjs",
      "smoke-web-elicitation.mjs",
    ]);
    for (const smoke of ENGINE_SMOKES) {
      assert.ok(
        existsSync(join(scriptDir, smoke)),
        `${smoke} is listed but missing — a rename would silently shrink the run`,
      );
    }
  });

  it("runs the cheapest smoke first", () => {
    // smoke-web-browser only boots the bundle; the other two drive a whole App
    // flow with 45s waits. Ordering it first is what makes "this engine cannot
    // run the bundle at all" fail in seconds rather than after two timeouts.
    assert.equal(ENGINE_SMOKES[0], "smoke-web-browser.mjs");
  });
});
