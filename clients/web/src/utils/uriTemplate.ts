/**
 * RFC 6570 URI Template support for the Resources screen.
 *
 * The web client used to discover and substitute variables with a bare
 * `/\{(\w+)\}/g` regex, which is wrong in two ways (#1919): it cannot see an
 * expression carrying an operator (`{?topic}`, `{/path}`, `{#frag}`, ...), so
 * no input is rendered for it; and it splices the raw value in, so a `/`, `?`,
 * `#` or space in a simple `{var}` lands unencoded and silently changes the
 * URI's structure.
 *
 * Expansion itself is delegated to the SDK's `UriTemplate` -- the same
 * implementation `InspectorClient.readResourceFromTemplate` (and therefore the
 * TUI) already expands through, so the two clients cannot disagree about what a
 * template means. What lives here is the surrounding form/preview logic the SDK
 * class does not provide: which variables to render an input for, which of them
 * a read cannot proceed without, and a partially-expanded preview string.
 */

import { UriTemplate } from "@modelcontextprotocol/client";

/** The RFC 6570 operators, in the order the SDK's parser tests for them. */
const OPERATORS = ["+", "#", ".", "/", "?", "&"] as const;

/**
 * Operators whose expansion omits cleanly when the variables in it are
 * undefined -- the whole expression, separator included, simply disappears.
 * A variable under any *other* operator is interpolated into the middle of the
 * URI, so leaving it out produces a different resource path rather than a
 * shorter one; those we require before allowing a read.
 */
const OMITTABLE_OPERATORS = new Set([".", "/", "?", "&"]);

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
   * than shorten it -- see {@link OMITTABLE_OPERATORS}.
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
      // Unclosed expression -- the rest is not a template, treat it as text.
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
function definedValues(values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value.length > 0),
  );
}

/**
 * Expands a template against the entered values per RFC 6570 -- percent-
 * encoding each value according to its operator, and omitting expressions whose
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
  try {
    return new UriTemplate(uriTemplate).expand(definedValues(values));
  } catch {
    return uriTemplate;
  }
}

/**
 * A placeholder standing in for an expression the user has not filled in yet.
 *
 * `U+0000` cannot appear in a URI template, so a token built from it can never
 * collide with real template text; and because it is emitted as *literal* text
 * rather than as a variable value, expansion passes it through unencoded.
 */
const deferredToken = (index: number) => `\u0000${index}\u0000`;

/**
 * A partially-expanded template for display: expressions whose variables are
 * all filled are expanded exactly as {@link expandUriTemplate} would, and the
 * rest are left standing as written so the user can see what is still needed.
 *
 * Unfilled expressions are swapped for an inert token and restored after
 * expansion -- rather than expanding each filled expression in isolation -- so
 * the SDK still sees one whole template and applies its cross-expression rules
 * (notably rewriting a second `?` query expression to `&`).
 */
export function previewUriTemplate(
  uriTemplate: string,
  values: Record<string, string>,
): string {
  const parts = parseUriTemplate(uriTemplate);
  const deferred: string[] = [];
  const defined = definedValues(values);

  const rewritten = parts
    .map((part) => {
      if (part.kind === "literal") return part.text;
      if (part.names.every((name) => defined[name] !== undefined)) {
        return part.source;
      }
      deferred.push(part.source);
      return deferredToken(deferred.length - 1);
    })
    .join("");

  let expanded: string;
  try {
    expanded = new UriTemplate(rewritten).expand(defined);
  } catch {
    return uriTemplate;
  }

  // Restored by exact-string replacement rather than by a pattern: a regex
  // matching the token would have to embed U+0000 literally, which `eslint`
  // rejects (`no-control-regex`) -- and each token's text is already known
  // here, so there is nothing to match on.
  return deferred.reduce(
    (uri, source, index) => uri.replaceAll(deferredToken(index), source),
    expanded,
  );
}
