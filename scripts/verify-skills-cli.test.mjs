// Tests for the authoritative-validator step's CLI resolution (#2163, Copilot).
//
// The point of the step is that it does NOT skip: `verify:skills` treats a
// missing CLI as a skip, and "skips when absent" plus "usually absent" adds up
// to "never runs", which is what made the acceptance criterion aspirational.
// So the branch that matters is the one that falls back to a pinned `npx`
// rather than giving up — and on a machine with a current CLI installed, that
// branch is never taken by an actual run.

import { test } from "node:test";
import assert from "node:assert/strict";
import { validatorCommand } from "./verify-skills-cli.mjs";
import {
  PINNED_CLI_VERSION,
  PLUGIN_VALIDATE_MIN_VERSION,
} from "./lib/skill-manifest.mjs";

test("uses an installed CLI that has the subcommand", () => {
  const cmd = validatorCommand({ version: [2, 1, 250] });
  assert.equal(cmd.command, "claude");
  assert.deepEqual(cmd.args, ["plugin", "validate", ".claude/skills"]);
  assert.match(cmd.via, /local claude 2\.1\.250/);
});

test("uses the installed CLI exactly at the floor", () => {
  assert.equal(
    validatorCommand({ version: PLUGIN_VALIDATE_MIN_VERSION }).command,
    "claude",
  );
});

test("falls back to a pinned npx when no CLI is present", () => {
  const cmd = validatorCommand({ version: null });
  assert.equal(cmd.command, "npx");
  assert.deepEqual(cmd.args, [
    "-y",
    `@anthropic-ai/claude-code@${PINNED_CLI_VERSION}`,
    "plugin",
    "validate",
    ".claude/skills",
  ]);
  assert.match(cmd.via, /no local CLI/);
});

test("falls back when the installed CLI predates the subcommand", () => {
  // An older binary answers `--version` fine and then exits nonzero on
  // `plugin validate` as an unknown command, so running it would fail the gate
  // for someone whose only sin is not having upgraded.
  const cmd = validatorCommand({ version: [2, 1, 232] });
  assert.equal(cmd.command, "npx");
  assert.match(cmd.via, /predates the subcommand/);
});
