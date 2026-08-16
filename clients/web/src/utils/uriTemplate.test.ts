import { describe, it, expect } from "vitest";
import {
  expandUriTemplate,
  parseUriTemplate,
  previewUriTemplate,
  templateVariables,
} from "./uriTemplate";

describe("parseUriTemplate", () => {
  it("splits literals from expressions", () => {
    expect(parseUriTemplate("foobar://events/{topic}")).toEqual([
      { kind: "literal", text: "foobar://events/" },
      {
        kind: "expression",
        source: "{topic}",
        operator: "",
        names: ["topic"],
      },
    ]);
  });

  it("reads the operator and the comma-separated name list", () => {
    expect(parseUriTemplate("x://{?a,b*}")).toEqual([
      { kind: "literal", text: "x://" },
      {
        kind: "expression",
        source: "{?a,b*}",
        operator: "?",
        names: ["a", "b"],
      },
    ]);
  });

  it("treats an unclosed expression as trailing literal text", () => {
    expect(parseUriTemplate("x://a/{oops")).toEqual([
      { kind: "literal", text: "x://a/{oops" },
    ]);
  });

  it("returns nothing for an empty template", () => {
    expect(parseUriTemplate("")).toEqual([]);
  });
});

describe("templateVariables", () => {
  it("finds a simple variable and marks it required", () => {
    expect(templateVariables("foobar://events/{topic}")).toEqual([
      { name: "topic", operator: "", required: true },
    ]);
  });

  it("finds a query variable the old `\\{(\\w+)\\}` regex could not see", () => {
    expect(templateVariables("foobar://events{?topic}")).toEqual([
      { name: "topic", operator: "?", required: false },
    ]);
  });

  it.each([
    ["{+path}", "+", true],
    ["{#frag}", "#", true],
    ["{.label}", ".", false],
    ["{/segment}", "/", false],
    ["{&extra}", "&", false],
  ])("classifies %s", (expression, operator, required) => {
    const [variable] = templateVariables(`x://a${expression}`);
    expect(variable.operator).toBe(operator);
    expect(variable.required).toBe(required);
  });

  it("deduplicates a repeated name and keeps it required if any use is", () => {
    expect(templateVariables("x://{?id}/{id}")).toEqual([
      { name: "id", operator: "?", required: true },
    ]);
  });

  it("returns an empty list for a template with no expressions", () => {
    expect(templateVariables("file:///static.txt")).toEqual([]);
  });
});

describe("expandUriTemplate", () => {
  it("percent-encodes a reserved character in a simple variable (#1919)", () => {
    expect(
      expandUriTemplate("foobar://events/{topic}", { topic: "foo/bar" }),
    ).toBe("foobar://events/foo%2Fbar");
  });

  it.each([
    ["?", "a?b", "a%3Fb"],
    ["#", "a#b", "a%23b"],
    ["%", "a%b", "a%25b"],
    ["space", "a b", "a%20b"],
    ["unicode", "caffè", "caff%C3%A8"],
  ])("encodes %s", (_label, value, encoded) => {
    expect(expandUriTemplate("x://{v}", { v: value })).toBe(`x://${encoded}`);
  });

  it("builds an encoded query expression", () => {
    expect(
      expandUriTemplate("foobar://events{?topic}", { topic: "foo/bar" }),
    ).toBe("foobar://events?topic=foo%2Fbar");
  });

  it("leaves reserved characters intact under the + operator", () => {
    expect(expandUriTemplate("x://{+path}", { path: "a/b" })).toBe("x://a/b");
  });

  it("omits an expression whose variable was left blank", () => {
    expect(expandUriTemplate("foobar://events{?topic}", { topic: "" })).toBe(
      "foobar://events",
    );
  });

  it("joins two query expressions with & rather than a second ?", () => {
    expect(expandUriTemplate("x://a{?one}{?two}", { one: "1", two: "2" })).toBe(
      "x://a?one=1&two=2",
    );
  });

  it("falls back to the raw template when the SDK cannot parse it", () => {
    expect(expandUriTemplate("x://a/{oops", { oops: "v" })).toBe("x://a/{oops");
  });
});

describe("previewUriTemplate", () => {
  it("shows the template verbatim before anything is entered", () => {
    expect(previewUriTemplate("file:///users/{userId}/profile", {})).toBe(
      "file:///users/{userId}/profile",
    );
  });

  it("substitutes only the expressions that are filled", () => {
    expect(
      previewUriTemplate("db://{tableName}/rows/{rowId}", {
        tableName: "users",
        rowId: "",
      }),
    ).toBe("db://users/rows/{rowId}");
  });

  it("encodes the filled values the same way expansion does", () => {
    expect(
      previewUriTemplate("foobar://events/{topic}", { topic: "foo/bar" }),
    ).toBe("foobar://events/foo%2Fbar");
  });

  it("keeps a multi-name expression whole until every name is filled", () => {
    expect(previewUriTemplate("x://a{?one,two}", { one: "1" })).toBe(
      "x://a{?one,two}",
    );
  });

  it("still rewrites the second ? to & when both query expressions resolve", () => {
    expect(
      previewUriTemplate("x://a{?one}{?two}", { one: "1", two: "2" }),
    ).toBe("x://a?one=1&two=2");
  });

  it("restores a deferred expression that follows a resolved query expression", () => {
    expect(previewUriTemplate("x://a{?one}{?two}", { one: "1" })).toBe(
      "x://a?one=1{?two}",
    );
  });

  it("falls back to the raw template when the SDK cannot parse it", () => {
    expect(previewUriTemplate("x://a/{oops", {})).toBe("x://a/{oops");
  });
});
