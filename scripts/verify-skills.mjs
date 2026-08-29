#!/usr/bin/env node
// Durable guard for `.claude/skills/**/SKILL.md` (#2163).
//
// `AGENTS.md` is loaded in full on every turn, so its rules are unconditionally
// present. A skill is conditional — its body loads only when it is invoked — so
// if a skill stops being reachable we lose behavior SILENTLY, and nothing in the
// normal workflow surfaces that. This is the check that does.
//
// What it asserts, cheapest first:
//   1. Every SKILL.md's frontmatter parses the way Claude Code parses it. This
//      is the whole-class failure: malformed YAML (or a fence that is not the
//      first line) loads the body with EMPTY metadata, so `/name` still works —
//      a manual spot check passes — while the description the model matches
//      against is gone and the skill never auto-fires again.
//   2. Every skill declares its invocation mode explicitly, so the set that has
//      to fire on its own is knowable by reading the files rather than inferred.
//   3. Every model-invoked skill has committed eval cases, including negatives.
//      Cases are run by `npm run skills:eval`, which needs the Claude CLI and is
//      therefore NOT in the gate; the cases existing is what this checks.
//   4. The skill LISTING stays inside its recorded character budget. Claude Code
//      truncates the listing when it overflows, dropping the least-invoked
//      entries first — which are exactly the model-invoked skills.
//
// It additionally runs `claude plugin validate` when that CLI is on PATH. That
// is the authoritative parse, but it cannot be a requirement: the CLI is absent
// in CI and on a contributor's machine, and a guard that skips itself wherever
// it actually runs is worse than one that reimplements the check.

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { claudeSpawnArgs, probeClaudeVersion } from "./lib/claude-cli.mjs";
import { reachableScripts, rootReachesScript } from "./lib/npm-scripts.mjs";
import {
  compareVersions,
  parseClaudeVersion,
  PINNED_CLI_VERSION,
  parseSkill,
  validateEvalCases,
  listingCost,
  LISTING_BUDGET,
} from "./lib/skill-manifest.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_SKILLS_DIR = path.join(ROOT, ".claude", "skills");

/** `PINNED_CLI_VERSION` as a comparable triple. */
const PINNED_VERSION_PARTS = parseClaudeVersion(PINNED_CLI_VERSION) ?? [];

/** Directory names under `.claude/skills` that contain a SKILL.md. */
export function skillDirs(
  dir,
  { readdir = readdirSync, stat = statSync } = {},
) {
  return readdir(dir)
    .filter((n) => !n.startsWith("."))
    .filter((n) => stat(path.join(dir, n)).isDirectory())
    .sort();
}

/**
 * Assert the two skill gates are still WIRED, not merely present.
 *
 * A gate that stops being invoked fails silently and every fixture test stays
 * green — which is the same failure the sibling guards' vouch cycle exists to
 * prevent, so this joins it (Copilot). Two distinct links:
 *
 *   - `verify:skills` (this file) must be reachable from the root `validate`.
 *     It cannot detect its own absence, so `verify:format-coverage` vouches for
 *     it and this vouches back — the established cycle.
 *   - `verify:skills:cli` must be in `local:gate` AND in the workflow. That is
 *     the step that actually runs the authoritative validator, and it is
 *     reachable from neither `validate` nor any test, so nothing else would
 *     notice it going missing.
 */
export function checkWiring(rootScripts, workflowText) {
  const problems = [];
  if (!rootReachesScript(rootScripts, "verify:format-coverage")) {
    problems.push(
      "the root `validate` no longer runs `verify:format-coverage` (a sibling guard). Restore it.",
    );
  }
  if (!reachableScripts(rootScripts, "local:gate").has("verify:skills:cli")) {
    problems.push(
      "`npm run local:gate` no longer runs `verify:skills:cli`, so the authoritative validator never runs locally. Restore it.",
    );
  }
  if (!/npm run verify:skills:cli/.test(workflowText)) {
    problems.push(
      "`.github/workflows/main.yml` no longer runs `npm run verify:skills:cli`, so the authoritative validator never runs in CI. Restore it.",
    );
  }
  return problems;
}

function main(argv = process.argv.slice(2)) {
  // An explicit directory is the seam the fixture tests drive; without it this
  // guard could only ever be exercised against the repo's own (green) skills,
  // so it could stop enforcing anything while every unit test stayed green.
  const override = argv[0];
  const SKILLS_DIR = override ? path.resolve(override) : DEFAULT_SKILLS_DIR;
  const failures = [];

  // Only meaningful against the real repo; a fixture run has no wiring.
  if (!override) {
    const rootScripts = JSON.parse(
      readFileSync(path.join(ROOT, "package.json"), "utf8"),
    ).scripts;
    const workflow = readFileSync(
      path.join(ROOT, ".github", "workflows", "main.yml"),
      "utf8",
    );
    for (const problem of checkWiring(rootScripts, workflow)) {
      failures.push(problem);
    }
  }

  if (!existsSync(SKILLS_DIR)) {
    console.error(
      `verify:skills — ${path.relative(ROOT, SKILLS_DIR)} does not exist.`,
    );
    process.exit(1);
  }

  const dirs = skillDirs(SKILLS_DIR);
  if (dirs.length === 0) {
    console.error("verify:skills — no skills found; the skill set is gone.");
    process.exit(1);
  }

  const parsed = [];
  for (const dir of dirs) {
    const file = path.join(SKILLS_DIR, dir, "SKILL.md");
    if (!existsSync(file)) {
      failures.push(`${dir}: no SKILL.md`);
      continue;
    }
    const skill = parseSkill(dir, readFileSync(file, "utf8"));
    for (const e of skill.errors) failures.push(`${dir}/SKILL.md: ${e}`);
    if (skill.errors.length > 0) continue;
    parsed.push(skill);

    if (skill.modelInvoked) {
      const evalsFile = path.join(SKILLS_DIR, dir, "evals", "evals.json");
      if (!existsSync(evalsFile)) {
        failures.push(
          `${dir}: model-invoked skills need committed eval cases at evals/evals.json`,
        );
        continue;
      }
      let cases;
      try {
        cases = JSON.parse(readFileSync(evalsFile, "utf8"));
      } catch (e) {
        failures.push(`${dir}/evals/evals.json: not valid JSON — ${e.message}`);
        continue;
      }
      for (const e of validateEvalCases(dir, cases)) {
        failures.push(`${dir}/evals/evals.json: ${e}`);
      }
    }
  }

  const cost = listingCost(parsed);
  if (cost > LISTING_BUDGET) {
    failures.push(
      `this repo contributes ${cost} chars to the skill listing, over its recorded ` +
        `budget of ${LISTING_BUDGET}. Tighten a description, or raise the budget ` +
        "deliberately in scripts/lib/skill-manifest.mjs — but note the real listing " +
        "budget is SHARED with bundled skills and the contributor's own " +
        "~/.claude/skills, none of which is visible from here.",
    );
  }

  if (failures.length > 0) {
    console.error(`verify:skills — ${failures.length} problem(s):\n`);
    for (const f of failures) console.error("  " + f);
    console.error("\nSee AGENTS.md → Maintaining the skills.");
    process.exit(1);
  }

  const modelInvoked = parsed.filter((s) => s.modelInvoked).map((s) => s.name);
  console.log(
    `verify:skills — OK: ${parsed.length} skills, ${modelInvoked.length} model-invoked ` +
      `(${modelInvoked.join(", ")}); this repo's listing share ${cost}/${LISTING_BUDGET} chars.`,
  );

  if (override) return;

  // The authoritative parse, when it is available — strictly a bonus, and only
  // from the EXACT pinned CLI.
  //
  // `local:gate` runs `validate` (and therefore this) before the pinned
  // `verify:skills:cli` step, so a local CLI on any other version could reject
  // skills that CI's pinned validator accepts — and the gate would exit here,
  // never reaching the reproducible step (Copilot). Accepting merely "new enough"
  // would reintroduce exactly the cross-machine schema drift the pin removes.
  // Anything else is left to `verify:skills:cli`, which fetches the pin.
  const version = probeClaudeVersion(parseClaudeVersion);
  if (version === null) {
    console.log(
      "verify:skills — no usable `claude` CLI here; `verify:skills:cli` runs the pinned validator.",
    );
    return;
  }
  if (compareVersions(version, PINNED_VERSION_PARTS) !== 0) {
    console.log(
      `verify:skills — local \`claude\` is ${version.join(".")}, not the pinned ` +
        `${PINNED_CLI_VERSION}; \`verify:skills:cli\` runs the pinned validator.`,
    );
    return;
  }
  const { command, args, options } = claudeSpawnArgs(
    ["plugin", "validate", ".claude/skills"],
    { cwd: ROOT, stdio: "inherit" },
  );
  if (spawnSync(command, args, options).status !== 0) {
    console.error("\nverify:skills — `claude plugin validate` failed.");
    process.exit(1);
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
