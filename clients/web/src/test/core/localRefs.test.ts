import { describe, it, expect } from "vitest";
import { inlineLocalRefs } from "@inspector/core/json/localRefs.js";

// Zod → JSON Schema converters deduplicate a reused schema instance into
// `$defs` and point each use at it with a bare `$ref`, which has no `type` for
// a form builder to dispatch on (#2321).
describe("inlineLocalRefs", () => {
  const date = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" };

  it("inlines a $defs reference, letting the use site's siblings win", () => {
    const schema = {
      type: "object",
      properties: {
        end: { $ref: "#/$defs/Date", description: "end date" },
      },
      $defs: { Date: { ...date, description: "a date" } },
    };
    const resolved = inlineLocalRefs(schema);
    expect(resolved.properties.end).toEqual({
      ...date,
      description: "end date",
    });
    // The input is never mutated.
    expect(schema.properties.end).toEqual({
      $ref: "#/$defs/Date",
      description: "end date",
    });
  });

  it("inlines a definitions reference nested in anyOf and items", () => {
    const resolved = inlineLocalRefs({
      type: "object",
      properties: {
        maybe: { anyOf: [{ $ref: "#/definitions/D" }, { type: "null" }] },
        list: { type: "array", items: { $ref: "#/definitions/D" } },
      },
      definitions: { D: date },
    });
    expect(resolved.properties.maybe.anyOf[0]).toEqual(date);
    expect(resolved.properties.list.items).toEqual(date);
  });

  it("resolves chained references", () => {
    const resolved = inlineLocalRefs({
      properties: { a: { $ref: "#/$defs/A" } },
      $defs: { A: { $ref: "#/$defs/B" }, B: date },
    });
    expect(resolved.properties.a).toEqual(date);
  });

  it("returns the same reference when there is nothing to inline", () => {
    const schema = { type: "object", properties: { a: date } };
    expect(inlineLocalRefs(schema)).toBe(schema);
    expect(inlineLocalRefs(null)).toBeNull();
    expect(inlineLocalRefs(["x"])).toEqual(["x"]);
  });

  it("returns the same resolved object for repeated calls", () => {
    const schema = {
      properties: { a: { $ref: "#/$defs/A" } },
      $defs: { A: date },
    };
    expect(inlineLocalRefs(schema)).toBe(inlineLocalRefs(schema));
  });

  it("stops at a recursive reference instead of looping", () => {
    const resolved = inlineLocalRefs({
      properties: { root: { $ref: "#/$defs/Node" } },
      $defs: {
        Node: {
          type: "object",
          properties: { child: { $ref: "#/$defs/Node" } },
        },
      },
    });
    expect(resolved.properties.root).toEqual({
      type: "object",
      properties: { child: { $ref: "#/$defs/Node" } },
    });
  });

  it("leaves remote, unresolvable and non-object references in place", () => {
    const resolved = inlineLocalRefs({
      properties: {
        remote: { $ref: "https://example.com/s.json" },
        missing: { $ref: "#/$defs/Nope" },
        badEscape: { $ref: "#/$defs/%E0%A4%A" },
        scalar: { $ref: "#/$defs/S/type" },
        pastEnd: { $ref: "#/$defs/L/5" },
        badIndex: { $ref: "#/$defs/L/01" },
      },
      $defs: { S: date, L: [date] },
    });
    expect(resolved.properties).toEqual({
      remote: { $ref: "https://example.com/s.json" },
      missing: { $ref: "#/$defs/Nope" },
      badEscape: { $ref: "#/$defs/%E0%A4%A" },
      scalar: { $ref: "#/$defs/S/type" },
      pastEnd: { $ref: "#/$defs/L/5" },
      badIndex: { $ref: "#/$defs/L/01" },
    });
  });

  it("follows array indices, escaped segments and the document root", () => {
    const resolved = inlineLocalRefs({
      type: "object",
      properties: {
        indexed: { $ref: "#/$defs/L/0" },
        escaped: { $ref: "#/$defs/a~1b~0c%20d" },
        self: { anyOf: [{ $ref: "#" }] },
      },
      $defs: { L: [date], "a/b~c d": date },
    });
    expect(resolved.properties.indexed).toEqual(date);
    expect(resolved.properties.escaped).toEqual(date);
    // `#` is the schema being inlined, so it is kept rather than recursed.
    expect(resolved.properties.self.anyOf[0]).toEqual({
      type: "object",
      properties: expect.any(Object),
      $defs: expect.any(Object),
    });
  });

  it("treats data keywords as data, but property NAMES as schemas", () => {
    const pointer = { $ref: "#/$defs/D" };
    const resolved = inlineLocalRefs({
      type: "object",
      default: pointer,
      properties: {
        default: pointer,
        enum: pointer,
        ["__proto__"]: pointer,
      },
      $defs: { D: date },
    });
    expect(resolved.default).toBe(pointer);
    expect(resolved.properties.default).toEqual(date);
    expect(resolved.properties.enum).toEqual(date);
    expect(Object.hasOwn(resolved.properties, "__proto__")).toBe(true);
  });

  it("finds a reference that sits only under a data-keyword-named property", () => {
    const schema = {
      properties: { const: { $ref: "#/$defs/D" } },
      $defs: { D: date },
    };
    expect(inlineLocalRefs(schema).properties.const).toEqual(date);
  });
});
