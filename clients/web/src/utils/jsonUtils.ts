import {
  admitsNull,
  normalizeNullableUnion,
} from "@inspector/core/json/nullableUnion.js";
import {
  resolveRootUnion,
  selectBranchIndex,
} from "@inspector/core/json/rootUnion.js";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonSchemaConst = {
  const: JsonValue;
  title?: string;
  description?: string;
};

export type InspectorFormSchema = {
  type?:
    | "string"
    | "number"
    | "integer"
    | "boolean"
    | "array"
    | "object"
    | "null"
    | (
        | "string"
        | "number"
        | "integer"
        | "boolean"
        | "array"
        | "object"
        | "null"
      )[];
  title?: string;
  description?: string;
  required?: string[];
  default?: JsonValue;
  properties?: Record<string, InspectorFormSchema>;
  items?: InspectorFormSchema;
  // Array validation constraints
  minItems?: number;
  maxItems?: number;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  nullable?: boolean;
  pattern?: string;
  format?: string;
  enum?: string[];
  // Non-standard legacy support: titles for enum values
  enumNames?: string[];
  const?: JsonValue;
  oneOf?: (InspectorFormSchema | JsonSchemaConst)[];
  anyOf?: (InspectorFormSchema | JsonSchemaConst)[];
  // Root composition the form flattens before rendering (#2123). `allOf` is
  // merged into the schema; `oneOf`/`anyOf` at the root become the branches the
  // Variant picker chooses between, labelled via `discriminator` when present.
  allOf?: InspectorFormSchema[];
  discriminator?: { propertyName?: string };
  $ref?: string;
};

export type JsonObject = { [key: string]: JsonValue };

/**
 * Narrow an MCP protocol schema (SDK `JsonSchemaType` — e.g. `Tool["inputSchema"]`
 * / `outputSchema`, an elicitation `requestedSchema`) to the {@link
 * InspectorFormSchema} subset the {@link SchemaForm} renderer understands.
 *
 * Under SDK v2 the protocol schema type (from `json-schema-typed`, exported as
 * `JsonSchemaType` from `@modelcontextprotocol/client`) is structurally distinct
 * from Inspector's form schema — same JSON on the wire, incompatible TS types.
 * Rather than cast at every call site, callers pass the SDK schema through here.
 * Returns `null` when there is no renderable object shape (missing schema, or a
 * non-object schema the form can't build fields from); callers handle `null`.
 */
export function toFormSchema(schema: unknown): InspectorFormSchema | null {
  if (schema == null || typeof schema !== "object" || Array.isArray(schema)) {
    return null;
  }
  // Structural narrow: the SDK schema's fields are a superset of what the form
  // reads (`type`, `properties`, `required`, `items`, …); the values the form
  // never dereferences don't affect rendering.
  return schema as InspectorFormSchema;
}

export type DataType =
  | "string"
  | "number"
  | "bigint"
  | "boolean"
  | "symbol"
  | "undefined"
  | "object"
  | "function"
  | "array"
  | "null";

/**
 * Determines the specific data type of a JSON value
 * @param value The JSON value to analyze
 * @returns The specific data type including "array" and "null" as distinct types
 */
export function getDataType(value: JsonValue): DataType {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

/**
 * Collect a schema's default field values into a values object. A schema form
 * displays defaults but only writes a field into its `values` once the user
 * edits it, so an untouched default would otherwise be absent from a
 * submission. Seeding form state with this keeps default-only fields in the
 * submitted result (parity with v1). Recurses into nested object schemas and
 * omits fields that have no default.
 */
export function collectSchemaDefaults(
  schema: InspectorFormSchema,
  knownValues: Record<string, unknown> = {},
): Record<string, unknown> {
  // Seed from the shape the form actually renders: root `allOf` merged in, and
  // for a root union the branch the picker will open on (#2123). Seeding every
  // branch would put fields of shapes the call is not making into the
  // arguments; seeding none would leave the branch's defaults — its
  // discriminator `const` among them — displayed but never submitted.
  //
  // `knownValues` is for a caller that already holds arguments it is about to
  // overlay on these defaults, as the App deep link does with its `appArgs`.
  // Those values can name a branch other than the first through its
  // discriminator, and seeding the first branch's defaults underneath them
  // would leave another shape's fields in the submitted arguments, invisible
  // to a form showing the branch the values actually identify.
  const { base, branches } = resolveRootUnion(schema);
  const selected = selectBranchIndex(branches, knownValues) ?? 0;
  const properties = (branches[selected]?.schema ?? base).properties ?? {};
  const result: Record<string, unknown> = {};
  for (const [fieldName, rawSchema] of Object.entries(properties)) {
    // Collapse a nullable union first, for the same reason `SchemaForm` does:
    // a nested object's `properties` live on the union's surviving branch, so
    // without this the form would *display* a hoisted default that never
    // reached the seeded values — the field would submit empty (#1928).
    const fieldSchema = normalizeNullableUnion(rawSchema);
    if (fieldSchema.const !== undefined) {
      // `const` is a one-value enumeration, so the only submittable value is
      // already known — seeding it spares the user hand-typing a discriminator
      // the schema has fixed (#2123).
      //
      // It outranks `default`, which JSON Schema defines as an annotation
      // rather than a constraint: a schema may advertise a default its own
      // `const` rejects, and seeding that would submit an invalid argument
      // through a field rendered read-only, leaving the user no way to correct
      // it.
      result[fieldName] = fieldSchema.const;
    } else if (fieldSchema.default !== undefined) {
      result[fieldName] = fieldSchema.default;
    } else if (fieldSchema.type === "object" && fieldSchema.properties) {
      const nested = collectSchemaDefaults(fieldSchema);
      if (Object.keys(nested).length > 0) {
        result[fieldName] = nested;
      }
    }
  }
  return result;
}

/**
 * Overwrite every `const`-pinned field with the value its schema fixes.
 *
 * The form renders such a field read-only, so a value disagreeing with it can
 * only have come from outside the form — an App deep link's `appArgs`, which
 * are spread over the seeded defaults and would otherwise leave the arguments
 * claiming a shape the user is being shown the opposite of (#2123). Apply this
 * *after* any such overlay.
 *
 * The branch is chosen the same way {@link collectSchemaDefaults} chooses it,
 * from the values themselves, so the constants applied belong to the shape the
 * form will display.
 */
export function applySchemaConstants(
  schema: InspectorFormSchema,
  values: Record<string, unknown>,
): Record<string, unknown> {
  const { base, branches } = resolveRootUnion(schema);
  const selected = selectBranchIndex(branches, values) ?? 0;
  const properties = (branches[selected]?.schema ?? base).properties ?? {};
  const pinned = Object.entries(properties).filter(
    ([, fieldSchema]) => fieldSchema.const !== undefined,
  );
  if (pinned.length === 0) return values;
  return Object.fromEntries([
    ...Object.entries(values),
    ...pinned.map(([name, fieldSchema]) => [name, fieldSchema.const]),
  ]);
}

/**
 * Whether any of the schema's required top-level fields is missing a value in
 * `values` (absent, null, or empty string). Used to gate a form's submit
 * action until required fields are supplied.
 *
 * `null` counts as missing only for a field that does not admit it. JSON
 * Schema's `required` constrains *presence*, not content, so a required field
 * whose schema is a nullable union is satisfied by an explicit `null` — and
 * since #1928 the user can produce exactly that by clearing a nullable enum.
 * Treating it as missing would leave the form's submit permanently disabled on
 * a value the schema calls valid.
 *
 * The test is `admitsNull`, **not** whether the renderer's collapse recognized
 * the field. Those differ: the collapse only handles a two-member union, so a
 * three-member `anyOf: [string, number, null]` renders through the JSON
 * fallback — where a user can still type `null` — while plainly admitting it.
 * Gating on the collapse would reject a value the schema accepts.
 */
export function hasMissingRequiredFields(
  schema: InspectorFormSchema,
  values: Record<string, unknown>,
): boolean {
  // Root composition first, so a schema keeping its `required` on branches is
  // gated at all (#2123). For a union the answer is selection-independent by
  // construction: valid arguments must satisfy *some* branch, so the submit is
  // blocked only when **every** branch is still missing something. That is
  // deliberately weaker than gating on the branch the picker is showing — this
  // function is handed `values`, never the selection — but it is sound in the
  // direction that matters: it never blocks arguments the schema accepts.
  const { base, branches } = resolveRootUnion(schema);
  if (branches.length > 0) {
    return branches.every((branch) => hasMissingIn(branch.schema, values));
  }
  return hasMissingIn(base, values);
}

/** {@link hasMissingRequiredFields} against one already-flattened schema. */
function hasMissingIn(
  schema: InspectorFormSchema,
  values: Record<string, unknown>,
): boolean {
  const required = schema.required ?? [];
  const properties = schema.properties ?? {};
  return required.some((field) => {
    const value = values[field];
    if (value === null) {
      const fieldSchema = properties[field];
      return fieldSchema === undefined ? true : !admitsNull(fieldSchema);
    }
    return value === undefined || value === "";
  });
}

/**
 * Attempts to parse a string as JSON, only for objects and arrays
 * @param str The string to parse
 * @returns Object with success boolean and either parsed data or original string
 */
export function tryParseJson(str: string): {
  success: boolean;
  data: JsonValue;
} {
  const trimmed = str?.trim();
  if (
    trimmed &&
    !(trimmed.startsWith("{") && trimmed.endsWith("}")) &&
    !(trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    return { success: false, data: str };
  }
  try {
    return { success: true, data: JSON.parse(str) };
  } catch {
    return { success: false, data: str };
  }
}

/**
 * Updates a value at a specific path in a nested JSON structure
 * @param obj The original JSON value
 * @param path Array of keys/indices representing the path to the value
 * @param value The new value to set
 * @returns A new JSON value with the updated path
 */
export function updateValueAtPath(
  obj: JsonValue,
  path: string[],
  value: JsonValue,
): JsonValue {
  if (path.length === 0) return value;

  if (obj === null || obj === undefined) {
    obj = !isNaN(Number(path[0])) ? [] : {};
  }

  if (Array.isArray(obj)) {
    return updateArray(obj, path, value);
  } else if (typeof obj === "object" && obj !== null) {
    return updateObject(obj as JsonObject, path, value);
  } else {
    console.error(
      `Cannot update path ${path.join(".")} in non-object/array value:`,
      obj,
    );
    return obj;
  }
}

/**
 * Updates an array at a specific path
 */
function updateArray(
  array: JsonValue[],
  path: string[],
  value: JsonValue,
): JsonValue[] {
  const [index, ...restPath] = path;
  const arrayIndex = Number(index);

  if (isNaN(arrayIndex)) {
    console.error(`Invalid array index: ${index}`);
    return array;
  }

  if (arrayIndex < 0) {
    console.error(`Array index out of bounds: ${arrayIndex} < 0`);
    return array;
  }

  let newArray: JsonValue[] = [];
  for (let i = 0; i < array.length; i++) {
    newArray[i] = i in array ? array[i] : null;
  }

  if (arrayIndex >= newArray.length) {
    const extendedArray: JsonValue[] = new Array(arrayIndex).fill(null);
    // Copy over the existing elements (now guaranteed to be dense)
    for (let i = 0; i < newArray.length; i++) {
      extendedArray[i] = newArray[i];
    }
    newArray = extendedArray;
  }

  if (restPath.length === 0) {
    newArray[arrayIndex] = value;
  } else {
    newArray[arrayIndex] = updateValueAtPath(
      newArray[arrayIndex],
      restPath,
      value,
    );
  }
  return newArray;
}

/**
 * Updates an object at a specific path
 */
function updateObject(
  obj: JsonObject,
  path: string[],
  value: JsonValue,
): JsonObject {
  const [key, ...restPath] = path;

  // Validate object key
  if (typeof key !== "string") {
    console.error(`Invalid object key: ${key}`);
    return obj;
  }

  const newObj = { ...obj };

  if (restPath.length === 0) {
    newObj[key] = value;
  } else {
    // Ensure key exists
    if (!(key in newObj)) {
      newObj[key] = {};
    }
    newObj[key] = updateValueAtPath(newObj[key], restPath, value);
  }
  return newObj;
}

/**
 * Gets a value at a specific path in a nested JSON structure
 * @param obj The JSON value to traverse
 * @param path Array of keys/indices representing the path to the value
 * @param defaultValue Value to return if path doesn't exist
 * @returns The value at the path, or defaultValue if not found
 */
export function getValueAtPath(
  obj: JsonValue,
  path: string[],
  defaultValue: JsonValue = null,
): JsonValue {
  if (path.length === 0) return obj;

  const [first, ...rest] = path;

  if (obj === null || obj === undefined) {
    return defaultValue;
  }

  if (Array.isArray(obj)) {
    const index = Number(first);
    if (isNaN(index) || index < 0 || index >= obj.length) {
      return defaultValue;
    }
    return getValueAtPath(obj[index], rest, defaultValue);
  }

  if (typeof obj === "object" && obj !== null) {
    if (!(first in obj)) {
      return defaultValue;
    }
    return getValueAtPath((obj as JsonObject)[first], rest, defaultValue);
  }

  return defaultValue;
}
