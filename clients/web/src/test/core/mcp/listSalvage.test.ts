import { describe, it, expect } from "vitest";
import { z } from "zod/v4";
import { SdkError, SdkErrorCode } from "@modelcontextprotocol/client";
import {
  LenientListPageSchema,
  describeIssues,
  isClientDecodeRejection,
  labelForRawItem,
  rawItemsOf,
  salvageListItems,
  summarizeMalformed,
} from "@inspector/core/mcp/listSalvage.js";

/**
 * Per-item list salvage (#1909).
 *
 * These cover the pure half — deciding what is salvageable and how it is
 * described. The client-side half (fall back only on a decode rejection, keep
 * the strict path otherwise) is driven end to end against a real malformed
 * server in `src/test/integration/mcp/inspectorClient-malformed-list.test.ts`.
 */

const ItemSchema = z.object({
  name: z.string(),
  annotations: z.object({ priority: z.number().optional() }).optional(),
});

describe("isClientDecodeRejection", () => {
  it("is true for a result the client received and refused", () => {
    const err = new SdkError(SdkErrorCode.InvalidResult, "bad result");
    expect(isClientDecodeRejection(err)).toBe(true);
  });

  it("is true for a result type the codec cannot handle", () => {
    const err = new SdkError(SdkErrorCode.UnsupportedResultType, "unknown");
    expect(isClientDecodeRejection(err)).toBe(true);
  });

  it("is false for a failure that produced no result to salvage", () => {
    // A transport drop / timeout: re-listing would just fail again, and there
    // is no response frame to pick entries out of.
    expect(isClientDecodeRejection(new Error("socket hang up"))).toBe(false);
    expect(
      isClientDecodeRejection(
        new SdkError(SdkErrorCode.RequestTimeout, "timed out"),
      ),
    ).toBe(false);
  });
});

describe("LenientListPageSchema", () => {
  it("keeps the primitive array unvalidated while typing the cursor", () => {
    const parsed = LenientListPageSchema.parse({
      resourceTemplates: [{ name: "ok" }, { name: 42 }],
      nextCursor: "page-2",
    });
    expect(parsed.nextCursor).toBe("page-2");
    expect(rawItemsOf(parsed, "resourceTemplates")).toHaveLength(2);
  });

  it("rejects a page whose cursor is malformed", () => {
    // The walk itself depends on `nextCursor`, so a bad one is not salvageable
    // — the strict error should stand rather than a partial list being kept.
    expect(
      LenientListPageSchema.safeParse({ tools: [], nextCursor: 7 }).success,
    ).toBe(false);
  });

  it("distinguishes an empty page from one that is not a list at all", () => {
    // Reading either as "no entries" would let a top-level violation pass as a
    // silently truncated list.
    expect(
      rawItemsOf(LenientListPageSchema.parse({ tools: [] }), "tools"),
    ).toEqual([]);
    expect(rawItemsOf({}, "tools")).toBeUndefined();
    expect(
      rawItemsOf(LenientListPageSchema.parse({ tools: "not-a-list" }), "tools"),
    ).toBeUndefined();
  });
});

describe("labelForRawItem", () => {
  it("prefers a name, then a uriTemplate, uri, or title", () => {
    expect(labelForRawItem({ name: "get_weather" })).toBe("get_weather");
    expect(labelForRawItem({ uriTemplate: "file:///{path}" })).toBe(
      "file:///{path}",
    );
    expect(labelForRawItem({ uri: "test://one" })).toBe("test://one");
    expect(labelForRawItem({ title: "Titled" })).toBe("Titled");
  });

  it("has no label for an entry too broken to carry one", () => {
    expect(labelForRawItem(null)).toBeUndefined();
    expect(labelForRawItem("just a string")).toBeUndefined();
    expect(labelForRawItem(7)).toBeUndefined();
    expect(labelForRawItem({ name: "" })).toBeUndefined();
    expect(labelForRawItem({ name: 42 })).toBeUndefined();
  });
});

describe("describeIssues", () => {
  it("names the offending field so the reader doesn't have to hunt", () => {
    const result = ItemSchema.safeParse({ name: "t", annotations: [] });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(describeIssues(result.error)).toMatch(
      /^annotations: .*expected object/i,
    );
  });

  it("names the expected type even when zod's message omits it", () => {
    // The browser build reports a bare "Invalid input" where Node spells out
    // "expected object, received array" — without the expected type the warning
    // says something is wrong but not what would be right.
    const terse = new z.ZodError([
      {
        code: "invalid_type",
        expected: "object",
        path: ["annotations"],
        message: "Invalid input",
        // Double cast: the terse-message shape is what zod's BROWSER build
        // emits, and no parse run under Node can produce it — the issue has to
        // be hand-built, and `$ZodIssue`'s union doesn't accept a literal.
      } as unknown as z.core.$ZodIssue,
    ]);
    expect(describeIssues(terse)).toBe(
      "annotations: Invalid input (expected object)",
    );
  });

  it("does not repeat an expected type the message already carries", () => {
    const result = ItemSchema.safeParse({ name: "t", annotations: [] });
    expect(result.success).toBe(false);
    if (result.success) return;
    const described = describeIssues(result.error);
    expect(described.match(/expected object/g)).toHaveLength(1);
  });

  it("omits the path when the failure is the entry itself", () => {
    const result = ItemSchema.safeParse("not an object");
    expect(result.success).toBe(false);
    if (result.success) return;
    const described = describeIssues(result.error);
    expect(described).not.toMatch(/^:/);
    expect(described).toMatch(/expected object/i);
  });
});

describe("salvageListItems", () => {
  it("keeps the valid entries and reports only the broken one", () => {
    const { valid, malformed } = salvageListItems({
      method: "resources/templates/list",
      items: [
        { name: "empty_annotations", annotations: {} },
        { name: "array_annotations", annotations: [] },
        { name: "full_annotations", annotations: { priority: 0.8 } },
      ],
      schema: ItemSchema,
    });

    expect(valid.map((item) => item.name)).toEqual([
      "empty_annotations",
      "full_annotations",
    ]);
    expect(malformed).toEqual([
      {
        method: "resources/templates/list",
        index: 1,
        label: "array_annotations",
        reason: expect.stringMatching(/^annotations: /),
      },
    ]);
  });

  it("reports an unlabelable entry by its position", () => {
    const { valid, malformed } = salvageListItems({
      method: "tools/list",
      items: [null],
      schema: ItemSchema,
    });
    expect(valid).toEqual([]);
    expect(malformed[0]).toMatchObject({ index: 0 });
    expect(malformed[0]).not.toHaveProperty("label");
  });

  it("indexes against the aggregated list, not the page", () => {
    // Page 2 of a paginated walk: an index that restarted per page would point
    // at the wrong entry in the list the user is looking at.
    const { malformed } = salvageListItems({
      method: "tools/list",
      items: [{ name: "ok" }, { name: 5 }],
      schema: ItemSchema,
      startIndex: 10,
    });
    expect(malformed[0]?.index).toBe(11);
  });

  it("salvages nothing from a wholly conforming page", () => {
    const { valid, malformed } = salvageListItems({
      method: "prompts/list",
      items: [{ name: "a" }, { name: "b" }],
      schema: ItemSchema,
    });
    expect(valid).toHaveLength(2);
    expect(malformed).toEqual([]);
  });
});

describe("summarizeMalformed", () => {
  it("names the single dropped entry and why", () => {
    expect(
      summarizeMalformed([
        {
          method: "resources/templates/list",
          index: 1,
          label: "array_annotations",
          reason: "annotations: expected object, received array",
        },
      ]),
    ).toBe(
      "Dropped 1 malformed entry — array_annotations: annotations: expected object, received array",
    );
  });

  it("counts the rest when several failed, falling back to the index", () => {
    const summary = summarizeMalformed([
      { method: "tools/list", index: 0, reason: "expected object" },
      { method: "tools/list", index: 3, reason: "expected object" },
    ]);
    expect(summary).toContain("Dropped 2 malformed entries");
    expect(summary).toContain("index 0");
    expect(summary).toContain("(+1 more)");
  });
});
