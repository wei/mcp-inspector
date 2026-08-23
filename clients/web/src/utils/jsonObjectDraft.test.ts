import { describe, it, expect } from "vitest";
import { parseJsonObjectDraft } from "./jsonObjectDraft";

describe("parseJsonObjectDraft", () => {
  it("reads empty text as the empty object rather than an error", () => {
    expect(parseJsonObjectDraft("")).toEqual({ ok: true, value: {} });
    expect(parseJsonObjectDraft("   \n ")).toEqual({ ok: true, value: {} });
  });

  it("accepts a JSON object with values of any JSON type", () => {
    const result = parseJsonObjectDraft(
      '{"s":"a","n":1,"b":true,"z":null,"arr":[1,{"k":2}],"o":{"deep":{"er":1}}}',
    );
    expect(result).toEqual({
      ok: true,
      value: {
        s: "a",
        n: 1,
        b: true,
        z: null,
        arr: [1, { k: 2 }],
        o: { deep: { er: 1 } },
      },
    });
  });

  it("rejects text that is not JSON", () => {
    expect(parseJsonObjectDraft('{"a":')).toEqual({
      ok: false,
      error: "Not valid JSON — changes are not applied",
    });
  });

  it.each([
    ["an array", "[1,2]"],
    ["a string", '"hello"'],
    ["a number", "42"],
    ["null", "null"],
  ])("rejects valid JSON that is not an object: %s", (_label, text) => {
    const result = parseJsonObjectDraft(text);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(
      /Must be a JSON object/,
    );
  });
});
