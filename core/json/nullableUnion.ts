/**
 * Flattening of the two JSON Schema encodings of "this type, **or** null" into
 * the plain type a form renderer can dispatch on.
 *
 * Shared because both form builders — the web client's `SchemaForm` and the
 * TUI's `schemaToForm` — dispatch on a *single* `type` string, and so both miss
 * a nullable field entirely without this step (#1928, #2015). Keeping one copy
 * is what stops the two clients from disagreeing about which schemas they can
 * render; the alternative was two implementations of the same subtle predicate.
 */

/**
 * JSON Schema type names a form renderer can build a widget for.
 *
 * `"null"` is deliberately absent: it is the branch a nullable union is being
 * flattened *away* from, and there is no widget for a field whose only
 * permitted value is `null`.
 */
const RENDERABLE_TYPES = [
  "string",
  "number",
  "integer",
  "boolean",
  "array",
  "object",
] as const;

type RenderableType = (typeof RENDERABLE_TYPES)[number];

function isRenderableType(type: unknown): type is RenderableType {
  return RENDERABLE_TYPES.includes(type as RenderableType);
}

/**
 * The keywords {@link normalizeNullableUnion} reads. Both clients' own schema
 * types are structurally assignable to this, so neither has to adopt the
 * other's — the shape is deliberately the minimum needed to *recognize* a
 * nullable union, not a full JSON Schema model.
 */
export interface NullableUnionSchema {
  type?: string | string[];
  enum?: unknown[];
  anyOf?: readonly unknown[];
}

/** Narrow an `anyOf` member to a readable object, or `null` if it isn't one. */
function toBranch(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

/**
 * Collapse a nullable union — what Zod's `.nullish()` / `.nullable()` and
 * FastMCP's optional arguments emit — into `{ type: <T>, nullable: true }`.
 *
 * Two encodings mean the same thing and are both handled:
 *
 * - `anyOf: [<branch>, { type: "null" }]` — the branch's *own* keywords are
 *   hoisted onto the result, because that is where the detail a renderer needs
 *   lives. A nullable enum compiles to
 *   `anyOf: [{ type: "string", enum: [...] }, { type: "null" }]`, so hoisting
 *   `enum` is what makes it a dropdown rather than a raw-JSON fallback (#1928).
 *   The branch also wins over the wrapper on any shared key, matching v1.x.
 * - `type: [<T>, "null"]` — the keywords already sit at the top level, so only
 *   `type` collapses.
 *
 * Anything else — a union of two real types, a three-member `anyOf`, a branch
 * whose type has no widget — is returned **by identity**, so a caller can use
 * `===` to tell that nothing was recognized.
 *
 * @param schema The schema to normalize
 * @returns A flattened copy, or `schema` itself when no nullable-union pattern
 *   matches
 */
export function normalizeNullableUnion<T extends NullableUnionSchema>(
  schema: T,
): T {
  if (schema.anyOf?.length === 2) {
    const branches = schema.anyOf.map(toBranch);
    const nullBranch = branches.find((entry) => entry?.type === "null");
    const branch = branches.find(
      (entry) => entry !== null && entry.type !== "null",
    );

    if (nullBranch && branch) {
      // A bare `{ enum: [...] }` branch carries no `type`; JSON Schema allows
      // that, and every value such a schema admits here is a string.
      const type = branch.type ?? (branch.enum ? "string" : undefined);
      if (isRenderableType(type)) {
        // The result is `schema` with `type` narrowed to a value it already
        // admitted, the branch's keywords merged in, and `nullable` added. TS
        // cannot express "a spread of T and a subset of T is still a T", and a
        // non-generic return would force every caller to cast instead.
        return {
          ...schema,
          ...branch,
          type,
          anyOf: undefined,
          nullable: true,
        } as T;
      }
    }
  }

  if (
    Array.isArray(schema.type) &&
    schema.type.length === 2 &&
    schema.type.includes("null")
  ) {
    const type = schema.type.find((member) => member !== "null");
    if (isRenderableType(type)) {
      // Same reasoning as above.
      return { ...schema, type, nullable: true } as T;
    }
  }

  return schema;
}
