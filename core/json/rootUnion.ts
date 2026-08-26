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
  /**
   * Read only to *decline*: `additionalProperties` constrains the names its
   * **sibling** `properties` does not list, so a restrictive one at the root
   * rejects every field a branch adds. See {@link resolveRootUnion}.
   */
  additionalProperties?: unknown;
  /**
   * Read only to *decline* a member: its referent is not resolved here, so a
   * `$ref` member's constraints are unknown rather than absent.
   */
  $ref?: string;
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
  /**
   * The names **this branch itself declares** — including one the base also
   * declares, since a branch commonly *specializes* a root property (root
   * `count: {}`, branch `count: { type: "number" }`) and a renderer that showed
   * only the base's version would render the untyped one.
   */
  declaredFields: string[];
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

/** Whether a schema's `type` permits an object instance. */
function admitsObject(schema: RootUnionSchema): boolean {
  const { type } = schema;
  if (type === undefined) return true;
  return Array.isArray(type) ? type.includes("object") : type === "object";
}

/** A readable `properties` map, or `null` when the value is not one. */
function propertiesOf(schema: RootUnionSchema): Record<string, unknown> | null {
  const { properties } = schema;
  if (
    typeof properties !== "object" ||
    properties === null ||
    Array.isArray(properties)
  ) {
    return null;
  }
  return properties;
}

/**
 * Whether a branch is one a form can offer as an alternative.
 *
 * Three ways it is not, all of which would put an option in the picker that
 * cannot be filled in:
 *
 * - **It carries no fields.** A `{ type: "null" }` member — the nullable
 *   encoding {@link ./nullableUnion.ts} owns — and a `$ref`-only or empty
 *   branch render nothing.
 * - **`properties` is not an object.** Members arrive as `unknown`, so a
 *   malformed `properties: null` is reachable and would throw in `Object.keys`
 *   rather than being declined.
 * - **Its `type` rules objects out.** Tool arguments are a JSON object, so a
 *   `{ type: "string", properties: {…} }` member can never match — rendering it
 *   as a fillable form would offer a call that cannot be valid.
 */
function isOfferable(branch: RootUnionSchema): boolean {
  const properties = propertiesOf(branch);
  return (
    properties !== null &&
    Object.keys(properties).length > 0 &&
    admitsObject(branch)
  );
}

/**
 * Keywords that annotate rather than constrain. Two declarations may disagree
 * about these without describing different values, so a disagreement here is
 * not a reason to refuse to flatten.
 */
const ANNOTATION_KEYWORDS = new Set([
  "title",
  "description",
  "examples",
  "deprecated",
  "readOnly",
  "writeOnly",
  "$comment",
  // An annotation too: a suggested initial value constrains nothing, so two
  // declarations suggesting different ones still accept the same values.
  "default",
]);

/** Structural equality, via canonical JSON — enough for schema keyword values. */
function sameValue(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Whether two declarations of one property name disagree about a constraint.
 *
 * Where a base and a branch both name a property, JSON Schema applies **both**
 * — the value must satisfy the two together. A keyword only one side states is
 * therefore safe to carry across, but a keyword they state *differently* is a
 * conjunction this module cannot compute: root `minimum: 10` under branch
 * `minimum: 0` is still 10, disjoint `enum`s leave nothing satisfiable at all,
 * and `type: "string"` under `type: "number"` describes a value that cannot
 * exist. Taking either side would render a form that accepts what the schema
 * rejects, so the caller declines the composition instead.
 */
function conflicts(baseProperty: unknown, branchProperty: unknown): boolean {
  const a = toBranch(baseProperty);
  const b = toBranch(branchProperty);
  if (a === null || b === null) {
    // At least one side is not a readable schema object — JSON Schema's boolean
    // form, or something malformed. Nothing can be merged keyword-wise, so the
    // two agree only if they are the same declaration. (Only reached for a name
    // the base declares, so `baseProperty` is never simply absent here.)
    return !sameValue(baseProperty, branchProperty);
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  return Object.keys(right).some(
    (keyword) =>
      !ANNOTATION_KEYWORDS.has(keyword) &&
      keyword in left &&
      !sameValue(left[keyword], right[keyword]),
  );
}

/**
 * Merge two declarations of the same property name — a shallow union, which is
 * the whole conjunction once {@link conflicts} has ruled out a keyword the two
 * state differently.
 */
function mergeProperty(
  baseProperty: unknown,
  branchProperty: unknown,
): unknown {
  const a = toBranch(baseProperty);
  const b = toBranch(branchProperty);
  if (a === null || b === null) {
    return branchProperty;
  }
  return { ...a, ...b };
}

/**
 * Whether a member can be folded into a base schema at all.
 *
 * Two ways it cannot, both of which would have the composition keyword
 * *removed* while its constraint went unapplied — a form that submits fields
 * the schema forbids:
 *
 * - **It is not an object schema.** JSON Schema's boolean form is legal, and
 *   `allOf: [false, …]` is unsatisfiable, so silently treating a non-object
 *   member as a no-op turns "nothing is valid here" into a fillable form.
 * - **It is a `$ref`.** The referent is not resolved by this module, so its
 *   constraints are unknown rather than absent.
 */
const MERGEABLE_KEYWORDS = new Set(["type", "properties", "required"]);

function isFlattenable(member: unknown): boolean {
  const branch = toBranch(member);
  if (branch === null || !admitsObject(branch)) return false;
  // `mergeBranch` applies `properties` and `required` and nothing else, so a
  // member stating anything further would have that constraint erased along
  // with the keyword — a nested `anyOf`, a `not`, an `additionalProperties`,
  // a `$ref` whose referent is not resolved here. Only the keywords the merge
  // actually carries, plus annotations that constrain nothing, are accepted.
  return Object.keys(branch).every(
    (keyword) =>
      MERGEABLE_KEYWORDS.has(keyword) || ANNOTATION_KEYWORDS.has(keyword),
  );
}

/** Whether any property declaration of `branch` conflicts with the base's. */
function conflictsWithBase(
  base: RootUnionSchema,
  branch: RootUnionSchema,
): boolean {
  const baseProperties = propertiesOf(base) ?? {};
  const branchProperties = propertiesOf(branch) ?? {};
  return Object.entries(branchProperties).some(
    ([name, branchProperty]) =>
      // `hasOwn`, not `in`: `properties` is a JSON record, so `constructor` and
      // `toString` are legal argument names that `in` would find on
      // `Object.prototype` and report as collisions the root never declared.
      Object.hasOwn(baseProperties, name) &&
      conflicts(baseProperties[name], branchProperty),
  );
}

/**
 * Whether some property discriminates the alternatives: declared by **every**
 * member, pinned by each to a `const`, and pinned to a *different* one by each.
 * That is what makes at most one alternative matchable, which is the constraint
 * `oneOf` states and flattening cannot otherwise keep.
 *
 * When the schema names a `discriminator`, only that property is considered —
 * the author has said which one carries the distinction.
 */
function hasDiscriminator(
  members: RootUnionSchema[],
  named: string | undefined,
): boolean {
  const first = propertiesOf(members[0] ?? {}) ?? {};
  const candidates = named !== undefined ? [named] : Object.keys(first);
  return candidates.some((name) => {
    const constants = members.map((member) => {
      const property = toBranch((propertiesOf(member) ?? {})[name]) as {
        const?: unknown;
      } | null;
      return property?.const;
    });
    if (constants.some((value) => value === undefined)) return false;
    const seen = new Set(constants.map((value) => JSON.stringify(value)));
    return seen.size === constants.length;
  });
}

/**
 * Every property name the schema's composition members declare, whether or not
 * the composition could be flattened.
 *
 * A caller deciding whether a tool takes arguments at all must count these: a
 * union this module declines still *has* fields, and reporting "no fields"
 * would auto-invoke the tool with `{}` rather than asking for them.
 */
export function declaresAnyFields(
  schema: RootUnionSchema | undefined,
): boolean {
  if (schema === undefined) return false;
  if (Object.keys(propertiesOf(schema) ?? {}).length > 0) return true;
  const members = [
    ...(schema.allOf ?? []),
    ...(schema.anyOf ?? []),
    ...(schema.oneOf ?? []),
  ];
  return members.some((member) => {
    const branch = toBranch(member);
    return branch !== null && declaresAnyFields(branch);
  });
}

/**
 * Merge a composition branch's `properties` and `required` into a base schema.
 *
 * Both keywords are **conjunctive** where they meet: a value satisfying an
 * `allOf` branch satisfies the base *and* the branch, and a value matching a
 * union branch must satisfy the root's own constraints too. So properties union
 * — a name both declare merged through {@link mergeProperty} rather than
 * replaced — and `required` unions.
 */
function mergeBranch<T extends RootUnionSchema>(
  base: T,
  branch: RootUnionSchema,
): ResolvedSchema<T> {
  const baseProperties = propertiesOf(base) ?? {};
  const branchProperties = propertiesOf(branch) ?? {};
  // Built through `fromEntries` rather than by assignment: a property named
  // `__proto__` is a legal argument name, and assigning it would invoke the
  // legacy prototype setter instead of creating an own property — losing the
  // field entirely. `hasOwn` for the same reason `conflictsWithBase` uses it.
  const properties: Record<string, unknown> = Object.fromEntries([
    ...Object.entries(baseProperties),
    ...Object.entries(branchProperties).map(([name, branchProperty]) => [
      name,
      Object.hasOwn(baseProperties, name)
        ? mergeProperty(baseProperties[name], branchProperty)
        : branchProperty,
    ]),
  ]);
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
  const properties = propertiesOf(branch) ?? {};
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
 * producing a form that cannot express the call.
 *
 * A schema carrying **both** `oneOf` and `anyOf` is declined rather than
 * half-read. The two are independent keywords a value must satisfy *together*,
 * not two spellings of one union, so picking one and dropping the other builds
 * a form that silently omits real constraints — worse than the empty form this
 * module exists to replace, because it looks complete. Satisfying both honestly
 * means offering the cross product of their alternatives, which no real schema
 * has yet asked for and which produces a picker whose option labels are pairs;
 * until something does, declining leaves the root `properties` rendering
 * unchanged and claims nothing that is not true.
 */
export function resolveRootUnion<T extends RootUnionSchema>(
  schema: T,
): ResolvedRootUnion<T> {
  // `allOf` is only folded in when EVERY member can be. A member this module
  // cannot flatten would otherwise have its keyword stripped by
  // `withoutComposition` while its constraint went unapplied — so an
  // unsatisfiable `allOf: [false, …]` would render as a fillable form, and a
  // `$ref` member's constraints would read as absent rather than unknown. When
  // one cannot, nothing is flattened: the schema's own `properties` render, its
  // composition keywords stay on it, and no union is offered either, since a
  // branch would otherwise be merged against a base whose constraints are not
  // all known.
  const allOfMembers = schema.allOf ?? [];
  let merged = schema as ResolvedSchema<T>;
  for (const member of allOfMembers) {
    const branch = toBranch(member);
    // Each member is checked against what has been merged **so far**, not
    // against the original root: two members declaring `x.minimum` as 10 and 0
    // agree with a root that declares neither, while contradicting each other.
    if (
      branch === null ||
      !isFlattenable(member) ||
      conflictsWithBase(merged, branch)
    ) {
      return { base: schema as ResolvedSchema<T>, branches: [] };
    }
    merged = mergeBranch(merged, branch);
  }
  const base = withoutComposition(merged);

  if (schema.oneOf !== undefined && schema.anyOf !== undefined) {
    return { base, branches: [] };
  }
  const isExclusiveUnion = schema.oneOf !== undefined;
  const members = schema.oneOf ?? schema.anyOf ?? [];
  const branches = members.map(toBranch);
  if (
    branches.length === 0 ||
    branches.some(
      (branch) =>
        branch === null ||
        !isOfferable(branch) ||
        // The same faithfulness test the `allOf` fold applies: a member
        // carrying a constraint the merge does not copy — a nested `allOf`, a
        // `not`, a `$ref` — would have it erased along with the union keyword,
        // which can present an unsatisfiable branch as a callable one.
        !isFlattenable(branch) ||
        conflictsWithBase(base, branch),
    )
  ) {
    return { base, branches: [] };
  }

  // `additionalProperties` applies to whatever its **sibling** `properties`
  // does not name, so a restrictive one at the root rejects every field the
  // branches add — the original schema admits none of them. Flattening moves
  // those fields *beside* the keyword, where they would read as allowed, so a
  // form built from it would submit what the schema forbids.
  const additional = base.additionalProperties;
  const restrictsAdditional =
    additional === false ||
    // An EMPTY schema object is the JSON Schema equivalent of `true` — it
    // constrains nothing, so it is no reason to decline. Only a schema that
    // states something is.
    (typeof additional === "object" &&
      additional !== null &&
      Object.keys(additional).length > 0);
  const baseNames = propertiesOf(base) ?? {};
  if (
    restrictsAdditional &&
    branches.some((branch) =>
      Object.keys(propertiesOf(branch as RootUnionSchema) ?? {}).some(
        (name) => !Object.hasOwn(baseNames, name),
      ),
    )
  ) {
    return { base, branches: [] };
  }

  // `oneOf` demands that **exactly one** alternative match, which flattening
  // cannot preserve: the merged branches are offered as if any of them would
  // do. That is only safe when the alternatives are mutually exclusive by
  // construction — a discriminator, i.e. some property every branch pins to a
  // `const` of its own. Without one, two branches can accept the same
  // arguments, and a call the form calls valid is one the server refuses.
  if (
    isExclusiveUnion &&
    !hasDiscriminator(
      branches as RootUnionSchema[],
      schema.discriminator?.propertyName,
    )
  ) {
    return { base, branches: [] };
  }

  const discriminatorProperty = schema.discriminator?.propertyName;
  return {
    base,
    branches: branches
      .filter((branch): branch is RootUnionSchema => branch !== null)
      .map((branch, index) => ({
        // `base` is already composition-free and `mergeBranch` copies only
        // `properties`/`required` off the branch, so the merge stays that way.
        schema: mergeBranch(base, branch),
        label: branchLabel(branch, index, discriminatorProperty),
        declaredFields: Object.keys(propertiesOf(branch) ?? {}),
      })),
  };
}

/**
 * The index of the branch a set of values already identifies, or `null` when
 * they identify none uniquely.
 *
 * A discriminated union pins its discriminator with `const`, so values carrying
 * one name the branch they belong to. Shared because more than one caller has
 * to reach the same answer: the web form opens its picker on that branch, and
 * the defaults seeded before the values are overlaid must belong to the same
 * one, or the arguments carry a shape the picker is not showing.
 */
export function selectBranchIndex<T extends RootUnionSchema>(
  branches: RootUnionBranch<T>[],
  values: Record<string, unknown>,
): number | null {
  const matches: number[] = [];
  branches.forEach((branch, index) => {
    const pinned = Object.entries(propertiesOf(branch.schema) ?? {})
      .map(
        ([name, schema]) =>
          [
            name,
            (toBranch(schema) as { const?: unknown } | null)?.const,
          ] as const,
      )
      .filter(([, constValue]) => constValue !== undefined);
    // Only the pinned names the caller actually supplied are evidence. A
    // constant it did not supply is one this identification exists to *seed* —
    // requiring it would mean a deep link naming `kind` alone matched no branch
    // whenever the branches also pin, say, a `version`.
    const supplied = pinned.filter(([name]) => values[name] !== undefined);
    if (
      supplied.length > 0 &&
      supplied.every(([name, constValue]) => values[name] === constValue)
    ) {
      matches.push(index);
    }
  });
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) return null;

  // No discriminator settled it. A union need not have one, and values still
  // belong to a shape — so fall back to the branch whose own required fields
  // the values supply, when exactly one branch's do. Without this, values for
  // an undiscriminated branch open the picker on the first branch while the
  // required-field gate (which accepts *any* satisfied branch) lets them be
  // submitted, so the form shows one shape and sends another.
  if (Object.keys(values).length === 0) return null;
  const satisfied = branches.filter((branch) => {
    const required = branch.schema.required ?? [];
    const own = required.filter((name) => branch.declaredFields.includes(name));
    return (
      own.length > 0 &&
      own.every(
        (name) => Object.hasOwn(values, name) && values[name] !== undefined,
      )
    );
  });
  return satisfied.length === 1 ? branches.indexOf(satisfied[0]) : null;
}
