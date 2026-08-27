/**
 * The guard that keeps the LOCAL pre-push gate out of GitHub CI (#2146).
 *
 * Two tiers run the same checks and are deliberately not the same set:
 *
 *   - **GitHub CI** (`.github/workflows/**`) runs `validate`, `coverage`, the
 *     two verify gates, `smoke` and the Storybook tests. `npm run smoke` covers
 *     `smoke:launcher`, `smoke:cli`, `smoke:tui`, `smoke:web` and
 *     `smoke:web:chromium` — all of which BELONG there.
 *   - **`npm run local:gate`**, the pre-push gate, is a strict superset: it adds
 *     the **Firefox** engine pass, and `smoke:tui` really runs there rather than
 *     self-skipping. WebKit is on demand and belongs to neither tier.
 *
 * The narrow thing that must never reach CI is a **non-Chromium engine pass**.
 * `smoke:web:firefox` was placed in the local gate on purpose (#2086,
 * #2133) after a CI job was trialled and removed for never once disagreeing
 * with Chromium, and `smoke:web:webkit` fails two of the three smokes outright
 * for reasons nobody has identified. Confidence in the cross-engine runs is not
 * high enough to let them break CI.
 *
 * Renaming the gate off `ci` removed the *invitation* to add it to a workflow.
 * This removes the *possibility*: it is the only part of #2146 that cannot rot,
 * since everything else there is prose.
 *
 * WHAT IT FORBIDS, and nothing more:
 *
 *   1. Invoking a `local:*` script. That namespace means local-only by
 *      construction, so the rule covers `local:storybook` and any future
 *      sibling without being edited.
 *   2. Invoking a non-Chromium engine pass (`smoke:web:firefox`,
 *      `smoke:web:webkit`). Derived from `SUPPORTED_BROWSERS`, so adding an
 *      engine extends the guard rather than opening a hole in it.
 *   3. Invoking `smoke:web:engine`, whose engine comes from the environment and
 *      therefore cannot be read off the workflow at all.
 *   4. Setting `SMOKE_BROWSER` to anything but a literal `chromium` — the back
 *      door that would redirect an otherwise innocent `npm run smoke`. This one
 *      is KIND-AWARE: an `env:` entry counts only when `SMOKE_BROWSER` is
 *      literally its key, and a `run:` script only on a shell assignment
 *      (`SMOKE_BROWSER=…`). A blanket text match rejected `echo
 *      "SMOKE_BROWSER: firefox"`, which sets nothing (Copilot). A shell
 *      assignment inside an `echo` is indistinguishable without parsing the
 *      shell, and inside a `run:` block erring toward the finding is the safe
 *      direction.
 *   5. Naming either family through a workflow **expression** —
 *      `npm run smoke:web:${{ matrix.browser }}`, `npm run local:${{ … }}`, or
 *      `SMOKE_BROWSER: ${{ matrix.browser }}`. This is rule 3's reason applied
 *      consistently: a matrix whose values the guard cannot read is a matrix
 *      that may well contain `firefox`, so an unreadable name is treated as a
 *      forbidden one rather than waved through (Copilot). Note the limit — a
 *      fully opaque `npm run ${{ matrix.script }}` names no family at all and
 *      is not detectable here; the guard covers the constructions that spell
 *      out a forbidden one.
 *
 * WHAT IT MUST NOT FORBID: `npm run smoke`, `smoke:web:chromium`, `smoke:tui`.
 * Those belong in CI and are there today — `smoke:tui` self-skips under
 * `process.env.CI` on its own, so it needs no guarding.
 *
 * ONLY EXECUTABLE POSITIONS ARE SCANNED — `run:` scalars (inline and block),
 * and the values of an `env:` or `with:` mapping, found by parsing the file
 * rather than by matching lines. Everything else in a workflow is metadata that
 * runs nothing, so scanning it produces findings that are simply false:
 * `name: Explain why smoke:web:firefox stays local` executes nothing, and
 * failing the suite on it would contradict the "what it forbids, and nothing
 * more" contract above (Copilot). Comments fall out for the same reason — and
 * the workflow's value is largely in its prose, so a guard that made the two
 * tiers undocumentable in the file implementing one of them would be traded for
 * the wrong thing.
 *
 * That is a real limit, stated rather than hidden: an execution vector outside
 * those three positions — a custom action that reads a script name from
 * somewhere else, say — is not seen. The alternative, scanning everything, was
 * measured against this repo's own workflow and produces false positives on
 * ordinary step names, which is the faster way to get a guard deleted.
 */

import {
  LineCounter,
  isAlias,
  isMap,
  isScalar,
  isSeq,
  parseAllDocuments,
} from "yaml";
import {
  BROWSER_ENV_VAR,
  SUPPORTED_BROWSERS,
  DEFAULT_BROWSER,
} from "./headless-browser.mjs";

/** Scripts whose `local:` prefix declares them local-only. */
export const LOCAL_SCRIPT_PREFIX = "local:";

/**
 * Engine passes that must never run in CI: every supported engine except the
 * default, plus the env-driven runner whose engine is unknowable statically.
 */
export const FORBIDDEN_ENGINE_SCRIPTS = [
  ...SUPPORTED_BROWSERS.filter((b) => b !== DEFAULT_BROWSER).map(
    (b) => `smoke:web:${b}`,
  ),
  "smoke:web:engine",
];

/** Reasons a finding can carry, kept as constants so tests pin them. */
export const VIOLATION = {
  LOCAL_SCRIPT: "local-only-script",
  ENGINE_SCRIPT: "non-chromium-engine-pass",
  BROWSER_ENV: "smoke-browser-override",
};

// The name may be spelled out (`local:gate`) or built from an expression
// (`local:${{ matrix.task }}`) — both are `local:` scripts, and neither may be
// invoked from a workflow.
//
// The expression arm keys off the `${{` PREFIX and then runs to the end of the
// line, rather than trying to find the matching `}}`. An expression body can
// itself contain braces — `${{ format('{0}', matrix.browser) }}` — so a
// `[^}]*\}\}` body stops at the first `}` and misses exactly the case worth
// catching (Copilot). Matching the prefix cannot be defeated by nesting, and
// since these are display strings the greedy tail costs nothing.
const EXPRESSION = String.raw`\$\{\{[^\n]*`;
const LOCAL_SCRIPT_RE = new RegExp(
  String.raw`\blocal:(?:[a-z0-9][a-z0-9:-]*|${EXPRESSION})`,
  "gi",
);
// Same reasoning one level down: `smoke:web:` followed by an expression could
// resolve to any engine, so it is read as a forbidden one.
const DYNAMIC_ENGINE_RE = new RegExp(
  String.raw`\bsmoke:web:${EXPRESSION}`,
  "gi",
);
// A shell assignment inside a `run:` script. The YAML `env:` spelling is not
// matched by text at all — it is recognized structurally, by key, so that a
// script merely PRINTING `SMOKE_BROWSER: firefox` is not read as setting it
// (Copilot). `\S*` rather than `\S+` because `SMOKE_BROWSER=` sets the empty
// string, which `resolveBrowserName` rejects as present-but-empty rather than
// treating as unset.
const BROWSER_SHELL_RE = new RegExp(`\\b${BROWSER_ENV_VAR}=(\\S*)`, "g");

// A shell assignment inside a `run:` script can still be quoted; a YAML value
// arrives already unquoted from the parser, so this is a no-op there.
function stripQuotes(value) {
  const trimmed = value.trim().replace(/[,;]+$/, "");
  const quoted = /^(["'])(.*)\1$/.exec(trimmed);
  return quoted ? quoted[2] : trimmed;
}

/**
 * The executable scalars of a workflow, with the line each came from.
 *
 * Parsed with the `yaml` package rather than by hand. The first two rounds of
 * this guard did hand-roll it, and both were wrong in the same direction — a
 * regex that stopped at the first `}`, then an opener that could not see
 * `run: | # explanation` or the flow mapping `env: { SMOKE_BROWSER: firefox }`
 * (Copilot, twice). Each miss is a workflow that invokes a forbidden pass while
 * `test:scripts` stays green, which is worse than no guard, because it reports
 * a coverage that is not there. YAML has too many spellings of the same thing
 * to recognize by indentation; a real parser knows all of them.
 *
 * `yaml` is already a root **dependency**, so this adds no install — and
 * `test:scripts` staying dependency-free was always about not adding one, not
 * about refusing what the repo has. This file is not in the published `files`
 * allowlist, so it changes nothing about the tarball.
 *
 * The walk is STRUCTURAL — it descends the schema's executable paths
 * (workflow `env`, job `env`/`container.env`/`with`, step `run`/`env`/`with`)
 * rather than
 * matching pairs by key name anywhere in the tree. Key-name matching looks
 * equivalent and is not: workflow input ids are user-defined, so an input
 * legitimately named `env` puts its own `description` and `default` in front of
 * the rules, and a doc string mentioning `SMOKE_BROWSER: firefox` fails the
 * gate (Copilot). A guard that fails on documentation of itself does not
 * survive contact with a contributor.
 *
 * ALIASES ARE RESOLVED. An alias node carries no `.value`, so reading one as a
 * scalar yields the empty string — and `run: *command`, with the command
 * anchored in a metadata scalar the walk never visits, would invoke anything at
 * all while the guard saw nothing (Copilot). Findings are reported at the line
 * where the alias is USED, not where its anchor was defined, since that is the
 * line to change.
 *
 * A parse error THROWS rather than yielding no regions: a workflow the guard
 * cannot read must not pass as a workflow with nothing in it.
 *
 * A multi-line `run:` block is one region carrying the whole script, reported
 * at the line of its `run:` key rather than at the offending line inside it.
 * The finding also prints what it matched, so that is still actionable.
 *
 * @param {string} text
 * @param {string} [file] only for the parse-error message
 * @returns {Array<{line: number, kind: string, text: string}>}
 */
export function extractExecutableRegions(text, file = "<workflow>") {
  const lineCounter = new LineCounter();
  const docs = parseAllDocuments(text, { lineCounter });
  const regions = [];

  for (const doc of docs) {
    if (doc.errors.length > 0) {
      throw new Error(
        `workflow-gate: could not parse ${file}: ${doc.errors[0].message}`,
      );
    }

    const lineOf = (node) => lineCounter.linePos(node.range[0]).line;
    const deref = (node) => (isAlias(node) ? node.resolve(doc) : node);

    /** A `run:` command — one scalar, reported where it is written or aliased. */
    const addCommand = (node) => {
      if (node == null) return;
      const resolved = deref(node);
      if (!isScalar(resolved)) return;
      regions.push({
        line: lineOf(node),
        kind: "run",
        text: String(resolved.value ?? ""),
      });
    };

    /**
     * An `env:` or `with:` mapping. Each entry is rebuilt as `NAME: value` so
     * the rules read it the way they read a shell assignment — and so an entry
     * with NO value (valid YAML, and an empty-string override) still reaches
     * them.
     */
    const addMapping = (kind, node) => {
      if (node == null) return;
      const map = deref(node);
      if (!isMap(map)) return;
      for (const entry of map.items) {
        if (!isScalar(entry.key)) continue;
        const value = deref(entry.value);
        const text = isScalar(value) ? String(value.value ?? "") : "";
        regions.push({
          line: lineOf(entry.key),
          kind,
          name: String(entry.key.value),
          value: text,
          text: `${String(entry.key.value)}: ${text}`,
        });
      }
    };

    const at = (node, key) => (isMap(node) ? node.get(key, true) : undefined);

    const root = deref(doc.contents);
    if (!isMap(root)) continue;
    addMapping("env", at(root, "env"));

    const jobs = deref(at(root, "jobs"));
    if (!isMap(jobs)) continue;
    for (const jobEntry of jobs.items) {
      const job = deref(jobEntry.value);
      if (!isMap(job)) continue;
      addMapping("env", at(job, "env"));
      // A job-level `with:` is the input block of a reusable-workflow call.
      addMapping("with", at(job, "with"));
      // `container.env` is job-wide too: every step running in the container
      // sees it, so an override there redirects `npm run smoke` exactly as a
      // job-level `env` would (Copilot). `container:` may also be a bare image
      // string, which `addMapping` ignores.
      addMapping("env", at(deref(at(job, "container")), "env"));

      const steps = deref(at(job, "steps"));
      if (!isSeq(steps)) continue;
      for (const stepNode of steps.items) {
        const step = deref(stepNode);
        if (!isMap(step)) continue;
        addCommand(at(step, "run"));
        addMapping("env", at(step, "env"));
        addMapping("with", at(step, "with"));
      }
    }
  }

  return regions;
}

/**
 * Scan one workflow file's text for invocations that must stay local-only.
 *
 * Pure: takes text, returns findings. `file` is carried through only so a
 * caller can report where a finding came from.
 *
 * @param {string} text
 * @param {string} [file]
 * @returns {Array<{file: string, line: number, rule: string, match: string, message: string}>}
 */
export function findWorkflowViolations(text, file = "<workflow>") {
  const findings = [];

  for (const region of extractExecutableRegions(text, file)) {
    const { line: lineNumber, kind } = region;
    // Inside a `run:` block the parser hands back the shell comments too, so
    // the "a comment invokes nothing" rule has to be applied here now that it
    // no longer falls out of skipping YAML comment lines (Copilot).
    const line = region.text
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("#"))
      .join("\n");
    for (const match of line.matchAll(LOCAL_SCRIPT_RE)) {
      findings.push({
        file,
        line: lineNumber,
        rule: VIOLATION.LOCAL_SCRIPT,
        match: match[0],
        message:
          `\`${match[0]}\` is a local-only script — the \`${LOCAL_SCRIPT_PREFIX}\` prefix means ` +
          `it runs in the pre-push gate, never in GitHub CI.`,
      });
    }

    for (const script of FORBIDDEN_ENGINE_SCRIPTS) {
      // Word-boundary on the right so `smoke:web:chromium` can never be read as
      // a prefix of a forbidden name (and vice versa).
      // `:` is not a regex metacharacter, so the name needs no escaping.
      const re = new RegExp(`\\b${script}\\b`, "g");
      for (const match of line.matchAll(re)) {
        findings.push({
          file,
          line: lineNumber,
          rule: VIOLATION.ENGINE_SCRIPT,
          match: match[0],
          message:
            `\`${script}\` is a non-Chromium engine pass and belongs to the local gate only ` +
            `(#2086). GitHub CI runs \`npm run smoke\`, which covers \`smoke:web:chromium\`.`,
        });
      }
    }

    for (const match of line.matchAll(DYNAMIC_ENGINE_RE)) {
      findings.push({
        file,
        line: lineNumber,
        rule: VIOLATION.ENGINE_SCRIPT,
        match: match[0],
        message:
          `\`${match[0]}\` builds an engine-pass name from an expression, so the guard cannot ` +
          `tell which engine it runs — and a matrix that a workflow can vary may well contain ` +
          `\`firefox\`. Name \`smoke:web:${DEFAULT_BROWSER}\` outright, or just run \`npm run smoke\`.`,
      });
    }

    // The browser rule is the one that must respect WHICH position it is in.
    const overrides =
      kind === "env"
        ? region.name === BROWSER_ENV_VAR
          ? [{ value: region.value, match: region.text.trim() }]
          : []
        : kind === "run"
          ? [...line.matchAll(BROWSER_SHELL_RE)].map((m) => ({
              value: m[1],
              match: m[0].trim(),
            }))
          : // A `with:` value is an action input, not an environment. Whatever
            // it names is covered by the script rules above.
            [];

    for (const override of overrides) {
      const value = stripQuotes(override.value);
      if (value === DEFAULT_BROWSER) continue;
      // Setting it to nothing is not the same as leaving it out: the variable
      // is then present and empty, which `resolveBrowserName` rejects outright
      // rather than falling back to the default.
      const described = value === "" ? "an empty value" : `\`${value}\``;
      findings.push({
        file,
        line: lineNumber,
        rule: VIOLATION.BROWSER_ENV,
        match: override.match,
        message:
          `${BROWSER_ENV_VAR} must not be set to ${described} in a workflow — only ` +
          `\`${DEFAULT_BROWSER}\` runs in GitHub CI, an expression cannot be ` +
          `checked statically, and an empty value is rejected rather than ` +
          `defaulted. Leave it unset; the default is \`${DEFAULT_BROWSER}\`.`,
      });
    }
  }

  return findings;
}

/**
 * Render findings as a single message, for an assertion failure or a CLI.
 *
 * @param {ReturnType<typeof findWorkflowViolations>} findings
 * @returns {string}
 */
export function formatWorkflowViolations(findings) {
  return findings
    .map((f) => `  ${f.file}:${f.line}  [${f.rule}]  ${f.message}`)
    .join("\n");
}
