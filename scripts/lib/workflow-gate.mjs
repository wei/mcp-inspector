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
 *      door that would redirect an otherwise innocent `npm run smoke`.
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
 * and the values of an `env:` or `with:` mapping. Everything else in a workflow
 * is metadata that runs nothing, so scanning it produces findings that are
 * simply false: `name: Explain why smoke:web:firefox stays local` executes
 * nothing, and failing the suite on it would contradict the "what it forbids,
 * and nothing more" contract above (Copilot). Comments are skipped for the same
 * reason and one more: the workflow's value is largely in its prose, and a
 * guard that made the two tiers undocumentable in the file implementing one of
 * them would be traded for the wrong thing.
 *
 * That is a real limit, stated rather than hidden: an execution vector outside
 * those three positions — a custom action that reads a script name from
 * somewhere else, say — is not seen. The alternative, scanning everything, was
 * measured against this repo's own workflow and produces false positives on
 * ordinary step names, which is the faster way to get a guard deleted.
 */

import { SUPPORTED_BROWSERS, DEFAULT_BROWSER } from "./headless-browser.mjs";

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
// The value may be quoted (`SMOKE_BROWSER: "firefox"`), assigned
// (`SMOKE_BROWSER=firefox`), or an expression — capture whatever follows.
const BROWSER_ENV_RE = /\bSMOKE_BROWSER\s*[:=]\s*(\S+)/gi;

function isComment(line) {
  return line.trimStart().startsWith("#");
}

function indentOf(line) {
  return line.length - line.trimStart().length;
}

/** `run:` with an inline command, optionally as the first key of a `- ` item. */
const RUN_INLINE_RE = /^\s*(?:-\s+)?run:\s*(.*)$/;
/** A key that opens a block whose nested lines are executable: `run: |`, `env:`, `with:`. */
const BLOCK_OPEN_RE = /^\s*(?:-\s+)?(run|env|with):\s*(?:[|>][-+]?\d*)?\s*$/;

/**
 * The executable scalars of a workflow, with the line each came from.
 *
 * Deliberately hand-rolled rather than YAML-parsed: the guard runs in
 * `test:scripts`, which is `node --test` with no dependencies by design, and
 * the three shapes it needs are simple enough to recognize by indentation.
 *
 * @param {string} text
 * @returns {Array<{line: number, kind: string, text: string}>}
 */
export function extractExecutableRegions(text) {
  const regions = [];
  let blockKind = null;
  let blockIndent = 0;

  text.split(/\r?\n/).forEach((line, index) => {
    if (isComment(line)) return;
    const lineNumber = index + 1;

    if (blockKind !== null) {
      // A blank line neither ends a block scalar nor carries anything.
      if (line.trim() === "") return;
      if (indentOf(line) > blockIndent) {
        regions.push({ line: lineNumber, kind: blockKind, text: line });
        return;
      }
      // Dedented out of the block — fall through and re-read this line as a key.
      blockKind = null;
    }

    const block = BLOCK_OPEN_RE.exec(line);
    if (block) {
      blockKind = block[1];
      blockIndent = indentOf(line);
      return;
    }

    const run = RUN_INLINE_RE.exec(line);
    if (run && run[1].trim() !== "") {
      regions.push({ line: lineNumber, kind: "run", text: run[1] });
    }
  });

  return regions;
}

function stripQuotes(value) {
  const trimmed = value.trim().replace(/[,;]+$/, "");
  const quoted = /^(["'])(.*)\1$/.exec(trimmed);
  return quoted ? quoted[2] : trimmed;
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

  for (const { line: lineNumber, text: line } of extractExecutableRegions(
    text,
  )) {
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

    for (const match of line.matchAll(BROWSER_ENV_RE)) {
      const value = stripQuotes(match[1]);
      if (value === DEFAULT_BROWSER) continue;
      findings.push({
        file,
        line: lineNumber,
        rule: VIOLATION.BROWSER_ENV,
        match: match[0].trim(),
        message:
          `SMOKE_BROWSER must not be set to \`${value}\` in a workflow — only ` +
          `\`${DEFAULT_BROWSER}\` runs in GitHub CI, and an expression cannot be ` +
          `checked statically. Leave it unset; the default is \`${DEFAULT_BROWSER}\`.`,
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
