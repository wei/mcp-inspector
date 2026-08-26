/**
 * Flattening of the JSON Schema **composition** keywords that a tool's
 * `inputSchema` may carry at its **root** — `allOf`, and a top-level `anyOf` /
 * `oneOf` union — into the plain object schema a form renderer can build fields
 * from.
 *
 * Both form builders — the web client's `SchemaForm` and the TUI's
 * `schemaToForm` — enumerate the root schema's `properties` and nothing else.
 * A schema that keeps its fields on composition branches therefore rendered
 * **no controls at all**: not a branch picker, not even the raw-JSON fallback a
 * union-typed *property* already gets, so the tool could only ever be called
 * with empty arguments (#2123). The 2026-07-28 revision makes such a schema
 * explicitly legal — `type: "object"` is required at the root, and "any JSON
 * Schema 2020-12 keyword may appear alongside `type`, including composition
 * keywords".
 *
 * Shared for the same reason {@link ./nullableUnion.ts} is: the two clients
 * would otherwise grow separate answers to "which schemas can I render", and
 * the CLI's argument coercion (`convertToolParameters`) needs the same view of
 * where a property's schema lives.
 *
 * Deliberately **not** a JSON Schema evaluator. It rewrites nothing it cannot
 * do faithfully: `not`, and branches that are not object schemas, are left
 * alone rather than guessed at (see {@link resolveRootUnion}).
 */

/**
 * The keywords this module reads. Both clients' own schema types are
 * structurally assignable to this — the shape is the minimum needed to
 * *recognize* root composition, not a full JSON Schema model.
 */
export interface RootUnionSchema {
  type?: string | string[];
  title?: string;
  properties?: Record<string, unknown>;
  required?: string[];
  allOf?: readonly unknown[];
  anyOf?: readonly unknown[];
  oneOf?: readonly unknown[];
  /**
   * OpenAPI's discriminator, which real servers emit beside `oneOf` (the issue's
   * own repro does). Read only to *label* a branch — never to validate.
   */
  discriminator?: { propertyName?: string };
}

/**
 * What a resolved schema is: the caller's own type, intersected with the
 * keywords this module may have *added* to it.
 *
 * The intersection is load-bearing rather than decorative. A schema that keeps
 * every field on a branch declares no `properties` of its own, so returning the
 * caller's `T` unchanged would hand back a type on which `properties` does not
 * exist — precisely the property the flattening was performed to produce.
 */
export type ResolvedSchema<T extends RootUnionSchema> = T & RootUnionSchema;

/** One selectable alternative of a root union. */
export interface RootUnionBranch<T extends RootUnionSchema> {
  /**
   * The base schema merged with this branch: the object schema a renderer
   * builds fields from while this alternative is selected.
   */
  schema: ResolvedSchema<T>;
  /** Human-readable name for the picker — see {@link branchLabel}. */
  label: string;
  /** Names this branch contributes that the base does not. */
  ownFields: string[];
}

/** What {@link resolveRootUnion} decomposes a root schema into. */
export interface ResolvedRootUnion<T extends RootUnionSchema> {
  /**
   * The schema without its composition keywords: the root's own `properties` /
   * `required` with every `allOf` branch merged in. Renderable on its own, and
   * what a renderer uses when there is no union.
   */
  base: ResolvedSchema<T>;
  /**
   * One entry per union alternative, or **empty** when the root carries no
   * usable union — which is the overwhelmingly common case, so callers can
   * treat a non-empty array as "this schema needs a branch picker".
   */
  branches: RootUnionBranch<T>[];
}

/** Narrow a composition member to a readable object, or `null` if it isn't one. */
function toBranch(value: unknown): RootUnionSchema | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as RootUnionSchema;
}

/**
 * Whether a branch contributes anything a form can render.
 *
 * A `{ type: "null" }` member — the nullable encoding {@link
 * ./nullableUnion.ts} owns — and a `$ref`-only or empty branch carry no
 * properties, so offering them as alternatives would produce a picker whose
 * options render nothing.
 */
function hasFields(branch: RootUnionSchema): boolean {
  return (
    branch.properties !== undefined && Object.keys(branch.properties).length > 0
  );
}

/**
 * Merge a composition branch's `properties` and `required` into a base schema.
 *
 * Both keywords are **conjunctive** where they meet: a value satisfying an
 * `allOf` branch satisfies the base *and* the branch, and a value matching a
 * union branch must satisfy the root's own constraints too. So properties union
 * (branch wins a name collision, being the more specific declaration) and
 * `required` unions.
 */
function mergeBranch<T extends RootUnionSchema>(
  base: T,
  branch: RootUnionSchema,
): ResolvedSchema<T> {
  const properties = { ...base.properties, ...branch.properties };
  const required = [
    ...(base.required ?? []),
    ...(branch.required ?? []).filter(
      (name) => !(base.required ?? []).includes(name),
    ),
  ];
  // One cast, owned here: a branch member is `unknown` on the wire, so its
  // property schemas are whatever the server sent however `T` declares them —
  // exactly the situation `normalizeNullableUnion`'s hoist documents. Every
  // consumer reads a property schema defensively, and the merged object is
  // otherwise structurally `T`.
  return {
    ...base,
    ...(Object.keys(properties).length > 0 ? { properties } : {}),
    ...(required.length > 0 ? { required } : {}),
  } as ResolvedSchema<T>;
}

/** Strip the composition keywords a resolved schema has absorbed. */
function withoutComposition<T extends RootUnionSchema>(
  schema: T,
): ResolvedSchema<T> {
  const { allOf: _allOf, anyOf: _anyOf, oneOf: _oneOf, ...rest } = schema;
  return rest as ResolvedSchema<T>;
}

/**
 * A branch's display name, in decreasing order of how deliberate it is:
 *
 * 1. the branch's own `title` — the author naming it outright;
 * 2. the `const` of the discriminator property, when the root names one;
 * 3. the `const` of the branch's only constant-valued property, which is what a
 *    discriminated union looks like without an OpenAPI `discriminator` (the
 *    `kind: { const: "email" }` shape) — restricted to a *single* candidate, so
 *    a branch with several constants is not labelled by an arbitrary one;
 * 4. a positional fallback.
 */
function branchLabel(
  branch: RootUnionSchema,
  index: number,
  discriminatorProperty: string | undefined,
): string {
  if (typeof branch.title === "string" && branch.title.trim() !== "") {
    return branch.title;
  }
  const properties = branch.properties ?? {};
  const constOf = (name: string): string | null => {
    const property = toBranch(properties[name]) as { const?: unknown } | null;
    const value = property?.const;
    return typeof value === "string" || typeof value === "number"
      ? String(value)
      : null;
  };
  if (discriminatorProperty !== undefined) {
    const value = constOf(discriminatorProperty);
    if (value !== null) return value;
  }
  const constants = Object.keys(properties)
    .map((name) => constOf(name))
    .filter((value): value is string => value !== null);
  if (constants.length === 1) return constants[0];
  return `Option ${index + 1}`;
}

/**
 * Decompose a root schema into the object schema a form renders and, when the
 * root is a union, the alternatives a picker offers.
 *
 * `allOf` is merged unconditionally — its branches are conjunctive, so there is
 * one correct rendering and no choice to present. A `oneOf` / `anyOf` becomes
 * `branches` only when **every** member is an object schema carrying fields:
 * a union mixing renderable and unrenderable members would give a picker
 * options that show nothing, and the whole point of this module is to stop
 * producing a form that cannot express the call. `oneOf` wins when a schema
 * carries both, being the stricter of the two.
 */
export function resolveRootUnion<T extends RootUnionSchema>(
  schema: T,
): ResolvedRootUnion<T> {
  const merged = (schema.allOf ?? []).reduce<ResolvedSchema<T>>(
    (acc, member) => {
      const branch = toBranch(member);
      return branch === null ? acc : mergeBranch(acc, branch);
    },
    schema as ResolvedSchema<T>,
  );
  const base = withoutComposition(merged);

  const members = schema.oneOf ?? schema.anyOf ?? [];
  const branches = members.map(toBranch);
  if (
    branches.length === 0 ||
    branches.some((branch) => branch === null || !hasFields(branch))
  ) {
    return { base, branches: [] };
  }

  const discriminatorProperty = schema.discriminator?.propertyName;
  const baseFields = new Set(Object.keys(base.properties ?? {}));
  return {
    base,
    branches: branches
      .filter((branch): branch is RootUnionSchema => branch !== null)
      .map((branch, index) => ({
        // `base` is already composition-free and `mergeBranch` copies only
        // `properties`/`required` off the branch, so the merge stays that way.
        schema: mergeBranch(base, branch),
        label: branchLabel(branch, index, discriminatorProperty),
        ownFields: Object.keys(branch.properties ?? {}).filter(
          (name) => !baseFields.has(name),
        ),
      })),
  };
}
