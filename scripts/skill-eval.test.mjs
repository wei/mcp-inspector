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
  runRejection,
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

const resultEvent = (subtype) =>
  JSON.stringify({ type: "result", subtype }) + "\n";

test("collectSkillInvocations reports the terminal result subtype", () => {
  assert.equal(
    collectSkillInvocations(resultEvent("success")).result,
    "success",
  );
  assert.equal(collectSkillInvocations("").result, null);
});

test("runRejection accepts a run that hit the turn limit", () => {
  // With `--max-turns 1`, a run in which a skill FIRES necessarily hits the
  // limit and the CLI exits 1. Rejecting on the exit code alone would throw away
  // exactly the observations the eval exists to count — verified against the
  // real CLI, which ends such a run `error_max_turns` with `num_turns: 2`.
  assert.equal(runRejection({ result: "error_max_turns", code: 1 }), null);
  assert.equal(runRejection({ result: "success", code: 0 }), null);
});

test("runRejection rejects a run that observed nothing", () => {
  // An auth failure, a rate limit, or a CLI that never started. Counting these
  // as "no skill invoked" passes every negative case and reads as a trigger
  // miss on every positive one.
  assert.match(runRejection({ result: null, code: 1 }) ?? "", /no terminal/);
  assert.match(runRejection({ result: null, code: 0 }) ?? "", /no terminal/);
  assert.match(
    runRejection({ result: "error_during_execution", code: 1 }) ?? "",
    /ended `error_during_execution`/,
  );
});

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
    spawnFn: fakeSpawn({
      chunks: [
        whole.slice(0, 30),
        whole.slice(30),
        resultEvent("error_max_turns"),
      ],
      code: 1,
    }),
  });
  assert.equal(sampleHit("testing", invoked), true);
});

test("runPrompt rejects a run that produced no terminal result", async () => {
  await assert.rejects(
    runPrompt("p", { spawnFn: fakeSpawn({ code: 1 }) }),
    /no terminal `result` event \(exit 1\) for prompt: p/,
  );
});

test("runPrompt rejects a run that ended in an unusable state", async () => {
  await assert.rejects(
    runPrompt("p", {
      spawnFn: fakeSpawn({
        chunks: [resultEvent("error_during_execution")],
        code: 1,
      }),
    }),
    /ended `error_during_execution`/,
  );
});

test("runPrompt propagates a spawn error", async () => {
  await assert.rejects(
    runPrompt("p", { spawnFn: fakeSpawn({ error: new Error("ENOENT") }) }),
    /ENOENT/,
  );
});

test("a negative case ignores skills that are not this repo's", () => {
  // A contributor's own `~/.claude/skills` entry, or a bundled skill, firing on
  // a negative prompt says nothing about these skills — failing on it would be
  // a false failure about someone else's environment.
  const ours = new Set(["testing", "local-dev"]);
  const foreign = new Set(['{"skill":"my-personal-notes"}']);
  const mine = new Set(['{"skill":"testing"}']);

  assert.equal(sampleHit(null, foreign, ours), true);
  assert.equal(sampleHit(null, mine, ours), false);
  assert.equal(sampleHit(null, new Set(), ours), true);
  // A positive case is unaffected: it names the skill it wants.
  assert.equal(sampleHit("testing", mine, ours), true);
  assert.equal(sampleHit("testing", foreign, ours), false);
  // With no repo set, any invocation still fails a negative case.
  assert.equal(sampleHit(null, foreign), false);
});
