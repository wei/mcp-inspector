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
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  checkWiring,
  ciRunsUnconditionally,
  runsCommand,
} from "./verify-skills.mjs";

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

// --- wiring vouch -----------------------------------------------------------
//
// The gates cannot detect being unrun, so they vouch for each other — the same
// cycle the sibling guards use. `checkWiring` is the pure half of that, driven
// here with fixture inputs; the other half (`verify:format-coverage` noticing
// `verify:skills` gone from `validate`) lives in that guard.
//
// Three distinct links, each of which would otherwise disappear in silence:
// `verify:skills` reachable from `validate`, `verify:skills:cli` in
// `local:gate`, and `verify:skills:cli` in the workflow.

const WIRED_SCRIPTS = {
  validate: "npm run verify:format-coverage && npm run verify:skills",
  "verify:format-coverage": "node scripts/verify-format-coverage.mjs",
  "verify:skills": "node scripts/verify-skills.mjs",
  "local:gate":
    "npm run validate && npm run verify:skills:cli && npm run coverage",
  "verify:skills:cli": "node scripts/verify-skills-cli.mjs",
};
const WIRED_WORKFLOW =
  "on:\n  push:\njobs:\n  build:\n    steps:\n      - run: npm run verify:skills:cli\n";

test("checkWiring is silent when both gates are wired", () => {
  assert.deepEqual(checkWiring(WIRED_SCRIPTS, WIRED_WORKFLOW), []);
});

test("checkWiring catches a sibling guard dropped from validate", () => {
  const scripts = { ...WIRED_SCRIPTS, validate: "npm run verify:skills" };
  assert.match(
    checkWiring(scripts, WIRED_WORKFLOW).join(),
    /no longer runs `verify:format-coverage`/,
  );
});

test("checkWiring catches the authoritative validator dropped from local:gate", () => {
  const scripts = {
    ...WIRED_SCRIPTS,
    "local:gate": "npm run validate && npm run coverage",
  };
  assert.match(
    checkWiring(scripts, WIRED_WORKFLOW).join(),
    /local:gate` no longer runs `verify:skills:cli`/,
  );
});

test("checkWiring catches the authoritative validator dropped from CI", () => {
  assert.match(
    checkWiring(
      WIRED_SCRIPTS,
      "on:\n  push:\njobs:\n  build:\n    steps:\n      - run: npm run validate\n",
    ).join(),
    /has no unconditional step that runs/,
  );
});

test("checkWiring reports every broken link at once", () => {
  assert.equal(
    checkWiring({ validate: "", "local:gate": "" }, "jobs: {}\n").length,
    3,
  );
});

test("the repository as it stands is wired", () => {
  // The live assertion: fixtures can drift from what the repo actually does.
  const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const scripts = JSON.parse(
    readFileSync(path.join(repoRoot, "package.json"), "utf8"),
  ).scripts;
  const workflow = readFileSync(
    path.join(repoRoot, ".github/workflows/main.yml"),
    "utf8",
  );
  assert.deepEqual(checkWiring(scripts, workflow), []);
});

test("checkWiring is not satisfied by a mention outside an executable step", () => {
  // A raw substring match would pass on any of these while CI ran nothing —
  // including on a step whose NAME describes the check it no longer performs,
  // which is exactly how a wiring guard goes quietly vacuous.
  const mentions = [
    "# npm run verify:skills:cli\non:\n  push:\njobs:\n  build:\n    steps:\n      - run: npm run validate\n",
    "on:\n  push:\njobs:\n  build:\n    steps:\n      - name: npm run verify:skills:cli\n        run: npm run validate\n",
    "on:\n  push:\n  workflow_dispatch:\n    inputs:\n      cmd:\n        default: npm run verify:skills:cli\njobs:\n  build:\n    steps:\n      - run: npm run validate\n",
  ];
  for (const workflow of mentions) {
    assert.match(
      checkWiring(WIRED_SCRIPTS, workflow).join(),
      /has no unconditional step that runs/,
      `should not count: ${workflow.split("\n")[0]}`,
    );
  }
});

test("checkWiring accepts the command inside a multi-line run step", () => {
  const workflow =
    "on:\n  push:\njobs:\n  build:\n    steps:\n      - run: |\n          npm run validate\n          npm run verify:skills:cli\n";
  assert.deepEqual(checkWiring(WIRED_SCRIPTS, workflow), []);
});

test("ciRunsUnconditionally requires a step that runs on every push", () => {
  const C = "npm run verify:skills:cli";
  const wired =
    "on:\n  push:\njobs:\n  build:\n    steps:\n      - run: npm run verify:skills:cli\n";
  assert.equal(ciRunsUnconditionally(wired, C), true);

  // A multi-line `run:` block is the obvious way to over-correct; it counts.
  assert.equal(
    ciRunsUnconditionally(
      "on:\n  push:\njobs:\n  build:\n    steps:\n      - run: |\n          npm run validate\n          npm run verify:skills:cli\n",
      C,
    ),
    true,
  );
});

test("ciRunsUnconditionally rejects a step that only runs sometimes", () => {
  const C = "npm run verify:skills:cli";
  // Both are syntactically `run:` steps, so an executable-position check alone
  // reports them as wired while PR CI validates nothing.
  const releaseOnly =
    "on:\n  push:\njobs:\n  publish:\n    if: github.event_name == 'release'\n    steps:\n      - run: npm run verify:skills:cli\n";
  const stepGated =
    "on:\n  push:\njobs:\n  build:\n    steps:\n      - if: false\n        run: npm run verify:skills:cli\n";
  assert.equal(ciRunsUnconditionally(releaseOnly, C), false);
  assert.equal(ciRunsUnconditionally(stepGated, C), false);
});

test("ciRunsUnconditionally is not satisfied by an unrelated or absent command", () => {
  const C = "npm run verify:skills:cli";
  // `verify:skills` must not satisfy a search for `verify:skills:cli`.
  assert.equal(
    ciRunsUnconditionally(
      "on:\n  push:\njobs:\n  build:\n    steps:\n      - run: npm run verify:skills\n",
      C,
    ),
    false,
  );
  assert.equal(ciRunsUnconditionally("not: yaml: at: all:", C), false);
  assert.equal(ciRunsUnconditionally("on: push\n", C), false);
});

test("the repository's workflow runs the validator unconditionally", () => {
  const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  assert.equal(
    ciRunsUnconditionally(
      readFileSync(path.join(repoRoot, ".github/workflows/main.yml"), "utf8"),
      "npm run verify:skills:cli",
    ),
    true,
  );
});

test("runsCommand matches an exact invocation, not a substring", () => {
  const C = "npm run verify:skills:cli";
  for (const script of [
    C,
    `npm run validate && ${C}`,
    `npm run validate\n${C}\n`,
    `${C} ; npm run something`,
  ]) {
    assert.equal(runsCommand(script, C), true, script);
  }
});

test("runsCommand rejects a longer script name or a mere mention", () => {
  // Both would let the real validator be removed while the wiring guard stayed
  // green — the counterexamples to the substring test this replaced.
  const C = "npm run verify:skills:cli";
  for (const script of [
    "npm run verify:skills:cli:disabled",
    "echo npm run verify:skills:cli",
    "npm run verify:skills",
    "npm run verify:skills:cli --silent",
    "",
  ]) {
    assert.equal(runsCommand(script, C), false, script);
  }
});

test("ciRunsUnconditionally inherits the exact-invocation rule", () => {
  const C = "npm run verify:skills:cli";
  assert.equal(
    ciRunsUnconditionally(
      "on:\n  push:\njobs:\n  build:\n    steps:\n      - run: npm run verify:skills:cli:disabled\n",
      C,
    ),
    false,
  );
});

test("ciRunsUnconditionally requires the workflow to fire on ordinary changes", () => {
  const C = "npm run verify:skills:cli";
  const step =
    "jobs:\n  build:\n    steps:\n      - run: npm run verify:skills:cli\n";

  // `on:` takes three shapes, and any of them may name the event.
  assert.equal(ciRunsUnconditionally(`on:\n  push:\n${step}`, C), true);
  assert.equal(ciRunsUnconditionally(`on: push\n${step}`, C), true);
  assert.equal(ciRunsUnconditionally(`on: [push, release]\n${step}`, C), true);
  assert.equal(ciRunsUnconditionally(`on:\n  pull_request:\n${step}`, C), true);

  // A workflow switched to release-only still CONTAINS the step, and an
  // unconditional-step check alone reports it as wired — while no PR ever runs
  // the validator (Copilot).
  assert.equal(
    ciRunsUnconditionally(
      `on:\n  release:\n    types: [published]\n${step}`,
      C,
    ),
    false,
  );
  assert.equal(ciRunsUnconditionally(step, C), false);
});
