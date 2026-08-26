import { describe, it, expect } from "vitest";
import { schemaToForm } from "../src/utils/schemaToForm.js";

describe("schemaToForm", () => {
  it("returns an empty Parameters section when there is no schema", () => {
    const form = schemaToForm(null, "noParams");
    expect(form.title).toBe("Test Tool: noParams");
    expect(form.sections).toEqual([{ title: "Parameters", fields: [] }]);
  });

  it("returns an empty Parameters section when properties are absent", () => {
    const form = schemaToForm({}, "empty");
    expect(form.sections[0]?.fields).toEqual([]);
  });

  it("treats a non-object property value as an empty schema instead of throwing", () => {
    // A malformed server schema whose property value is null/primitive must not
    // crash — the field degrades to a plain string input labelled by its key.
    const form = schemaToForm(
      { properties: { bad: null, worse: 42 } },
      "malformed",
    );
    const fields = form.sections[0]?.fields ?? [];
    expect(fields).toHaveLength(2);
    expect(
      fields.map((f) => ({ name: f.name, type: f.type, label: f.label })),
    ).toEqual([
      { name: "bad", type: "string", label: "bad" },
      { name: "worse", type: "string", label: "worse" },
    ]);
  });

  it("maps each JSON Schema type to the matching ink-form field type", () => {
    const form = schemaToForm(
      {
        properties: {
          name: { type: "string", title: "Name" },
          age: { type: "integer", minimum: 0, maximum: 120 },
          ratio: { type: "number", minimum: 0, maximum: 1 },
          active: { type: "boolean" },
          mystery: { type: "object" },
        },
        required: ["name"],
      },
      "typed",
    );

    const fields = form.sections[0]!.fields;
    const byName = Object.fromEntries(fields.map((f) => [f.name, f]));

    expect(byName.name).toMatchObject({
      type: "string",
      label: "Name",
      required: true,
    });
    expect(byName.age).toMatchObject({ type: "integer", min: 0, max: 120 });
    expect(byName.ratio).toMatchObject({ type: "float", min: 0, max: 1 });
    expect(byName.active).toMatchObject({ type: "boolean" });
    // Unknown types fall back to string, and label falls back to the key.
    expect(byName.mystery).toMatchObject({ type: "string", label: "mystery" });
  });

  it("builds a select field from an enum", () => {
    const form = schemaToForm(
      { properties: { color: { type: "string", enum: ["red", "blue"] } } },
      "enum",
    );
    expect(form.sections[0]!.fields[0]).toMatchObject({
      type: "select",
      options: [
        { label: "red", value: "red" },
        { label: "blue", value: "blue" },
      ],
    });
  });

  it("builds a select field from an array-of-enum on items.enum alone", () => {
    const form = schemaToForm(
      {
        properties: {
          // Standard array-of-enums shape: options come from `items.enum` with
          // NO top-level `enum`. The array branch keys on `items.enum` alone
          // (matching the web guard), so this renders as a select.
          tags: {
            type: "array",
            items: { enum: ["a", "b"] },
          },
        },
      },
      "arrayEnum",
    );
    expect(form.sections[0]!.fields[0]).toMatchObject({
      type: "select",
      options: [
        { label: "a", value: "a" },
        { label: "b", value: "b" },
      ],
    });
  });

  it("still builds a select for an array-of-enum that also carries a top-level enum", () => {
    const form = schemaToForm(
      {
        properties: {
          tags: {
            type: "array",
            enum: ["a", "b"],
            items: { enum: ["a", "b"] },
          },
        },
      },
      "arrayEnumRedundant",
    );
    expect(form.sections[0]!.fields[0]).toMatchObject({
      type: "select",
      options: [
        { label: "a", value: "a" },
        { label: "b", value: "b" },
      ],
    });
  });

  it("uses enumNames as single-select labels while keeping raw values", () => {
    const form = schemaToForm(
      {
        properties: {
          pet: {
            type: "string",
            enum: ["pet-1", "pet-2"],
            enumNames: ["Cats", "Dogs"],
          },
        },
      },
      "titledEnum",
    );
    expect(form.sections[0]!.fields[0]).toMatchObject({
      type: "select",
      options: [
        { label: "Cats", value: "pet-1" },
        { label: "Dogs", value: "pet-2" },
      ],
    });
  });

  it("falls back to raw single-select labels when enumNames length mismatches", () => {
    const form = schemaToForm(
      {
        properties: {
          pet: {
            type: "string",
            enum: ["pet-1", "pet-2"],
            // Only one name for two values — a wrong-length zip would
            // mislabel, so the raw values are used as labels.
            enumNames: ["Cats"],
          },
        },
      },
      "mismatchedEnum",
    );
    expect(form.sections[0]!.fields[0]).toMatchObject({
      options: [
        { label: "pet-1", value: "pet-1" },
        { label: "pet-2", value: "pet-2" },
      ],
    });
  });

  it("uses items.enumNames as array-of-enum labels while keeping raw values", () => {
    const form = schemaToForm(
      {
        properties: {
          pets: {
            type: "array",
            items: { enum: ["pet-1", "pet-2"], enumNames: ["Cats", "Dogs"] },
          },
        },
      },
      "titledArrayEnum",
    );
    expect(form.sections[0]!.fields[0]).toMatchObject({
      type: "select",
      options: [
        { label: "Cats", value: "pet-1" },
        { label: "Dogs", value: "pet-2" },
      ],
    });
  });

  it("falls back to raw array-of-enum labels when items.enumNames length mismatches", () => {
    const form = schemaToForm(
      {
        properties: {
          pets: {
            type: "array",
            items: { enum: ["pet-1", "pet-2"], enumNames: ["Cats"] },
          },
        },
      },
      "mismatchedArrayEnum",
    );
    expect(form.sections[0]!.fields[0]).toMatchObject({
      options: [
        { label: "pet-1", value: "pet-1" },
        { label: "pet-2", value: "pet-2" },
      ],
    });
  });

  it("carries a JSON Schema default through as the field's initialValue", () => {
    const form = schemaToForm(
      { properties: { greeting: { type: "string", default: "hi" } } },
      "withDefault",
    );
    expect(form.sections[0]!.fields[0]).toMatchObject({ initialValue: "hi" });
  });

  // #2015 (the TUI twin of #1928): an argument declared with Zod's `.nullish()`
  // has no top-level `type`/`enum` — they sit on the surviving `anyOf` branch —
  // so before normalization every one of these degraded to a plain text field.
  describe("nullable unions", () => {
    it("renders a select for an anyOf string-enum|null argument", () => {
      const form = schemaToForm(
        {
          properties: {
            direction: {
              anyOf: [
                { type: "string", enum: ["envio", "recebimento"] },
                { type: "null" },
              ],
            },
          },
        },
        "nullableEnum",
      );
      expect(form.sections[0]!.fields[0]).toMatchObject({
        name: "direction",
        type: "select",
        options: [
          { label: "envio", value: "envio" },
          { label: "recebimento", value: "recebimento" },
        ],
      });
    });

    it("maps the remaining nullable scalar branches to their typed fields", () => {
      const form = schemaToForm(
        {
          properties: {
            reference: { anyOf: [{ type: "string" }, { type: "null" }] },
            quantity: {
              anyOf: [
                { type: "integer", minimum: 1, maximum: 9 },
                { type: "null" },
              ],
            },
            ratio: { anyOf: [{ type: "number" }, { type: "null" }] },
            express: { anyOf: [{ type: "boolean" }, { type: "null" }] },
          },
        },
        "nullableScalars",
      );
      const fields = form.sections[0]!.fields;
      expect(fields.map((f) => ({ name: f.name, type: f.type }))).toEqual([
        { name: "reference", type: "string" },
        { name: "quantity", type: "integer" },
        { name: "ratio", type: "float" },
        { name: "express", type: "boolean" },
      ]);
      // The branch's own constraints are hoisted along with its type.
      expect(fields[1]).toMatchObject({ min: 1, max: 9 });
    });

    it("renders a select for a nullable array-of-enum argument", () => {
      const form = schemaToForm(
        {
          properties: {
            tags: {
              anyOf: [
                { type: "array", items: { enum: ["a", "b"] } },
                { type: "null" },
              ],
            },
          },
        },
        "nullableArrayEnum",
      );
      expect(form.sections[0]!.fields[0]).toMatchObject({
        type: "select",
        options: [
          { label: "a", value: "a" },
          { label: "b", value: "b" },
        ],
      });
    });

    // With the null left in the list, the all-strings check would reject the
    // enum and this would degrade to a plain text field.
    it("renders a select for a type: [string, null] enum, null stripped", () => {
      const form = schemaToForm(
        {
          properties: {
            direction: {
              type: ["string", "null"],
              enum: ["envio", "recebimento", null],
            },
          },
        },
        "typeArrayNullableEnum",
      );
      expect(form.sections[0]!.fields[0]).toMatchObject({
        type: "select",
        options: [
          { label: "envio", value: "envio" },
          { label: "recebimento", value: "recebimento" },
        ],
      });
    });

    it("collapses the type: [T, null] encoding too", () => {
      const form = schemaToForm(
        {
          properties: {
            note: { type: ["string", "null"] },
            flag: { type: ["boolean", "null"] },
          },
        },
        "typeArrayNull",
      );
      expect(
        form.sections[0]!.fields.map((f) => ({ name: f.name, type: f.type })),
      ).toEqual([
        { name: "note", type: "string" },
        { name: "flag", type: "boolean" },
      ]);
    });

    // ink-form hands a select's stringified value straight back, so a numeric
    // enum routed to a select would submit "1" for 1. The typed field loses the
    // enum constraint but keeps the value's type — the safer loss.
    it("routes a nullable numeric enum to its typed field, not a select", () => {
      const form = schemaToForm(
        {
          properties: {
            level: {
              anyOf: [{ type: "integer", enum: [1, 2] }, { type: "null" }],
            },
            ratio: {
              anyOf: [{ type: "number", enum: [0.5, 1.5] }, { type: "null" }],
            },
          },
        },
        "numericEnum",
      );
      expect(
        form.sections[0]!.fields.map((f) => ({ name: f.name, type: f.type })),
      ).toEqual([
        { name: "level", type: "integer" },
        { name: "ratio", type: "float" },
      ]);
    });

    it("routes a plain numeric enum to its typed field too", () => {
      const form = schemaToForm(
        { properties: { level: { type: "integer", enum: [1, 2] } } },
        "plainNumericEnum",
      );
      expect(form.sections[0]!.fields[0]).toMatchObject({ type: "integer" });
    });

    it("leaves a union of two real types as a plain string field", () => {
      const form = schemaToForm(
        {
          properties: {
            mixed: { anyOf: [{ type: "string" }, { type: "number" }] },
          },
        },
        "realUnion",
      );
      expect(form.sections[0]!.fields[0]).toMatchObject({
        name: "mixed",
        type: "string",
      });
    });

    // #1005: the unportable-schemas showcase advertises a remote `$ref` so the
    // lint has a `remote-ref` finding to report. A `$ref`-only property falls
    // through to a string field here, which the tool's real (numeric) handler
    // then rejects — so the fixture keeps a local `type` alongside the ref and
    // the tool stays runnable. This pins the half of that contract the TUI
    // owns; the wire half is in `raw-tool-schemas.test.ts`.
    it("types a property that carries both a remote $ref and a local type", () => {
      const form = schemaToForm(
        {
          properties: {
            a: {
              type: "number",
              $ref: "https://example.com/schemas/number.json",
            },
          },
        },
        "refWithLocalType",
      );
      // `float` is this form builder's numeric field kind — the point is that
      // it is NOT the string fallback a `$ref`-only property would get.
      expect(form.sections[0]!.fields[0]).toMatchObject({
        name: "a",
        type: "float",
      });
    });
  });
  describe("root composition (#2123)", () => {
    const UNION = {
      type: "object",
      properties: { note: { type: "string" } },
      discriminator: { propertyName: "kind" },
      oneOf: [
        {
          type: "object",
          properties: {
            kind: { type: "string", const: "email" },
            address: { type: "string" },
          },
          required: ["kind", "address"],
        },
        {
          type: "object",
          properties: {
            kind: { type: "string", const: "sms" },
            count: { type: "integer" },
          },
          required: ["kind", "count"],
        },
      ],
    };

    it("gives each branch its own section instead of rendering no fields", () => {
      const form = schemaToForm(UNION, "union_tool");
      expect(form.sections.map((section) => section.title)).toEqual([
        "Parameters",
        "email",
        "sms",
      ]);
      expect(form.sections[0]!.fields.map((field) => field.name)).toEqual([
        "note",
      ]);
      expect(form.sections[1]!.fields.map((field) => field.name)).toEqual([
        "kind",
        "address",
      ]);
    });

    it("keeps a branch's typed fields typed", () => {
      const form = schemaToForm(UNION, "union_tool");
      expect(form.sections[2]!.fields[1]).toMatchObject({
        name: "count",
        type: "integer",
      });
    });

    it("renders branch fields optional, since only one branch applies", () => {
      const form = schemaToForm(UNION, "union_tool");
      for (const field of form.sections[1]!.fields) {
        expect(field.required).toBe(false);
      }
    });

    it("seeds a branch's discriminator const so it need not be typed", () => {
      const form = schemaToForm(UNION, "union_tool");
      expect(form.sections[1]!.fields[0]).toMatchObject({
        name: "kind",
        initialValue: "email",
      });
    });

    it("merges a root allOf into the parameters section", () => {
      const form = schemaToForm(
        {
          type: "object",
          properties: { a: { type: "string" } },
          allOf: [{ type: "object", properties: { b: { type: "boolean" } } }],
        },
        "allof_tool",
      );
      expect(form.sections).toHaveLength(1);
      expect(form.sections[0]!.fields.map((field) => field.name)).toEqual([
        "a",
        "b",
      ]);
    });

    it("still renders an empty form for a schema with no properties", () => {
      const form = schemaToForm({ type: "object" }, "empty_tool");
      expect(form.sections).toEqual([{ title: "Parameters", fields: [] }]);
    });
  });
});
