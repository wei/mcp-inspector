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
import {
  parseSkill,
  validateEvalCases,
  listingCost,
  LISTING_BUDGET,
} from "./lib/skill-manifest.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKILLS_DIR = path.join(ROOT, ".claude", "skills");

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

function main() {
  const failures = [];

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
      `the skill listing costs ${cost} chars, over the recorded budget of ${LISTING_BUDGET}. ` +
        "Tighten a description, or raise the budget deliberately in scripts/lib/skill-manifest.mjs.",
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
      `(${modelInvoked.join(", ")}); listing ${cost}/${LISTING_BUDGET} chars.`,
  );

  // The authoritative parse, when it is available.
  const probe = spawnSync("claude", ["--version"], { stdio: "ignore" });
  if (probe.error) {
    console.log(
      "verify:skills — `claude` CLI not on PATH; skipped `claude plugin validate`.",
    );
    return;
  }
  const res = spawnSync("claude", ["plugin", "validate", ".claude/skills"], {
    cwd: ROOT,
    stdio: "inherit",
  });
  if (res.status !== 0) {
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
