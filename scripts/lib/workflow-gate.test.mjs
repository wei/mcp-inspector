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

describe("findWorkflowViolations", () => {
  const cases = [
    {
      name: "flags the pre-push gate itself",
      text: "      - run: npm run local:gate\n",
      rules: [VIOLATION.LOCAL_SCRIPT],
    },
    {
      name: "flags any other local: script, without being edited for it",
      text: "      - run: npm run local:storybook\n",
      rules: [VIOLATION.LOCAL_SCRIPT],
    },
    {
      name: "flags the Firefox engine pass",
      text: "      - run: npm run smoke:web:firefox\n",
      rules: [VIOLATION.ENGINE_SCRIPT],
    },
    {
      name: "flags the WebKit engine pass",
      text: "      - run: npm run smoke:web:webkit\n",
      rules: [VIOLATION.ENGINE_SCRIPT],
    },
    {
      name: "flags the env-driven runner, whose engine cannot be read statically",
      text: "      - run: npm run smoke:web:engine\n",
      rules: [VIOLATION.ENGINE_SCRIPT],
    },
    {
      // Copilot, first review: the matrix form is exactly how a forbidden
      // engine reaches CI without anyone typing its name.
      name: "flags an engine pass whose name is built from an expression",
      text: "      - run: npm run smoke:web:${{ matrix.browser }}\n",
      rules: [VIOLATION.ENGINE_SCRIPT],
    },
    {
      name: "flags a local: script whose name is built from an expression",
      text: "      - run: npm run local:${{ matrix.task }}\n",
      rules: [VIOLATION.LOCAL_SCRIPT],
    },
    {
      name: "flags SMOKE_BROWSER pointed at another engine",
      text: "        env:\n          SMOKE_BROWSER: firefox\n",
      rules: [VIOLATION.BROWSER_ENV],
    },
    {
      name: "flags a quoted SMOKE_BROWSER value",
      text: '        env:\n          SMOKE_BROWSER: "webkit"\n',
      rules: [VIOLATION.BROWSER_ENV],
    },
    {
      name: "flags a shell-assigned SMOKE_BROWSER",
      text: "      - run: SMOKE_BROWSER=firefox npm run smoke\n",
      rules: [VIOLATION.BROWSER_ENV],
    },
    {
      name: "flags an expression, which cannot be checked statically",
      text: "        env:\n          SMOKE_BROWSER: ${{ matrix.browser }}\n",
      rules: [VIOLATION.BROWSER_ENV],
    },
    {
      name: "allows SMOKE_BROWSER set explicitly to chromium",
      text: "        env:\n          SMOKE_BROWSER: chromium\n",
      rules: [],
    },
    {
      name: "allows the smoke suite, which belongs in CI",
      text: "      - run: npm run smoke\n",
      rules: [],
    },
    {
      name: "allows the Chromium engine pass, which belongs in CI",
      text: "      - run: npm run smoke:web:chromium\n",
      rules: [],
    },
    {
      // #2148's tab smoke pins Chromium on both halves of its npm script and is
      // deliberately outside ENGINE_SMOKES — it is not an engine pass, and the
      // guard must not read `smoke:web:` as forbidden by itself.
      name: "allows the Chromium-only tab smoke",
      text: "      - run: npm run smoke:web:tabs\n",
      rules: [],
    },
    {
      name: "allows smoke:tui, which self-skips under CI on its own",
      text: "      - run: npm run smoke:tui\n",
      rules: [],
    },
    {
      name: "allows the rest of the CI chain",
      text: [
        "      - run: npm run validate",
        "      - run: npm run coverage",
        "      - run: npm run verify:build-gate",
        "      - run: npm run verify:bundle-externals",
        "      - run: npm run test:storybook",
        "",
      ].join("\n"),
      rules: [],
    },
    {
      // Copilot, second review: an expression body can itself contain braces,
      // so a brace-balanced regex stops at the first `}` and misses the one
      // case worth catching. The rule keys off the `${{` prefix instead.
      name: "flags an expression whose own body contains braces",
      text: "      - run: npm run smoke:web:${{ format('{0}', matrix.browser) }}\n",
      rules: [VIOLATION.ENGINE_SCRIPT],
    },
    {
      name: "flags a command inside a block scalar, not just an inline run",
      text: "      - run: |\n          npm run local:gate\n",
      rules: [VIOLATION.LOCAL_SCRIPT],
    },
    {
      name: "flags a command passed as an action input",
      text: "        with:\n          args: npm run local:gate\n",
      rules: [VIOLATION.LOCAL_SCRIPT],
    },
    {
      // Copilot, third review: a hand-rolled opener could not see either of
      // these, and each is a forbidden invocation that would have passed.
      name: "flags a block scalar opened with a trailing comment",
      text: "      - run: | # why this step exists\n          npm run local:gate\n",
      rules: [VIOLATION.LOCAL_SCRIPT],
    },
    {
      name: "flags an env override written as a flow mapping",
      text: "      - env: { SMOKE_BROWSER: firefox }\n        run: npm run smoke\n",
      rules: [VIOLATION.BROWSER_ENV],
    },
    {
      // Present-but-empty is not unset: `resolveBrowserName` rejects it rather
      // than falling back to chromium, so a workflow must not write it either.
      name: "flags SMOKE_BROWSER set to nothing at all",
      text: "        env:\n          SMOKE_BROWSER:\n",
      rules: [VIOLATION.BROWSER_ENV],
    },
    {
      name: "flags an empty shell assignment too",
      text: "      - run: SMOKE_BROWSER= npm run smoke\n",
      rules: [VIOLATION.BROWSER_ENV],
    },
    {
      // Copilot, second review: metadata executes nothing, so a finding there
      // is simply false — and the fastest way to get a guard deleted.
      name: "does not read a step name as an invocation",
      text: "      - name: Explain why smoke:web:firefox stays local\n",
      rules: [],
    },
    {
      name: "does not read an `if:` condition as one either",
      text: "        if: github.event_name == 'push'\n",
      rules: [],
    },
    {
      name: "does not read a similarly-named key as the override",
      text: "        env:\n          SMOKE_BROWSER_DOC: firefox\n",
      rules: [],
    },
    {
      name: "does not read a comment as an invocation",
      text: "      # smoke:web:firefox runs in npm run local:gate, never here\n",
      rules: [],
    },
    {
      name: "does not read a shell comment inside a run block as one either",
      text: "          # SMOKE_BROWSER=webkit is local-only\n",
      rules: [],
    },
  ];

  for (const { name, text, rules } of cases) {
    it(name, () => {
      const found = findWorkflowViolations(text, "case.yml").map((f) => f.rule);
      assert.deepEqual(
        found,
        rules,
        formatWorkflowViolations(findWorkflowViolations(text, "case.yml")),
      );
    });
  }

  it("reports the line a finding came from", () => {
    const [finding] = findWorkflowViolations(
      "jobs:\n  build:\n    steps:\n      - run: npm run local:gate\n",
      "main.yml",
    );
    assert.equal(finding.line, 4);
    assert.equal(finding.file, "main.yml");
    assert.equal(finding.match, "local:gate");
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
  it("ends a block when the next line dedents, and re-reads that line", () => {
    // The table cases cannot isolate this: a block that never closed would
    // still produce the right findings for them, and would then read the whole
    // rest of the file as executable.
    const regions = extractExecutableRegions(
      [
        "steps:",
        "  - name: smoke:web:firefox is local-only",
        "    env:",
        "      SMOKE_BROWSER: chromium",
        "    run: npm run smoke",
        "",
      ].join("\n"),
    );
    // The step `name:` is absent, and the two executable values are not.
    assert.deepEqual(
      regions.map((r) => [r.kind, r.text.trim()]),
      [
        ["env", "SMOKE_BROWSER: chromium"],
        ["run", "npm run smoke"],
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
