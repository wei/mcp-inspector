/**
 * RFC 6570 URI Template parsing and expansion, shared by every client (#1919).
 *
 * Expansion is delegated to the SDK's `UriTemplate` — with one correction
 * applied first, documented on {@link expandMultiNameExpression} below. This
 * lives in `core/` rather than in a client so the web form, the TUI, and the
 * CLI cannot disagree about what a template means; `InspectorClient
 * .readResourceFromTemplate` and the web Resources form both expand through
 * {@link expandUriTemplate}.
 */

import { UriTemplate } from "@modelcontextprotocol/client";

/** The RFC 6570 operators, in the order the SDK's parser tests for them. */
const OPERATORS = ["+", "#", ".", "/", "?", "&"] as const;

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
const OMITTABLE_OPERATORS = new Set(["#", ".", "/", "?", "&"]);

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
  /** Variable names in the expression, `*` (explode) and whitespace stripped. */
  names: string[];
}

export type TemplatePart = TemplateLiteral | TemplateExpression;

export interface TemplateVariable {
  name: string;
  /** The operator of the expression the variable was first seen in. */
  operator: string;
  /**
   * True when omitting the variable would change the URI's structure rather
   * than shorten it — see {@link OMITTABLE_OPERATORS}.
   */
  required: boolean;
}

/**
 * Splits a template into literal runs and expressions.
 *
 * Deliberately mirrors the SDK parser's own scanning rules (first matching
 * operator character wins, names split on `,`, `*` stripped) so this never
 * disagrees with the class that ultimately does the expanding. An unclosed
 * `{` yields a trailing literal, which is what makes the callers below degrade
 * to "render no inputs, show the template verbatim" rather than throw.
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
    const names = body
      .slice(operator.length)
      .split(",")
      .map((name) => name.replace("*", "").trim())
      .filter((name) => name.length > 0);
    parts.push({
      kind: "expression",
      source: uriTemplate.slice(i, end + 1),
      operator,
      names,
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
        byName.set(name, { name, operator: part.operator, required });
      }
    }
  }

  return [...byName.values()];
}

/**
 * Drops empty entries so an untouched optional field reads as *undefined* to
 * the SDK (the expression disappears) rather than as the empty string (which
 * would expand to a valueless `?topic=`).
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
 * Expands a **multi-name, non-query** expression (`{a,b}`, `{/a,b}`, …).
 *
 * The pinned SDK gets this branch wrong: `UriTemplate.expandPart` takes an
 * early `part.names.length > 1` path that raw-joins the values with `,` —
 * skipping `encodeValue` *and* the operator prefix entirely. Measured against
 * the pinned SDK, `x://{a,b}` with `a = "foo/bar"` expands to `x://foo/bar,q`
 * (unencoded, so the slash creates a path segment — the very defect #1919 is
 * about), and `x://a{/p,q}` expands to `x://ax y,z` — no leading `/`, spaces
 * intact. Only the `?`/`&` operators are handled correctly there, because they
 * are dispatched before that branch.
 *
 * So those expressions are expanded here and spliced into the template as
 * *literal* text before the SDK ever sees them. This is deliberately surgical:
 * every other shape — the overwhelmingly common single-name expression, and
 * every query expression — still goes through the SDK untouched, so the two
 * cannot drift on the ordinary path, and if the SDK fixes its branch this
 * correction keeps producing the same (correct) answer.
 *
 * Splicing is safe because both encoders escape `{` and `}` (to `%7B`/`%7D`),
 * so an expanded value can never be re-parsed as an expression.
 *
 * Returns `""` when no name in the expression has a value, matching RFC 6570's
 * rule that an expression with only undefined variables expands to nothing.
 */
function expandMultiNameExpression(
  part: TemplateExpression,
  values: Record<string, string>,
): string {
  const encoded = part.names
    .map((name) => values[name])
    .filter((value) => value !== undefined)
    .map((value) => encodeValue(value, part.operator));

  if (encoded.length === 0) return "";

  switch (part.operator) {
    case "#":
      return `#${encoded.join(",")}`;
    case ".":
      return `.${encoded.join(".")}`;
    case "/":
      return `/${encoded.join("/")}`;
    // "" and "+" — a bare comma-joined list, no prefix.
    default:
      return encoded.join(",");
  }
}

/**
 * True for the expressions {@link expandMultiNameExpression} has to take over:
 * more than one name, and not a query operator (which the SDK dispatches before
 * its broken branch and therefore handles correctly).
 */
function needsMultiNameCorrection(part: TemplateExpression): boolean {
  return (
    part.names.length > 1 && part.operator !== "?" && part.operator !== "&"
  );
}

/**
 * Rebuilds `uriTemplate` with every mis-expanded multi-name expression already
 * resolved to literal text, leaving the rest for the SDK.
 */
export function applyMultiNameCorrection(
  parts: TemplatePart[],
  values: Record<string, string>,
): string {
  return parts
    .map((part) => {
      if (part.kind === "literal") return part.text;
      return needsMultiNameCorrection(part)
        ? expandMultiNameExpression(part, values)
        : part.source;
    })
    .join("");
}

/**
 * Expands a template against the entered values per RFC 6570 — percent-encoding
 * each value according to its operator, and omitting expressions whose
 * variables were left blank.
 *
 * A template the SDK refuses to parse falls back to the raw template string,
 * which is what the user already sees in the preview and what the server will
 * reject with a legible error; throwing here would take out the whole panel.
 */
export function expandUriTemplate(
  uriTemplate: string,
  values: Record<string, string>,
): string {
  const defined = definedValues(values);
  try {
    const corrected = applyMultiNameCorrection(
      parseUriTemplate(uriTemplate),
      defined,
    );
    return new UriTemplate(corrected).expand(defined);
  } catch {
    return uriTemplate;
  }
}
