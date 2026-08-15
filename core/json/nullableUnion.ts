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

/** A `type` name the collapse is willing to produce. */
export type RenderableType = (typeof RENDERABLE_TYPES)[number];

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
  // Read only by `admitsNull`, which considers encodings the collapse itself
  // declines to flatten.
  oneOf?: readonly unknown[];
  nullable?: boolean;
}

/** Narrow an `anyOf` member to a readable object, or `null` if it isn't one. */
function toBranch(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

/**
 * Whether an `enum` is one that can be rendered as a string-valued dropdown.
 *
 * JSON Schema's `enum` is untyped — `[1, 2]`, `[true, false]`, and `[null]` are
 * all legal — so a bare `{ enum: [...] }` does **not** imply strings. Guessing
 * `"string"` for a numeric enum would hand non-strings to a renderer that has
 * declared them `string[]`: the web `Select` would receive numbers, and the TUI
 * would `String(...)` them and submit `"1"` where the server expects `1`. So
 * only an all-string enum earns the inference; anything else stays on the
 * fallback path, which renders the value honestly as JSON.
 *
 * Exported because the same question decides whether a *dispatcher* may route
 * an enum to a select at all. The TUI's does, and its options are stringified,
 * so an unguarded numeric enum there submits `"1"` where the server wants `1`.
 */
export function isStringEnum(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((member) => typeof member === "string")
  );
}

/**
 * The result of a collapse that actually matched. Spelled out rather than
 * reusing `T` because the collapse genuinely changes two of `T`'s fields:
 * `type` becomes a single renderable name (never an array, never `"null"`),
 * and `anyOf` is cleared. Returning `T` for these would let a caller whose `T`
 * types `type` as an array go on treating it as one after it has become a
 * string, or dereference an `anyOf` that is now `undefined`.
 *
 * Note this cannot make the *hoist* sound: an `anyOf` branch is `unknown`, so
 * any keyword lifted off it is whatever the server sent, however `T` declares
 * it. {@link isStringEnum} validates the one keyword the renderers dereference
 * as a typed array (`enum`); the rest reach widgets that read them defensively.
 */
export type NormalizedNullableUnion<T extends NullableUnionSchema> = Omit<
  T,
  "type" | "anyOf"
> & {
  type?: RenderableType;
  anyOf?: undefined;
  nullable?: boolean;
};

/**
 * Drop a `null` sentinel from an `enum`, since the collapse has already moved
 * that fact onto `nullable`.
 *
 * The `type: [T, "null"]` encoding keeps its keywords at the top level, so a
 * nullable enum written that way carries the null *inside* the list:
 * `{ type: ["string", "null"], enum: ["envio", "recebimento", null] }`. Leaving
 * it there breaks both renderers in different ways — the web dispatcher would
 * hand `null` to Mantine as option data, and the TUI's all-strings check would
 * reject the whole enum and fall back to a plain text field. Neither is the
 * dropdown the schema is asking for.
 *
 * Returns `undefined` when nothing but `null` was in the list: an enum of only
 * `null` permits no value a dropdown could offer, so the field is better served
 * by its plain widget than by an empty select.
 */
function stripNullFromEnum(value: unknown): unknown[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const members = value.filter((member) => member !== null);
  return members.length > 0 ? members : undefined;
}

/**
 * Build the collapsed schema.
 *
 * The assertion is needed because the spread merges an unresolved generic `T`
 * with an `unknown` branch, and `NormalizedNullableUnion<T>`'s `Omit` stays
 * deferred while `T` is open — so TS cannot verify the two line up even though
 * every field is set right here. Isolated in this one function so the exported
 * signature carries the contract and nothing else has to assert it.
 */
function collapsed<T extends NullableUnionSchema>(
  schema: T,
  branch: Record<string, unknown> | undefined,
  type: RenderableType,
): NormalizedNullableUnion<T> {
  const merged = { ...schema, ...branch };
  return {
    ...merged,
    type,
    anyOf: undefined,
    nullable: true,
    // `enum` is read after the spread so the branch's list wins when it has
    // one, and the null sentinel is stripped either way.
    ...(merged.enum === undefined
      ? {}
      : { enum: stripNullFromEnum(merged.enum) }),
  } as NormalizedNullableUnion<T>;
}

/**
 * Whether a schema permits an explicit `null`.
 *
 * Deliberately **independent of {@link normalizeNullableUnion}**, which is a
 * *renderer* question — "can this become one widget?" — and is therefore
 * narrower on purpose: it only collapses a two-member union. Null admission is
 * a *validity* question and has no such limit, so
 * `anyOf: [{ type: "string" }, { type: "number" }, { type: "null" }]` admits
 * null even though it renders through the JSON fallback. Deriving one from the
 * other would make a form reject a value its own schema accepts, which is why
 * these are two functions rather than a `.nullable` flag read off the collapse.
 *
 * Recognizes every encoding the collapse does, plus the ones it declines:
 * `nullable: true`, `type: "null"`, `type: [..., "null"]`, and a `"null"`
 * branch anywhere in an `anyOf` or `oneOf` of any size.
 */
export function admitsNull(schema: NullableUnionSchema): boolean {
  if (schema.nullable === true) {
    return true;
  }
  if (schema.type === "null") {
    return true;
  }
  if (Array.isArray(schema.type) && schema.type.includes("null")) {
    return true;
  }
  return [schema.anyOf, schema.oneOf].some((branches) =>
    branches?.some((entry) => {
      const branch = toBranch(entry);
      if (branch === null) {
        return false;
      }
      return (
        branch.type === "null" ||
        (Array.isArray(branch.type) && branch.type.includes("null"))
      );
    }),
  );
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
): T | NormalizedNullableUnion<T> {
  if (schema.anyOf?.length === 2) {
    const branches = schema.anyOf.map(toBranch);
    const nullBranch = branches.find((entry) => entry?.type === "null");
    const branch = branches.find(
      (entry) => entry !== null && entry.type !== "null",
    );

    if (nullBranch && branch) {
      // A branch may carry an `enum` and no `type`; JSON Schema allows that, and
      // an all-string enum is unambiguously a string field. See isStringEnum for
      // why a non-string enum deliberately does not get the same treatment.
      const type =
        branch.type ?? (isStringEnum(branch.enum) ? "string" : undefined);
      if (isRenderableType(type)) {
        return collapsed(schema, branch, type);
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
      return collapsed(schema, undefined, type);
    }
  }

  return schema;
}
