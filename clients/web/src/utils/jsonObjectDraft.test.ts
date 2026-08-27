import { describe, it, expect } from "vitest";
import { hasRoundedInteger, parseJsonObjectDraft } from "./jsonObjectDraft";

// `isSerializableJson` catches a literal too large to represent (`1e400` →
// `Infinity` → `null` on the wire). This is the quieter one: a whole number
// past 2^53−1 parses to the nearest double, so the draft shows digits the wire
// will not carry.
describe("hasRoundedInteger", () => {
  it("accepts whole numbers inside the safe range", () => {
    expect(hasRoundedInteger({ id: Number.MAX_SAFE_INTEGER })).toBe(false);
    expect(hasRoundedInteger({ id: -Number.MAX_SAFE_INTEGER })).toBe(false);
    expect(hasRoundedInteger({ id: 0 })).toBe(false);
  });

  it("rejects a whole number past the safe range", () => {
    // Typed as …93, parsed as …92.
    expect(hasRoundedInteger(JSON.parse('{"id":9007199254740993}'))).toBe(true);
  });

  // A fractional or exponent-form value is a double by nature and is sent as
  // the double it parsed to, so nothing is lost between typing and sending.
  it("accepts a fractional value however large", () => {
    expect(hasRoundedInteger({ ratio: 1.5 })).toBe(false);
    expect(hasRoundedInteger({ ratio: 0.1 + 0.2 })).toBe(false);
  });

  // JS stringifies from 1e21 upward in exponent form, so such a value was typed
  // that way and the parsed double is what was asked for. `parseJsonObjectDraft`
  // has always accepted these.
  it("accepts a value whose shortest form carries an exponent", () => {
    expect(hasRoundedInteger({ n: 1e308 })).toBe(false);
    expect(hasRoundedInteger({ n: 1e21 })).toBe(false);
  });

  it("looks inside arrays and nested objects", () => {
    expect(hasRoundedInteger(JSON.parse('[{"a":[9007199254740993]}]'))).toBe(
      true,
    );
    expect(hasRoundedInteger({ a: { b: [1, 2, "x", null, true] } })).toBe(
      false,
    );
  });

  it("has nothing to say about non-numeric values", () => {
    expect(hasRoundedInteger("9007199254740993")).toBe(false);
    expect(hasRoundedInteger(null)).toBe(false);
  });
});

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

  it.each([
    ["an overflowing literal", '{"n":1e400}'],
    ["a negative overflow", '{"n":-1e400}'],
    ["one nested in an array", '{"a":[1,1e400]}'],
  ])("rejects %s, which would be sent as null", (_label, text) => {
    // `JSON.parse` accepts these; `JSON.stringify` then writes `null`, so the
    // editor would show one value and the wire would carry another.
    const result = parseJsonObjectDraft(text);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/finite/);
  });

  it("still accepts large-but-finite numbers", () => {
    expect(parseJsonObjectDraft('{"n":1e308}')).toEqual({
      ok: true,
      value: { n: 1e308 },
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
