import { describe, it, expect } from "vitest";
import {
  admitsNull,
  normalizeNullableUnion,
} from "@inspector/core/json/nullableUnion.js";

// The two JSON Schema encodings of "this type, or null". Both form builders —
// the web `SchemaForm` and the TUI's `schemaToForm` — dispatch on a single
// `type` string, so this collapse is what keeps a nullable field renderable
// (#1928 in the web client, #2015 in the TUI).
describe("normalizeNullableUnion", () => {
  it("normalizes anyOf string|null", () => {
    expect(
      normalizeNullableUnion({
        anyOf: [{ type: "string" }, { type: "null" }],
      }),
    ).toEqual({
      type: "string",
      anyOf: undefined,
      nullable: true,
    });
  });

  it("normalizes anyOf boolean|null", () => {
    expect(
      normalizeNullableUnion({
        anyOf: [{ type: "boolean" }, { type: "null" }],
      }),
    ).toEqual({
      type: "boolean",
      anyOf: undefined,
      nullable: true,
    });
  });

  it("normalizes anyOf number|null", () => {
    expect(
      normalizeNullableUnion({
        anyOf: [{ type: "number" }, { type: "null" }],
      }),
    ).toEqual({
      type: "number",
      anyOf: undefined,
      nullable: true,
    });
  });

  it("normalizes anyOf integer|null", () => {
    expect(
      normalizeNullableUnion({
        anyOf: [{ type: "integer" }, { type: "null" }],
      }),
    ).toEqual({
      type: "integer",
      anyOf: undefined,
      nullable: true,
    });
  });

  it("normalizes anyOf array|null", () => {
    expect(
      normalizeNullableUnion({
        anyOf: [{ type: "array" }, { type: "null" }],
      }),
    ).toEqual({
      type: "array",
      anyOf: undefined,
      nullable: true,
    });
  });

  it("normalizes type array string|null", () => {
    expect(normalizeNullableUnion({ type: ["string", "null"] })).toEqual({
      type: "string",
      nullable: true,
    });
  });

  it("normalizes type array boolean|null", () => {
    expect(normalizeNullableUnion({ type: ["boolean", "null"] })).toEqual({
      type: "boolean",
      nullable: true,
    });
  });

  it("normalizes type array number|null", () => {
    expect(normalizeNullableUnion({ type: ["number", "null"] })).toEqual({
      type: "number",
      nullable: true,
    });
  });

  it("normalizes type array integer|null", () => {
    expect(normalizeNullableUnion({ type: ["integer", "null"] })).toEqual({
      type: "integer",
      nullable: true,
    });
  });

  it("returns schema unchanged when no union pattern matches", () => {
    const schema = { type: "string" as const };
    expect(normalizeNullableUnion(schema)).toBe(schema);
  });

  it("ignores anyOf with more than two members", () => {
    const schema = {
      anyOf: [
        { type: "string" as const },
        { type: "null" as const },
        { type: "number" as const },
      ],
    };
    expect(normalizeNullableUnion(schema)).toBe(schema);
  });

  it("ignores a two-member anyOf with no null branch", () => {
    const schema = {
      anyOf: [{ type: "string" as const }, { type: "number" as const }],
    };
    expect(normalizeNullableUnion(schema)).toBe(schema);
  });

  it("ignores an anyOf whose non-null branch has no renderable type (#1928)", () => {
    const schema = {
      anyOf: [{ const: "only" }, { type: "null" as const }],
    };
    expect(normalizeNullableUnion(schema)).toBe(schema);
  });

  // #1928: the enum lives on the surviving branch, and hoisting it is what makes
  // the field render as a Select instead of the raw-JSON fallback.
  it("hoists enum out of an anyOf string-enum|null branch", () => {
    expect(
      normalizeNullableUnion({
        description: "Direction",
        anyOf: [
          { type: "string", enum: ["envio", "recebimento"] },
          { type: "null" },
        ],
      }),
    ).toEqual({
      type: "string",
      description: "Direction",
      enum: ["envio", "recebimento"],
      anyOf: undefined,
      nullable: true,
    });
  });

  // JSON Schema's `enum` is untyped, so a typeless branch only implies strings
  // when every member is one. Guessing otherwise would hand a number to a
  // renderer that declared the option list `string[]`.
  it("does not infer string for a typeless non-string enum branch", () => {
    const schema = { anyOf: [{ enum: [1, 2] }, { type: "null" as const }] };
    expect(normalizeNullableUnion(schema)).toBe(schema);
  });

  it("does not infer string for a typeless mixed enum branch", () => {
    const schema = { anyOf: [{ enum: ["a", 2] }, { type: "null" as const }] };
    expect(normalizeNullableUnion(schema)).toBe(schema);
  });

  it("does not infer string for a typeless empty enum branch", () => {
    const schema = { anyOf: [{ enum: [] }, { type: "null" as const }] };
    expect(normalizeNullableUnion(schema)).toBe(schema);
  });

  // An explicit `type` is authoritative — the enum members are the server's
  // problem at that point, not an inference this function is making.
  it("still collapses a non-string enum branch that declares its type", () => {
    expect(
      normalizeNullableUnion({
        anyOf: [{ type: "number", enum: [1, 2] }, { type: "null" }],
      }),
    ).toEqual({
      type: "number",
      enum: [1, 2],
      anyOf: undefined,
      nullable: true,
    });
  });

  it("infers string for a typeless enum branch", () => {
    expect(
      normalizeNullableUnion({
        anyOf: [{ enum: ["a", "b"] }, { type: "null" }],
      }),
    ).toEqual({
      type: "string",
      enum: ["a", "b"],
      anyOf: undefined,
      nullable: true,
    });
  });

  it("hoists items out of an anyOf array|null branch", () => {
    expect(
      normalizeNullableUnion({
        anyOf: [
          { type: "array", items: { type: "string", enum: ["a", "b"] } },
          { type: "null" },
        ],
      }),
    ).toEqual({
      type: "array",
      items: { type: "string", enum: ["a", "b"] },
      anyOf: undefined,
      nullable: true,
    });
  });

  it("hoists properties out of an anyOf object|null branch", () => {
    expect(
      normalizeNullableUnion({
        anyOf: [
          { type: "object", properties: { a: { type: "string" } } },
          { type: "null" },
        ],
      }),
    ).toEqual({
      type: "object",
      properties: { a: { type: "string" } },
      anyOf: undefined,
      nullable: true,
    });
  });

  it("normalizes anyOf object|null regardless of branch order", () => {
    expect(
      normalizeNullableUnion({
        anyOf: [{ type: "null" }, { type: "object" }],
      }),
    ).toEqual({ type: "object", anyOf: undefined, nullable: true });
  });

  it("normalizes type array object|null", () => {
    expect(
      normalizeNullableUnion({
        type: ["object", "null"],
        properties: { a: { type: "string" } },
      }),
    ).toEqual({
      type: "object",
      properties: { a: { type: "string" } },
      nullable: true,
    });
  });

  it("normalizes type array array|null", () => {
    expect(normalizeNullableUnion({ type: ["array", "null"] })).toEqual({
      type: "array",
      nullable: true,
    });
  });

  it("keeps a type array of two non-null members unchanged", () => {
    const schema = { type: ["string", "number"] as const };
    expect(
      normalizeNullableUnion({ ...schema, type: [...schema.type] }),
    ).toEqual({
      type: ["string", "number"],
    });
  });

  // A server can put anything in `anyOf`; a non-object member must not be read
  // as a branch (nor throw), it simply means no nullable union was recognized.
  it("ignores an anyOf holding a non-object member", () => {
    const schema = { anyOf: ["string", { type: "null" as const }] };
    expect(normalizeNullableUnion(schema)).toBe(schema);
  });

  it("ignores an anyOf holding an array member", () => {
    const schema = { anyOf: [["string"], { type: "null" as const }] };
    expect(normalizeNullableUnion(schema)).toBe(schema);
  });

  it("ignores a type array whose non-null member has no widget", () => {
    const schema = { type: ["null", "null"] };
    expect(normalizeNullableUnion(schema)).toBe(schema);
  });

  it("ignores a schema with no union keywords at all", () => {
    const schema = { type: "object" as const, properties: {} };
    expect(normalizeNullableUnion(schema)).toBe(schema);
  });
});

// `admitsNull` answers a *validity* question and is deliberately decoupled from
// the collapse, which answers a narrower *rendering* one. A schema can admit
// null while being unrenderable as a single widget, and a form that conflated
// the two would reject a value its own schema accepts.
describe("admitsNull", () => {
  it("recognizes every encoding the collapse handles", () => {
    expect(admitsNull({ anyOf: [{ type: "string" }, { type: "null" }] })).toBe(
      true,
    );
    expect(admitsNull({ type: ["string", "null"] })).toBe(true);
    expect(admitsNull({ type: "null" })).toBe(true);
    expect(admitsNull({ nullable: true })).toBe(true);
  });

  it("recognizes a null branch the collapse declines to flatten", () => {
    // Three members, so `normalizeNullableUnion` leaves this alone and it
    // renders through the JSON fallback — where a user can still enter `null`.
    const wide = {
      anyOf: [{ type: "string" }, { type: "number" }, { type: "null" }],
    };
    expect(normalizeNullableUnion(wide)).toBe(wide);
    expect(admitsNull(wide)).toBe(true);
  });

  it("recognizes a null branch in a oneOf, and a nested type array", () => {
    expect(admitsNull({ oneOf: [{ type: "string" }, { type: "null" }] })).toBe(
      true,
    );
    expect(admitsNull({ anyOf: [{ type: ["string", "null"] }] })).toBe(true);
  });

  it("is false for a schema that does not permit null", () => {
    expect(admitsNull({ type: "string" })).toBe(false);
    expect(admitsNull({ type: ["string", "number"] })).toBe(false);
    expect(
      admitsNull({ anyOf: [{ type: "string" }, { type: "number" }] }),
    ).toBe(false);
    expect(admitsNull({})).toBe(false);
  });

  it("ignores non-object anyOf members instead of throwing", () => {
    expect(admitsNull({ anyOf: ["null", ["null"], 7] })).toBe(false);
  });
});
