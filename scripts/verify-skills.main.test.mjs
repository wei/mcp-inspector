// Fixture-level tests for `verify-skills`'s orchestration (#2163, Copilot).
//
// `skill-manifest.test.mjs` covers the parsers; this covers `main()` — that the
// guard actually *reports* what those parsers find, and exits nonzero when it
// does. Without it, the mandatory gate could stop enforcing its checks while
// every parser test stayed green, which is the same "a gate that stops gating"
// failure the sibling guards' `*.main.test.mjs` suites exist to prevent.
//
// Each case builds a throwaway skills directory and runs the real script
// against it via the directory argument. Run via `npm run test:scripts`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "verify-skills.mjs",
);

/**
 * Build a skills directory.
 *
 * @param {Record<string, {skill?: string, evals?: string}>} skills
 */
function fixture(skills) {
  const root = mkdtempSync(path.join(tmpdir(), "verify-skills-"));
  for (const [name, { skill, evals }] of Object.entries(skills)) {
    const dir = path.join(root, name);
    mkdirSync(dir, { recursive: true });
    if (skill !== undefined) writeFileSync(path.join(dir, "SKILL.md"), skill);
    if (evals !== undefined) {
      mkdirSync(path.join(dir, "evals"), { recursive: true });
      writeFileSync(path.join(dir, "evals", "evals.json"), evals);
    }
  }
  return root;
}

function run(dir) {
  const res = spawnSync(process.execPath, [SCRIPT, dir], { encoding: "utf8" });
  return { code: res.status, out: (res.stdout ?? "") + (res.stderr ?? "") };
}

const byName = (name, extra = "") =>
  `---\nname: ${name}\ndescription: A description.\ndisable-model-invocation: true\n${extra}---\n\nBody\n`;

const modelInvoked = (name) =>
  `---\nname: ${name}\ndescription: A description.\ndisable-model-invocation: false\n---\n\nBody\n`;

const goodEvals = (name) =>
  JSON.stringify([
    { prompt: "fires", expect: name },
    { prompt: "does not", expect: null },
  ]);

test("passes a well-formed directory", () => {
  const dir = fixture({
    alpha: { skill: byName("alpha") },
    beta: { skill: modelInvoked("beta"), evals: goodEvals("beta") },
  });
  const { code, out } = run(dir);
  assert.equal(code, 0, out);
  assert.match(out, /2 skills, 1 model-invoked \(beta\)/);
  rmSync(dir, { recursive: true, force: true });
});

test("fails an empty or missing directory", () => {
  const empty = mkdtempSync(path.join(tmpdir(), "verify-skills-empty-"));
  assert.match(run(empty).out, /no skills found/);
  assert.equal(run(empty).code, 1);
  assert.equal(run(path.join(empty, "nope")).code, 1);
  rmSync(empty, { recursive: true, force: true });
});

test("fails a skill directory with no SKILL.md", () => {
  const dir = fixture({ alpha: {} });
  const { code, out } = run(dir);
  assert.equal(code, 1);
  assert.match(out, /alpha: no SKILL\.md/);
  rmSync(dir, { recursive: true, force: true });
});

test("fails frontmatter that would load with empty metadata", () => {
  // The failure the guard exists for: `/alpha` still works, so a spot check
  // passes, while the description the model matches against is gone.
  const dir = fixture({
    alpha: {
      skill:
        "---\nname: alpha\ndescription: Use this: always\ndisable-model-invocation: true\n---\n",
    },
  });
  const { code, out } = run(dir);
  assert.equal(code, 1);
  assert.match(out, /not valid YAML/);
  rmSync(dir, { recursive: true, force: true });
});

test("fails a skill that does not declare its invocation mode", () => {
  const dir = fixture({
    alpha: { skill: "---\nname: alpha\ndescription: d\n---\n" },
  });
  const { code, out } = run(dir);
  assert.equal(code, 1);
  assert.match(out, /must be declared explicitly/);
  rmSync(dir, { recursive: true, force: true });
});

test("fails a model-invoked skill with no eval cases", () => {
  const dir = fixture({ beta: { skill: modelInvoked("beta") } });
  const { code, out } = run(dir);
  assert.equal(code, 1);
  assert.match(out, /need committed eval cases/);
  rmSync(dir, { recursive: true, force: true });
});

test("fails eval cases that are unreadable, all-positive, or all-negative", () => {
  for (const [evals, pattern] of [
    ["{ not json", /not valid JSON/],
    [JSON.stringify([{ prompt: "a", expect: "beta" }]), /no negative case/],
    [JSON.stringify([{ prompt: "a", expect: null }]), /no positive case/],
    [JSON.stringify([{ expect: null }]), /prompt/],
  ]) {
    const dir = fixture({ beta: { skill: modelInvoked("beta"), evals } });
    const { code, out } = run(dir);
    assert.equal(code, 1, out);
    assert.match(out, pattern);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fails when the skill listing exceeds its budget", () => {
  // Only model-invoked skills occupy the listing, so the same text behind
  // `disable-model-invocation: true` must NOT trip it.
  const long = "d".repeat(1500);
  const many = {};
  for (let i = 0; i < 4; i++) {
    many[`skill-${i}`] = {
      skill: `---\nname: skill-${i}\ndescription: ${long}\ndisable-model-invocation: false\n---\n`,
      evals: goodEvals(`skill-${i}`),
    };
  }
  const over = fixture(many);
  const { code, out } = run(over);
  assert.equal(code, 1);
  assert.match(out, /over its recorded budget/);
  rmSync(over, { recursive: true, force: true });

  const quiet = {};
  for (let i = 0; i < 4; i++) {
    quiet[`skill-${i}`] = {
      skill: `---\nname: skill-${i}\ndescription: ${long}\ndisable-model-invocation: true\n---\n`,
    };
  }
  const under = fixture(quiet);
  assert.equal(run(under).code, 0);
  rmSync(under, { recursive: true, force: true });
});

test("reports every offender in one pass rather than dying on the first", () => {
  const dir = fixture({
    alpha: {},
    beta: { skill: modelInvoked("beta") },
    gamma: {
      skill:
        "---\nname: wrong-name\ndescription: d\ndisable-model-invocation: true\n---\n",
    },
  });
  const { code, out } = run(dir);
  assert.equal(code, 1);
  assert.match(out, /3 problem\(s\)/);
  rmSync(dir, { recursive: true, force: true });
});
