#!/usr/bin/env node
// Runs `claude plugin validate` — the AUTHORITATIVE skill schema — as a
// guaranteed step, resolving the CLI rather than hoping it is installed (#2163).
//
// `verify:skills` (inside `validate`) reimplements the parse and treats a
// missing CLI as a skip, deliberately: `npm run validate` is the fast inner
// loop, it must work offline, and a Node contributor should not need Claude Code
// installed to run it. But "skips when absent" plus "usually absent" adds up to
// "never runs", which made the acceptance criterion aspirational (Copilot).
//
// So the authoritative check gets its own step, in `local:gate` and in CI, and
// it does NOT skip: an already-installed CLI new enough to have the subcommand
// is used as-is, and otherwise a PINNED one is fetched with `npx -y`. Pinned
// rather than @latest because a validator that moves on its own can start
// failing a PR that changed nothing, which is how a gate loses its credibility.
//
// It needs no authentication — verified against a scrubbed environment and a
// clean HOME.

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  compareVersions,
  parseClaudeVersion,
  PINNED_CLI_VERSION,
  PLUGIN_VALIDATE_MIN_VERSION,
} from "./lib/skill-manifest.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKILLS_DIR = ".claude/skills";

/**
 * The argv that runs a usable validator: the local CLI when it is new enough,
 * otherwise the pinned one through `npx`.
 *
 * @param {{ version: number[] | null }} local
 * @returns {{ command: string, args: string[], via: string }}
 */
export function validatorCommand({ version }) {
  if (
    version !== null &&
    compareVersions(version, PLUGIN_VALIDATE_MIN_VERSION) >= 0
  ) {
    return {
      command: "claude",
      args: ["plugin", "validate", SKILLS_DIR],
      via: `local claude ${version.join(".")}`,
    };
  }
  return {
    command: "npx",
    args: [
      "-y",
      `@anthropic-ai/claude-code@${PINNED_CLI_VERSION}`,
      "plugin",
      "validate",
      SKILLS_DIR,
    ],
    via:
      version === null
        ? `npx @anthropic-ai/claude-code@${PINNED_CLI_VERSION} (no local CLI)`
        : `npx @anthropic-ai/claude-code@${PINNED_CLI_VERSION} (local ${version.join(".")} predates the subcommand)`,
  };
}

function main() {
  const probe = spawnSync("claude", ["--version"], { encoding: "utf8" });
  const version =
    probe.error || probe.status !== 0
      ? null
      : parseClaudeVersion(probe.stdout ?? "");

  const { command, args, via } = validatorCommand({ version });
  console.log(`verify:skills:cli — validating ${SKILLS_DIR} via ${via}…`);

  const res = spawnSync(command, args, {
    cwd: ROOT,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (res.error) {
    console.error(
      `\nverify:skills:cli — could not run \`${command}\`: ${res.error.message}`,
    );
    process.exit(1);
  }
  if (res.status !== 0) {
    console.error(
      "\nverify:skills:cli — `claude plugin validate` rejected the skills.",
    );
    process.exit(1);
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
