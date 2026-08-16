import { describe, it, expect } from "vitest";
import { previewUriTemplate } from "./uriTemplate";

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

  it("expands a partially-filled multi-name expression, as submitting would", () => {
    // RFC 6570 drops the undefined names rather than the whole expression, so
    // showing `{?one,two}` here would promise a URI the submit does not send.
    expect(previewUriTemplate("x://a{?one,two}", { one: "1" })).toBe(
      "x://a?one=1",
    );
  });

  it("keeps a multi-name expression whole while none of its names is filled", () => {
    expect(previewUriTemplate("x://a{?one,two}", {})).toBe("x://a{?one,two}");
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

describe("previewUriTemplate - multi-name expressions", () => {
  it("applies the same correction the real expansion does", () => {
    // Must match expandUriTemplate("x://{a,b}", ...) exactly, or the preview
    // would promise a URI that submitting does not send.
    expect(previewUriTemplate("x://{a,b}", { a: "foo/bar", b: "q" })).toBe(
      "x://foo%2Fbar,q",
    );
  });
});
