import { describe, it, expect } from "vitest";
import {
  findDuplicateObjectKey,
  hasImpreciseIntegerLiteral,
  parseJsonObjectDraft,
} from "./jsonObjectDraft";

// `isSerializableJson` catches a literal too large to represent (`1e400` →
// `Infinity` → `null` on the wire). This is the quieter one: a whole number
// past 2^53−1 parses to the nearest double, so the draft shows digits the wire
// will not carry.
describe("hasImpreciseIntegerLiteral", () => {
  it("accepts whole numbers inside the safe range", () => {
    expect(hasImpreciseIntegerLiteral('{"id":9007199254740991}')).toBe(false);
    expect(hasImpreciseIntegerLiteral('{"id":-9007199254740991}')).toBe(false);
    expect(hasImpreciseIntegerLiteral('{"id":0}')).toBe(false);
  });

  it("rejects a whole number that loses digits when parsed", () => {
    // Typed as …93, parsed as …92.
    expect(hasImpreciseIntegerLiteral('{"id":9007199254740993}')).toBe(true);
  });

  // The case the previous, value-based check could not see: at or above 1e21
  // JS stringifies in exponent form, so inferring the literal from the parsed
  // number said "exponent form, nothing lost" about digits that were lost.
  it("rejects a full-form literal at or above 1e21", () => {
    expect(hasImpreciseIntegerLiteral('{"id":1000000000000000000001}')).toBe(
      true,
    );
  });

  // …and the false positive it also had. Written out in full, past the safe
  // range, and exactly representable, so it is sent as written.
  it("accepts a full-form literal that is exactly representable", () => {
    expect(hasImpreciseIntegerLiteral('{"id":18014398509481984}')).toBe(false);
  });

  // A fractional or exponent-form value is a double by nature and is sent as
  // the double it parsed to, so nothing is lost between typing and sending.
  it("accepts fractional and exponent-form values", () => {
    expect(hasImpreciseIntegerLiteral('{"n":1.5}')).toBe(false);
    expect(hasImpreciseIntegerLiteral('{"n":1e308}')).toBe(false);
    expect(hasImpreciseIntegerLiteral('{"n":1e21}')).toBe(false);
    expect(hasImpreciseIntegerLiteral('{"n":-2.5e-7}')).toBe(false);
  });

  // The reason this scans rather than running a regex over the text: those
  // digits are a *string*, sent back exactly as written.
  it("ignores digits inside a string", () => {
    expect(hasImpreciseIntegerLiteral('{"id":"9007199254740993"}')).toBe(false);
  });

  it("ignores digits inside a key, and an escaped quote inside a string", () => {
    expect(hasImpreciseIntegerLiteral('{"9007199254740993":1}')).toBe(false);
    expect(
      hasImpreciseIntegerLiteral('{"a":"say \\"9007199254740993\\"","b":1}'),
    ).toBe(false);
  });

  it("looks through arrays and nesting", () => {
    expect(hasImpreciseIntegerLiteral('[{"a":[9007199254740993]}]')).toBe(true);
    expect(hasImpreciseIntegerLiteral('{"a":{"b":[1,2,"x",null,true]}}')).toBe(
      false,
    );
  });

  it("says nothing about text that is not JSON", () => {
    expect(hasImpreciseIntegerLiteral("")).toBe(false);
    expect(hasImpreciseIntegerLiteral("{")).toBe(false);
  });
});

// `JSON.parse` accepts duplicate member names and keeps the last silently, so
// the evidence is gone by the time it returns — nothing downstream can see that
// the document said more than the value carries.
describe("findDuplicateObjectKey", () => {
  it("names the repeated member", () => {
    expect(findDuplicateObjectKey('{"role":"user","role":"admin"}')).toBe(
      "role",
    );
  });

  it("accepts a document whose names are all distinct", () => {
    expect(findDuplicateObjectKey('{"a":1,"b":2}')).toBeNull();
  });

  // The repeat has to be within one set of braces.
  it("scopes the check per object", () => {
    expect(findDuplicateObjectKey('{"a":{"a":1}}')).toBeNull();
    expect(findDuplicateObjectKey('[{"a":1},{"a":2}]')).toBeNull();
  });

  it("finds a repeat nested inside another object or an array", () => {
    expect(findDuplicateObjectKey('{"outer":{"a":1,"a":2}}')).toBe("a");
    expect(findDuplicateObjectKey('[{"a":1,"a":2}]')).toBe("a");
  });

  // Compared by decoded value: `"a"` and `"\u0061"` name the same member, so
  // comparing the raw source would miss a duplicate written the second way.
  it("compares names by value, not by spelling", () => {
    expect(findDuplicateObjectKey('{"a":1,"\\u0061":2}')).toBe("a");
  });

  // A string *value* that repeats is not a duplicate name, and a name that
  // merely appears inside one is not either.
  it("does not confuse values with names", () => {
    expect(findDuplicateObjectKey('{"a":"x","b":"x"}')).toBeNull();
    expect(findDuplicateObjectKey('{"a":"b","c":1}')).toBeNull();
    expect(findDuplicateObjectKey('{"a":"}\\"a\\":1{","b":2}')).toBeNull();
  });

  it("says nothing about a half-typed draft", () => {
    expect(findDuplicateObjectKey('{"a":1,"a')).toBeNull();
    expect(findDuplicateObjectKey("")).toBeNull();
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

  it("rejects a document that names the same member twice", () => {
    const result = parseJsonObjectDraft('{"role":"user","role":"admin"}');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/`role` appears twice/);
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
