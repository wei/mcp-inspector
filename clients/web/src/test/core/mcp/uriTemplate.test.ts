import { describe, it, expect } from "vitest";
import {
  expandUriTemplate,
  parseUriTemplate,
  templateVariables,
} from "@inspector/core/mcp/uriTemplate.js";

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

  // Required iff omitting the variable leaves an empty slot mid-URI rather
  // than a shorter, still-well-formed URI. Verified against the pinned SDK:
  // `x://a/{+path}` with no `path` expands to "x://a/" (empty segment), while
  // `x://a{#frag}` expands to exactly "x://a".
  it.each([
    ["{+path}", "+", true],
    ["{#frag}", "#", false],
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

  it.each([
    ["file:///users/{userId}/profile", "file:///users//profile"],
    ["x://a/{+path}", "x://a/"],
  ])(
    "requires %s because omitting it leaves an empty slot (%s)",
    (template, omitted) => {
      expect(templateVariables(template)[0].required).toBe(true);
      // The reason, asserted rather than asserted-about: this is what the URI
      // would become if the field were left blank.
      expect(expandUriTemplate(template, {})).toBe(omitted);
    },
  );

  it("does not require {#frag}, which omits to a well-formed URI", () => {
    expect(templateVariables("x://a{#frag}")[0].required).toBe(false);
    expect(expandUriTemplate("x://a{#frag}", {})).toBe("x://a");
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

describe("expandUriTemplate - multi-name expressions (SDK correction)", () => {
  // The pinned SDK's `expandPart` takes an early `names.length > 1` branch that
  // raw-joins the values, skipping BOTH encodeValue and the operator prefix.
  // Measured directly: `x://{a,b}` -> "x://foo/bar,q", `x://a{/p,q}` ->
  // "x://ax y,z". These assert the corrected output.
  it("encodes each value in a simple multi-name expression", () => {
    expect(expandUriTemplate("x://{a,b}", { a: "foo/bar", b: "q" })).toBe(
      "x://foo%2Fbar,q",
    );
  });

  it("keeps the / operator prefix and separator, and encodes", () => {
    expect(expandUriTemplate("x://a{/p,q}", { p: "x y", q: "z" })).toBe(
      "x://a/x%20y/z",
    );
  });

  it("keeps the . operator prefix and separator", () => {
    expect(expandUriTemplate("x://a{.p,q}", { p: "x/y", q: "z" })).toBe(
      "x://a.x%2Fy.z",
    );
  });

  it("keeps the # prefix and leaves reserved characters under it", () => {
    expect(expandUriTemplate("x://a{#p,q}", { p: "x/y", q: "z" })).toBe(
      "x://a#x/y,z",
    );
  });

  it("leaves reserved characters under the + operator", () => {
    expect(expandUriTemplate("x://{+a,b}", { a: "x/y", b: "z" })).toBe(
      "x://x/y,z",
    );
  });

  it("drops only the undefined names, keeping the rest", () => {
    expect(expandUriTemplate("x://a{/p,q}", { q: "z" })).toBe("x://a/z");
  });

  it("omits the whole expression when no name has a value", () => {
    expect(expandUriTemplate("x://a{/p,q}", {})).toBe("x://a");
  });

  it("leaves multi-name query expressions to the SDK, which handles them", () => {
    expect(expandUriTemplate("x://a{?p,q}", { p: "x/y", q: "z" })).toBe(
      "x://a?p=x%2Fy&q=z",
    );
  });
});
