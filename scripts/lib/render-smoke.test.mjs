import { strict as assert } from "node:assert";
import test from "node:test";

import { outputTail, runRenderSmoke } from "./render-smoke.mjs";

const MARKER = "MCP Servers";

/** A stub terminal app, driven as a real child process rather than a spy. */
function stub(body) {
  return { command: process.execPath, args: ["-e", body] };
}

const paintThenExit = (code) =>
  stub(`console.log(${JSON.stringify(MARKER)}); process.exit(${code});`);
const paintThenLive = stub(
  `console.log(${JSON.stringify(MARKER)}); setInterval(() => {}, 1000);`,
);

const opts = {
  marker: MARKER,
  timeoutMs: 5000,
  surviveMs: 400,
  exitGraceMs: 500,
  drainMs: 200,
  warn: () => {},
};

// The regression this module exists for. The old harness resolved OK on the
// marker and never looked again, so this exact stub — paint, then die — passed.
test("fails when the child paints the marker and then exits non-zero", async () => {
  const r = await runRenderSmoke({ ...opts, ...paintThenExit(1) });
  assert.equal(r.code, 1, `expected failure, got: ${r.message}`);
  assert.match(r.message, /code 1/);
  assert.match(r.message, /survival window/);
  // The diagnostic must not read as a crash *before* first paint — that was a
  // different defect, and conflating them sends the reader to the wrong place.
  assert.doesNotMatch(r.message, /before rendering/);
});

// Exiting 0 right after painting is the same failure: the app did not run. It
// is called out separately because `script(1)` under busybox reports 0 for a
// crashed child, so the verdict cannot rest on the exit code.
test("fails when the child paints the marker and then exits zero", async () => {
  const r = await runRenderSmoke({ ...opts, ...paintThenExit(0) });
  assert.equal(r.code, 1, `expected failure, got: ${r.message}`);
  assert.match(r.message, /it painted one frame, it did not run/);
});

test("passes when the child paints the marker and keeps running", async () => {
  const r = await runRenderSmoke({ ...opts, ...paintThenLive });
  assert.equal(r.code, 0, `expected pass, got: ${r.message}`);
  assert.match(r.message, /still running 400ms later/);
});

test("fails when the child exits before painting", async () => {
  const r = await runRenderSmoke({
    ...opts,
    ...stub(`console.error("boom"); process.exit(3);`),
  });
  assert.equal(r.code, 1);
  assert.match(r.message, /before rendering/);
  assert.match(r.message, /code 3/);
  // The tail is quoted after the drain, so the crash reason survives.
  assert.match(r.message, /boom/);
});

test("fails when the child never paints, and kills it", async () => {
  let spawned;
  const r = await runRenderSmoke({
    ...opts,
    ...stub(`setInterval(() => {}, 1000);`),
    timeoutMs: 300,
    onSpawn: (c) => (spawned = c),
  });
  assert.equal(r.code, 1);
  assert.match(r.message, /did not render/);
  // The #2000 ownership rule: the child is published before the wait, so the
  // timeout path leaves a stoppable handle rather than an orphan.
  assert.ok(spawned, "onSpawn was never called");
  assert.notEqual(
    spawned.exitCode === null && spawned.signalCode === null,
    true,
  );
});

test("reports a spawn failure rather than throwing it uncaught", async () => {
  const r = await runRenderSmoke({
    ...opts,
    command: "/definitely/not/a/binary-2147",
    args: [],
  });
  assert.equal(r.code, 1);
  assert.match(r.message, /failed to spawn/);
});

test("scans stderr as well as stdout for the marker", async () => {
  // An Ink app writing to stderr is missed entirely by a stdout-only scan,
  // which then times out with an empty diagnostic.
  const r = await runRenderSmoke({
    ...opts,
    ...stub(
      `console.error(${JSON.stringify(MARKER)}); setInterval(() => {}, 1000);`,
    ),
  });
  assert.equal(r.code, 0, `expected pass, got: ${r.message}`);
});

test("outputTail drops a leading partial line but keeps short output whole", () => {
  assert.equal(outputTail("short", 800), "short");
  // Over the limit: the slice can land mid-escape-sequence, so it starts after
  // the first newline instead of leading with a fragment.
  const long = "x".repeat(50) + "\nkeep me";
  assert.equal(outputTail(long, 20), "keep me");
  // No newline in the tail at all: nothing to trim to, so return it as sliced.
  assert.equal(outputTail("y".repeat(50), 10), "y".repeat(10));
});
