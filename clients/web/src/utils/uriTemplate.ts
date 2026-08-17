/**
 * The web Resources form's view of an RFC 6570 URI template (#1919).
 *
 * Parsing, variable classification, and expansion live in
 * `@inspector/core/mcp/uriTemplate.js` so the web form and the TUI cannot
 * disagree about what a template means -- they are re-exported here so the
 * panel has a single import. (The CLI is not a consumer: it has no template
 * form, and its `resources/read` passes an already-expanded `--uri` straight to
 * `readResource`.) What this module adds is the one piece that is purely a
 * display concern: the partially-expanded preview string.
 */

import {
  definedValues,
  expandUriTemplate,
  parseUriTemplate,
} from "@inspector/core/mcp/uriTemplate.js";

export {
  expandUriTemplate,
  hasRequiredValues,
  parseUriTemplate,
  requiredGroups,
  templateVariables,
  tryExpandUriTemplate,
} from "@inspector/core/mcp/uriTemplate.js";
export type {
  TemplateExpansion,
  TemplatePart,
  TemplateVariable,
  VarSpec,
} from "@inspector/core/mcp/uriTemplate.js";

/**
 * A placeholder standing in for an expression the user has not filled in yet.
 *
 * `U+0000` cannot appear in a URI template, so a token built from it can never
 * collide with real template text; and because it is emitted as *literal* text
 * rather than as a variable value, expansion passes it through unencoded.
 */
const deferredToken = (index: number) => `\u0000${index}\u0000`;

/**
 * A partially-expanded template for display: expressions with at least one
 * value are expanded exactly as `expandUriTemplate` would, and the rest are
 * left standing as written so the user can see what is still needed.
 *
 * Unfilled expressions are swapped for an inert token and restored afterwards,
 * and the rewritten template is expanded by `expandUriTemplate` itself. Routing
 * it back through the real expander is what keeps the preview honest: it cannot
 * promise a URI that submitting would not send. (Expansion carries no
 * cross-expression state — see `expandParts` — so this is a per-expression
 * substitution, not a whole-template rewrite that some later pass depends on.)
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
      // `Object.hasOwn`, not a bare lookup: `toString` and `constructor` are
      // valid RFC 6570 variable names, and a plain lookup would find
      // `Object.prototype`'s member and treat a blank field as filled.
      if (part.names.some((name) => Object.hasOwn(defined, name))) {
        return part.source;
      }
      deferred.push(part.source);
      return deferredToken(deferred.length - 1);
    })
    .join("");

  const expanded = expandUriTemplate(rewritten, defined);

  // Restored by exact-string replacement rather than by a pattern: a regex
  // matching the token would have to embed U+0000 literally, which `eslint`
  // rejects (`no-control-regex`) -- and each token's text is already known
  // here, so there is nothing to match on.
  return deferred.reduce(
    (uri, source, index) => uri.replaceAll(deferredToken(index), source),
    expanded,
  );
}
