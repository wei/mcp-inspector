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
