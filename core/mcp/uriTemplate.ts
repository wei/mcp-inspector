/**
 * RFC 6570 URI Template parsing and expansion, shared by every client (#1919).
 *
 * This lives in `core/` rather than in a client so the web Resources form, the
 * TUI, and the CLI cannot disagree about what a template means: the form calls
 * {@link templateVariables} / {@link expandUriTemplate} directly, and the TUI
 * and CLI reach the same code through `InspectorClient.readResourceFromTemplate`.
 *
 * ## Why this is not simply `new UriTemplate(t).expand(v)`
 *
 * Expansion is delegated to the SDK's `UriTemplate` for every expression it
 * handles correctly — which is the overwhelmingly common case, and keeping it
 * there means we cannot drift from the SDK on the ordinary path. But its parser
 * and expander are incomplete in three ways that a *form* makes visible,
 * because a form has to name the variables it is asking the user to fill in.
 * Each was measured against the pinned SDK, not inferred:
 *
 * | Shape        | SDK `variableNames` | SDK expansion                     | Correct        |
 * | ------------ | ------------------- | --------------------------------- | -------------- |
 * | `{a,b}`      | `["a","b"]`         | `foo/bar,q` — unencoded, no prefix| `foo%2Fbar,q`  |
 * | `{;id}`      | `[";id"]`           | `""` — operator unknown           | `;id=7`        |
 * | `{id:3}`     | `["id:3"]`          | `""` — modifier folded into name  | `abc`          |
 *
 * For the last two the damage is not just a wrong URI: the form would render
 * fields literally labelled `;id` and `id:3`, which the user cannot fill in
 * usefully. So this module parses varspecs properly and, **when a template
 * contains any expression the SDK gets wrong, expands that whole template
 * itself** in {@link expandParts} rather than splicing corrected fragments into
 * a template the SDK then re-expands — splicing would leave the SDK's
 * cross-expression `?`-to-`&` rewrite unaware of the fragments we resolved.
 */

import { UriTemplate } from "@modelcontextprotocol/client";

/**
 * The RFC 6570 operators.
 *
 * `;` is here but **not** in the SDK's own list, which is why `{;id}` parses
 * there as a variable literally named `;id`. Order matters only in that each is
 * a distinct single character; the first match wins.
 */
const OPERATORS = ["+", "#", ".", "/", ";", "?", "&"] as const;

/**
 * Operators whose expansion omits cleanly when the variables in it are
 * undefined — the whole expression, separator and all, simply disappears and
 * what is left is still a well-formed URI naming a real (broader) resource.
 *
 * The remaining operators — `""` (simple) and `+` (reserved) — interpolate the
 * value into the *middle* of the URI, so omitting one leaves an empty path
 * segment rather than a shorter URI: measured against the pinned SDK,
 * `file:///users/{userId}/profile` expands to `file:///users//profile` and
 * `x://a/{+path}` to `x://a/`, both of which name a different resource. Those
 * are the ones a form must require before allowing a read.
 *
 * `#` is in the omittable set on the same measurement: `x://a{#frag}` with no
 * `frag` expands to exactly `x://a`. A fragment is optional by construction.
 */
const OMITTABLE_OPERATORS = new Set(["#", ".", "/", ";", "?", "&"]);

/** Operators that expand to `name=value` pairs rather than bare values. */
const NAMED_OPERATORS = new Set([";", "?", "&"]);

/** A single variable reference inside an expression, e.g. `id` or `id:3`. */
export interface VarSpec {
  name: string;
  /**
   * The RFC 6570 prefix modifier (`{id:3}`), a maximum length in *characters*.
   * Applied to the value before percent-encoding, per §3.2.1.
   */
  maxLength?: number;
}

interface TemplateLiteral {
  kind: "literal";
  text: string;
}

interface TemplateExpression {
  kind: "expression";
  /** The expression including its braces, e.g. `{?topic}`. */
  source: string;
  /** The RFC 6570 operator, or `""` for a simple expression. */
  operator: string;
  /** The variable references, in order. */
  varspecs: VarSpec[];
  /** Bare variable names, `*` and any `:length` modifier stripped. */
  names: string[];
}

export type TemplatePart = TemplateLiteral | TemplateExpression;

export interface TemplateVariable {
  name: string;
  /** The operator of the expression the variable was first seen in. */
  operator: string;
  /**
   * True when the expression this variable belongs to cannot be omitted
   * without changing the URI's structure — see {@link OMITTABLE_OPERATORS}.
   *
   * Note this is a property of the *expression*, not of the single variable:
   * RFC 6570 drops undefined names from a multi-name expression, so `{a,b}`
   * with only `a` filled expands to `a`'s value. Use {@link hasRequiredValues}
   * rather than testing every required variable individually, or a form will
   * refuse input the expander would have accepted.
   */
  required: boolean;
  /**
   * Every name in the expression this variable belongs to, itself included.
   * A single-name expression yields a one-element array.
   */
  groupNames: string[];
}

/** Parses one varspec (`id`, `id*`, `id:3`) into a name and optional prefix. */
function parseVarSpec(raw: string): VarSpec | null {
  // The explode modifier is stripped rather than honored: it only changes how
  // a list or map value is joined, and every value reaching this module is a
  // single string.
  const spec = raw.replace("*", "").trim();
  if (spec.length === 0) return null;

  const colon = spec.indexOf(":");
  if (colon === -1) return { name: spec };

  const name = spec.slice(0, colon);
  const length = Number(spec.slice(colon + 1));
  // A malformed modifier (`{id:}`, `{id:abc}`) is not a valid varspec; keep the
  // name and ignore the modifier rather than inventing a truncation.
  if (name.length === 0) return null;
  return Number.isInteger(length) && length > 0
    ? { name, maxLength: length }
    : { name };
}

/**
 * Splits a template into literal runs and expressions.
 *
 * An unclosed `{` yields a trailing literal, which is what makes the callers
 * below degrade to "render no inputs, show the template verbatim" rather than
 * throw at the user.
 */
export function parseUriTemplate(uriTemplate: string): TemplatePart[] {
  const parts: TemplatePart[] = [];
  let literal = "";
  let i = 0;

  while (i < uriTemplate.length) {
    if (uriTemplate[i] !== "{") {
      literal += uriTemplate[i];
      i += 1;
      continue;
    }
    const end = uriTemplate.indexOf("}", i);
    if (end === -1) {
      // Unclosed expression — the rest is not a template, treat it as text.
      literal += uriTemplate.slice(i);
      break;
    }
    if (literal) {
      parts.push({ kind: "literal", text: literal });
      literal = "";
    }
    const body = uriTemplate.slice(i + 1, end);
    const operator = OPERATORS.find((op) => body.startsWith(op)) ?? "";
    const varspecs = body
      .slice(operator.length)
      .split(",")
      .map(parseVarSpec)
      .filter((spec): spec is VarSpec => spec !== null);
    parts.push({
      kind: "expression",
      source: uriTemplate.slice(i, end + 1),
      operator,
      varspecs,
      names: varspecs.map((spec) => spec.name),
    });
    i = end + 1;
  }

  if (literal) parts.push({ kind: "literal", text: literal });
  return parts;
}

/**
 * The variables a form should render an input for, in template order and
 * deduplicated by name. A name appearing under more than one operator is
 * required if *any* of its occurrences is.
 */
export function templateVariables(uriTemplate: string): TemplateVariable[] {
  const byName = new Map<string, TemplateVariable>();

  for (const part of parseUriTemplate(uriTemplate)) {
    if (part.kind !== "expression") continue;
    const required = !OMITTABLE_OPERATORS.has(part.operator);
    for (const name of part.names) {
      const existing = byName.get(name);
      if (existing) {
        existing.required = existing.required || required;
      } else {
        byName.set(name, {
          name,
          operator: part.operator,
          required,
          groupNames: part.names,
        });
      }
    }
  }

  return [...byName.values()];
}

/**
 * Whether `values` supplies everything expansion structurally needs.
 *
 * A required *expression* is satisfied by any one of its names having a value,
 * because RFC 6570 drops the undefined ones — `{a,b}` with only `a` filled
 * expands to `a`'s value, which the SDK does too. Testing each required
 * variable individually would block that valid input.
 */
export function hasRequiredValues(
  variables: TemplateVariable[],
  values: Record<string, string>,
): boolean {
  return variables.every(
    (variable) =>
      !variable.required ||
      variable.groupNames.some((name) => (values[name] ?? "").length > 0),
  );
}

/**
 * Drops empty entries so an untouched optional field reads as *undefined*
 * (the expression disappears) rather than as the empty string (which would
 * expand to a valueless `?topic=`).
 */
export function definedValues(
  values: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value.length > 0),
  );
}

/** The SDK's `encodeValue`: reserved characters survive under `+` and `#`. */
function encodeValue(value: string, operator: string): string {
  return operator === "+" || operator === "#"
    ? encodeURI(value)
    : encodeURIComponent(value);
}

/**
 * Applies a prefix modifier, then encodes.
 *
 * Truncation is by *code point* (`Array.from`), not by `slice`: RFC 6570 counts
 * the prefix in characters, and `String.prototype.slice` counts UTF-16 code
 * units, so it can cut an astral character in half and yield a lone surrogate.
 */
function renderValue(value: string, spec: VarSpec, operator: string): string {
  const truncated =
    spec.maxLength === undefined
      ? value
      : Array.from(value).slice(0, spec.maxLength).join("");
  return encodeValue(truncated, operator);
}

/**
 * True for an expression the SDK would get wrong, and which this module must
 * therefore expand itself. See the table in the module comment.
 */
function needsOwnExpansion(part: TemplatePart): boolean {
  if (part.kind !== "expression") return false;
  return (
    // Multi-name, non-query: the SDK raw-joins, skipping encoding and prefix.
    (part.varspecs.length > 1 &&
      part.operator !== "?" &&
      part.operator !== "&") ||
    // The SDK has no `;` operator at all.
    part.operator === ";" ||
    // The SDK folds everything after a `:` into the variable name. Keyed on the
    // raw source rather than on a parsed `maxLength` so a *malformed* modifier
    // (`{id:}`, `{id:abc}`) is caught too: this module drops the modifier and
    // looks up `id`, while the SDK would look up `id:` and find nothing.
    part.source.includes(":")
  );
}

/** Expands one expression per RFC 6570. Returns "" if no name has a value. */
function expandExpression(
  part: TemplateExpression,
  values: Record<string, string>,
): string {
  const present = part.varspecs.filter(
    (spec) => values[spec.name] !== undefined,
  );
  if (present.length === 0) return "";

  const { operator } = part;

  if (NAMED_OPERATORS.has(operator)) {
    const pairs = present.map(
      (spec) =>
        `${spec.name}=${renderValue(values[spec.name], spec, operator)}`,
    );
    // `;` repeats its separator per pair; `?`/`&` join with `&`.
    return operator === ";"
      ? `;${pairs.join(";")}`
      : `${operator}${pairs.join("&")}`;
  }

  const rendered = present.map((spec) =>
    renderValue(values[spec.name], spec, operator),
  );

  switch (operator) {
    case "#":
      return `#${rendered.join(",")}`;
    case ".":
      return `.${rendered.join(".")}`;
    case "/":
      return `/${rendered.join("/")}`;
    // "" and "+" — a bare comma-joined list, no prefix.
    default:
      return rendered.join(",");
  }
}

/**
 * Expands a whole parsed template, mirroring the SDK's `expand` — including its
 * rule that a second query expression switches its leading `?` to `&`.
 */
export function expandParts(
  parts: TemplatePart[],
  values: Record<string, string>,
): string {
  let result = "";
  let hasQueryParam = false;

  for (const part of parts) {
    if (part.kind === "literal") {
      result += part.text;
      continue;
    }
    const expanded = expandExpression(part, values);
    if (!expanded) continue;

    const isQuery = part.operator === "?" || part.operator === "&";
    result += isQuery && hasQueryParam ? `&${expanded.slice(1)}` : expanded;
    if (isQuery) hasQueryParam = true;
  }

  return result;
}

/**
 * Expands a template against the entered values per RFC 6570 — percent-encoding
 * each value according to its operator, and omitting expressions whose
 * variables were left blank. **Throws** on a template that is not valid.
 *
 * Templates the SDK handles correctly still go through the SDK, so the two
 * cannot drift on the ordinary path; only a template containing at least one
 * expression from the table above is expanded here instead. That is a
 * whole-template switch rather than a per-expression splice so the `?`-to-`&`
 * rewrite always sees every expression that actually produced output.
 *
 * The SDK template is constructed *before* choosing a path, and unconditionally:
 * that construction is what validates the syntax and throws `Unclosed template
 * expression`, and callers such as `readResourceFromTemplate` wrap that error.
 * Skipping it on the own-expansion path would silently accept a template like
 * `{;a}{b,c` — this module's parser treats the unclosed tail as literal text,
 * so nothing else would object.
 */
export function expandUriTemplateStrict(
  uriTemplate: string,
  values: Record<string, string>,
): string {
  const defined = definedValues(values);
  const sdkTemplate = new UriTemplate(uriTemplate);
  const parts = parseUriTemplate(uriTemplate);
  return parts.some(needsOwnExpansion)
    ? expandParts(parts, defined)
    : sdkTemplate.expand(defined);
}

/**
 * {@link expandUriTemplateStrict}, but falling back to the raw template string
 * instead of throwing.
 *
 * This is the form's variant: the template comes from the connected server, not
 * from the user, so an invalid one is not something the user can fix from the
 * panel — and what they already see in the URI preview is the raw template.
 * Letting it throw would take out the whole panel on render; returning it
 * unchanged sends the server a URI it rejects with a legible error instead.
 * Call sites that need the failure (`readResourceFromTemplate`, which wraps it
 * with the template name) use the strict variant.
 */
export function expandUriTemplate(
  uriTemplate: string,
  values: Record<string, string>,
): string {
  try {
    return expandUriTemplateStrict(uriTemplate, values);
  } catch {
    return uriTemplate;
  }
}
