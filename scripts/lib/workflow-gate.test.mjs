/**
 * The local-gate-out-of-CI guard (#2146), in two halves.
 *
 * The table-driven half pins one case per rule the parser encodes — including
 * the negative cases, which are the ones that matter most here: a guard that
 * also rejected `npm run smoke` or `smoke:web:chromium` would be "fixed" by
 * deleting it, taking the real protection with it.
 *
 * The second half runs the parser over the repository's ACTUAL workflow files.
 * That is the assertion the issue asks for: it fails the moment a workflow
 * invokes the pre-push gate, a non-Chromium engine pass, or `smoke:web:engine`,
 * or points `SMOKE_BROWSER` at something else.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  FORBIDDEN_ENGINE_SCRIPTS,
  VIOLATION,
  extractExecutableRegions,
  findWorkflowViolations,
  formatWorkflowViolations,
} from "./workflow-gate.mjs";

const repoRoot = join(import.meta.dirname, "..", "..");
const workflowDir = join(repoRoot, ".github", "workflows");

/**
 * A minimal but SCHEMA-VALID workflow around some step YAML.
 *
 * The fixtures have to be real workflows now that the walk is structural
 * rather than key-name based: a bare `- run: …` fragment sits in no job and no
 * step, so it is correctly invisible, and a table built out of fragments would
 * pass while asserting nothing.
 */
const workflow = (steps) =>
  [
    "on: push",
    "jobs:",
    "  build:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    steps,
  ].join("\n");

describe("findWorkflowViolations", () => {
  const cases = [
    {
      name: "flags the pre-push gate itself",
      text: workflow("      - run: npm run local:gate"),
      rules: [VIOLATION.LOCAL_SCRIPT],
    },
    {
      name: "flags any other local: script, without being edited for it",
      text: workflow("      - run: npm run local:storybook"),
      rules: [VIOLATION.LOCAL_SCRIPT],
    },
    {
      name: "flags the Firefox engine pass",
      text: workflow("      - run: npm run smoke:web:firefox"),
      rules: [VIOLATION.ENGINE_SCRIPT],
    },
    {
      name: "flags the WebKit engine pass",
      text: workflow("      - run: npm run smoke:web:webkit"),
      rules: [VIOLATION.ENGINE_SCRIPT],
    },
    {
      name: "flags the env-driven runner, whose engine cannot be read statically",
      text: workflow("      - run: npm run smoke:web:engine"),
      rules: [VIOLATION.ENGINE_SCRIPT],
    },
    {
      // Copilot, first review: the matrix form is exactly how a forbidden
      // engine reaches CI without anyone typing its name.
      name: "flags an engine pass whose name is built from an expression",
      text: workflow("      - run: npm run smoke:web:${{ matrix.browser }}"),
      rules: [VIOLATION.ENGINE_SCRIPT],
    },
    {
      name: "flags a local: script whose name is built from an expression",
      text: workflow("      - run: npm run local:${{ matrix.task }}"),
      rules: [VIOLATION.LOCAL_SCRIPT],
    },
    {
      // Copilot, second review: an expression body can itself contain braces,
      // so a brace-balanced regex stops at the first `}` and misses the one
      // case worth catching. The rule keys off the `${{` prefix instead.
      name: "flags an expression whose own body contains braces",
      text: workflow(
        "      - run: npm run smoke:web:${{ format('{0}', matrix.browser) }}",
      ),
      rules: [VIOLATION.ENGINE_SCRIPT],
    },
    {
      name: "flags a command inside a block scalar",
      text: workflow("      - run: |\n          npm run local:gate"),
      rules: [VIOLATION.LOCAL_SCRIPT],
    },
    {
      // Copilot, third review: a hand-rolled opener could not see either of
      // these, and each is a forbidden invocation that would have passed.
      name: "flags a block scalar opened with a trailing comment",
      text: workflow(
        "      - run: | # why this step exists\n          npm run local:gate",
      ),
      rules: [VIOLATION.LOCAL_SCRIPT],
    },
    {
      // Copilot, fourth review: an alias carries no `.value`, so reading one as
      // a scalar sees an empty string — with the command anchored somewhere the
      // walk never visits, this invoked the gate while the guard saw nothing.
      name: "flags a command reached through a YAML alias",
      text: workflow(
        [
          "      - name: &cmd npm run local:gate",
          "        run: echo documenting the gate",
          "      - run: *cmd",
        ].join("\n"),
      ),
      rules: [VIOLATION.LOCAL_SCRIPT],
    },
    {
      name: "flags a command passed as an action input",
      text: workflow("      - with:\n          args: npm run local:gate"),
      rules: [VIOLATION.LOCAL_SCRIPT],
    },
    {
      name: "flags SMOKE_BROWSER pointed at another engine",
      text: workflow(
        "      - env:\n          SMOKE_BROWSER: firefox\n        run: npm run smoke",
      ),
      rules: [VIOLATION.BROWSER_ENV],
    },
    {
      name: "flags a quoted SMOKE_BROWSER value",
      text: workflow(
        '      - env:\n          SMOKE_BROWSER: "webkit"\n        run: npm run smoke',
      ),
      rules: [VIOLATION.BROWSER_ENV],
    },
    {
      name: "flags a shell-assigned SMOKE_BROWSER",
      text: workflow("      - run: SMOKE_BROWSER=firefox npm run smoke"),
      rules: [VIOLATION.BROWSER_ENV],
    },
    {
      name: "flags an expression, which cannot be checked statically",
      text: workflow(
        "      - env:\n          SMOKE_BROWSER: ${{ matrix.browser }}\n        run: npm run smoke",
      ),
      rules: [VIOLATION.BROWSER_ENV],
    },
    {
      // Copilot, third review: the flow spelling of the same mapping.
      name: "flags an env override written as a flow mapping",
      text: workflow(
        "      - env: { SMOKE_BROWSER: firefox }\n        run: npm run smoke",
      ),
      rules: [VIOLATION.BROWSER_ENV],
    },
    {
      // Present-but-empty is not unset: `resolveBrowserName` rejects it rather
      // than falling back to chromium, so a workflow must not write it either.
      name: "flags SMOKE_BROWSER set to nothing at all",
      text: workflow(
        "      - env:\n          SMOKE_BROWSER:\n        run: npm run smoke",
      ),
      rules: [VIOLATION.BROWSER_ENV],
    },
    {
      name: "flags an empty shell assignment too",
      text: workflow("      - run: SMOKE_BROWSER= npm run smoke"),
      rules: [VIOLATION.BROWSER_ENV],
    },
    {
      name: "flags a workflow-level env override",
      text: [
        "on: push",
        "env:",
        "  SMOKE_BROWSER: firefox",
        "jobs:",
        "  build:",
        "    steps:",
        "      - run: npm run smoke",
      ].join("\n"),
      rules: [VIOLATION.BROWSER_ENV],
    },
    {
      name: "allows SMOKE_BROWSER set explicitly to chromium",
      text: workflow(
        "      - env:\n          SMOKE_BROWSER: chromium\n        run: npm run smoke",
      ),
      rules: [],
    },
    {
      name: "allows the smoke suite, which belongs in CI",
      text: workflow("      - run: npm run smoke"),
      rules: [],
    },
    {
      name: "allows the Chromium engine pass, which belongs in CI",
      text: workflow("      - run: npm run smoke:web:chromium"),
      rules: [],
    },
    {
      // #2148's tab smoke pins Chromium on both halves of its npm script and is
      // deliberately outside ENGINE_SMOKES — it is not an engine pass, and the
      // guard must not read `smoke:web:` as forbidden by itself.
      name: "allows the Chromium-only tab smoke",
      text: workflow("      - run: npm run smoke:web:tabs"),
      rules: [],
    },
    {
      name: "allows smoke:tui, which self-skips under CI on its own",
      text: workflow("      - run: npm run smoke:tui"),
      rules: [],
    },
    {
      name: "allows the rest of the CI chain",
      text: workflow(
        [
          "      - run: npm run validate",
          "      - run: npm run coverage",
          "      - run: npm run verify:build-gate",
          "      - run: npm run verify:bundle-externals",
          "      - run: npm run test:storybook",
        ].join("\n"),
      ),
      rules: [],
    },
    {
      // Copilot, second review: metadata executes nothing, so a finding there
      // is simply false — and the fastest way to get a guard deleted.
      name: "does not read a step name as an invocation",
      text: workflow(
        "      - name: Explain why smoke:web:firefox stays local\n        run: npm run smoke",
      ),
      rules: [],
    },
    {
      name: "does not read an `if:` condition as one either",
      text: workflow(
        "      - if: github.event_name == 'push'\n        run: npm run smoke",
      ),
      rules: [],
    },
    {
      // Copilot, fourth review: workflow input ids are user-defined, so an
      // input legitimately named `env` would have its own docs scanned by a
      // key-name match — failing the gate on documentation of the gate.
      name: "does not scan a workflow input that happens to be named env",
      text: [
        "on:",
        "  workflow_dispatch:",
        "    inputs:",
        "      env:",
        "        description: why smoke:web:firefox stays local",
        "        default: npm run local:gate",
        "jobs:",
        "  build:",
        "    steps:",
        "      - run: npm run smoke",
      ].join("\n"),
      rules: [],
    },
    {
      name: "does not read a similarly-named key as the override",
      text: workflow(
        "      - env:\n          SMOKE_BROWSER_DOC: firefox\n        run: npm run smoke",
      ),
      rules: [],
    },
    {
      name: "does not read a YAML comment as an invocation",
      text: workflow(
        "      # smoke:web:firefox runs in npm run local:gate, never here\n      - run: npm run smoke",
      ),
      rules: [],
    },
    {
      // Copilot, third review: this fixture used to be a YAML comment, which
      // the parser strips — so it asserted nothing. Inside a `run:` block the
      // comment text really does survive into the scalar, which is where the
      // "a comment invokes nothing" rule has to be applied.
      name: "does not read a shell comment inside a run block as one either",
      text: workflow(
        "      - run: |\n          # SMOKE_BROWSER=webkit is local-only\n          npm run smoke",
      ),
      rules: [],
    },
  ];

  for (const { name, text, rules } of cases) {
    it(name, () => {
      const found = findWorkflowViolations(text, "case.yml");
      assert.deepEqual(
        found.map((f) => f.rule),
        rules,
        formatWorkflowViolations(found),
      );
    });
  }

  it("reports the line a finding came from", () => {
    const [finding] = findWorkflowViolations(
      workflow("      - run: npm run local:gate"),
      "main.yml",
    );
    assert.equal(finding.line, 6);
    assert.equal(finding.file, "main.yml");
    assert.equal(finding.match, "local:gate");
  });

  it("names the file in a parse error, rather than a placeholder", () => {
    // The filename is passed in for diagnostics; forgetting to forward it left
    // a malformed real workflow reported as `<workflow>` (Copilot).
    assert.throws(
      () => findWorkflowViolations("jobs:\n  - a\n  b: c\n", "main.yml"),
      /could not parse main\.yml/,
    );
  });

  it("derives the forbidden engines rather than listing them by hand", () => {
    // Adding a fourth engine to SUPPORTED_BROWSERS must extend the guard, not
    // open a hole in it — which is why this reads the derived constant.
    assert.deepEqual(FORBIDDEN_ENGINE_SCRIPTS, [
      "smoke:web:firefox",
      "smoke:web:webkit",
      "smoke:web:engine",
    ]);
  });
});

describe("extractExecutableRegions", () => {
  it("descends the executable paths and skips the metadata beside them", () => {
    const regions = extractExecutableRegions(
      [
        "on: push",
        "jobs:",
        "  build:",
        "    steps:",
        "      - name: smoke:web:firefox is local-only",
        "        env:",
        "          SMOKE_BROWSER: chromium",
        "        run: npm run smoke",
      ].join("\n"),
    );
    // The step `name:` is absent, and the two executable values are not.
    // Order follows the walk (a step's `run` before its `env`), not the file.
    assert.deepEqual(
      regions.map((r) => [r.kind, r.text.trim()]),
      [
        ["run", "npm run smoke"],
        ["env", "SMOKE_BROWSER: chromium"],
      ],
    );
  });

  it("throws on a workflow it cannot parse, rather than finding nothing", () => {
    // A file that does not parse must not read as a file with nothing in it —
    // that is the one failure mode where an unreadable workflow passes.
    assert.throws(
      () => extractExecutableRegions("jobs:\n  - a\n  b: c\n", "broken.yml"),
      /could not parse broken\.yml/,
    );
  });
});

describe(".github/workflows", () => {
  const files = readdirSync(workflowDir).filter((f) => /\.ya?ml$/.test(f));

  it("has workflow files to check", () => {
    // Deny-by-default: an empty glob would otherwise make the check below pass
    // vacuously after a rename or a move of the workflow directory.
    assert.ok(
      files.length > 0,
      `no workflow files found in ${workflowDir} — the guard below would pass vacuously`,
    );
  });

  it("never invokes the local pre-push gate or a non-Chromium engine pass", () => {
    const findings = files.flatMap((file) =>
      findWorkflowViolations(
        readFileSync(join(workflowDir, file), "utf8"),
        file,
      ),
    );
    assert.deepEqual(
      findings,
      [],
      "GitHub CI must not run the local-only gate or a non-Chromium engine " +
        `pass (#2146):\n${formatWorkflowViolations(findings)}`,
    );
  });
});
