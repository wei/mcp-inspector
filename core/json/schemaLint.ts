/**
 * Tool-schema portability lint (#1005).
 *
 * A tool's `inputSchema`/`outputSchema` can be a perfectly legal JSON Schema
 * and still be rejected outright by the client the server is actually meant to
 * run against. The reported case is Go's `jsonschema` package emitting a bare
 * `true` for an `interface{}` field: valid Draft 2020-12, accepted by the MCP
 * SDK's own parser, and refused by Claude Code with a bare `"Invalid input"`
 * pointing at `["tools", 7, "outputSchema", "properties", "data"]`. The
 * Inspector is where a server author looks *first*, so a construct that will
 * fail downstream should be named here rather than silently passed through.
 *
 * This is deliberately **not** a JSON Schema validator, for a measured reason:
 * a census of 617 public servers (14,804 tool schemas) reported on the issue
 * found **0** that fail the SDK's own `ListToolsResultSchema.safeParse` — so a
 * conformance check would report nothing on essentially every real server.
 * What bites instead is the narrower subset each consumer accepts, which is
 * what the rules below encode. Every rule is a construct that is legal JSON
 * Schema and is known to be refused or quietly mishandled by real MCP clients.
 *
 * Kept pure and dependency-free so all three clients share one verdict: the
 * CLI's `--strict` report, the TUI's tool detail pane, and the web Tools tab
 * must not disagree about whether a schema is portable.
 */

import type { Tool } from "@modelcontextprotocol/client";

/** Which of a tool's two schemas a finding was raised against. */
export type SchemaKind = "inputSchema" | "outputSchema";

/**
 * `error` — the construct is refused by at least one shipping MCP client, so
 * the tool is unusable there. `warning` — accepted unevenly, or degraded
 * (silently coerced, ignored) rather than rejected.
 */
export type SchemaLintSeverity = "error" | "warning";

/** Stable identifier for a lint rule, so a caller can filter or suppress. */
export type SchemaLintRule =
  | "boolean-schema"
  | "type-union"
  | "untyped-schema"
  | "non-object-root"
  | "remote-ref";

/** One problem found at one location in one schema. */
export interface SchemaFinding {
  rule: SchemaLintRule;
  severity: SchemaLintSeverity;
  /** Which schema the finding is in. */
  schema: SchemaKind;
  /**
   * Location within that schema, in the dotted/bracketed form the report
   * prints — `properties.data`, `anyOf[1].items`. Empty string means the
   * schema root.
   */
  path: string;
  /** What is wrong, phrased for a server author. */
  issue: string;
  /** A concrete replacement, not a restatement of the problem. */
  suggestion: string;
}

/** Every finding raised against one tool, in walk order. */
export interface ToolSchemaFindings {
  toolName: string;
  findings: SchemaFinding[];
}

/**
 * Keywords whose value is a schema *or* a boolean by design. `true`/`false`
 * here is the idiomatic spelling ("allow anything else" / "allow nothing
 * else") and every client understands it, so the boolean-schema rule must not
 * fire on them — the issue's own suggested fix is `additionalProperties: true`.
 */
const BOOLEAN_VALUED_KEYWORDS: ReadonlySet<string> = new Set([
  "additionalProperties",
  "unevaluatedProperties",
  "additionalItems",
  "unevaluatedItems",
]);

/** Keywords whose value is a single subschema. */
const SUBSCHEMA_KEYWORDS = [
  "items",
  "contains",
  "not",
  "propertyNames",
  "if",
  "then",
  "else",
  "additionalProperties",
  "unevaluatedProperties",
  "additionalItems",
  "unevaluatedItems",
] as const;

/** Keywords whose value is an array of subschemas. */
const SUBSCHEMA_ARRAY_KEYWORDS = [
  "allOf",
  "anyOf",
  "oneOf",
  "prefixItems",
] as const;

/** Keywords whose value is a name → subschema map. */
const SUBSCHEMA_MAP_KEYWORDS = [
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
] as const;

/**
 * Keywords that carry no validation meaning — metadata a schema may hold
 * alongside its constraints. A schema built *only* from these accepts every
 * value, which is what the `untyped-schema` rule reports.
 *
 * Defining the rule this way, rather than as "has no `type`", is deliberate:
 * `{"properties": {…}}` with no `type` does constrain its input, so calling it
 * unconstrained would be false. That shape is left alone; the rule fires on
 * `{}` and on annotation-only schemas — the object-literal spelling of the
 * same "any" that a bare `true` expresses.
 */
const ANNOTATION_ONLY_KEYWORDS: ReadonlySet<string> = new Set([
  "title",
  "description",
  "default",
  "examples",
  "deprecated",
  "readOnly",
  "writeOnly",
  "$comment",
  "$id",
  "$schema",
  "$anchor",
]);

/**
 * Depth cap for the walk. A `$ref`-free JSON document cannot be cyclic, but
 * this module is handed whatever a server sent, so bound the recursion rather
 * than trusting it.
 */
const MAX_DEPTH = 64;

type SchemaRecord = Record<string, unknown>;

function isRecord(value: unknown): value is SchemaRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Append a key to a path, quoting it when it is not a bare identifier so the
 * printed path stays unambiguous for an odd property name.
 */
function childPath(parent: string, key: string): string {
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)) {
    return parent === "" ? key : `${parent}.${key}`;
  }
  return `${parent}[${JSON.stringify(key)}]`;
}

function indexPath(parent: string, index: number): string {
  return `${parent}[${index}]`;
}

/** Human label for a path, so the root reads as something rather than blank. */
export function describeSchemaPath(schema: SchemaKind, path: string): string {
  return path === "" ? schema : `${schema}.${path}`;
}

interface WalkContext {
  schema: SchemaKind;
  findings: SchemaFinding[];
}

function add(
  ctx: WalkContext,
  rule: SchemaLintRule,
  severity: SchemaLintSeverity,
  path: string,
  issue: string,
  suggestion: string,
): void {
  ctx.findings.push({
    rule,
    severity,
    schema: ctx.schema,
    path,
    issue,
    suggestion,
  });
}

/**
 * Visit one schema position. `keyword` is the parent keyword this node sits
 * under (undefined at the root), which is what decides whether a bare boolean
 * is idiomatic here or a portability defect.
 */
function walk(
  node: unknown,
  path: string,
  keyword: string | undefined,
  depth: number,
  ctx: WalkContext,
): void {
  if (depth > MAX_DEPTH) return;

  if (typeof node === "boolean") {
    if (keyword !== undefined && BOOLEAN_VALUED_KEYWORDS.has(keyword)) return;
    add(
      ctx,
      "boolean-schema",
      "error",
      path,
      `Bare \`${String(node)}\` used where a schema object is expected.`,
      node
        ? 'Spell the "anything" schema out — `{"type": "object", "additionalProperties": true}` for a free-form object, or the concrete type if you know it.'
        : "Remove the property (or the keyword) rather than schema-ing it away with `false`.",
    );
    return;
  }

  // Anything that is neither a boolean nor an object is not a schema at all.
  // That is malformed rather than merely unportable, and the SDK's own parser
  // is the right place to reject it, so this lint stays quiet and stops here.
  if (!isRecord(node)) return;

  lintNode(node, path, ctx);

  for (const key of SUBSCHEMA_MAP_KEYWORDS) {
    const map = node[key];
    if (!isRecord(map)) continue;
    for (const [name, sub] of Object.entries(map)) {
      walk(sub, childPath(childPath(path, key), name), key, depth + 1, ctx);
    }
  }

  for (const key of SUBSCHEMA_ARRAY_KEYWORDS) {
    const arr = node[key];
    if (!Array.isArray(arr)) continue;
    arr.forEach((sub, i) => {
      walk(sub, indexPath(childPath(path, key), i), key, depth + 1, ctx);
    });
  }

  for (const key of SUBSCHEMA_KEYWORDS) {
    if (!(key in node)) continue;
    const value = node[key];
    // Draft-04 tuple form: `items` may be an array of schemas.
    if (key === "items" && Array.isArray(value)) {
      value.forEach((sub, i) => {
        walk(sub, indexPath(childPath(path, key), i), key, depth + 1, ctx);
      });
      continue;
    }
    walk(value, childPath(path, key), key, depth + 1, ctx);
  }
}

/** Rules that apply to a single schema object, ignoring its children. */
function lintNode(node: SchemaRecord, path: string, ctx: WalkContext): void {
  const type = node.type;

  if (Array.isArray(type)) {
    const nonNull = type.filter(
      (t): t is string => typeof t === "string" && t !== "null",
    );
    add(
      ctx,
      "type-union",
      "warning",
      path,
      `\`type\` is an array (${JSON.stringify(type)}). The array form is legal JSON Schema, but several MCP clients read \`type\` as a single string and either reject the tool or drop the constraint.`,
      nonNull.length === 1
        ? `Use \`"type": "${nonNull[0]}"\` and leave the property out of \`required\` to express "may be absent".`
        : "Split the alternatives into `anyOf` branches, each with a single `type`.",
    );
  }

  const ref = node.$ref;
  if (typeof ref === "string" && ref !== "" && !ref.startsWith("#")) {
    add(
      ctx,
      "remote-ref",
      "warning",
      path,
      `\`$ref\` points outside this document (\`${ref}\`). Clients do not fetch remote schemas, so the constraint is dropped or the tool is rejected.`,
      "Inline the referenced schema, or move it into `$defs` and reference it as `#/$defs/<name>`.",
    );
  }

  const constrains = Object.keys(node).some(
    (key) => !ANNOTATION_ONLY_KEYWORDS.has(key),
  );
  if (!constrains) {
    add(
      ctx,
      "untyped-schema",
      "warning",
      path,
      "Schema carries no validation keyword at all, so it accepts any value — the object-literal spelling of a bare `true`.",
      'Give it an explicit `type`. For a genuinely free-form value use `{"type": "object", "additionalProperties": true}`.',
    );
  }
}

/**
 * Lint one of a tool's schemas. The root gets one extra rule: MCP requires a
 * tool schema to describe an object, and a root of any other type is refused
 * by the SDK-side parsers rather than merely degraded.
 */
function lintSchema(
  schema: unknown,
  kind: SchemaKind,
  findings: SchemaFinding[],
): void {
  const ctx: WalkContext = { schema: kind, findings };
  if (isRecord(schema)) {
    const type = schema.type;
    if (typeof type === "string" && type !== "object") {
      add(
        ctx,
        "non-object-root",
        "error",
        "",
        `Root \`type\` is "${type}". MCP requires a tool's ${kind} to describe an object.`,
        'Wrap the value in an object schema — `{"type": "object", "properties": {…}}`.',
      );
    }
  }
  walk(schema, "", undefined, 0, ctx);
}

/**
 * Lint both of a tool's schemas. Returns findings in walk order — inputSchema
 * first, then outputSchema — so a report reads top-down through the tool.
 */
export function lintToolSchemas(tool: Tool): SchemaFinding[] {
  const findings: SchemaFinding[] = [];
  if (tool.inputSchema !== undefined) {
    lintSchema(tool.inputSchema, "inputSchema", findings);
  }
  if (tool.outputSchema !== undefined) {
    lintSchema(tool.outputSchema, "outputSchema", findings);
  }
  return findings;
}

/** Lint a tool list, dropping the tools that came back clean. */
export function lintTools(tools: readonly Tool[]): ToolSchemaFindings[] {
  const results: ToolSchemaFindings[] = [];
  for (const tool of tools) {
    const findings = lintToolSchemas(tool);
    if (findings.length > 0) results.push({ toolName: tool.name, findings });
  }
  return results;
}

/** Count findings by severity across a lint result. */
export function countFindings(results: readonly ToolSchemaFindings[]): {
  errors: number;
  warnings: number;
} {
  let errors = 0;
  let warnings = 0;
  for (const { findings } of results) {
    for (const f of findings) {
      if (f.severity === "error") errors++;
      else warnings++;
    }
  }
  return { errors, warnings };
}

/** `2 errors` / `1 warning` — one pluralized count, used in every surface. */
function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * One-line summary of a lint result, shared by the CLI's non-strict hint, the
 * TUI's tools header and the web Tools tab so the three cannot disagree.
 */
export function summarizeFindings(
  results: readonly ToolSchemaFindings[],
): string {
  const { errors, warnings } = countFindings(results);
  return `${plural(errors, "error")}, ${plural(warnings, "warning")} across ${plural(results.length, "tool")}`;
}

/**
 * Render a lint result as plain text — the CLI's `--strict` report, and the
 * body the TUI's detail pane prints. Shared so the two cannot describe the
 * same finding differently.
 */
export function formatSchemaLintReport(
  results: readonly ToolSchemaFindings[],
): string {
  const lines: string[] = [];
  for (const { toolName, findings } of results) {
    for (const f of findings) {
      lines.push(
        `${f.severity === "error" ? "Error" : "Warning"}: tool "${toolName}"`,
      );
      lines.push(`  Path: ${describeSchemaPath(f.schema, f.path)}`);
      lines.push(`  Issue: ${f.issue}`);
      lines.push(`  Suggestion: ${f.suggestion}`);
      lines.push("");
    }
  }
  lines.push(`${summarizeFindings(results)}.`);
  return lines.join("\n");
}
