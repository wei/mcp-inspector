import type { JsonValue, InspectorFormSchema, JsonObject } from "./jsonUtils";
import Ajv from "ajv";
import type { ValidateFunction } from "ajv";
import type { Tool, JSONRPCMessage } from "@modelcontextprotocol/client";
import { isJSONRPCRequest } from "@modelcontextprotocol/client";

const ajv = new Ajv();

// Cache for compiled validators
const toolOutputValidators = new Map<string, ValidateFunction>();

/**
 * Compiles and caches output schema validators for a list of tools
 * Following the same pattern as SDK's Client.cacheToolOutputSchemas
 * @param tools Array of tools that may have output schemas
 */
export function cacheToolOutputSchemas(tools: Tool[]): void {
  toolOutputValidators.clear();
  for (const tool of tools) {
    if (tool.outputSchema) {
      try {
        const validator = ajv.compile(tool.outputSchema);
        toolOutputValidators.set(tool.name, validator);
      } catch (error) {
        console.warn(
          `Failed to compile output schema for tool ${tool.name}:`,
          error,
        );
      }
    }
  }
}

/**
 * Gets the cached output schema validator for a tool
 * Following the same pattern as SDK's Client.getToolOutputValidator
 * @param toolName Name of the tool
 * @returns The compiled validator function, or undefined if not found
 */
export function getToolOutputValidator(
  toolName: string,
): ValidateFunction | undefined {
  return toolOutputValidators.get(toolName);
}

/**
 * Validates structured content against a tool's output schema
 * Returns validation result with detailed error messages
 * @param toolName Name of the tool
 * @param structuredContent The structured content to validate
 * @returns An object with isValid boolean and optional error message
 */
export function validateToolOutput(
  toolName: string,
  structuredContent: unknown,
): { isValid: boolean; error?: string } {
  const validator = getToolOutputValidator(toolName);
  if (!validator) {
    return { isValid: true }; // No validator means no schema to validate against
  }

  const isValid = validator(structuredContent);
  if (!isValid) {
    return {
      isValid: false,
      error: ajv.errorsText(validator.errors),
    };
  }

  return { isValid: true };
}

/**
 * Checks if a tool has an output schema
 * @param toolName Name of the tool
 * @returns true if the tool has an output schema
 */
export function hasOutputSchema(toolName: string): boolean {
  return toolOutputValidators.has(toolName);
}

/**
 * Generates a default value based on a JSON schema type
 * @param schema The JSON schema definition
 * @param propertyName Optional property name for checking if it's required in parent schema
 * @param parentSchema Optional parent schema to check required array
 * @returns A default value matching the schema type
 */
export function generateDefaultValue(
  schema: InspectorFormSchema,
  propertyName?: string,
  parentSchema?: InspectorFormSchema,
): JsonValue {
  if ("default" in schema && schema.default !== undefined) {
    return schema.default;
  }

  // Check if this property is required in the parent schema
  const isRequired =
    propertyName && parentSchema
      ? isPropertyRequired(propertyName, parentSchema)
      : false;
  const isRootSchema = propertyName === undefined && parentSchema === undefined;

  switch (schema.type) {
    case "string":
      return isRequired ? "" : undefined;
    case "number":
    case "integer":
      return isRequired ? 0 : undefined;
    case "boolean":
      return isRequired ? false : undefined;
    case "array":
      return isRequired ? [] : undefined;
    case "object": {
      if (!schema.properties) {
        return isRequired || isRootSchema ? {} : undefined;
      }

      const obj: JsonObject = {};
      // Include required properties OR optional properties that declare a default
      Object.entries(schema.properties).forEach(([key, prop]) => {
        const hasExplicitDefault =
          "default" in prop &&
          (prop as InspectorFormSchema).default !== undefined;
        if (isPropertyRequired(key, schema) || hasExplicitDefault) {
          const value = generateDefaultValue(prop, key, schema);
          if (value !== undefined) {
            obj[key] = value;
          }
        }
      });

      if (Object.keys(obj).length === 0) {
        return isRequired || isRootSchema ? {} : undefined;
      }
      return obj;
    }
    case "null":
      return null;
    default:
      return undefined;
  }
}

/**
 * Helper function to check if a property is required in a schema
 * @param propertyName The name of the property to check
 * @param schema The parent schema containing the required array
 * @returns true if the property is required, false otherwise
 */
export function isPropertyRequired(
  propertyName: string,
  schema: InspectorFormSchema,
): boolean {
  return schema.required?.includes(propertyName) ?? false;
}

/**
 * Resolves $ref references in JSON schema
 * @param schema The schema that may contain $ref
 * @param rootSchema The root schema to resolve references against
 * @returns The resolved schema without $ref
 */
export function resolveRef(
  schema: InspectorFormSchema,
  rootSchema: InspectorFormSchema,
): InspectorFormSchema {
  if (!("$ref" in schema) || !schema.$ref) {
    return schema;
  }

  const ref = schema.$ref;

  // Handle simple #/properties/name references
  if (ref.startsWith("#/")) {
    const path = ref.substring(2).split("/");
    let current: unknown = rootSchema;

    for (const segment of path) {
      if (
        current &&
        typeof current === "object" &&
        current !== null &&
        segment in current
      ) {
        current = (current as Record<string, unknown>)[segment];
      } else {
        // If reference cannot be resolved, return the original schema
        console.warn(`Could not resolve $ref: ${ref}`);
        return schema;
      }
    }

    return current as InspectorFormSchema;
  }

  // For other types of references, return the original schema
  console.warn(`Unsupported $ref format: ${ref}`);
  return schema;
}

/**
 * The `type` values {@link SchemaForm} dispatches on. `"null"` is deliberately
 * absent: it is the branch a nullable union is being flattened *away* from, and
 * there is no widget for a field whose only permitted value is `null`.
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
 * Normalizes a nullable union (`string|null` from FastMCP, or anything Zod's
 * `.nullish()` / `.nullable()` compiles to) into the plain type the form
 * renderer dispatches on.
 *
 * Two encodings mean the same thing and are both flattened to
 * `{ type: <T>, nullable: true }`:
 *
 * - `anyOf: [<branch>, { type: "null" }]` — the branch's *own* keywords are
 *   hoisted onto the result, because that is where the detail the renderer
 *   needs lives. A nullable enum compiles to
 *   `anyOf: [{ type: "string", enum: [...] }, { type: "null" }]`, so hoisting
 *   `enum` is what makes it a `Select` instead of falling through to the raw
 *   JSON fallback (#1928). The branch also wins over the wrapper on any shared
 *   key, matching v1.x's behavior.
 * - `type: [<T>, "null"]` — the keywords already sit at the top level, so only
 *   `type` collapses.
 *
 * Anything else — a union of two real types, a three-member `anyOf`, a branch
 * whose type has no widget — is returned untouched and renders through the
 * JSON fallback, which is the honest representation of a shape the form cannot
 * model.
 *
 * @param schema The JSON schema to normalize
 * @returns A normalized schema, or the original schema when no nullable-union
 *   pattern matches
 */
export function normalizeUnionType(
  schema: InspectorFormSchema,
): InspectorFormSchema {
  if (schema.anyOf && schema.anyOf.length === 2) {
    // `JsonSchemaConst` is structurally a subset of `InspectorFormSchema` (it
    // just carries no `type`), so reading both as the latter is safe.
    const branches = schema.anyOf as InspectorFormSchema[];
    const nullBranch = branches.find((branch) => branch?.type === "null");
    const branch = branches.find((candidate) => candidate?.type !== "null");

    if (nullBranch && branch) {
      // A bare `{ enum: [...] }` branch carries no `type`; JSON Schema allows
      // that, and every value such a schema admits here is a string.
      const type = branch.type ?? (branch.enum ? "string" : undefined);
      if (isRenderableType(type)) {
        return { ...schema, ...branch, type, anyOf: undefined, nullable: true };
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
      return { ...schema, type, nullable: true };
    }
  }

  return schema;
}

/**
 * Formats a field key into a human-readable label
 * @param key The field key to format
 * @returns A formatted label string
 */
export function formatFieldLabel(key: string): string {
  return key
    .replace(/([A-Z])/g, " $1") // Insert space before capital letters
    .replace(/_/g, " ") // Replace underscores with spaces
    .replace(/^\w/, (c) => c.toUpperCase()); // Capitalize first letter
}

/**
 * Resolves `$ref` references in a JSON-RPC "elicitation/create" message's `requestedSchema` field
 * @param message The JSON-RPC message that may contain $ref references
 * @returns A new message with resolved $ref references, or the original message if no resolution is needed
 */
export function resolveRefsInMessage(message: JSONRPCMessage): JSONRPCMessage {
  if (!isJSONRPCRequest(message) || !message.params?.requestedSchema) {
    return message;
  }

  const requestedSchema = message.params.requestedSchema as InspectorFormSchema;

  if (!requestedSchema?.properties) {
    return message;
  }

  const resolvedMessage = {
    ...message,
    params: {
      ...message.params,
      requestedSchema: {
        ...requestedSchema,
        properties: Object.fromEntries(
          Object.entries(requestedSchema.properties).map(
            ([key, propSchema]) => {
              const resolved = resolveRef(propSchema, requestedSchema);
              const normalized = normalizeUnionType(resolved);
              return [key, normalized];
            },
          ),
        ),
      },
    },
  };

  return resolvedMessage;
}
