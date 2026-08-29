#!/usr/bin/env node
// Trigger eval for the model-invoked skills in `.claude/skills` (#2163).
//
// `verify:skills` asserts a skill is well-formed and that its cases exist. This
// runs them: each prompt is executed headless in a FRESH session and we assert
// on whether the Skill tool fired with the expected skill.
//
// Seeing a skill fire once tells us Claude found it, not that it finds it
// reliably — the measurement is a hit rate over repeated fresh sessions. It
// needs negative cases too: a skill that fires on everything is a context
// regression, and it is the failure nobody notices by hand. `verify:skills`
// requires both.
//
// NOT part of `validate`, `local:gate`, or CI, and that is a decision rather
// than an omission. A trigger eval cannot be a gate: it spends metered model
// calls on every push, the measurement IS a hit rate over samples so it is
// non-deterministic by construction, and it goes red on a rate limit or an
// expired token — failures unrelated to the diff, whose first consequence is
// that people stop trusting the gate. Run it when adding a skill or editing a
// model-invoked skill's description.
//
// The cost of that split, stated plainly: `verify:skills` cannot detect a
// well-formed skill whose description simply never matches anything. Nothing in
// the gate can. Closing that would need a deterministic trigger oracle, which
// does not exist.
//
// Usage:
//   npm run skills:eval                  # every model-invoked skill's cases
//   npm run skills:eval -- testing       # one skill's cases
//   RUNS=5 THRESHOLD=0.8 npm run skills:eval

import { spawn, spawnSync } from "node:child_process";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseSkill } from "./lib/skill-manifest.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKILLS_DIR = path.join(ROOT, ".claude", "skills");

const THRESHOLD = Number(process.env.THRESHOLD ?? 0.8);
const RUNS = Number(process.env.RUNS ?? 3);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 4);

/** Collect the committed cases for every model-invoked skill (optionally one). */
function collectCases(only) {
  const cases = [];
  for (const dir of readdirSync(SKILLS_DIR).sort()) {
    if (only && dir !== only) continue;
    const skillFile = path.join(SKILLS_DIR, dir, "SKILL.md");
    if (
      !statSync(path.join(SKILLS_DIR, dir)).isDirectory() ||
      !existsSync(skillFile)
    )
      continue;
    const skill = parseSkill(dir, readFileSync(skillFile, "utf8"));
    if (skill.errors.length > 0 || !skill.modelInvoked) continue;
    const evalsFile = path.join(SKILLS_DIR, dir, "evals", "evals.json");
    if (!existsSync(evalsFile)) continue;
    for (const c of JSON.parse(readFileSync(evalsFile, "utf8")))
      cases.push({ ...c, from: dir });
  }
  return cases;
}

/**
 * Extract the payloads the `Skill` tool was invoked with from a chunk of
 * `--output-format stream-json` output.
 *
 * Pure and separately tested: everything below spawns a real CLI, so the
 * parsing and the process-outcome handling are unreachable from the happy path
 * of an eval run and would otherwise only ever be exercised by the thing they
 * are supposed to measure.
 *
 * @param {string} text One or more newline-delimited JSON events. A trailing
 *   partial line is ignored, so this can be fed incrementally.
 * @returns {{ invoked: Set<string>, rest: string }}
 */
export function collectSkillInvocations(text) {
  const lines = text.split("\n");
  const rest = lines.pop() ?? "";
  const invoked = new Set();
  for (const line of lines) {
    if (!line.trim()) continue;
    let evt;
    try {
      evt = JSON.parse(line);
    } catch {
      // A malformed line is noise from the CLI, not an observation.
      continue;
    }
    if (evt?.type !== "assistant") continue;
    for (const block of evt.message?.content ?? []) {
      if (block?.type !== "tool_use" || block.name !== "Skill") continue;
      // Don't assume the input field's name — match on the whole payload.
      invoked.add(JSON.stringify(block.input ?? {}));
    }
  }
  return { invoked, rest };
}

/**
 * Whether one sample satisfies a case.
 *
 * @param {string | null} expect Skill name, or null for a negative case.
 * @param {Set<string>} invoked
 */
export function sampleHit(expect, invoked) {
  if (expect === null) return invoked.size === 0;
  return [...invoked].some((payload) => payload.includes(expect));
}

/** Returns the payloads the Skill tool was called with in one fresh session. */
function runOnce(prompt) {
  return new Promise((resolve, reject) => {
    const p = spawn(
      "claude",
      [
        "-p",
        prompt,
        "--output-format",
        "stream-json",
        "--verbose",
        "--max-turns",
        "1",
        // Keep the run read-only. A skill may inject `!`-prefixed shell commands
        // on load, and those run BEFORE its content reaches the model.
        "--disallowedTools",
        "Bash,Write,Edit,NotebookEdit",
      ],
      { cwd: ROOT, stdio: ["ignore", "pipe", "inherit"] },
    );

    let buf = "";
    const invoked = new Set();
    p.stdout.on("data", (chunk) => {
      const parsed = collectSkillInvocations(buf + chunk.toString());
      buf = parsed.rest;
      for (const payload of parsed.invoked) invoked.add(payload);
    });
    p.on("error", reject);
    p.on("close", (code) => {
      // A CLI that failed to run observed NOTHING. Resolving it as an empty set
      // would silently pass every negative case and read as a trigger miss on
      // every positive one, so an auth error or a rate limit would come back as
      // a plausible-looking hit rate (Copilot).
      if (code !== 0) {
        reject(new Error(`\`claude -p\` exited ${code} for prompt: ${prompt}`));
        return;
      }
      resolve(invoked);
    });
  });
}

const hit = (invoked, skill) =>
  [...invoked].some((payload) => payload.includes(skill));

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]);
      }
    }),
  );
  return out;
}

async function main() {
  if (spawnSync("claude", ["--version"], { stdio: "ignore" }).error) {
    console.error(
      "skills:eval — the `claude` CLI is not on PATH. This eval needs it.",
    );
    process.exit(1);
  }

  const cases = collectCases(process.argv[2]);
  if (cases.length === 0) {
    console.error("skills:eval — no cases found.");
    process.exit(1);
  }

  const jobs = cases.flatMap((c) => Array.from({ length: RUNS }, () => c));
  const results = await pool(jobs, CONCURRENCY, async (c) => ({
    c,
    invoked: await runOnce(c.prompt),
  }));

  let failed = 0;
  for (const c of cases) {
    const mine = results.filter((r) => r.c === c);
    const passes = mine.filter((r) => sampleHit(c.expect, r.invoked)).length;
    const rate = passes / mine.length;
    const ok = rate >= THRESHOLD;
    if (!ok) failed++;
    const label = c.expect ?? "(no skill)";
    console.log(
      `${ok ? "PASS" : "FAIL"} ${(rate * 100).toFixed(0).padStart(3)}%  ${label.padEnd(20)} ${c.prompt}`,
    );
  }

  console.log(
    `\n${cases.length - failed}/${cases.length} cases at or above ${THRESHOLD * 100}%.`,
  );
  process.exit(failed > 0 ? 1 : 0);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
  });
}
