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
  encodeLiteral,
  expandTemplateExpression,
  parseUriTemplate,
} from "@inspector/core/mcp/uriTemplate.js";

export {
  definedValues,
  encodeLiteral,
  expandUriTemplate,
  hasRequiredValues,
  parseUriTemplate,
  requiredGroups,
  templateVariables,
  tryExpandUriTemplate,
  unmetRequiredGroups,
} from "@inspector/core/mcp/uriTemplate.js";
export type {
  TemplateExpansion,
  TemplatePart,
  TemplateVariable,
  VarSpec,
} from "@inspector/core/mcp/uriTemplate.js";

/**
 * A partially-expanded template for display: an expression with at least one
 * value is expanded exactly as the wire would render it, and the rest are left
 * standing as written so the user can see what is still needed.
 *
 * Assembled part by part rather than by rewriting the template and re-parsing
 * it. The rewrite approach needed a placeholder to stand in for each unexpanded
 * expression, and a placeholder is exactly what cannot survive the round trip
 * now that literals are pct-encoded on expansion (RFC 6570 §3.1) -- whatever
 * token stood in for `{?topic}` would come back encoded and no longer match.
 * Going part by part removes the token, and with it the question of what text
 * could never collide with a server-supplied template.
 *
 * Each half still comes from the shared expander -- `encodeLiteral` for literal
 * runs, `expandTemplateExpression` for filled ones -- so the preview cannot
 * promise a URI that submitting would not send.
 *
 * Two guards keep that promise, both of them things the previous
 * expand-the-whole-template implementation got for free from the lenient
 * `expandUriTemplate` it called:
 *
 * - **An invalid expression is left standing.** `{a,}` still parses `a` into
 *   its varspecs, so filling `a` would preview `x://1` for a template whose
 *   submission is refused outright -- a URI the user could never send.
 * - **The whole thing is wrapped.** This runs during render, where a throw
 *   unmounts the panel instead of disabling its button, and encoding can throw
 *   for real input: `encodeURIComponent` raises `URIError` on an unpaired
 *   surrogate, which a paste can deliver. The panel already reports that case
 *   through `tryExpandUriTemplate`; here it degrades to the raw template.
 */
export function previewUriTemplate(
  uriTemplate: string,
  values: Record<string, string>,
): string {
  const defined = definedValues(values);

  try {
    return parseUriTemplate(uriTemplate)
      .map((part) => {
        if (part.kind === "literal") return encodeLiteral(part.text);
        if (part.invalid) return part.source;
        // `Object.hasOwn`, not a bare lookup: `toString` and `constructor` are
        // valid RFC 6570 variable names, and a plain lookup would find
        // `Object.prototype`'s member and treat a blank field as filled.
        return part.names.some((name) => Object.hasOwn(defined, name))
          ? expandTemplateExpression(part, defined)
          : part.source;
      })
      .join("");
  } catch {
    return uriTemplate;
  }
}
