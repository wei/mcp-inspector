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
 * - **Sibling keywords win over the referent's.** `{ $ref, description }` is
 *   exactly what `.optional().describe(…)` on a shared instance produces, and
 *   the description written at the use site is the one the user should see.
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
  "$defs",
  "definitions",
]);

type JsonRecord = Record<string, unknown>;

/** Whether `key` holds data rather than a subschema, in a schema object. */
function isDataKey(key: string, inNameMap: boolean): boolean {
  return !inNameMap && DATA_KEYWORDS.has(key);
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The referent of a `#/…` JSON Pointer within `root`, or `undefined`. */
function resolvePointer(root: unknown, ref: string): unknown {
  if (ref === "#") return root;
  if (!ref.startsWith("#/")) return undefined;
  let current: unknown = root;
  for (const raw of ref.slice(2).split("/")) {
    let decoded: string;
    try {
      // A fragment is URI-encoded (`#/$defs/a%20b`) before it is a pointer.
      decoded = decodeURIComponent(raw);
    } catch {
      return undefined;
    }
    // RFC 6901 escaping, `~1` before `~0` so `~01` decodes to `~1`.
    const segment = decoded.replace(/~1/g, "/").replace(/~0/g, "~");
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

function inline(node: unknown, root: unknown, active: Set<string>): unknown {
  if (Array.isArray(node)) {
    return node.map((item) => inline(item, root, active));
  }
  if (!isRecord(node)) return node;

  const ref = node.$ref;
  if (typeof ref === "string" && !active.has(ref)) {
    const target = resolvePointer(root, ref);
    if (isRecord(target)) {
      active.add(ref);
      const resolved = inline(target, root, active) as JsonRecord;
      active.delete(ref);
      const siblings: JsonRecord = { ...node };
      delete siblings.$ref;
      return { ...resolved, ...inlineEntries(siblings, root, active, false) };
    }
  }
  return inlineEntries(node, root, active, false);
}

function inlineEntries(
  node: JsonRecord,
  root: unknown,
  active: Set<string>,
  inNameMap: boolean,
): JsonRecord {
  const result: JsonRecord = {};
  for (const [key, value] of Object.entries(node)) {
    let next: unknown = value;
    if (inNameMap) {
      next = inline(value, root, active);
    } else if (NAME_MAP_KEYWORDS.has(key) && isRecord(value)) {
      next = inlineEntries(value, root, active, true);
    } else if (!isDataKey(key, false)) {
      next = inline(value, root, active);
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
 * Returns `schema` itself — same reference — when it contains no `$ref`, and
 * the same resolved object for repeated calls with the same input. Never
 * mutates the input.
 */
export function inlineLocalRefs<T>(schema: T): T {
  if (!isRecord(schema) || !containsRef(schema)) return schema;
  const cached = cache.get(schema);
  if (cached !== undefined) return cached as T;
  // The result is the input's own shape with references expanded, so it is
  // still a `T` to every caller that reads it as one.
  const resolved = inline(schema, schema, new Set()) as T;
  cache.set(schema, resolved);
  return resolved;
}
