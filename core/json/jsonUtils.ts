import type { Tool } from "@modelcontextprotocol/client";
import { resolveRootUnion } from "./rootUnion.js";

/**
 * JSON value type used across the inspector project
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

/**
 * A JSON value that survives serialization unchanged — {@link JsonValue}
 * without `undefined`.
 *
 * `JsonValue` admits `undefined` because it is also used for *arguments*, where
 * it usefully means "this field was not supplied". That meaning does not carry
 * to a payload the Inspector promises to transmit verbatim: `JSON.stringify`
 * drops an `undefined` object member entirely and rewrites an `undefined` array
 * element to `null`, so a value the type accepted is not the value that arrives.
 *
 * Used for `_meta` (#1910), whose whole contract is that any JSON the user
 * writes reaches the wire as written.
 */
export type StrictJsonValue =
  | string
  | number
  | boolean
  | null
  | StrictJsonValue[]
  | { [key: string]: StrictJsonValue };

export type StrictJsonObject = { [key: string]: StrictJsonValue };

/**
 * Whether a value is JSON that survives `JSON.stringify` unchanged.
 *
 * {@link StrictJsonValue} is the *type*-level half of this and cannot express
 * the rest: TypeScript has one `number`, but JSON has no encoding for `NaN` or
 * `±Infinity`, so `JSON.stringify` rewrites them to `null`.
 *
 * That is reachable from ordinary input, not just from a careless caller —
 * `JSON.parse("1e400")` returns `Infinity` on overflow, so text a user typed
 * parses successfully, satisfies the type, and then reaches the wire as `null`
 * while the editor still shows what they wrote. Checking at the boundary is the
 * only place the distinction exists.
 */
export function isSerializableJson(value: unknown): value is StrictJsonValue {
  if (value === null) return true;
  switch (typeof value) {
    case "string":
    case "boolean":
      return true;
    case "number":
      // Rejects NaN and ±Infinity; every other number round-trips.
      return Number.isFinite(value);
    case "object":
      return Array.isArray(value)
        ? value.every(isSerializableJson)
        : Object.values(value as Record<string, unknown>).every(
            isSerializableJson,
          );
    default:
      // `undefined`, functions, symbols and bigints are not JSON at all.
      return false;
  }
}

/**
 * Widen a typed object to a generic string-keyed record so its keys can be
 * iterated or read/written generically. Many of the project's config/SDK types
 * (`StoredMCPServer`, `MCPServerConfig`, `pino.Logger`, DOM `Window`, …) have no
 * index signature, so a direct `value as Record<string, unknown>` at a call
 * site is a TS2352 error that would otherwise force an `as unknown as` double
 * cast. Taking the argument as the general `object` type makes the single `as`
 * legal — `Record<string, unknown>` is assignable to `object`, so the two types
 * sufficiently overlap — letting this one audited spot own the widening while
 * the double casts stay out of the call sites. Purely a structural view of the
 * same object; no runtime effect.
 */
export function toRecord(value: object): Record<string, unknown> {
  return value as Record<string, unknown>;
}

/**
 * Simple schema type for parameter conversion
 */
type ParameterSchema = {
  type?: string;
};

/**
 * Convert a string parameter value to the appropriate JSON type based on schema
 */
export function convertParameterValue(
  value: string,
  schema: ParameterSchema,
): JsonValue {
  if (!value) {
    return value;
  }

  if (schema.type === "number" || schema.type === "integer") {
    return Number(value);
  }

  if (schema.type === "boolean") {
    return value.toLowerCase() === "true";
  }

  if (schema.type === "object" || schema.type === "array") {
    try {
      return JSON.parse(value) as JsonValue;
    } catch {
      return value;
    }
  }

  return value;
}

/**
 * Which property schema types each supplied argument, for a tool whose
 * `inputSchema` puts its fields on root composition branches (#2123).
 *
 * Reading only the root's `properties` finds no schema for any of them, so
 * every value would be sent as the string the user typed — `--tool-arg count=3`
 * reaching the server as `"3"`.
 *
 * The CLI has no branch picker, so which branch a call means is *inferred*:
 * a discriminated union pins its discriminator with `const`, and the supplied
 * arguments either match one branch's constants or they do not.
 *
 * - **Exactly one branch matches** — use its merged schema, which is also where
 *   a branch's specialization of a root-declared property lives.
 * - **No branch is identifiable** — coerce only the names every branch that
 *   declares them types the *same* way. A name two branches type differently
 *   is left uncoerced rather than coerced by an arbitrary branch: `value` as a
 *   number in branch 0 and a boolean in branch 1 would otherwise turn
 *   `value=true` into `Number("true")`, i.e. `NaN`. Passing the raw string
 *   through is what this function did for every argument before it existed.
 */
function coercionProperties(
  base: { properties?: Record<string, unknown> },
  branches: {
    schema: { properties?: Record<string, unknown> };
    declaredFields: string[];
  }[],
  params: Record<string, string>,
): Record<string, unknown> {
  if (branches.length === 0) {
    return { ...base.properties };
  }

  const matching = branches.filter((branch) =>
    matchesConstants(branch.schema.properties ?? {}, params),
  );
  if (matching.length === 1) {
    return { ...matching[0].schema.properties };
  }

  const properties: Record<string, unknown> = { ...base.properties };
  for (const name of new Set(branches.flatMap((b) => b.declaredFields))) {
    // Only the branches that *declare* the name have an opinion about it — a
    // branch that merely inherited the root's declaration is not a second,
    // disagreeing vote. Read through the merged schema so a branch's
    // specialization of a root property carries the root's keywords too.
    const declarations = branches
      .filter((branch) => branch.declaredFields.includes(name))
      .map((branch) => branch.schema.properties?.[name]);
    const types = new Set(declarations.map((schema) => typeNameOf(schema)));
    if (types.size === 1) {
      properties[name] = declarations[0];
    } else {
      delete properties[name];
    }
  }
  return properties;
}

/** A schema's `type`, as a comparable string (`""` when it states none). */
function typeNameOf(schema: unknown): string {
  if (typeof schema !== "object" || schema === null) return "";
  const { type } = schema as { type?: unknown };
  return Array.isArray(type)
    ? type.join(",")
    : typeof type === "string"
      ? type
      : "";
}

/**
 * Whether every `const`-pinned property of a branch agrees with what was
 * supplied. Values arrive as strings, so the comparison is stringified — which
 * is exactly right for a discriminator, whose constants are string literals.
 */
function matchesConstants(
  properties: Record<string, unknown>,
  params: Record<string, string>,
): boolean {
  return Object.entries(properties).every(([name, schema]) => {
    if (typeof schema !== "object" || schema === null) return true;
    const constValue = (schema as { const?: unknown }).const;
    if (constValue === undefined) return true;
    const supplied = params[name];
    return supplied === undefined || supplied === String(constValue);
  });
}

/**
 * Convert string parameters to JSON values based on tool schema
 */
export function convertToolParameters(
  tool: Tool,
  params: Record<string, string>,
): Record<string, JsonValue> {
  const result: Record<string, JsonValue> = {};
  // A property's schema can live on a root composition branch rather than on
  // the root itself (#2123); see `coercionProperties` for how the branch is
  // identified when it does.
  const { base, branches } = resolveRootUnion(tool.inputSchema ?? {});
  const properties = coercionProperties(base, branches, params);
  for (const [key, value] of Object.entries(params)) {
    const paramSchema = properties[key] as ParameterSchema | undefined;

    if (paramSchema) {
      result[key] = convertParameterValue(value, paramSchema);
    } else {
      result[key] = value;
    }
  }

  return result;
}

/**
 * Convert prompt arguments (JsonValue) to strings for prompt API
 */
export function convertPromptArguments(
  args: Record<string, JsonValue>,
): Record<string, string> {
  const stringArgs: Record<string, string> = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "string") {
      stringArgs[key] = value;
    } else if (value === null || value === undefined) {
      stringArgs[key] = String(value);
    } else {
      stringArgs[key] = JSON.stringify(value);
    }
  }
  return stringArgs;
}
