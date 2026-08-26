/**
 * Converts JSON Schema to ink-form format
 */

import type { FormStructure, FormSection, FormField } from "ink-form";
import {
  isStringEnum,
  normalizeNullableUnion,
} from "@inspector/core/json/nullableUnion.js";
import { resolveRootUnion } from "@inspector/core/json/rootUnion.js";

/** Minimal JSON Schema property shape used when building tool parameter forms */
interface JsonSchemaProperty {
  /**
   * An array here is the `["string", "null"]` nullable encoding, which
   * {@link normalizeNullableUnion} collapses to a single name before the
   * dispatch below reads it.
   */
  type?: string | string[];
  title?: string;
  enum?: unknown[];
  /** Non-standard legacy support: titles for enum values */
  enumNames?: string[];
  items?: { enum?: unknown[]; enumNames?: string[] };
  minimum?: number;
  maximum?: number;
  default?: unknown;
  /** A one-value enumeration; seeded like a `default` — see below. */
  const?: unknown;
  /** Present on a nullable union; see {@link normalizeNullableUnion}. */
  anyOf?: readonly unknown[];
}

/**
 * Build ink-form select options from enum values, using their non-standard
 * `enumNames` titles as labels when present and length-matched. Falls back to
 * the stringified value as the label otherwise, since a wrong-length zip would
 * mislabel options — worse than showing raw values.
 */
function toSelectOptions(
  values: unknown[],
  names: string[] | undefined,
): { label: string; value: string }[] {
  const useNames = names !== undefined && names.length === values.length;
  return values.map((val, index) => ({
    label: useNames ? names[index] : String(val),
    value: String(val),
  }));
}

/**
 * Minimal JSON Schema object shape (properties + required). Property values are
 * `unknown` so the SDK's broadly-typed `Tool["inputSchema"]` (whose `properties`
 * values are the recursive JSON type) is assignable here; each value is narrowed
 * to {@link JsonSchemaProperty} at the point of use below.
 */
interface JsonSchemaObject {
  properties?: Record<string, unknown>;
  required?: string[];
  /**
   * Root composition, read by {@link resolveRootUnion} before `properties` is
   * enumerated (#2123). Members are `unknown` for the same reason property
   * values are: the SDK's `Tool["inputSchema"]` types them as the recursive
   * JSON type, and each is narrowed where it is used.
   */
  type?: string | string[];
  allOf?: readonly unknown[];
  anyOf?: readonly unknown[];
  oneOf?: readonly unknown[];
  discriminator?: { propertyName?: string };
}

/**
 * The select that names which alternative of a root union the call is making.
 *
 * ink-form keeps **one** value object for the whole form, keyed by field name
 * alone — sections are visual grouping, not scope. So two branches of a
 * discriminated union both declaring `kind` are the *same* field: the later
 * section's initial value wins, and filling the first branch's section would
 * submit the second branch's discriminator. Prefixing each branch's fields and
 * choosing between them explicitly is what makes the alternatives independent.
 */
export const VARIANT_FIELD = "__variant";

/** The form-local name a branch's field is rendered under. */
function branchFieldName(branchIndex: number, name: string): string {
  return `__b${branchIndex}__${name}`;
}

/**
 * Converts a JSON Schema to ink-form structure
 */
export function schemaToForm(
  schema: JsonSchemaObject | null | undefined,
  toolName: string,
): FormStructure {
  const title = `Test Tool: ${toolName}`;
  if (!schema) {
    return { title, sections: [{ title: "Parameters", fields: [] }] };
  }

  // Flatten root composition before reading `properties` (#2123). Without it a
  // tool whose arguments are declared as a root `oneOf`/`anyOf` — legal since
  // the 2026-07-28 revision — rendered a form with no fields at all, so it
  // could only be called with empty arguments.
  const { base, branches } = resolveRootUnion(schema);

  const parameters = buildFields(base);
  if (branches.length > 0) {
    // ink-form is static, so there is no picker that can swap the fields out.
    // Every branch is rendered instead, and this select says which one the
    // call means — read back by {@link decodeFormValues}, which drops the rest.
    parameters.unshift({
      type: "select",
      name: VARIANT_FIELD,
      label: "Variant",
      required: true,
      initialValue: "0",
      options: branches.map((branch, index) => ({
        label: branch.label,
        value: String(index),
      })),
    } as FormField);
  }

  const sections: FormSection[] = [{ title: "Parameters", fields: parameters }];

  // One section per alternative, its fields **optional** whatever the branch
  // says: only one alternative applies to a call, so requiring them would build
  // a form that can never be submitted.
  branches.forEach((branch, index) => {
    const ownProperties = Object.fromEntries(
      branch.ownFields.map((name) => [
        branchFieldName(index, name),
        branch.schema.properties?.[name],
      ]),
    );
    sections.push({
      title: branch.label,
      fields: buildFields({ properties: ownProperties }),
    });
  });

  return { title, sections };
}

/**
 * Turn what the form submitted back into the arguments the server expects:
 * the base fields, plus the fields of the branch the {@link VARIANT_FIELD}
 * select names, under their real property names.
 *
 * Every other branch's fields are dropped rather than sent — they describe a
 * shape this call is not making, and the user filled at most one section. Call
 * this on the way out of the form; for a schema with no root union it returns
 * the values unchanged, so it is safe to apply unconditionally.
 */
export function decodeFormValues<T>(
  schema: JsonSchemaObject | null | undefined,
  values: Record<string, T>,
): Record<string, T> {
  const { branches } = resolveRootUnion(schema ?? {});
  if (branches.length === 0) {
    return values;
  }

  const raw = values[VARIANT_FIELD];
  const selected = Number(raw);
  const branchIndex =
    Number.isInteger(selected) && selected >= 0 && selected < branches.length
      ? selected
      : 0;

  const decoded: Record<string, T> = {};
  for (const [name, value] of Object.entries(values)) {
    // Skip the select itself and every branch's prefixed field; the chosen
    // branch's are re-added below under the names the schema declares.
    if (name !== VARIANT_FIELD && !name.startsWith("__b")) {
      decoded[name] = value;
    }
  }
  for (const name of branches[branchIndex]!.ownFields) {
    const value = values[branchFieldName(branchIndex, name)];
    if (value !== undefined) {
      decoded[name] = value;
    }
  }
  return decoded;
}

/** Build the ink-form fields for one already-flattened object schema. */
function buildFields(schema: JsonSchemaObject): FormField[] {
  const fields: FormField[] = [];
  const properties = schema.properties || {};
  const required = schema.required || [];

  for (const [key, prop] of Object.entries(properties)) {
    // `properties` values are `unknown` (the SDK schema admits anything), so
    // guard before treating a value as a schema object — a malformed server
    // schema with e.g. `properties: { foo: null }` must not throw on `.title`.
    // Flatten a nullable union (`anyOf: [X, {type:"null"}]`, `type: [X,"null"]`)
    // before dispatching. Every branch below reads a single `type` string, and
    // for an enum the `enum` keyword sits on the union's surviving branch — so
    // without this an argument declared with Zod's `.nullish()` loses its
    // select and degrades to a plain text field (#2015, the TUI twin of #1928).
    const property = normalizeNullableUnion(
      (typeof prop === "object" && prop !== null
        ? prop
        : {}) as JsonSchemaProperty,
    );
    const baseField = {
      name: key,
      label: property.title || key,
      required: required.includes(key),
    };

    let field: FormField;

    // Handle enum -> select. Detect the array-of-enums case on `items.enum`
    // alone (matching the web SchemaForm guard) — a standard array-of-enums
    // schema carries no top-level `enum`, so gating on it would drop the field
    // to a plain string input.
    if (property.type === "array" && property.items?.enum) {
      // ink-form has no multiselect, so we render a single select.
      field = {
        type: "select",
        ...baseField,
        options: toSelectOptions(property.items.enum, property.items.enumNames),
      } as FormField;
    } else if (isStringEnum(property.enum)) {
      // Single select. Gated on the members being strings because
      // `toSelectOptions` stringifies them and ink-form hands the string
      // straight back: a numeric `enum: [1, 2]` would submit `"1"` and violate
      // the schema. A typed non-string enum falls through to its typed field
      // below, which loses the enum constraint but keeps the value's type —
      // the safer of the two losses.
      field = {
        type: "select",
        ...baseField,
        options: toSelectOptions(property.enum ?? [], property.enumNames),
      } as FormField;
    } else {
      // Map JSON Schema types to ink-form types
      switch (property.type) {
        case "string":
          field = {
            type: "string",
            ...baseField,
          } as FormField;
          break;
        case "integer":
          field = {
            type: "integer",
            ...baseField,
            ...(property.minimum !== undefined && { min: property.minimum }),
            ...(property.maximum !== undefined && { max: property.maximum }),
          } as FormField;
          break;
        case "number":
          field = {
            type: "float",
            ...baseField,
            ...(property.minimum !== undefined && { min: property.minimum }),
            ...(property.maximum !== undefined && { max: property.maximum }),
          } as FormField;
          break;
        case "boolean":
          field = {
            type: "boolean",
            ...baseField,
          } as FormField;
          break;
        default:
          // Default to string for unknown types
          field = {
            type: "string",
            ...baseField,
          } as FormField;
      }
    }

    // Set initial value from default (ink-form FormField allows initialValue for some types).
    // A `const` is seeded the same way and OUTRANKS `default`: it is a
    // one-value enumeration, so the only submittable value is already known and
    // the user would otherwise have to hand-type a union's discriminator
    // (#2123), while `default` is an annotation a schema may set to something
    // its own `const` rejects. Tested against `undefined` rather than `??`
    // chained, so an explicit `null` default is honored as a value.
    const initialValue =
      property.const !== undefined ? property.const : property.default;
    if (initialValue !== undefined) {
      (field as FormField & { initialValue?: unknown }).initialValue =
        initialValue;
    }

    fields.push(field);
  }

  return fields;
}
