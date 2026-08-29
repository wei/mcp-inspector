// Table-driven tests for the `.claude/skills` frontmatter contract (#2163),
// one case per rule the parsers encode. The guard that reads them
// (`verify-skills.mjs`) walks the real skills directory, so a rule it enforces
// is only observable there when a skill happens to violate it — which, by
// construction, none does once the guard is green.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  splitFrontmatter,
  parseSkill,
  validateEvalCases,
  listingCost,
  parseClaudeVersion,
  compareVersions,
  PINNED_CLI_VERSION,
} from "./skill-manifest.mjs";

const fm = (body) => `---\n${body}\n---\n\n# Body\n`;

test("splitFrontmatter requires the fence on the very first line", () => {
  // This is the whole failure class: anything before the fence and Claude Code
  // treats the WHOLE file, `---` markers included, as body content.
  for (const text of [
    "\n---\nname: x\n---\n",
    "﻿---\nname: x\n---\n",
    "# Title\n---\nname: x\n---\n",
  ]) {
    assert.match(splitFrontmatter(text).error ?? "", /first line/);
  }
  assert.equal(splitFrontmatter(fm("name: x")).error, undefined);
});

test("splitFrontmatter requires the closing fence to be a whole line", () => {
  // `---oops` is not a terminator. Accepting it would silently truncate the
  // frontmatter to whatever preceded it and report the file as valid.
  assert.match(
    splitFrontmatter("---\nname: x\n---oops\nbody\n").error ?? "",
    /never closed/,
  );
  // Trailing whitespace on the fence is still a fence, and so is EOF.
  assert.equal(
    splitFrontmatter("---\nname: x\n---  \nbody\n").frontmatter,
    "name: x",
  );
  assert.equal(splitFrontmatter("---\nname: x\n---").frontmatter, "name: x");
  assert.equal(
    splitFrontmatter("---\nname: x\n---\r\nbody").frontmatter,
    "name: x",
  );
});

test("splitFrontmatter reports an unterminated block", () => {
  assert.match(splitFrontmatter("---\nname: x\n").error ?? "", /never closed/);
});

test("parseSkill accepts a well-formed skill", () => {
  const r = parseSkill(
    "local-dev",
    fm(
      "name: local-dev\ndescription: Does a thing.\ndisable-model-invocation: false",
    ),
  );
  assert.deepEqual(r.errors, []);
  assert.equal(r.modelInvoked, true);
  assert.equal(r.userInvocable, true);
});

test("parseSkill rejects frontmatter that is not valid YAML", () => {
  // An unquoted colon in a description is enough, and this is exactly what
  // silently strips the description Claude matches against.
  const r = parseSkill(
    "x",
    fm(
      "name: x\ndescription: Use this: always\ndisable-model-invocation: true",
    ),
  );
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /not valid YAML/);
});

test("parseSkill requires name to match the directory, kebab-case", () => {
  assert.match(
    parseSkill(
      "board-ops",
      fm("name: boardOps\ndescription: d\ndisable-model-invocation: true"),
    ).errors.join(),
    /does not match its directory/,
  );
  assert.match(
    parseSkill(
      "Board_Ops",
      fm("name: Board_Ops\ndescription: d\ndisable-model-invocation: true"),
    ).errors.join(),
    /kebab-case/,
  );
});

test("parseSkill requires a non-empty description", () => {
  for (const d of ["", "   "]) {
    assert.match(
      parseSkill(
        "x",
        fm(`name: x\ndescription: "${d}"\ndisable-model-invocation: true`),
      ).errors.join(),
      /description. is required/,
    );
  }
});

test("parseSkill caps the description at the listing-entry limit", () => {
  const long = "a".repeat(1537);
  assert.match(
    parseSkill(
      "x",
      fm(`name: x\ndescription: ${long}\ndisable-model-invocation: true`),
    ).errors.join(),
    /caps a listing entry/,
  );
});

test("parseSkill requires the invocation mode to be declared", () => {
  assert.match(
    parseSkill("x", fm("name: x\ndescription: d")).errors.join(),
    /must be declared explicitly/,
  );
  assert.match(
    parseSkill(
      "x",
      fm("name: x\ndescription: d\ndisable-model-invocation: yes-please"),
    ).errors.join(),
    /must be a boolean/,
  );
});

test("parseSkill rejects a skill nothing can reach", () => {
  const r = parseSkill(
    "x",
    fm(
      "name: x\ndescription: d\ndisable-model-invocation: true\nuser-invocable: false",
    ),
  );
  assert.match(r.errors.join(), /unreachable/);
});

test("parseSkill validates the paths list", () => {
  assert.match(
    parseSkill(
      "x",
      fm(
        "name: x\ndescription: d\ndisable-model-invocation: false\npaths: '**/*.ts'",
      ),
    ).errors.join(),
    /list of glob strings/,
  );
  assert.deepEqual(
    parseSkill(
      "x",
      fm(
        "name: x\ndescription: d\ndisable-model-invocation: false\npaths:\n  - '**/*.ts'",
      ),
    ).paths,
    ["**/*.ts"],
  );
});

test("listingCost counts only the skills that occupy the listing", () => {
  const skills = [
    { name: "aa", description: "bbb", modelInvoked: true },
    { name: "cccc", description: "ddddd", modelInvoked: false },
  ];
  assert.equal(listingCost(skills), 5);
});

test("validateEvalCases requires a positive and a negative", () => {
  assert.deepEqual(
    validateEvalCases("testing", [
      { prompt: "a", expect: "testing" },
      { prompt: "b", expect: null },
    ]),
    [],
  );
  assert.match(
    validateEvalCases("testing", [{ prompt: "a", expect: "testing" }]).join(),
    /no negative case/,
  );
  assert.match(
    validateEvalCases("testing", [{ prompt: "a", expect: null }]).join(),
    /no positive case/,
  );
});

test("validateEvalCases rejects malformed cases", () => {
  assert.match(validateEvalCases("x", []).join(), /non-empty array/);
  assert.match(
    validateEvalCases("x", [{ expect: null }]).join(),
    /prompt.*non-empty string/,
  );
  assert.match(
    validateEvalCases("x", [{ prompt: "a", expect: 7 }]).join(),
    /expect. must be a skill name or null/,
  );
});

test("parseClaudeVersion reads the CLI's version banner", () => {
  assert.deepEqual(parseClaudeVersion("2.1.250 (Claude Code)"), [2, 1, 250]);
  assert.deepEqual(parseClaudeVersion("claude 10.0.4\n"), [10, 0, 4]);
  assert.equal(parseClaudeVersion("no version here"), null);
});

test("compareVersions can decide exact equality with the pin", () => {
  // Both validators require the EXACT pinned version, so what matters is that
  // "equal" is distinguishable from newer as well as older — a floor would let a
  // newer local CLI validate against a different schema than CI's.
  const pin = parseClaudeVersion(PINNED_CLI_VERSION);
  assert.equal(compareVersions(pin, pin), 0);
  assert.ok(compareVersions([pin[0], pin[1], pin[2] - 1], pin) < 0);
  assert.ok(compareVersions([pin[0], pin[1], pin[2] + 1], pin) > 0);
  assert.ok(compareVersions([pin[0] + 1, 0, 0], pin) > 0);
  // Shorter and longer triples still order sanely.
  assert.ok(compareVersions([pin[0]], pin) < 0);
  assert.equal(compareVersions([...pin, 0], pin), 0);
});

test("the listing-entry cap covers description AND when_to_use together", () => {
  // The cap is over the combined entry, so checking `description` alone would
  // pass an over-cap listing entry.
  const under = fm(
    `name: x\ndescription: ${"a".repeat(1000)}\nwhen_to_use: ${"b".repeat(536)}\ndisable-model-invocation: true`,
  );
  assert.deepEqual(parseSkill("x", under).errors, []);

  const over = fm(
    `name: x\ndescription: ${"a".repeat(1000)}\nwhen_to_use: ${"b".repeat(537)}\ndisable-model-invocation: true`,
  );
  assert.match(parseSkill("x", over).errors.join(), /caps a listing entry/);

  assert.match(
    parseSkill(
      "x",
      fm(
        "name: x\ndescription: d\nwhen_to_use: 7\ndisable-model-invocation: true",
      ),
    ).errors.join(),
    /when_to_use. must be a string/,
  );
});

test("listingCost counts when_to_use too", () => {
  assert.equal(
    listingCost([
      { name: "aa", description: "bbb", whenToUse: "cc", modelInvoked: true },
    ]),
    7,
  );
});

test("a CRLF manifest is valid — the fence is still the first line", () => {
  // A Windows checkout with `core.autocrlf` produces these. Rejecting one would
  // fail `npm run validate` on a manifest the authoritative validator accepts,
  // and would fail it *before* that validator ever ran.
  const crlf =
    "---\r\nname: x\r\ndescription: d\r\ndisable-model-invocation: true\r\n---\r\n\r\nBody\r\n";
  assert.equal(
    splitFrontmatter(crlf).frontmatter,
    "name: x\r\ndescription: d\r\ndisable-model-invocation: true",
  );
  assert.deepEqual(parseSkill("x", crlf).errors, []);

  // Mixed endings are still fine, and so is a CRLF file with no trailing body.
  assert.deepEqual(
    parseSkill(
      "x",
      "---\r\nname: x\ndescription: d\r\ndisable-model-invocation: true\n---\r\n",
    ).errors,
    [],
  );
  assert.deepEqual(
    parseSkill(
      "x",
      "---\r\nname: x\r\ndescription: d\r\ndisable-model-invocation: true\r\n---",
    ).errors,
    [],
  );
});

test("CRLF does not weaken the first-line rule", () => {
  // The point of the opening check is that anything before the fence turns the
  // whole file into body — accepting CRLF must not start accepting those.
  for (const text of [
    "\r\n---\r\nname: x\r\n---\r\n",
    "﻿---\r\nname: x\r\n---\r\n",
    "# Title\r\n---\r\nname: x\r\n---\r\n",
    "--- \r\nname: x\r\n---\r\n".replace("--- ", "---x"),
  ]) {
    assert.match(splitFrontmatter(text).error ?? "", /first line|never closed/);
  }
  // And `---oops` is still not a terminator with CRLF endings either.
  assert.match(
    splitFrontmatter("---\r\nname: x\r\n---oops\r\nbody\r\n").error ?? "",
    /never closed/,
  );
});

test("an eval file may only expect its own skill", () => {
  // A foreign name passes whenever that OTHER skill fires, so the file reports
  // a measurement of something it does not describe — and it satisfies the
  // positive-case requirement while doing it, hiding the absence of a real one.
  assert.match(
    validateEvalCases("testing", [
      { prompt: "a", expect: "local-dev" },
      { prompt: "b", expect: "testing" },
      { prompt: "c", expect: null },
    ]).join(),
    /expects `local-dev`, but this file only measures `testing`/,
  );
  // The masking case: a foreign positive is no longer enough on its own.
  const masked = validateEvalCases("testing", [
    { prompt: "a", expect: "local-dev" },
    { prompt: "b", expect: null },
  ]);
  assert.match(masked.join(), /only measures/);
  assert.match(masked.join(), /no positive case/);
  // Null and own-name cases are unaffected.
  assert.deepEqual(
    validateEvalCases("testing", [
      { prompt: "a", expect: "testing" },
      { prompt: "b", expect: null },
    ]),
    [],
  );
});
