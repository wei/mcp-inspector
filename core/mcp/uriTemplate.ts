/**
 * RFC 6570 URI Template parsing and expansion, shared by every client (#1919).
 *
 * This lives in `core/` rather than in a client so the web Resources form and
 * the TUI cannot disagree about what a template means. Both derive their form
 * fields from {@link templateVariables} and expand through
 * {@link expandUriTemplate} — the web panel directly, the TUI via
 * `InspectorClient.readResourceFromTemplate`.
 *
 * The **CLI is deliberately not a consumer**: it has no template form, and its
 * `resources/read` passes the already-expanded `--uri` straight to
 * `readResource` (see `clients/cli/src/handlers/run-method.ts`). Nothing here
 * runs for it.
 *
 * ## Why this is not simply `new UriTemplate(t).expand(v)`
 *
 * The SDK's `UriTemplate` is still used, but only to *validate* a template —
 * constructing it is what rejects an unclosed expression. Its expander is not,
 * because it is incomplete in ways a form makes visible: a form has to *name*
 * the variables it asks the user to fill in, so a parser that mangles a name
 * produces a field nobody can use. Each of these was measured against the
 * pinned SDK, not inferred:
 *
 * | Shape            | SDK behavior                                              |
 * | ---------------- | --------------------------------------------------------- |
 * | `{a,b}`          | raw-joins the values — no encoding, operator prefix dropped |
 * | `{;id}`          | `;` is not in its operator list, so the variable is `;id`  |
 * | `{id:3}`         | the prefix modifier is folded into the name, giving `id:3` |
 * | `{+v}` / `{#v}`  | `encodeURI` mangles reserved `[`/`]` and double-encodes `%` |
 * | `{v}`            | `encodeURIComponent` leaves the sub-delims `!'()*` bare     |
 *
 * An earlier revision delegated the shapes the SDK got right and took over only
 * the rest. That split is gone: once the encoders themselves differed, the two
 * paths would have encoded the *same value* differently depending on whether
 * the expression happened to carry a modifier. One expander, one set of rules.
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
  /**
   * True when a varspec carried a modifier that is not valid RFC 6570. Strict
   * expansion rejects the template; discovery stays lenient so the panel can
   * still render something rather than going blank.
   */
  invalid: boolean;
}

export type TemplatePart = TemplateLiteral | TemplateExpression;

export interface TemplateVariable {
  name: string;
  /** The operator of the expression the variable was first seen in. */
  operator: string;
  /**
   * True when this variable appears in at least one expression that cannot be
   * omitted without changing the URI's structure — see
   * {@link OMITTABLE_OPERATORS}. Drives the form's "Optional" marker.
   *
   * It does **not** mean "the user must fill this field in". Requiredness is a
   * property of the *expression*: RFC 6570 drops undefined names from a
   * multi-name expression, so `{a,b}` with only `a` filled expands to `a`'s
   * value. Gate submission on {@link hasRequiredValues} over
   * {@link requiredGroups}, never by testing this flag per variable.
   */
  required: boolean;
}

/**
 * RFC 6570's `max-length` production: `%x31-39 0*3DIGIT` — 1 to 9999, no
 * leading zero. `{id:}`, `{id:0}`, `{id:abc}` and `{id:10000}` are all invalid
 * *templates*, not templates with an ignorable modifier.
 */
const MAX_LENGTH_GRAMMAR = /^[1-9][0-9]{0,3}$/;

/**
 * Parses one varspec (`id`, `id*`, `id:3`) into a name and optional prefix.
 *
 * Returns `null` for an empty varspec (a stray comma) and `"invalid"` for one
 * whose modifier does not match the grammar. The two are distinguished because
 * the first is ignorable and the second must fail the template: silently
 * treating `{id:abc}` as `{id}` would send a URI that does not match what the
 * server advertised, with nothing to alert anyone.
 */
function parseVarSpec(raw: string): VarSpec | null | "invalid" {
  // The explode modifier is stripped rather than honored: it only changes how
  // a list or map value is joined, and every value reaching this module is a
  // single string.
  const spec = raw.replace("*", "").trim();
  if (spec.length === 0) return null;

  const colon = spec.indexOf(":");
  if (colon === -1) return { name: spec };

  const name = spec.slice(0, colon);
  const modifier = spec.slice(colon + 1);
  if (name.length === 0 || !MAX_LENGTH_GRAMMAR.test(modifier)) return "invalid";
  return { name, maxLength: Number(modifier) };
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
    const parsed = body.slice(operator.length).split(",").map(parseVarSpec);
    const varspecs = parsed.filter(
      (spec): spec is VarSpec => spec !== null && spec !== "invalid",
    );
    parts.push({
      kind: "expression",
      source: uriTemplate.slice(i, end + 1),
      operator,
      varspecs,
      names: varspecs.map((spec) => spec.name),
      invalid: parsed.includes("invalid"),
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
 * The variable names of each expression that cannot be omitted, in template
 * order — one entry per expression, not per variable.
 *
 * This is deliberately *not* folded onto {@link TemplateVariable}. A name can
 * appear in several expressions with different operators, and each required
 * expression has to be satisfied on its own: in `x{?a}{?b}{a,b}` the only
 * required expression is `{a,b}`, which either `a` or `b` satisfies (the SDK
 * expands that template with just `a` to `x?a=11`), while a per-variable model
 * that kept only the first occurrence's group would mark both names required
 * with singleton groups and refuse it. And in `{a,b}{a,c}` — two required
 * expressions sharing `a` — filling `b` and `c` satisfies both, which no
 * per-variable flag can express at all.
 */
export function requiredGroups(uriTemplate: string): string[][] {
  const groups: string[][] = [];
  for (const part of parseUriTemplate(uriTemplate)) {
    if (part.kind !== "expression") continue;
    if (OMITTABLE_OPERATORS.has(part.operator)) continue;
    groups.push(part.names);
  }
  return groups;
}

/**
 * Whether `values` supplies everything expansion structurally needs: every
 * required expression has at least one of its names filled in.
 */
export function hasRequiredValues(
  groups: string[][],
  values: Record<string, string>,
): boolean {
  return groups.every((names) =>
    names.some((name) => (readValue(values, name) ?? "").length > 0),
  );
}

/**
 * Reads a variable, ignoring anything inherited from `Object.prototype`.
 *
 * `toString`, `constructor`, `valueOf` and `__proto__` are all valid RFC 6570
 * variable names (`varname` allows ALPHA / DIGIT / `_` / pct-encoded), and a
 * plain object lookup finds the prototype's member for every one of them. A
 * bare `values[name] !== undefined` therefore reports a *blank* `{?toString}`
 * as supplied and expands a function body into the URI; `hasRequiredValues`
 * likewise saw `constructor` as satisfied because `Object.length` is 1.
 */
function readValue(
  values: Record<string, string>,
  name: string,
): string | undefined {
  return Object.hasOwn(values, name) ? values[name] : undefined;
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

/**
 * The characters RFC 6570 leaves alone under the `+` and `#` operators:
 * RFC 3986 *unreserved* plus *reserved* (gen-delims and sub-delims).
 */
const ALLOW_RESERVED = /[^A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=]/gu;

/**
 * The `allow-reserved` value encoding of RFC 6570 §3.2.1, used by `+` and `#`.
 *
 * The SDK reaches for `encodeURI` here, which is close but wrong twice over,
 * and both cases corrupt the URI rather than merely over-escaping it:
 *
 * - It escapes `[` and `]`, which are *reserved* and must survive — so an IPv6
 *   literal `[::1]` becomes `%5B::1%5D`.
 * - It escapes `%`, so an already-encoded value is double-encoded: `%2F`
 *   becomes `%252F`, and the server sees a literal "%2F" rather than a slash.
 *
 * The spec instead keeps existing pct-triplets intact, which is what the split
 * below does: odd chunks are whole `%XX` triplets and pass through untouched,
 * even chunks are scanned for anything outside the allowed set. A lone `%` is
 * not a triplet, so it lands in an even chunk and is correctly encoded to
 * `%25`. The `u` flag makes the class match by code point, so an astral
 * character is handed to `encodeURIComponent` whole rather than as surrogates.
 */
function encodeAllowReserved(value: string): string {
  return value
    .split(/(%[0-9A-Fa-f]{2})/g)
    .map((chunk, index) =>
      index % 2 === 1
        ? chunk
        : chunk.replace(ALLOW_RESERVED, (char) => encodeURIComponent(char)),
    )
    .join("");
}

/**
 * Percent-encodes everything outside RFC 3986's *unreserved* set, which is what
 * every operator except `+` and `#` calls for.
 *
 * `encodeURIComponent` alone is not that set: it leaves `!`, `'`, `(`, `)` and
 * `*` unescaped. Those are sub-delims, not unreserved, so RFC 6570 requires
 * them encoded for simple, label, path, matrix and query expansion. They are
 * substituted afterwards rather than hand-rolled, so `encodeURIComponent` still
 * does the UTF-8 work for everything else.
 */
const FORCE_ENCODED: Record<string, string> = {
  "!": "%21",
  "'": "%27",
  "(": "%28",
  ")": "%29",
  "*": "%2A",
};

function encodeUnreserved(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => FORCE_ENCODED[char],
  );
}

/** Encodes one value for its operator: reserved characters survive `+` and `#`. */
function encodeValue(value: string, operator: string): string {
  return operator === "+" || operator === "#"
    ? encodeAllowReserved(value)
    : encodeUnreserved(value);
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

/** Expands one expression per RFC 6570. Returns "" if no name has a value. */
function expandExpression(
  part: TemplateExpression,
  values: Record<string, string>,
): string {
  // The value is carried through the filter rather than re-read afterwards, so
  // the "is it defined" test and the read cannot disagree — and so nothing
  // downstream needs a non-null assertion to convince the compiler.
  const present = part.varspecs.flatMap((spec) => {
    const value = readValue(values, spec.name);
    return value === undefined ? [] : [{ spec, value }];
  });
  if (present.length === 0) return "";

  const { operator } = part;

  if (NAMED_OPERATORS.has(operator)) {
    const pairs = present.map(
      ({ spec, value }) => `${spec.name}=${renderValue(value, spec, operator)}`,
    );
    // `;` repeats its separator per pair; `?`/`&` join with `&`.
    return operator === ";"
      ? `;${pairs.join(";")}`
      : `${operator}${pairs.join("&")}`;
  }

  const rendered = present.map(({ spec, value }) =>
    renderValue(value, spec, operator),
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
 * Expands a whole parsed template.
 *
 * Each expression is expanded **independently**, which is what RFC 6570
 * specifies — expansion carries no cross-expression state. The SDK instead
 * tracks whether a query expression has already emitted and rewrites a later
 * `{?two}`'s leading `?` to `&`. That looks friendlier and is wrong: measured
 * against the pinned SDK, `x{?one}{?two}` expands to `x?one=1&two=2`, and
 * `UriTemplate.match` on that same template *rejects* it — `match("x?one=1&two=2")`
 * is `null`, while `match("x?one=1?two=2")` returns both variables. So the
 * rewrite emits a URI the advertised template cannot match, which is precisely
 * the failure #1919 is about, one level up.
 *
 * A server that wants a continuation advertises it: `{?one}{&two}` expands to
 * `x?one=1&two=2` and matches. Producing that shape is the server's choice to
 * declare, not ours to infer.
 */
export function expandParts(
  parts: TemplatePart[],
  values: Record<string, string>,
): string {
  return parts
    .map((part) =>
      part.kind === "literal" ? part.text : expandExpression(part, values),
    )
    .join("");
}

/**
 * Expands a template against the entered values per RFC 6570 — percent-encoding
 * each value according to its operator, and omitting expressions whose
 * variables were left blank. **Throws** on a template that is not valid.
 *
 * Every expression is expanded by {@link expandParts}; the SDK's `UriTemplate`
 * is constructed only because that is what rejects an unclosed expression, and
 * callers such as `readResourceFromTemplate` wrap the error it throws. Its own
 * `expand` is deliberately unused — see the module comment for the five shapes
 * it gets wrong.
 *
 * Its constructor is not a complete validator either: it accepts `{id:abc}`,
 * whose modifier is not RFC 6570's `max-length` production. Treating that as a
 * plain `{id}` would send a URI the server never advertised, so the owned
 * parser's verdict is checked too.
 */
export function expandUriTemplateStrict(
  uriTemplate: string,
  values: Record<string, string>,
): string {
  const defined = definedValues(values);
  new UriTemplate(uriTemplate);
  const parts = parseUriTemplate(uriTemplate);
  const bad = parts.find((part) => part.kind === "expression" && part.invalid);
  if (bad) {
    throw new Error(
      `Invalid RFC 6570 varspec in "${uriTemplate}": ${
        bad.kind === "expression" ? bad.source : ""
      } — a prefix modifier must be 1-9999 with no leading zero.`,
    );
  }
  return expandParts(parts, defined);
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
