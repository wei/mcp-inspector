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
  MIN_POSITIVE_CASES,
  validateEvalCases,
  listingCost,
  parseClaudeVersion,
  compareVersions,
  PINNED_CLI_VERSION,
  isPinnedVersion,
  formatClaudeVersion,
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
  const positives = (n, expect = "testing") =>
    Array.from({ length: n }, (_, i) => ({ prompt: `p${i}`, expect }));

  assert.deepEqual(
    validateEvalCases("testing", [
      ...positives(MIN_POSITIVE_CASES),
      { prompt: "b", expect: null },
    ]),
    [],
  );
  assert.match(
    validateEvalCases("testing", positives(MIN_POSITIVE_CASES)).join(),
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
  assert.deepEqual(parseClaudeVersion("2.1.250 (Claude Code)"), {
    parts: [2, 1, 250],
    prerelease: null,
  });
  assert.deepEqual(parseClaudeVersion("claude 10.0.4\n"), {
    parts: [10, 0, 4],
    prerelease: null,
  });
  assert.equal(parseClaudeVersion("no version here"), null);
});

test("parseClaudeVersion keeps a prerelease suffix rather than dropping it", () => {
  // Dropping it made `2.1.250-beta.1` compare EQUAL to the stable pin — a
  // different validator schema running while the log claimed an exact match.
  assert.deepEqual(parseClaudeVersion("2.1.250-beta.1 (Claude Code)"), {
    parts: [2, 1, 250],
    prerelease: "beta.1",
  });
  assert.equal(
    formatClaudeVersion(parseClaudeVersion("2.1.250-beta.1")),
    "2.1.250-beta.1",
  );
  assert.equal(formatClaudeVersion(null), "(unreadable version)");
});

test("isPinnedVersion accepts only the exact stable pin", () => {
  const pin = PINNED_CLI_VERSION;
  assert.equal(isPinnedVersion(parseClaudeVersion(pin), pin), true);
  // Build metadata is ignored for precedence by SemVer, so it still matches.
  assert.equal(
    isPinnedVersion(parseClaudeVersion(`${pin}+build.7`), pin),
    true,
  );
  // A prerelease of the same triple is NOT the pin.
  assert.equal(
    isPinnedVersion(parseClaudeVersion(`${pin}-beta.1`), pin),
    false,
  );
  assert.equal(isPinnedVersion(parseClaudeVersion("2.1.249"), pin), false);
  assert.equal(isPinnedVersion(parseClaudeVersion("99.0.0"), pin), false);
  assert.equal(isPinnedVersion(null, pin), false);
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
      ...Array.from({ length: MIN_POSITIVE_CASES }, (_, i) => ({
        prompt: `p${i}`,
        expect: "testing",
      })),
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
      ...Array.from({ length: MIN_POSITIVE_CASES }, (_, i) => ({
        prompt: `p${i}`,
        expect: "testing",
      })),
      { prompt: "b", expect: null },
    ]),
    [],
  );
});

test("an unquoted `#` truncates a description, and that is an error", () => {
  // The dangerous part is that YAML leaves a *non-empty* string behind, so the
  // "description is required and non-empty" check passes and the skill keeps
  // auto-firing — just with its most distinctive words missing from the
  // listing. `board-ops` shipped this way, losing both board numbers.
  const withHash = [
    "---",
    "name: board-ops",
    "description: Recipes. Covers board #28 (v2) and board #11 (v1).",
    "disable-model-invocation: false",
    "---",
    "body",
  ].join("\n");
  const parsed = parseSkill("board-ops", withHash);
  assert.equal(parsed.description, "Recipes. Covers board");
  assert.match(parsed.errors.join(" "), /truncated by an unquoted `#`/);

  // Quoting is the fix, and it must come back clean.
  const quoted = withHash.replace(
    /^description: (.*)$/m,
    (_m, d) => `description: "${d}"`,
  );
  const ok = parseSkill("board-ops", quoted);
  assert.deepEqual(ok.errors, []);
  assert.equal(
    ok.description,
    "Recipes. Covers board #28 (v2) and board #11 (v1).",
  );
});

test("a `#` inside a quoted description is not treated as truncation", () => {
  // Guard against the check firing on every legitimately quoted description.
  const quoted = [
    "---",
    "name: alpha",
    'description: "counts # and : safely"',
    "disable-model-invocation: false",
    "---",
    "body",
  ].join("\n");
  assert.deepEqual(parseSkill("alpha", quoted).errors, []);
});

test("a model-invoked skill needs at least MIN_POSITIVE_CASES positives", () => {
  // `positives === 0` alone let a skill regress to a single prompt and still
  // pass the gate. At RUNS=5 one case is 20 points of that skill's reading, so
  // a one- or two-case skill reports a rate a single flake can move across the
  // threshold — well-formed to the checker, meaningless as a measurement.
  const withPositives = (n) => [
    ...Array.from({ length: n }, (_, i) => ({
      prompt: `p${i}`,
      expect: "alpha",
    })),
    { prompt: "n", expect: null },
  ];

  assert.match(
    validateEvalCases("alpha", withPositives(1)).join(" "),
    /only 1 positive case\(s\)/,
  );
  assert.match(
    validateEvalCases("alpha", withPositives(MIN_POSITIVE_CASES - 1)).join(" "),
    /needs at least 5/,
  );
  assert.deepEqual(
    validateEvalCases("alpha", withPositives(MIN_POSITIVE_CASES)),
    [],
  );

  // Zero still reports the clearer "no positive case" message rather than the
  // count one, so the common mistake keeps its specific diagnosis.
  assert.match(
    validateEvalCases("alpha", [{ prompt: "n", expect: null }]).join(" "),
    /no positive case expects/,
  );
});

test("the truncation guard covers `when_to_use`, not just `description`", () => {
  // The guard loops over both fields, so a regression that dropped `when_to_use`
  // from that list would be invisible to the description-only tests above.
  const withHash = [
    "---",
    "name: alpha",
    'description: "safe because quoted"',
    "when_to_use: Use when filing against board #28 or board #11.",
    "disable-model-invocation: false",
    "---",
    "body",
  ].join("\n");
  const parsed = parseSkill("alpha", withHash);
  assert.equal(parsed.whenToUse, "Use when filing against board");
  assert.match(parsed.errors.join(" "), /`when_to_use` is truncated/);
  // The description is quoted, so it must not be implicated.
  assert.doesNotMatch(parsed.errors.join(" "), /`description` is truncated/);

  const quoted = withHash.replace(
    /^when_to_use: (.*)$/m,
    (_m, w) => `when_to_use: "${w}"`,
  );
  const ok = parseSkill("alpha", quoted);
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.whenToUse, "Use when filing against board #28 or board #11.");
});
