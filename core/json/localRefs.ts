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
 *   {@link EXPANSION_BUDGET} nodes — or {@link MAX_DEPTH} levels of nesting,
 *   which would otherwise overflow the stack — the whole schema is returned
 *   unresolved rather than freezing or crashing the form that renders it.
 */

/*
 * Where subschemas live, and nowhere else. Every other keyword's value is data
 * — `const`, `enum`, an `x-vendor` extension — and is copied untouched even
 * when it happens to hold a `$ref`-shaped object. Same lists as
 * `schemaLint.ts`.
 */

/** Keywords whose value is one subschema (or, for draft-04 `items`, an array). */
const SUBSCHEMA_KEYWORDS = new Set([
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
  "contentSchema",
]);

/** Keywords whose value is an array of subschemas. */
const SUBSCHEMA_ARRAY_KEYWORDS = new Set([
  "allOf",
  "anyOf",
  "oneOf",
  "prefixItems",
]);

/**
 * Keywords whose values map arbitrary NAMES to subschemas. Their keys are
 * user-chosen, so a property called `default` is a schema, not data.
 */
const SUBSCHEMA_MAP_KEYWORDS = new Set([
  "properties",
  "patternProperties",
  "dependentSchemas",
  // Pre-2019 spelling of `dependentSchemas`; its array values are property
  // name lists, which are not schemas and pass through untouched.
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
  // Non-standard labels for `enum` values, read by both form builders.
  "enumNames",
  "$comment",
  "$schema",
  "$id",
  "$defs",
  "definitions",
]);

/** Most schema nodes one inlining may produce before it gives up. */
export const EXPANSION_BUDGET = 10_000;

/**
 * Deepest subschema nesting either pass walks before it gives up — the same
 * bound `schemaLint.ts` uses. Both passes recurse, and a server can nest far
 * deeper than the call stack allows.
 */
export const MAX_DEPTH = 64;

/** Thrown to unwind a traversal that hit a bound; the input is returned. */
class Bail extends Error {}

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
  if (traversal.remaining < 0) throw new Bail();
}

/**
 * Rebuild `node` with `visit` applied to each subschema it holds directly,
 * copying every other value untouched.
 */
function mapSubschemas(
  node: JsonRecord,
  visit: (child: unknown) => unknown,
): JsonRecord {
  const result: JsonRecord = {};
  for (const [key, value] of Object.entries(node)) {
    let next: unknown = value;
    if (SUBSCHEMA_KEYWORDS.has(key)) {
      next = Array.isArray(value) ? value.map(visit) : visit(value);
    } else if (SUBSCHEMA_ARRAY_KEYWORDS.has(key) && Array.isArray(value)) {
      next = value.map(visit);
    } else if (SUBSCHEMA_MAP_KEYWORDS.has(key) && isRecord(value)) {
      next = mapNames(value, visit);
    }
    define(result, key, next);
  }
  return result;
}

/** A name → subschema map with `visit` applied to each value. */
function mapNames(
  map: JsonRecord,
  visit: (child: unknown) => unknown,
): JsonRecord {
  const result: JsonRecord = {};
  for (const [name, value] of Object.entries(map)) {
    define(result, name, Array.isArray(value) ? value : visit(value));
  }
  return result;
}

/**
 * `defineProperty`, not assignment: `__proto__` is a legal property name in a
 * schema's `properties`, and assigning it would set the prototype instead.
 */
function define(target: JsonRecord, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
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
    // `~0` and `~1` are the only escapes RFC 6901 defines; anything else makes
    // the pointer malformed rather than naming a key that happens to match.
    if (/~(?![01])/.test(token)) return undefined;
    // `~1` before `~0`, so `~01` decodes to `~1`.
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

/** Whether any subschema in `node` holds a `$ref` string. */
function containsRef(node: unknown, depth: number): boolean {
  if (depth > MAX_DEPTH) throw new Bail();
  if (!isRecord(node)) return false;
  if (typeof node.$ref === "string") return true;
  let found = false;
  mapSubschemas(node, (child) => {
    found ||= containsRef(child, depth + 1);
    return child;
  });
  return found;
}

function inline(node: unknown, traversal: Traversal, depth: number): unknown {
  if (depth > MAX_DEPTH) throw new Bail();
  if (!isRecord(node)) return node;
  // An embedded resource: its pointers are relative to itself (see the header).
  if (node !== traversal.root && typeof node.$id === "string") return node;
  spend(traversal);
  const visit = (child: unknown) => inline(child, traversal, depth + 1);

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
      const resolved = visit(target) as JsonRecord;
      traversal.active.delete(ref);
      const siblings: JsonRecord = { ...node };
      delete siblings.$ref;
      return { ...resolved, ...mapSubschemas(siblings, visit) };
    }
  }
  return mapSubschemas(node, visit);
}

// Keyed on the input object: form panels call this on every render, and a
// fresh tree each time would defeat anything downstream keyed on identity.
const cache = new WeakMap<object, unknown>();

/**
 * `schema` with every resolvable same-document `$ref` replaced by its referent.
 *
 * Returns `schema` itself — same reference — when it contains no `$ref`, or
 * when inlining would exceed {@link EXPANSION_BUDGET} or {@link MAX_DEPTH};
 * and the same resolved object for repeated calls with the same input. Never
 * mutates the input.
 */
export function inlineLocalRefs<T>(schema: T): T {
  if (!isRecord(schema)) return schema;
  const cached = cache.get(schema);
  if (cached !== undefined) return cached as T;
  // The result is the input's own shape with references expanded, so it is
  // still a `T` to every caller that reads it as one.
  let resolved: T;
  try {
    resolved = containsRef(schema, 0)
      ? (inline(
          schema,
          { root: schema, active: new Set(), remaining: EXPANSION_BUDGET },
          0,
        ) as T)
      : schema;
  } catch (error) {
    /* v8 ignore next -- Bail is the only thing either traversal throws */
    if (!(error instanceof Bail)) throw error;
    resolved = schema;
  }
  cache.set(schema, resolved);
  return resolved;
}
