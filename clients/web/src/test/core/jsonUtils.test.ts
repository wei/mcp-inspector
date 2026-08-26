import { describe, it, expect } from "vitest";
import {
  convertParameterValue,
  convertToolParameters,
  convertPromptArguments,
  toRecord,
} from "@inspector/core/json/jsonUtils.js";
import type { Tool } from "@modelcontextprotocol/client";

describe("JSON Utils", () => {
  describe("toRecord", () => {
    it("returns the same object widened to a string-keyed record", () => {
      const source = { a: 1, b: "two" };
      const widened = toRecord(source);
      expect(widened).toBe(source);
      expect(widened.a).toBe(1);
      expect(Object.keys(widened)).toEqual(["a", "b"]);
    });
  });

  describe("convertParameterValue", () => {
    it("should convert string to string", () => {
      expect(convertParameterValue("hello", { type: "string" })).toBe("hello");
    });

    it("returns the raw value unchanged when it is empty", () => {
      // Empty string short-circuits before any type coercion.
      expect(convertParameterValue("", { type: "number" })).toBe("");
    });

    it("falls back to the raw string when JSON parsing fails", () => {
      expect(convertParameterValue("{not json", { type: "object" })).toBe(
        "{not json",
      );
      expect(convertParameterValue("[oops", { type: "array" })).toBe("[oops");
    });

    it("should convert string to number", () => {
      expect(convertParameterValue("42", { type: "number" })).toBe(42);
      expect(convertParameterValue("3.14", { type: "number" })).toBe(3.14);
    });

    it("should convert string to boolean", () => {
      expect(convertParameterValue("true", { type: "boolean" })).toBe(true);
      expect(convertParameterValue("false", { type: "boolean" })).toBe(false);
    });

    it("should parse JSON strings", () => {
      expect(
        convertParameterValue('{"key":"value"}', { type: "object" }),
      ).toEqual({
        key: "value",
      });
      expect(convertParameterValue("[1,2,3]", { type: "array" })).toEqual([
        1, 2, 3,
      ]);
    });

    it("should return string for unknown types", () => {
      expect(convertParameterValue("hello", { type: "unknown" })).toBe("hello");
    });
  });

  describe("convertToolParameters", () => {
    const tool: Tool = {
      name: "test-tool",
      description: "Test tool",
      inputSchema: {
        type: "object",
        properties: {
          message: { type: "string" },
          count: { type: "number" },
          enabled: { type: "boolean" },
        },
      },
    };

    it("coerces a value whose schema lives on a root union branch (#2123)", () => {
      const unionTool: Tool = {
        name: "union-tool",
        inputSchema: {
          type: "object",
          properties: { note: { type: "string" } },
          anyOf: [
            {
              type: "object",
              properties: { count: { type: "number" } },
            },
            {
              type: "object",
              properties: { enabled: { type: "boolean" } },
            },
          ],
        },
      };
      // Reading the root's `properties` alone finds no schema for either, so
      // both would have been sent as the strings the user typed.
      expect(
        convertToolParameters(unionTool, {
          note: "hi",
          count: "42",
          enabled: "true",
        }),
      ).toEqual({ note: "hi", count: 42, enabled: true });
    });

    it("prefers a branch's specialization of a root property (#2123)", () => {
      const specializing: Tool = {
        name: "specializing",
        inputSchema: {
          type: "object",
          // The root declares the name but constrains nothing; the branch is
          // what says it is a number.
          properties: { count: {} },
          anyOf: [
            { type: "object", properties: { count: { type: "number" } } },
            { type: "object", properties: { other: { type: "string" } } },
          ],
        },
      };
      expect(convertToolParameters(specializing, { count: "3" })).toEqual({
        count: 3,
      });
    });

    it("picks the branch its discriminator names (#2123)", () => {
      const discriminated: Tool = {
        name: "discriminated",
        inputSchema: {
          type: "object",
          oneOf: [
            {
              type: "object",
              properties: {
                kind: { type: "string", const: "a" },
                value: { type: "number" },
              },
            },
            {
              type: "object",
              properties: {
                kind: { type: "string", const: "b" },
                value: { type: "boolean" },
              },
            },
          ],
        },
      };
      // `value` is a number in one branch and a boolean in the other, so the
      // discriminator is the only thing that says how to coerce it.
      expect(
        convertToolParameters(discriminated, { kind: "b", value: "true" }),
      ).toEqual({ kind: "b", value: true });
      expect(
        convertToolParameters(discriminated, { kind: "a", value: "3" }),
      ).toEqual({ kind: "a", value: 3 });
    });

    it("identifies the branch from the argument names supplied (#2123)", () => {
      const undiscriminated: Tool = {
        name: "undiscriminated",
        inputSchema: {
          type: "object",
          anyOf: [
            {
              type: "object",
              properties: { a: { type: "string" }, value: { type: "number" } },
            },
            {
              type: "object",
              properties: { b: { type: "string" }, value: { type: "boolean" } },
            },
          ],
        },
      };
      // `a` belongs to the first branch alone, so `value` is that branch's
      // number — falling straight through to cross-branch type agreement would
      // drop the coercion and send "3".
      expect(
        convertToolParameters(undiscriminated, { a: "x", value: "3" }),
      ).toEqual({ a: "x", value: 3 });
    });

    it("leaves an ambiguously typed argument uncoerced (#2123)", () => {
      const ambiguous: Tool = {
        name: "ambiguous",
        inputSchema: {
          type: "object",
          anyOf: [
            {
              type: "object",
              properties: {
                value: { type: "number" },
                a: { type: "string" },
              },
            },
            {
              type: "object",
              properties: {
                value: { type: "boolean" },
                b: { type: "string" },
              },
            },
          ],
        },
      };
      // Nothing identifies a branch, so coercing `value` by an arbitrary one
      // would turn `true` into `Number("true")` — `NaN`, i.e. `null` on the
      // wire. The raw string is honest; it is also what shipped before.
      expect(convertToolParameters(ambiguous, { value: "true" })).toEqual({
        value: "true",
      });
    });

    it("agrees on an array-form type across branches (#2123)", () => {
      const arrayTyped: Tool = {
        name: "array-typed",
        inputSchema: {
          type: "object",
          anyOf: [
            {
              type: "object",
              properties: { v: { type: ["number", "null"] }, a: {} },
            },
            {
              type: "object",
              properties: { v: { type: ["number", "null"] }, b: {} },
            },
          ],
        },
      };
      // Both spell the type the same way, so it is not ambiguous.
      expect(convertToolParameters(arrayTyped, { v: "2" })).toEqual({ v: "2" });
    });

    it("ignores a malformed branch declaration when matching constants (#2123)", () => {
      const malformed: Tool = {
        name: "malformed",
        inputSchema: {
          type: "object",
          anyOf: [
            {
              type: "object",
              properties: {
                kind: { type: "string", const: "a" },
                broken: null as unknown,
                value: { type: "number" },
              },
            },
            {
              type: "object",
              properties: {
                kind: { type: "string", const: "b" },
                value: { type: "boolean" },
              },
            },
          ],
        },
      };
      // A `properties: { broken: null }` entry must not throw, and a branch is
      // still identifiable by the discriminator that *is* well-formed.
      expect(
        convertToolParameters(malformed, { kind: "a", value: "3" }),
      ).toEqual({ kind: "a", value: 3 });
    });

    it("falls back to the branch-agreement path when no constant is supplied (#2123)", () => {
      const discriminated: Tool = {
        name: "no-discriminator-supplied",
        inputSchema: {
          type: "object",
          anyOf: [
            {
              type: "object",
              properties: {
                kind: { type: "string", const: "a" },
                shared: { type: "number" },
              },
            },
            {
              type: "object",
              properties: {
                kind: { type: "string", const: "b" },
                shared: { type: "number" },
              },
            },
          ],
        },
      };
      // Both branches match vacuously, so no single branch is identified — but
      // they agree about `shared`, so it is still coerced.
      expect(convertToolParameters(discriminated, { shared: "4" })).toEqual({
        shared: 4,
      });
    });

    it("ignores a malformed branch declaration when agreeing on a type (#2123)", () => {
      const malformedDeclaration: Tool = {
        name: "malformed-declaration",
        inputSchema: {
          type: "object",
          anyOf: [
            { type: "object", properties: { count: null as unknown, a: {} } },
            {
              type: "object",
              properties: { count: { type: "number" }, b: {} },
            },
          ],
        },
      };
      // The `null` is not a vote about the type, and must not end up standing
      // in for one — the surviving declaration is what coerces.
      expect(
        convertToolParameters(malformedDeclaration, { count: "3" }),
      ).toEqual({ count: 3 });
    });

    it("coerces a value whose schema lives on a root allOf branch (#2123)", () => {
      const allOfTool: Tool = {
        name: "allof-tool",
        inputSchema: {
          type: "object",
          allOf: [
            { type: "object", properties: { count: { type: "number" } } },
          ],
        },
      };
      expect(convertToolParameters(allOfTool, { count: "7" })).toEqual({
        count: 7,
      });
    });

    it("should convert string parameters", () => {
      const result = convertToolParameters(tool, {
        message: "hello",
        count: "42",
        enabled: "true",
      });

      expect(result.message).toBe("hello");
      expect(result.count).toBe(42);
      expect(result.enabled).toBe(true);
    });

    it("should preserve non-string values", () => {
      const result = convertToolParameters(tool, {
        message: "hello",
        count: "42", // Still pass as string, conversion will handle it
        enabled: "true", // Still pass as string, conversion will handle it
      });

      expect(result.message).toBe("hello");
      expect(result.count).toBe(42);
      expect(result.enabled).toBe(true);
    });

    it("should handle missing schema", () => {
      const toolWithoutSchema: Tool = {
        name: "test-tool",
        description: "Test tool",
        inputSchema: {
          type: "object",
          properties: {},
        },
      };

      const result = convertToolParameters(toolWithoutSchema, {
        message: "hello",
      });

      expect(result.message).toBe("hello");
    });
  });

  describe("convertPromptArguments", () => {
    it("should convert values to strings", () => {
      const result = convertPromptArguments({
        name: "John",
        age: 42,
        active: true,
        data: { key: "value" },
        items: [1, 2, 3],
      });

      expect(result.name).toBe("John");
      expect(result.age).toBe("42");
      expect(result.active).toBe("true");
      expect(result.data).toBe('{"key":"value"}');
      expect(result.items).toBe("[1,2,3]");
    });

    it("should handle null and undefined", () => {
      const result = convertPromptArguments({
        value: null,
        missing: undefined,
      });

      expect(result.value).toBe("null");
      expect(result.missing).toBe("undefined");
    });
  });
});
