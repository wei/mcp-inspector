import { strict as assert } from "node:assert";
import test from "node:test";

import {
  DEFAULTS,
  normalizeMs,
  outputTail,
  runRenderSmoke,
} from "./render-smoke.mjs";

const MARKER = "MCP Servers";

/** A stub terminal app, driven as a real child process rather than a spy. */
function stub(body) {
  return { command: process.execPath, args: ["-e", body] };
}

// `process.exitCode`, never `process.exit()`. Writing to a *pipe* is
// asynchronous, and `process.exit()` tears the process down without draining —
// so `console.log(MARKER); process.exit(1)` can lose the marker outright. That
// is not hypothetical: probing the drain race for this PR, a 4MB write followed
// by `process.exit()` arrived at the parent with the marker missing entirely.
// A stub that intermittently never paints would fail the very assertion meant
// to pin the paint-then-die path, and would fail it as "exited before
// rendering" — the neighbouring branch. Setting `exitCode` and letting the loop
// drain still exits immediately after the write; nothing holds it open.
const paintThenExit = (code) =>
  stub(`console.log(${JSON.stringify(MARKER)}); process.exitCode = ${code};`);
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
  assert.match(r.message, /it painted one frame, it did not run/);
  // The diagnostic must not read as a crash *before* first paint — that was a
  // different defect, and conflating them sends the reader to the wrong place.
  assert.doesNotMatch(r.message, /before rendering/);
});

// `exit` races the child's last `data` event, so this stub can be observed
// either way round on the same machine. Both orders must produce the same
// verdict AND the same wording — a message phrased off observation order would
// flip run to run, which is how a stable failure gets written off as flake.
// Repeated because one pass proves nothing about a race.
test("the verdict does not depend on whether exit beats the final output", async () => {
  for (let i = 0; i < 12; i++) {
    const r = await runRenderSmoke({ ...opts, ...paintThenExit(1) });
    assert.equal(r.code, 1, `run ${i}: expected failure, got: ${r.message}`);
    assert.match(r.message, /it painted one frame, it did not run/, `run ${i}`);
    assert.doesNotMatch(r.message, /before rendering/, `run ${i}`);
  }
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

// The first-paint deadline and the survival window overlap: `done` is
// first-caller-wins, so an armed render timer firing during the survival window
// settles the run as "did not render" — while quoting an output tail that
// visibly contains the marker. A slow-but-fine TUI would fail, intermittently,
// with a diagnostic pointing at the wrong thing entirely.
test("a paint landing just under the deadline is not failed by the render timer", async () => {
  const paintAt = 250;
  const r = await runRenderSmoke({
    ...opts,
    ...stub(
      `setTimeout(() => { console.log(${JSON.stringify(MARKER)}); ` +
        `setInterval(() => {}, 1000); }, ${paintAt});`,
    ),
    // The shape being reproduced is an overlap, and only an overlap:
    //
    //   actual paint  <  timeoutMs  <  actual paint + surviveMs
    //
    // i.e. the render deadline expires while the survival window is still
    // open. Both margins are deliberately wide, because the two clocks start
    // at different moments: `paintAt` is measured from the child's first JS
    // tick, while `renderTimer` is armed in the parent at spawn. The left
    // margin therefore has to absorb everything in between — child process
    // startup, plus whatever scheduling delay the machine is under.
    //
    // `stub()` spawns `process.execPath` directly, so there is no `script(1)`
    // in this path: the PTY wrapper lives in `smoke-tui.mjs`, the caller. Node
    // boot alone measured 46-59ms idle here. That fits the old `paintAt + 150`
    // budget with room to spare, which is exactly why this read as a flake
    // rather than a bug — but under the load of a full `local:gate` run the
    // remaining ~90ms of slack is not enough to cover scheduling delay on both
    // the child's boot and the parent's timer, and it failed three gate runs
    // in a row while passing every time standalone (#2177). The diagnostic it
    // failed with, "did not render", is the misreport this test exists to
    // catch.
    //
    // Do not tighten these back up to make the test faster: the overlap is the
    // point, not the tightness. 1200ms clears any plausible paint time, and
    // still falls inside a survival window that cannot close before ~1750ms.
    timeoutMs: 1200,
    surviveMs: 1500,
  });
  assert.equal(r.code, 0, `expected pass, got: ${r.message}`);
  assert.doesNotMatch(r.message, /did not render/);
});

test("fails when the child exits before painting", async () => {
  const r = await runRenderSmoke({
    ...opts,
    // `exitCode`, not `exit()` — see `paintThenExit`. A forced exit can
    // truncate the stderr write, making the `boom` assertion below flaky.
    ...stub(`console.error("boom"); process.exitCode = 3;`),
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

// `Number("")` is 0 and `Number("typo")` is NaN, and `??` catches neither
// because both are non-nullish. `setTimeout` fires immediately on either, so an
// un-normalized `surviveMs` resolves the survival check before the child could
// possibly have died — restoring the exact first-paint false green, on a run
// that still prints OK. This is the guard on the guard.
test("normalizeMs rejects the values a bad env var actually produces", () => {
  assert.equal(normalizeMs(Number(""), 2000), 2000);
  assert.equal(normalizeMs(Number("typo"), 2000), 2000);
  assert.equal(normalizeMs(undefined, 2000), 2000);
  assert.equal(normalizeMs(-1, 2000), 2000);
  assert.equal(normalizeMs(Infinity, 2000), 2000);
  assert.equal(normalizeMs("3000", 2000), 2000, "a string is not a duration");
  // 0 is a typo, never "skip the check" — there is no caller who wants that.
  assert.equal(normalizeMs(0, 2000), 2000);
  // A real value passes through untouched.
  assert.equal(normalizeMs(1234, 2000), 1234);
});

test("a zero survival window falls back rather than passing instantly", async () => {
  // End to end through the real state machine: with surviveMs honored as 0 the
  // paint-then-exit stub would settle OK before the child's exit was seen.
  const r = await runRenderSmoke({
    ...opts,
    ...paintThenExit(1),
    surviveMs: Number(""),
  });
  assert.equal(r.code, 1, `expected failure, got: ${r.message}`);
  // The window named in the message is the normalized one, not the 0 passed in.
  assert.match(
    r.message,
    new RegExp(`${DEFAULTS.surviveMs}ms survival window`),
  );
  assert.doesNotMatch(r.message, /\b0ms survival window/);
});

// `forbidOutput` is `smoke:tui`'s guard for the acceptance criterion that the
// raw-mode error must not appear in a passing run. It lives here rather than at
// the call site precisely so it can be driven both ways: the real PTY happy
// path only ever exercises the pattern NOT matching, so a regression that broke
// this check would stay green forever.
test("forbidOutput fails a run that would otherwise have passed", async () => {
  const r = await runRenderSmoke({
    ...opts,
    ...stub(
      `console.log(${JSON.stringify(MARKER)}); ` +
        `console.error("Raw mode is not supported on the current process.stdin"); ` +
        `setInterval(() => {}, 1000);`,
    ),
    forbidOutput: {
      pattern: /Raw mode is not supported/,
      reason: "survived but logged the raw-mode error",
    },
  });
  assert.equal(r.code, 1, `expected failure, got: ${r.message}`);
  assert.match(r.message, /survived but logged the raw-mode error/);
  // The offending output is quoted, so the reader sees the evidence.
  assert.match(r.message, /Raw mode is not supported/);
});

test("forbidOutput leaves a passing run alone when it does not match", async () => {
  const r = await runRenderSmoke({
    ...opts,
    ...paintThenLive,
    forbidOutput: {
      pattern: /Raw mode is not supported/,
      reason: "should not be reached",
    },
  });
  assert.equal(r.code, 0, `expected pass, got: ${r.message}`);
  assert.doesNotMatch(r.message, /should not be reached/);
});

// A crash reason is more useful than "and it also printed X", which is usually
// a symptom of the same crash rather than a separate finding.
test("forbidOutput does not overwrite an existing failure's diagnostic", async () => {
  const r = await runRenderSmoke({
    ...opts,
    ...stub(
      `console.error("Raw mode is not supported"); process.exitCode = 1;`,
    ),
    forbidOutput: {
      pattern: /Raw mode is not supported/,
      reason: "should not replace the crash reason",
    },
  });
  assert.equal(r.code, 1);
  assert.match(r.message, /before rendering/);
  assert.doesNotMatch(r.message, /should not replace the crash reason/);
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
