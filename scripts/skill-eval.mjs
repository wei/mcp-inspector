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
// The cost of that split, stated plainly: neither `verify:skills` nor the
// authoritative `claude plugin validate` CI step can detect a well-formed skill
// whose description simply never matches anything. Both check structure.
// Closing that would need a deterministic trigger oracle, which does not exist.
//
// Usage:
//   npm run skills:eval                  # every model-invoked skill's cases
//   npm run skills:eval -- testing       # one skill's cases
//   RUNS=5 THRESHOLD=0.8 npm run skills:eval

import { spawn } from "node:child_process";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { claudeSpawnArgs, probeClaudeVersion } from "./lib/claude-cli.mjs";
import {
  parseClaudeVersion,
  parseSkill,
  validateEvalCases,
} from "./lib/skill-manifest.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKILLS_DIR = path.join(ROOT, ".claude", "skills");

const THRESHOLD = Number(process.env.THRESHOLD ?? 0.8);
const RUNS = Number(process.env.RUNS ?? 3);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 4);

/** Collect the committed cases for every model-invoked skill (optionally one). */
/**
 * Collect the committed cases, and the set of skill names that are OURS.
 *
 * `only` narrows which cases run, but it must NOT narrow `ours`: a negative
 * case means "no skill of this repo fired", so excluding the repo's other
 * model-invoked skills from that set would let `skills:eval -- testing` score a
 * `local-dev` invocation as foreign and pass a negative case it should fail
 * (Copilot). Every model-invoked skill is inspected; `only` is applied when
 * enqueueing.
 *
 * @param {string | undefined} only
 * @param {string} [skillsDir]
 * @returns {{ cases: object[], ours: Set<string> }}
 */
export function collectCases(only, skillsDir = SKILLS_DIR) {
  const cases = [];
  const ours = new Set();
  for (const dir of readdirSync(skillsDir).sort()) {
    const skillFile = path.join(skillsDir, dir, "SKILL.md");
    if (
      !statSync(path.join(skillsDir, dir)).isDirectory() ||
      !existsSync(skillFile)
    )
      continue;
    const skill = parseSkill(dir, readFileSync(skillFile, "utf8"));
    // Skipping a BROKEN skill here would let `skills:eval` run the remaining
    // cases and exit 0 while omitting the very skill that was just broken —
    // reporting a green measurement of a set that quietly shrank (Copilot).
    // Only a well-formed, deliberately name-only skill is skipped.
    if (skill.errors.length > 0) {
      throw new Error(
        `${dir}/SKILL.md does not parse (${skill.errors[0]}). Run \`npm run verify:skills\`.`,
      );
    }
    if (!skill.modelInvoked) continue;
    ours.add(dir);

    const evalsFile = path.join(skillsDir, dir, "evals", "evals.json");
    if (!existsSync(evalsFile)) {
      throw new Error(
        `${dir} is model-invoked but has no evals/evals.json. Run \`npm run verify:skills\`.`,
      );
    }
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(evalsFile, "utf8"));
    } catch (e) {
      throw new Error(
        `${dir}/evals/evals.json is not valid JSON — ${e.message}`,
      );
    }
    const invalid = validateEvalCases(dir, parsed);
    if (invalid.length > 0) {
      throw new Error(`${dir}/evals/evals.json: ${invalid.join("; ")}`);
    }
    if (only && dir !== only) continue;
    for (const c of parsed) cases.push({ ...c, from: dir });
  }
  return { cases, ours };
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
 * @returns {{ invoked: Set<string>, rest: string, result: string | null }}
 */
export function collectSkillInvocations(text) {
  const lines = text.split("\n");
  const rest = lines.pop() ?? "";
  const invoked = new Set();
  let result = null;
  for (const line of lines) {
    if (!line.trim()) continue;
    let evt;
    try {
      evt = JSON.parse(line);
    } catch {
      // A malformed line is noise from the CLI, not an observation.
      continue;
    }
    if (evt?.type === "result") result = evt.subtype ?? null;
    if (evt?.type !== "assistant") continue;
    for (const block of evt.message?.content ?? []) {
      if (block?.type !== "tool_use" || block.name !== "Skill") continue;
      // Don't assume the input field's name — match on the whole payload.
      invoked.add(JSON.stringify(block.input ?? {}));
    }
  }
  return { invoked, rest, result };
}

/**
 * Terminal `result` subtypes that mean the session ran to a real conclusion.
 *
 * `error_max_turns` is a SUCCESSFUL observation here, not a failure: with
 * `--max-turns 1`, a run in which the model invokes a skill necessarily hits
 * the limit and the CLI exits 1 — so treating a nonzero exit as failure would
 * reject exactly the runs the eval is trying to count. Verified against the
 * CLI: a firing prompt ends `{subtype: "error_max_turns", num_turns: 2}`.
 */
const CONCLUSIVE_RESULTS = new Set(["success", "error_max_turns"]);

/**
 * Whether a finished run produced a usable observation.
 *
 * The failure that matters is the opposite one: an auth error, a rate limit or
 * a missing CLI observes NOTHING, and counting that as "no skill invoked"
 * passes every negative case and reads as a trigger miss on every positive one,
 * so a run that never happened comes back as a plausible hit rate (Copilot).
 * Classifying on the terminal event rather than the exit code separates the two.
 *
 * @param {{ result: string | null, code: number | null }} outcome
 * @returns {string | null} A reason to reject, or null if the run is usable.
 */
export function runRejection({ result, code }) {
  if (result === null) {
    return `produced no terminal \`result\` event (exit ${code})`;
  }
  if (!CONCLUSIVE_RESULTS.has(result)) {
    return `ended \`${result}\` (exit ${code})`;
  }
  return null;
}

/**
 * The skill names a `Skill` tool_use payload actually asked for.
 *
 * Structural rather than substring: matching `"testing"` against the raw JSON
 * counts `{"skill":"not-testing"}` as a hit and inflates the measured rate
 * (Copilot). The field name is still not assumed — every string value in the
 * payload is a candidate, compared by equality.
 *
 * @param {string} payload JSON text as recorded by `collectSkillInvocations`.
 * @returns {string[]}
 */
export function invokedSkillNames(payload) {
  let parsed;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return [];
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    return [];
  return Object.values(parsed).filter((v) => typeof v === "string");
}

/**
 * Whether one sample satisfies a case.
 *
 * A negative case asserts that no skill **of this repo's** fired. Asserting
 * that nothing fired at all would fail for a contributor who happens to have an
 * unrelated skill in `~/.claude/skills`, or when a bundled skill matches — a
 * false failure about someone else's environment rather than about these
 * skills (Copilot).
 *
 * @param {string | null} expect Skill name, or null for a negative case.
 * @param {Set<string>} invoked
 * @param {Set<string> | null} [ours] Repo skill names. Null counts any skill.
 */
export function sampleHit(expect, invoked, ours = null) {
  const names = [...invoked].flatMap(invokedSkillNames);
  if (expect === null) {
    return ours === null ? names.length === 0 : !names.some((n) => ours.has(n));
  }
  return names.includes(expect);
}

/**
 * Drive one fresh session and return the payloads the `Skill` tool was called
 * with.
 *
 * `spawnFn` is injectable so the stream handling and — more importantly — the
 * exit handling are testable. Without a seam here, changing the nonzero branch
 * back to resolving an empty set would leave every test green while the eval
 * silently reported a plausible hit rate for runs that never happened (Copilot).
 *
 * @param {string} prompt
 * @param {{ spawnFn?: typeof spawn, cwd?: string }} [opts]
 * @returns {Promise<Set<string>>}
 */
export function runPrompt(
  prompt,
  { spawnFn = spawn, cwd = ROOT, platform = process.platform } = {},
) {
  return new Promise((resolve, reject) => {
    // The prompt goes in on STDIN, not in argv. `claude -p` with piped stdin
    // reads the prompt from it (verified), and that removes two problems at
    // once: on Windows the CLI is a `.cmd` shim, so it can only be started
    // through a shell, and `cmd.exe` would re-parse any prompt containing a
    // metacharacter as syntax (Copilot). It also keeps the prompt out of the
    // process table.
    const { command, args, options } = claudeSpawnArgs(
      [
        "-p",
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
      { cwd, stdio: ["pipe", "pipe", "inherit"] },
      platform,
    );
    const p = spawnFn(command, args, options);

    let buf = "";
    const invoked = new Set();
    let result = null;
    p.stdout.on("data", (chunk) => {
      const parsed = collectSkillInvocations(buf + chunk.toString());
      buf = parsed.rest;
      for (const payload of parsed.invoked) invoked.add(payload);
      if (parsed.result !== null) result = parsed.result;
    });
    p.on("error", reject);
    p.on("close", (code) => {
      const rejection = runRejection({ result, code });
      if (rejection !== null) {
        reject(new Error(`\`claude -p\` ${rejection} for prompt: ${prompt}`));
        return;
      }
      resolve(invoked);
    });
    p.stdin?.end(prompt);
  });
}

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
  if (probeClaudeVersion(parseClaudeVersion) === null) {
    console.error(
      "skills:eval — no usable `claude` CLI on PATH. This eval needs one.",
    );
    process.exit(1);
  }

  const { cases, ours } = collectCases(process.argv[2]);
  if (cases.length === 0) {
    console.error("skills:eval — no cases found.");
    process.exit(1);
  }

  const jobs = cases.flatMap((c) => Array.from({ length: RUNS }, () => c));
  const results = await pool(jobs, CONCURRENCY, async (c) => ({
    c,
    invoked: await runPrompt(c.prompt),
  }));

  let failed = 0;
  for (const c of cases) {
    const mine = results.filter((r) => r.c === c);
    const passes = mine.filter((r) =>
      sampleHit(c.expect, r.invoked, ours),
    ).length;
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
