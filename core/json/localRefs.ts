/**
 * Inlining of same-document `$ref`s (`#/$defs/…`, `#/definitions/…`) into the
 * schema that uses them, so a form builder sees the referent's `type`.
 *
 * Every form builder here — the web `SchemaForm`, the TUI's `schemaToForm` —
 * and the argument conversion in {@link ./jsonUtils.ts} dispatch on a
 * property's own `type`. Zod → JSON Schema converters deduplicate a schema
 * instance used twice by emitting it once under `$defs` and pointing both
 * uses at it with a bare `$ref`, which carries no `type` at all. So the second
 * of two fields sharing `z.string().regex(…)` fell through to the raw JSON
 * editor, and a date typed into it was rejected as invalid JSON and dropped
 * from the call (#2321). Resolving here, once, keeps the three consumers from
 * disagreeing about which fields are strings.
 *
 * Deliberately narrow:
 * - **Local pointers only.** A remote or relative `$ref` names a document this
 *   code cannot fetch, and is left in place (the field keeps its JSON editor).
 * - **Unresolvable pointers are left in place**, for the same reason.
 * - **Recursive references stop at the recursion.** A `$ref` to a schema that
 *   is already being inlined above it is kept as a `$ref`, so a tree type
 *   renders its first level and edits the rest as JSON rather than looping.
 * - **Only annotation siblings are merged.** `{ $ref, description }` is exactly
 *   what `.optional().describe(…)` on a shared instance produces, and the
 *   description written at the use site is the one the user should see. A
 *   sibling that *constrains* (`enum`, `minLength`, …) applies in conjunction
 *   with the referent rather than replacing it, which a merge cannot express —
 *   so a `$ref` carrying one is left unresolved rather than loosened.
 * - **Embedded resources are left alone.** A nested `$id` starts a new base
 *   URI, and a `#/…` pointer beneath it means that resource's root, not the
 *   document's. Rather than track bases, nothing under a nested `$id` is
 *   resolved.
 * - **Expansion is bounded.** Inlining copies a referent at every use, so a
 *   chain of definitions each using the previous one twice grows as `2^n`
 *   from an `O(n)` schema. A server controls the schema, so past
 *   {@link EXPANSION_BUDGET} nodes the whole schema is returned unresolved
 *   rather than freezing the form that renders it.
 */

/** Keywords whose values are data, not subschemas — never walked. */
const DATA_KEYWORDS = new Set(["const", "default", "enum", "examples"]);

/**
 * Keywords whose values map arbitrary NAMES to subschemas. Their keys are
 * user-chosen, so a property called `default` is a schema, not data.
 */
const NAME_MAP_KEYWORDS = new Set([
  "properties",
  "patternProperties",
  "dependentSchemas",
  // Pre-2019 spelling of `dependentSchemas` (its array values are name lists,
  // which the walk passes through untouched).
  "dependencies",
  "$defs",
  "definitions",
]);

/**
 * Keywords that may sit beside a `$ref` without blocking its inlining: they
 * annotate or organize, and constrain nothing, so the use site's value can
 * safely replace the referent's.
 */
const NON_CONSTRAINT_SIBLINGS = new Set([
  "title",
  "description",
  "default",
  "examples",
  "deprecated",
  "readOnly",
  "writeOnly",
  "$comment",
  "$schema",
  "$id",
  "$defs",
  "definitions",
]);

/** Most schema nodes one inlining may produce before it gives up. */
export const EXPANSION_BUDGET = 10_000;

/** Thrown to unwind a traversal that has spent {@link EXPANSION_BUDGET}. */
class BudgetExceeded extends Error {}

type JsonRecord = Record<string, unknown>;

interface Traversal {
  root: JsonRecord;
  /** References being inlined above the current node, for cycle detection. */
  active: Set<string>;
  remaining: number;
}

/** Charge one produced node against the traversal's budget. */
function spend(traversal: Traversal): void {
  traversal.remaining -= 1;
  if (traversal.remaining < 0) throw new BudgetExceeded();
}

/** Whether `key` holds data rather than a subschema, in a schema object. */
function isDataKey(key: string, inNameMap: boolean): boolean {
  return !inNameMap && DATA_KEYWORDS.has(key);
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The referent of a `#/…` JSON Pointer within `root`, or `undefined`. */
function resolvePointer(root: unknown, ref: string): unknown {
  if (!ref.startsWith("#")) return undefined;
  let pointer: string;
  try {
    // The whole fragment is URI-decoded BEFORE it is split into tokens (RFC
    // 6901 §6): `#%2F$defs%2FDate` is the pointer `/$defs/Date`, and
    // `#/a%2Fb` is the path `a` → `b`. A literal `/` inside a name is `~1`.
    pointer = decodeURIComponent(ref.slice(1));
  } catch {
    return undefined;
  }
  if (pointer === "") return root;
  if (!pointer.startsWith("/")) return undefined;
  let current: unknown = root;
  for (const token of pointer.slice(1).split("/")) {
    // RFC 6901 escaping, `~1` before `~0` so `~01` decodes to `~1`.
    const segment = token.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!/^(0|[1-9]\d*)$/.test(segment) || index >= current.length) {
        return undefined;
      }
      current = current[index];
    } else if (isRecord(current) && Object.hasOwn(current, segment)) {
      current = current[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

/** Whether any subschema position in `node` holds a `$ref` string. */
function containsRef(node: unknown, inNameMap = false): boolean {
  if (Array.isArray(node)) return node.some((item) => containsRef(item));
  if (!isRecord(node)) return false;
  if (!inNameMap && typeof node.$ref === "string") return true;
  return Object.entries(node).some(
    ([key, value]) =>
      !isDataKey(key, inNameMap) &&
      containsRef(value, !inNameMap && NAME_MAP_KEYWORDS.has(key)),
  );
}

function inline(node: unknown, traversal: Traversal): unknown {
  if (Array.isArray(node)) {
    spend(traversal);
    return node.map((item) => inline(item, traversal));
  }
  if (!isRecord(node)) return node;
  // An embedded resource: its pointers are relative to itself (see the header).
  if (node !== traversal.root && typeof node.$id === "string") return node;
  spend(traversal);

  const ref = node.$ref;
  const siblingsConstrain = Object.keys(node).some(
    (key) => key !== "$ref" && !NON_CONSTRAINT_SIBLINGS.has(key),
  );
  if (
    typeof ref === "string" &&
    !siblingsConstrain &&
    !traversal.active.has(ref)
  ) {
    const target = resolvePointer(traversal.root, ref);
    if (isRecord(target)) {
      traversal.active.add(ref);
      const resolved = inline(target, traversal) as JsonRecord;
      traversal.active.delete(ref);
      const siblings: JsonRecord = { ...node };
      delete siblings.$ref;
      return { ...resolved, ...inlineEntries(siblings, traversal, false) };
    }
  }
  return inlineEntries(node, traversal, false);
}

function inlineEntries(
  node: JsonRecord,
  traversal: Traversal,
  inNameMap: boolean,
): JsonRecord {
  const result: JsonRecord = {};
  for (const [key, value] of Object.entries(node)) {
    let next: unknown = value;
    if (inNameMap) {
      next = inline(value, traversal);
    } else if (NAME_MAP_KEYWORDS.has(key) && isRecord(value)) {
      next = inlineEntries(value, traversal, true);
    } else if (!isDataKey(key, false)) {
      next = inline(value, traversal);
    }
    // `defineProperty`, not assignment: `__proto__` is a legal property name
    // in a schema's `properties`, and assigning it would set the prototype.
    Object.defineProperty(result, key, {
      value: next,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  return result;
}

// Keyed on the input object: form panels call this on every render, and a
// fresh tree each time would defeat anything downstream keyed on identity.
const cache = new WeakMap<object, unknown>();

/**
 * `schema` with every resolvable same-document `$ref` replaced by its referent.
 *
 * Returns `schema` itself — same reference — when it contains no `$ref` or
 * inlining would exceed {@link EXPANSION_BUDGET}, and the same resolved object for repeated calls with the same input. Never
 * mutates the input.
 */
export function inlineLocalRefs<T>(schema: T): T {
  if (!isRecord(schema) || !containsRef(schema)) return schema;
  const cached = cache.get(schema);
  if (cached !== undefined) return cached as T;
  // The result is the input's own shape with references expanded, so it is
  // still a `T` to every caller that reads it as one.
  let resolved: T;
  try {
    resolved = inline(schema, {
      root: schema,
      active: new Set(),
      remaining: EXPANSION_BUDGET,
    }) as T;
  } catch (error) {
    /* v8 ignore next -- only BudgetExceeded is thrown by the traversal */
    if (!(error instanceof BudgetExceeded)) throw error;
    resolved = schema;
  }
  cache.set(schema, resolved);
  return resolved;
}
