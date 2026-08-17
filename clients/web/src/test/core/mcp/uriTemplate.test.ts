import { describe, it, expect } from "vitest";
import {
  expandUriTemplate,
  expandUriTemplateStrict,
  hasRequiredValues,
  parseUriTemplate,
  requiredGroups,
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
        varspecs: [{ name: "topic" }],
        names: ["topic"],
        invalid: false,
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
        varspecs: [{ name: "a" }, { name: "b" }],
        names: ["a", "b"],
        invalid: false,
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

  it("expands each query expression independently, per RFC 6570", () => {
    // NOT `?one=1&two=2`. The SDK rewrites the second `?` to `&`, but measured
    // against the pinned SDK its own matcher then rejects the result:
    // match("x?one=1&two=2") on `x{?one}{?two}` is null, while
    // match("x?one=1?two=2") returns both variables. A server wanting a
    // continuation advertises `{?one}{&two}` -- see the test below.
    expect(expandUriTemplate("x://a{?one}{?two}", { one: "1", two: "2" })).toBe(
      "x://a?one=1?two=2",
    );
  });

  it("emits & only where the template asks for the continuation operator", () => {
    expect(expandUriTemplate("x://a{?one}{&two}", { one: "1", two: "2" })).toBe(
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

describe("varspec modifiers", () => {
  // The pinned SDK folds a `:length` modifier into the variable name --
  // `new UriTemplate("x://a/{id:3}").variableNames` is `["id:3"]`, and it
  // expands to "x://a/" -- so a form built on it would render a field the
  // user cannot usefully fill.
  it("parses a prefix modifier off the variable name", () => {
    expect(templateVariables("x://a/{id:3}")).toEqual([
      { name: "id", operator: "", required: true },
    ]);
  });

  it("truncates the value to the prefix length before encoding", () => {
    expect(expandUriTemplate("x://a/{id:3}", { id: "abcdef" })).toBe(
      "x://a/abc",
    );
  });

  it("encodes what survives truncation", () => {
    expect(expandUriTemplate("x://a/{id:3}", { id: "a/bcdef" })).toBe(
      "x://a/a%2Fb",
    );
  });

  it("truncates by code point, never splitting an astral character", () => {
    // "\u{1F600}" is one code point but two UTF-16 units, so a naive
    // `slice(0, 1)` would emit a lone surrogate.
    expect(expandUriTemplate("x://{v:1}", { v: "\u{1F600}x" })).toBe(
      `x://${encodeURIComponent("\u{1F600}")}`,
    );
  });

  it("strips the explode modifier from the name", () => {
    expect(templateVariables("x://{id*}")[0].name).toBe("id");
  });
});

describe("the ; (path-parameter) operator", () => {
  // Absent from the SDK's operator list entirely: it parses `{;id}` as a
  // variable named ";id" and expands to "".
  it("is recognised as an operator, not part of the name", () => {
    expect(templateVariables("x://a{;id}")).toEqual([
      { name: "id", operator: ";", required: false },
    ]);
  });

  it("expands to a named path parameter", () => {
    expect(expandUriTemplate("x://a{;id}", { id: "7" })).toBe("x://a;id=7");
  });

  it("repeats its separator per pair", () => {
    expect(expandUriTemplate("x://a{;a,b}", { a: "1", b: "2" })).toBe(
      "x://a;a=1;b=2",
    );
  });

  it("encodes the value", () => {
    expect(expandUriTemplate("x://a{;p}", { p: "x/y" })).toBe("x://a;p=x%2Fy");
  });

  it("omits cleanly when undefined", () => {
    expect(expandUriTemplate("x://a{;id}", {})).toBe("x://a");
  });
});

describe("requiredGroups / hasRequiredValues", () => {
  // A required *expression* is satisfied by any one of its names, because
  // RFC 6570 drops the undefined ones -- verified against the SDK:
  // `x://{a,b}` with only `a` expands to "x://only-a".
  it("accepts a multi-name expression with only one name filled", () => {
    const groups = requiredGroups("x://{a,b}");
    expect(groups).toEqual([["a", "b"]]);
    expect(hasRequiredValues(groups, { a: "only-a", b: "" })).toBe(true);
    expect(expandUriTemplate("x://{a,b}", { a: "only-a", b: "" })).toBe(
      "x://only-a",
    );
  });

  it("rejects a multi-name expression with nothing filled", () => {
    expect(
      hasRequiredValues(requiredGroups("x://{a,b}"), { a: "", b: "" }),
    ).toBe(false);
  });

  it("still requires a lone required variable", () => {
    const groups = requiredGroups("file:///users/{userId}/profile");
    expect(hasRequiredValues(groups, { userId: "" })).toBe(false);
    expect(hasRequiredValues(groups, { userId: "alice" })).toBe(true);
  });

  it("never blocks on an omittable expression", () => {
    expect(requiredGroups("foobar://events{?topic}")).toEqual([]);
    expect(
      hasRequiredValues(requiredGroups("foobar://events{?topic}"), {
        topic: "",
      }),
    ).toBe(true);
  });

  it("is satisfied by a template with no variables at all", () => {
    expect(hasRequiredValues(requiredGroups("file:///static.txt"), {})).toBe(
      true,
    );
  });

  it("tracks a name that recurs under a different operator", () => {
    // A per-variable model keeping only the first occurrence's group would
    // mark both names required with singleton groups and refuse this input;
    // the SDK expands the same template with just `a` to "x?a=11".
    const groups = requiredGroups("x{?a}{?b}{a,b}");
    expect(groups).toEqual([["a", "b"]]);
    expect(hasRequiredValues(groups, { a: "1", b: "" })).toBe(true);
    expect(expandUriTemplate("x{?a}{?b}{a,b}", { a: "1" })).toBe("x?a=11");
  });

  it("satisfies two required expressions sharing a name, from the others", () => {
    // `{a,b}{a,c}`: filling only b and c satisfies both groups. No
    // per-variable flag can express this, which is why groups are separate.
    const groups = requiredGroups("x://{a,b}{a,c}");
    expect(groups).toEqual([
      ["a", "b"],
      ["a", "c"],
    ]);
    expect(hasRequiredValues(groups, { b: "B", c: "C" })).toBe(true);
    expect(hasRequiredValues(groups, { b: "B" })).toBe(false);
  });
});

describe("expression independence", () => {
  it("does not rewrite a later query expression on the own-expansion path", () => {
    expect(
      expandUriTemplate("x://a{;k}{?one}{?two}", {
        k: "v",
        one: "1",
        two: "2",
      }),
    ).toBe("x://a;k=v?one=1?two=2");
  });

  it("omits an expression with no value without affecting its neighbours", () => {
    expect(
      expandUriTemplate("x://a{;k}{?one}{?two}", { k: "v", two: "2" }),
    ).toBe("x://a;k=v?two=2");
  });
});

describe("allow-reserved encoding under + and #", () => {
  // The SDK uses `encodeURI` for these operators, which corrupts two classes
  // of value rather than merely over-escaping: measured, encodeURI("[::1]")
  // is "%5B::1%5D" and encodeURI("%2F") is "%252F".
  it.each(["+", "#"])("leaves reserved [ and ] intact under %s", (operator) => {
    const prefix = operator === "#" ? "#" : "";
    expect(expandUriTemplate(`x://{${operator}v}`, { v: "[::1]" })).toBe(
      `x://${prefix}[::1]`,
    );
  });

  it.each(["+", "#"])(
    "does not double-encode an existing pct-triplet under %s",
    (operator) => {
      const prefix = operator === "#" ? "#" : "";
      expect(expandUriTemplate(`x://{${operator}v}`, { v: "a%2Fb" })).toBe(
        `x://${prefix}a%2Fb`,
      );
    },
  );

  it("still encodes a lone % that is not a triplet", () => {
    expect(expandUriTemplate("x://{+v}", { v: "100%" })).toBe("x://100%25");
  });

  it("still encodes characters outside the allowed set", () => {
    expect(expandUriTemplate("x://{+v}", { v: "a b" })).toBe("x://a%20b");
  });

  it("encodes an astral character whole rather than as surrogates", () => {
    expect(expandUriTemplate("x://{+v}", { v: "\u{1F600}" })).toBe(
      `x://${encodeURIComponent("\u{1F600}")}`,
    );
  });

  it("applies the same encoding in a multi-name + expression", () => {
    expect(expandUriTemplate("x://{+a,b}", { a: "[::1]", b: "%2F" })).toBe(
      "x://[::1],%2F",
    );
  });

  it("still percent-encodes reserved characters under the simple operator", () => {
    // Only + and # allow reserved through; the default path is unchanged.
    expect(expandUriTemplate("x://{v}", { v: "[::1]" })).toBe(
      "x://%5B%3A%3A1%5D",
    );
  });
});

describe("unreserved encoding under the non-reserved operators", () => {
  // `encodeURIComponent` leaves the sub-delims !'()* bare, but RFC 6570 only
  // allows *unreserved* characters through for these operators.
  it.each([
    ["", "x://"],
    [".", "x://a."],
    ["/", "x://a/"],
  ])("encodes !'()* under the %s operator", (operator, prefix) => {
    const base = operator === "" ? "x://" : "x://a";
    expect(
      expandUriTemplate(`${base}{${operator}v}`, { v: "a!b'c(d)e*f" }),
    ).toBe(`${prefix}a%21b%27c%28d%29e%2Af`);
  });

  it("encodes them in a named (query) expression too", () => {
    expect(expandUriTemplate("x://a{?v}", { v: "a!b" })).toBe("x://a?v=a%21b");
  });

  it("encodes them in a matrix expression too", () => {
    expect(expandUriTemplate("x://a{;v}", { v: "a!b" })).toBe("x://a;v=a%21b");
  });

  it("leaves them alone under + and #, where reserved characters are allowed", () => {
    expect(expandUriTemplate("x://{+v}", { v: "a!b'c(d)e*f" })).toBe(
      "x://a!b'c(d)e*f",
    );
  });

  it("still leaves the unreserved set itself untouched", () => {
    expect(expandUriTemplate("x://{v}", { v: "aZ0-._~" })).toBe("x://aZ0-._~");
  });
});

describe("prefix-modifier grammar", () => {
  // RFC 6570: max-length = %x31-39 0*3DIGIT -- 1..9999, no leading zero.
  // The SDK's constructor accepts these shapes, so nothing else rejects them;
  // treating `{id:abc}` as a plain `{id}` would send a URI the server never
  // advertised, with nothing to alert anyone.
  it.each(["x://{id:}", "x://{id:0}", "x://{id:abc}", "x://{id:10000}"])(
    "strict rejects the invalid template %s",
    (template) => {
      expect(() => expandUriTemplateStrict(template, { id: "abcdef" })).toThrow(
        /Invalid RFC 6570 varspec/,
      );
    },
  );

  it.each(["x://{id:}", "x://{id:abc}"])(
    "lenient returns %s unchanged rather than guessing",
    (template) => {
      expect(expandUriTemplate(template, { id: "abcdef" })).toBe(template);
    },
  );

  it.each([
    ["x://{id:1}", "a"],
    ["x://{id:9999}", "abcdef"],
  ])("accepts the in-range modifier %s", (template, expected) => {
    expect(expandUriTemplate(template, { id: "abcdef" })).toBe(
      `x://${expected}`,
    );
  });
});

describe("variable names that collide with Object.prototype", () => {
  // `toString`, `constructor`, `valueOf` and `__proto__` are all valid RFC 6570
  // varnames. A bare `values[name]` lookup finds the prototype's member for
  // every one of them, so a *blank* field read as supplied: measured,
  // `({})["toString"] !== undefined` is true and its typeof is "function".
  it.each(["toString", "constructor", "valueOf", "hasOwnProperty"])(
    "omits a blank {?%s} instead of expanding a prototype member",
    (name) => {
      expect(expandUriTemplate(`x://a{?${name}}`, { [name]: "" })).toBe(
        "x://a",
      );
    },
  );

  it("omits the expression when the key is absent entirely", () => {
    expect(expandUriTemplate("x://a{?toString}", {})).toBe("x://a");
  });

  it("still expands such a variable when it really has a value", () => {
    expect(expandUriTemplate("x://a{?toString}", { toString: "v" })).toBe(
      "x://a?toString=v",
    );
  });

  it("does not treat an inherited member as satisfying a required group", () => {
    // `Object` (the inherited constructor) has length 1, so the old
    // `(values[name] ?? "").length > 0` test reported this as satisfied.
    expect(hasRequiredValues([["constructor"]], {})).toBe(false);
    expect(hasRequiredValues([["constructor"]], { constructor: "c" })).toBe(
      true,
    );
  });

  it("handles __proto__ as an ordinary variable name", () => {
    expect(expandUriTemplate("x://a{?__proto__}", {})).toBe("x://a");
  });
});
