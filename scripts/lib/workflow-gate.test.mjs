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
      text: '          SMOKE_BROWSER: "webkit"\n',
      rules: [VIOLATION.BROWSER_ENV],
    },
    {
      name: "flags a shell-assigned SMOKE_BROWSER",
      text: "      - run: SMOKE_BROWSER=firefox npm run smoke\n",
      rules: [VIOLATION.BROWSER_ENV],
    },
    {
      name: "flags an expression, which cannot be checked statically",
      text: "          SMOKE_BROWSER: ${{ matrix.browser }}\n",
      rules: [VIOLATION.BROWSER_ENV],
    },
    {
      name: "allows SMOKE_BROWSER set explicitly to chromium",
      text: "          SMOKE_BROWSER: chromium\n",
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
