// Pure parsers for the `.claude/skills/**/SKILL.md` contract, extracted so
// `verify-skills.mjs` can be unit-tested without a filesystem (#2163).
//
// The failure this guards is silent by construction: Claude Code reads a
// SKILL.md's frontmatter only when the opening `---` is the file's FIRST line
// and the YAML between the fences parses. Otherwise the body loads with EMPTY
// metadata — `/skill-name` still works, so a manual spot check passes, but
// there is no `description` left for the model to match against and the skill
// never auto-fires again. A stray unquoted colon in a description is enough.
//
// So every check here is deny-by-default: a file we cannot read the way Claude
// Code reads it is an error, not a skip.

import { parse as parseYaml } from "yaml";

/** Combined per-entry cap Claude Code applies to a skill listing entry. */
export const DESCRIPTION_CAP = 1536;

/**
 * Character budget for the skill LISTING — the sum of name + description over
 * the skills that occupy it. Only model-invoked skills do: a skill with
 * `disable-model-invocation: true` is reachable solely by name, so its
 * description never enters context.
 *
 * The listing is truncated when it overflows the model's budget, and the
 * entries dropped first are the ones invoked least — i.e. exactly the
 * model-invoked skills that must fire on their own. Recording the number here
 * is what makes a regression visible when a skill is added later.
 */
export const LISTING_BUDGET = 4000;

const FRONTMATTER_FENCE = "---";

/**
 * Split a SKILL.md into its raw frontmatter and body the way Claude Code does.
 * Returns `{ error }` rather than throwing, so the caller can report every
 * offending file in one pass instead of dying on the first.
 *
 * @param {string} text Full file contents.
 * @returns {{ frontmatter?: string, body?: string, error?: string }}
 */
export function splitFrontmatter(text) {
  // A BOM or a leading blank line means the fence is not the first line, and
  // Claude Code then treats the WHOLE file — `---` markers included — as body.
  if (!text.startsWith(FRONTMATTER_FENCE + "\n")) {
    return {
      error:
        "frontmatter must open with `---` on the very first line (no BOM, no leading blank line)",
    };
  }
  const rest = text.slice(FRONTMATTER_FENCE.length + 1);
  const end = rest.indexOf("\n" + FRONTMATTER_FENCE);
  if (end === -1)
    return { error: "frontmatter is never closed by a `---` line" };
  return {
    frontmatter: rest.slice(0, end),
    body: rest.slice(end + FRONTMATTER_FENCE.length + 2),
  };
}

/**
 * Parse and validate one skill's frontmatter.
 *
 * @param {string} dirName Directory the SKILL.md lives in — the skill's identity.
 * @param {string} text Full file contents.
 * @returns {{ name?: string, description?: string, modelInvoked?: boolean,
 *            userInvocable?: boolean, paths?: string[], errors: string[] }}
 */
export function parseSkill(dirName, text) {
  const errors = [];
  const { frontmatter, error } = splitFrontmatter(text);
  if (error) return { errors: [error] };

  let meta;
  try {
    meta = parseYaml(frontmatter);
  } catch (e) {
    // The whole point of the guard: this is what strips the description.
    return {
      errors: [`frontmatter is not valid YAML — ${e.message.split("\n")[0]}`],
    };
  }
  if (meta === null || typeof meta !== "object" || Array.isArray(meta)) {
    return { errors: ["frontmatter must parse to a mapping"] };
  }

  const name = meta.name;
  if (typeof name !== "string" || name.length === 0) {
    errors.push("`name` is required and must be a string");
  } else if (name !== dirName) {
    errors.push(
      `\`name: ${name}\` does not match its directory \`${dirName}\``,
    );
  } else if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) {
    errors.push(`\`name: ${name}\` must be kebab-case`);
  }

  const description = meta.description;
  if (typeof description !== "string" || description.trim().length === 0) {
    errors.push("`description` is required and must be a non-empty string");
  } else if (description.length > DESCRIPTION_CAP) {
    errors.push(
      `\`description\` is ${description.length} chars; Claude Code caps a listing entry at ${DESCRIPTION_CAP}`,
    );
  }

  // Every skill states its invocation mode rather than inheriting a default,
  // so the eval surface is knowable by reading the files.
  if (!("disable-model-invocation" in meta)) {
    errors.push(
      "`disable-model-invocation` must be declared explicitly (true = invoked by name only, false = the model may fire it)",
    );
  }
  const dmi = meta["disable-model-invocation"];
  if ("disable-model-invocation" in meta && typeof dmi !== "boolean") {
    errors.push("`disable-model-invocation` must be a boolean");
  }
  const modelInvoked = dmi === false;

  if ("user-invocable" in meta && typeof meta["user-invocable"] !== "boolean") {
    errors.push("`user-invocable` must be a boolean");
  }
  if ("paths" in meta) {
    if (
      !Array.isArray(meta.paths) ||
      meta.paths.some((p) => typeof p !== "string")
    ) {
      errors.push("`paths` must be a list of glob strings");
    }
  }
  // A skill nothing can reach is dead weight that still costs a directory.
  if (!modelInvoked && meta["user-invocable"] === false) {
    errors.push(
      "skill is unreachable: `disable-model-invocation: true` with `user-invocable: false`",
    );
  }

  return {
    name: typeof name === "string" ? name : undefined,
    description: typeof description === "string" ? description : undefined,
    modelInvoked,
    userInvocable: meta["user-invocable"] !== false,
    paths: Array.isArray(meta.paths) ? meta.paths : undefined,
    errors,
  };
}

/**
 * Cost of the skill listing Claude Code loads into context, counting only the
 * skills that appear in it.
 *
 * @param {Array<{ name?: string, description?: string, modelInvoked?: boolean }>} skills
 */
export function listingCost(skills) {
  return skills
    .filter((s) => s.modelInvoked)
    .reduce(
      (n, s) => n + (s.name?.length ?? 0) + (s.description?.length ?? 0),
      0,
    );
}

/**
 * Validate an `evals/evals.json` payload for a model-invoked skill.
 *
 * A skill that fires on everything is a context regression, not a win, and it
 * is the failure nobody notices by hand — so negatives are required, not
 * optional.
 *
 * @param {string} skillName
 * @param {unknown} cases Parsed JSON.
 * @returns {string[]} errors
 */
export function validateEvalCases(skillName, cases) {
  if (!Array.isArray(cases) || cases.length === 0) {
    return ["evals.json must be a non-empty array of cases"];
  }
  const errors = [];
  cases.forEach((c, i) => {
    if (c === null || typeof c !== "object" || Array.isArray(c)) {
      errors.push(`case ${i}: must be an object`);
      return;
    }
    if (typeof c.prompt !== "string" || c.prompt.trim() === "") {
      errors.push(`case ${i}: \`prompt\` must be a non-empty string`);
    }
    if (
      !("expect" in c) ||
      (c.expect !== null && typeof c.expect !== "string")
    ) {
      errors.push(`case ${i}: \`expect\` must be a skill name or null`);
    }
  });
  const positives = cases.filter((c) => c && c.expect === skillName).length;
  const negatives = cases.filter((c) => c && c.expect === null).length;
  if (positives === 0) {
    errors.push(`no positive case expects \`${skillName}\``);
  }
  if (negatives === 0) {
    errors.push(
      "no negative case (`expect: null`) — a skill that fires on everything is a regression",
    );
  }
  return errors;
}
