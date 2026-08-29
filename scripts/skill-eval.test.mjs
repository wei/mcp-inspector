// Tests for the pure halves of the skill trigger eval (#2163).
//
// Everything else in `skill-eval.mjs` spawns a real `claude` CLI, so its stream
// parsing and its process-outcome handling are unreachable from an eval run's
// happy path — they would only ever be exercised by the very measurement they
// are supposed to make trustworthy. A nonzero exit read as "no skill invoked"
// (the bug these cases pin) passes every negative case and reads as a trigger
// miss on every positive one, so a rate-limited run reports a plausible number
// instead of failing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  collectSkillInvocations,
  invokedSkillNames,
  runPrompt,
  sampleHit,
} from "./skill-eval.mjs";

const assistant = (...blocks) =>
  JSON.stringify({ type: "assistant", message: { content: blocks } });
const skillUse = (name) => ({
  type: "tool_use",
  name: "Skill",
  input: { skill: name },
});

test("collectSkillInvocations finds Skill tool_use payloads", () => {
  const { invoked } = collectSkillInvocations(
    assistant(skillUse("testing")) + "\n",
  );
  assert.equal(invoked.size, 1);
  assert.ok([...invoked][0].includes("testing"));
});

test("collectSkillInvocations ignores other tools and other event types", () => {
  const text =
    assistant({ type: "tool_use", name: "Read", input: { file_path: "a" } }) +
    "\n" +
    JSON.stringify({ type: "result", result: "Skill" }) +
    "\n";
  assert.equal(collectSkillInvocations(text).invoked.size, 0);
});

test("collectSkillInvocations survives malformed and blank lines", () => {
  const text = "not json\n\n" + assistant(skillUse("local-dev")) + "\n";
  const { invoked } = collectSkillInvocations(text);
  assert.equal(invoked.size, 1);
});

test("collectSkillInvocations holds back a trailing partial line", () => {
  const whole = assistant(skillUse("local-dev"));
  const first = collectSkillInvocations(whole.slice(0, 20));
  assert.equal(first.invoked.size, 0);
  assert.equal(first.rest, whole.slice(0, 20));
  // Feeding the remainder back with the held-over prefix completes the event.
  const second = collectSkillInvocations(first.rest + whole.slice(20) + "\n");
  assert.equal(second.invoked.size, 1);
});

test("collectSkillInvocations tolerates a tool_use with no input", () => {
  const text = assistant({ type: "tool_use", name: "Skill" }) + "\n";
  assert.deepEqual([...collectSkillInvocations(text).invoked], ["{}"]);
});

test("sampleHit scores positive and negative cases", () => {
  const fired = new Set(['{"skill":"testing"}']);
  const none = new Set();
  assert.equal(sampleHit("testing", fired), true);
  assert.equal(sampleHit("local-dev", fired), false);
  assert.equal(sampleHit(null, none), true);
  assert.equal(sampleHit(null, fired), false);
  assert.equal(sampleHit("testing", none), false);
});

test("invokedSkillNames matches structurally, not by substring", () => {
  // `{"skill":"not-testing"}` contains "testing" and must NOT count — a
  // substring match inflates the measured hit rate with invocations of a
  // different skill.
  assert.deepEqual(invokedSkillNames('{"skill":"not-testing"}'), [
    "not-testing",
  ]);
  assert.equal(
    sampleHit("testing", new Set(['{"skill":"not-testing"}'])),
    false,
  );
  assert.equal(sampleHit("testing", new Set(['{"skill":"testing"}'])), true);
  // The field name is not assumed, so any string value is a candidate.
  assert.equal(
    sampleHit("testing", new Set(['{"name":"testing","args":""}'])),
    true,
  );
});

test("invokedSkillNames tolerates payloads it cannot read", () => {
  for (const payload of ["not json", "[1,2]", "null", '"testing"']) {
    assert.deepEqual(invokedSkillNames(payload), []);
  }
});

/** Minimal stand-in for a ChildProcess: emits stdout chunks, then closes. */
function fakeSpawn({ chunks = [], code = 0, error = null }) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    queueMicrotask(() => {
      if (error) {
        child.emit("error", error);
        return;
      }
      for (const c of chunks) child.stdout.emit("data", Buffer.from(c));
      child.emit("close", code);
    });
    return child;
  };
}

test("runPrompt collects invocations across chunk boundaries", async () => {
  const whole =
    JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", name: "Skill", input: { skill: "testing" } },
        ],
      },
    }) + "\n";
  const invoked = await runPrompt("p", {
    spawnFn: fakeSpawn({ chunks: [whole.slice(0, 30), whole.slice(30)] }),
  });
  assert.equal(sampleHit("testing", invoked), true);
});

test("runPrompt rejects a nonzero exit rather than reporting an empty observation", async () => {
  // The regression that matters: resolving here would pass every negative case
  // and read as a trigger miss on every positive one, so a rate-limited run
  // would report a plausible hit rate.
  await assert.rejects(
    runPrompt("p", { spawnFn: fakeSpawn({ code: 1 }) }),
    /exited 1 for prompt: p/,
  );
});

test("runPrompt propagates a spawn error", async () => {
  await assert.rejects(
    runPrompt("p", { spawnFn: fakeSpawn({ error: new Error("ENOENT") }) }),
    /ENOENT/,
  );
});
