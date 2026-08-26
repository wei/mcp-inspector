import { describe, it, expect } from "vitest";
import {
  declaresAnyFields,
  resolveRootUnion,
  selectBranchIndex,
} from "@inspector/core/json/rootUnion.js";

const EMAIL = {
  type: "object",
  properties: {
    kind: { type: "string", const: "email" },
    address: { type: "string" },
  },
  required: ["kind", "address"],
};

const SMS = {
  type: "object",
  properties: {
    kind: { type: "string", const: "sms" },
    phone: { type: "string" },
  },
  required: ["kind", "phone"],
};

describe("resolveRootUnion", () => {
  it("leaves an ordinary object schema alone", () => {
    const schema = {
      type: "object" as const,
      properties: { message: { type: "string" as const } },
      required: ["message"],
    };
    const { base, branches } = resolveRootUnion(schema);
    expect(branches).toEqual([]);
    expect(base.properties).toEqual(schema.properties);
    expect(base.required).toEqual(["message"]);
  });

  it("returns a branch per anyOf member, merged with the root", () => {
    const { base, branches } = resolveRootUnion({
      type: "object",
      properties: { note: { type: "string" } },
      required: ["note"],
      anyOf: [EMAIL, SMS],
    });

    // The root's own fields render for every branch, so they stay on the base
    // and are merged into each branch rather than belonging to one.
    expect(Object.keys(base.properties ?? {})).toEqual(["note"]);
    expect(branches).toHaveLength(2);
    expect(Object.keys(branches[0].schema.properties ?? {})).toEqual([
      "note",
      "kind",
      "address",
    ]);
    expect(branches[0].schema.required).toEqual(["note", "kind", "address"]);
    expect(branches[0].declaredFields).toEqual(["kind", "address"]);
    expect(branches[1].declaredFields).toEqual(["kind", "phone"]);
  });

  it("strips the composition keywords it has absorbed", () => {
    const { base, branches } = resolveRootUnion({
      type: "object",
      anyOf: [EMAIL, SMS],
    });
    expect(base.anyOf).toBeUndefined();
    expect(branches[0].schema.anyOf).toBeUndefined();
  });

  it("declines a schema carrying both oneOf and anyOf", () => {
    // Independent keywords a value satisfies together, so reading one and
    // dropping the other would build a form missing real constraints.
    const { base, branches } = resolveRootUnion({
      type: "object",
      properties: { note: { type: "string" } },
      oneOf: [EMAIL],
      anyOf: [EMAIL, SMS],
    });
    expect(branches).toEqual([]);
    expect(Object.keys(base.properties ?? {})).toEqual(["note"]);
  });

  it("leaves an unsatisfiable allOf alone rather than dropping it", () => {
    // `allOf: [false, …]` admits nothing. Treating the boolean member as a
    // no-op and stripping the keyword would render a fillable form for a schema
    // that can never be satisfied.
    const schema = {
      type: "object" as const,
      allOf: [
        false as unknown,
        { type: "object", properties: { x: { type: "string" } } },
      ],
    };
    const { base, branches } = resolveRootUnion(schema);
    expect(branches).toEqual([]);
    expect(base.properties).toBeUndefined();
    expect(base.allOf).toBe(schema.allOf);
  });

  it("leaves an allOf carrying a $ref alone", () => {
    // The referent is not resolved here, so its constraints are unknown rather
    // than absent.
    const { base } = resolveRootUnion({
      type: "object",
      allOf: [{ $ref: "#/$defs/Thing" }],
    });
    expect(base.allOf).toHaveLength(1);
    expect(base.properties).toBeUndefined();
  });

  it("declines a union when the allOf beneath it could not be flattened", () => {
    const { branches } = resolveRootUnion({
      type: "object",
      allOf: [{ $ref: "#/$defs/Thing" }],
      anyOf: [EMAIL, SMS],
    });
    expect(branches).toEqual([]);
  });

  it("leaves an allOf member carrying a constraint the merge cannot apply", () => {
    // Only `properties`/`required` are merged, so a member stating anything
    // further would have that constraint erased with the keyword.
    for (const member of [
      { type: "object", properties: { x: {} }, additionalProperties: false },
      { type: "object", properties: { x: {} }, not: { properties: {} } },
      { type: "string", properties: { x: {} } },
    ]) {
      const { base } = resolveRootUnion({
        type: "object" as const,
        allOf: [member as unknown],
      });
      expect(base.allOf).toHaveLength(1);
      expect(base.properties).toBeUndefined();
    }
  });

  it("declines an allOf whose members contradict each other", () => {
    // Neither conflicts with the root, which declares no `x` at all.
    const { base } = resolveRootUnion({
      type: "object",
      allOf: [
        { type: "object", properties: { x: { minimum: 10 } } },
        { type: "object", properties: { x: { minimum: 0 } } },
      ],
    });
    expect(base.allOf).toHaveLength(2);
    expect(base.properties).toBeUndefined();
  });

  it("merges allOf branches unconditionally", () => {
    const { base, branches } = resolveRootUnion({
      type: "object",
      properties: { a: { type: "string" } },
      required: ["a"],
      allOf: [
        {
          type: "object",
          properties: { b: { type: "number" } },
          required: ["b"],
        },
      ],
    });
    expect(branches).toEqual([]);
    expect(Object.keys(base.properties ?? {})).toEqual(["a", "b"]);
    expect(base.required).toEqual(["a", "b"]);
    expect(base.allOf).toBeUndefined();
  });

  it("merges allOf into every union branch", () => {
    const { branches } = resolveRootUnion({
      type: "object",
      allOf: [{ type: "object", properties: { shared: { type: "string" } } }],
      oneOf: [EMAIL, SMS],
    });
    expect(Object.keys(branches[0].schema.properties ?? {})).toContain(
      "shared",
    );
  });

  it("merges a name collision rather than replacing the root's declaration", () => {
    // Both apply, so the root's floor must survive the branch's ceiling.
    const { branches } = resolveRootUnion({
      type: "object",
      properties: { id: { type: "number", minimum: 0 } },
      required: ["id"],
      anyOf: [
        { type: "object", properties: { id: { maximum: 10 } } },
        { type: "object", properties: { other: { type: "string" } } },
      ],
    });
    expect(branches[0].schema.properties?.id).toEqual({
      type: "number",
      minimum: 0,
      maximum: 10,
    });
    // `required` unions rather than duplicating.
    expect(branches[0].schema.required).toEqual(["id"]);
    // The branch declares the name, even though the base did too.
    expect(branches[0].declaredFields).toEqual(["id"]);
  });

  it("declines a union whose branch restates a constraint differently", () => {
    // Both apply, so root `minimum: 10` under branch `minimum: 0` is still 10.
    // Rendering either side would accept a value the schema rejects.
    const { branches } = resolveRootUnion({
      type: "object",
      properties: { x: { type: "number", minimum: 10 } },
      anyOf: [
        { type: "object", properties: { x: { minimum: 0 } } },
        { type: "object", properties: { other: { type: "string" } } },
      ],
    });
    expect(branches).toEqual([]);
  });

  it("tolerates a branch disagreeing only about annotations", () => {
    const { branches } = resolveRootUnion({
      type: "object",
      properties: { x: { type: "number", description: "root" } },
      anyOf: [
        {
          type: "object",
          properties: { x: { description: "branch", maximum: 3 } },
        },
        { type: "object", properties: { other: { type: "string" } } },
      ],
    });
    expect(branches).toHaveLength(2);
    expect(branches[0].schema.properties?.x).toEqual({
      type: "number",
      description: "branch",
      maximum: 3,
    });
  });

  it("carries an identical non-object declaration across", () => {
    // JSON Schema's boolean form is legal as a property schema. There are no
    // keywords to merge, so the two agree only by being the same declaration.
    const { branches } = resolveRootUnion({
      type: "object",
      properties: { x: true as unknown },
      anyOf: [
        { type: "object", properties: { x: true as unknown } },
        { type: "object", properties: { other: { type: "string" } } },
      ],
    });
    expect(branches).toHaveLength(2);
    expect(branches[0].schema.properties?.x).toBe(true);
  });

  it("declines a union whose branch redeclares a non-object property differently", () => {
    const { branches } = resolveRootUnion({
      type: "object",
      properties: { x: true as unknown },
      anyOf: [
        { type: "object", properties: { x: false as unknown } },
        { type: "object", properties: { other: { type: "string" } } },
      ],
    });
    expect(branches).toEqual([]);
  });

  it("declines a union whose branch contradicts the root's type for a field", () => {
    // `string` under a base `number` describes a value that cannot exist, so
    // flattening it would render one type and accept what the schema rejects.
    const { branches } = resolveRootUnion({
      type: "object",
      properties: { id: { type: "number" } },
      anyOf: [
        { type: "object", properties: { id: { type: "string" } } },
        { type: "object", properties: { other: { type: "string" } } },
      ],
    });
    expect(branches).toEqual([]);
  });

  describe("branch labels", () => {
    it("uses the branch's own title first", () => {
      const { branches } = resolveRootUnion({
        type: "object",
        anyOf: [{ ...EMAIL, title: "By email" }, SMS],
      });
      expect(branches[0].label).toBe("By email");
    });

    it("uses the discriminator property's const when one is named", () => {
      const { branches } = resolveRootUnion({
        type: "object",
        discriminator: { propertyName: "kind" },
        oneOf: [EMAIL, SMS],
      });
      expect(branches.map((branch) => branch.label)).toEqual(["email", "sms"]);
    });

    it("uses a lone constant-valued property when there is no discriminator", () => {
      const { branches } = resolveRootUnion({
        type: "object",
        anyOf: [EMAIL, SMS],
      });
      expect(branches.map((branch) => branch.label)).toEqual(["email", "sms"]);
    });

    it("falls back to a position when a branch has several constants", () => {
      const twoConstants = {
        type: "object",
        properties: {
          kind: { const: "a" },
          other: { const: "b" },
        },
      };
      const { branches } = resolveRootUnion({
        type: "object",
        anyOf: [twoConstants, SMS],
      });
      expect(branches[0].label).toBe("Option 1");
    });

    it("falls back to a position when a branch names no constant", () => {
      const { branches } = resolveRootUnion({
        type: "object",
        anyOf: [
          { type: "object", properties: { a: { type: "string" } } },
          { type: "object", properties: { b: { type: "string" } } },
        ],
      });
      expect(branches.map((branch) => branch.label)).toEqual([
        "Option 1",
        "Option 2",
      ]);
    });

    it("ignores a discriminator naming a property without a usable const", () => {
      const { branches } = resolveRootUnion({
        type: "object",
        discriminator: { propertyName: "missing" },
        anyOf: [EMAIL, SMS],
      });
      expect(branches[0].label).toBe("email");
    });

    it("labels a numeric const by its value", () => {
      const { branches } = resolveRootUnion({
        type: "object",
        anyOf: [
          { type: "object", properties: { v: { const: 1 } } },
          { type: "object", properties: { v: { const: 2 } } },
        ],
      });
      expect(branches.map((branch) => branch.label)).toEqual(["1", "2"]);
    });

    it("ignores a blank title", () => {
      const { branches } = resolveRootUnion({
        type: "object",
        anyOf: [{ ...EMAIL, title: "  " }, SMS],
      });
      expect(branches[0].label).toBe("email");
    });
  });

  describe("unions it declines to offer", () => {
    // Each of these would produce a picker with an option that renders
    // nothing, which is the failure this module exists to prevent.
    it("declines a union with a member that is not an object", () => {
      const { branches } = resolveRootUnion({
        type: "object",
        anyOf: [EMAIL, "nope" as unknown],
      });
      expect(branches).toEqual([]);
    });

    it("declines a union with a fieldless member", () => {
      const { branches } = resolveRootUnion({
        type: "object",
        anyOf: [EMAIL, { type: "null" }],
      });
      expect(branches).toEqual([]);
    });

    it("declines a member whose type rules objects out", () => {
      // Tool arguments are a JSON object, so a `{ type: "string" }` member can
      // never match — a fillable form for it would offer an invalid call.
      const { branches } = resolveRootUnion({
        type: "object",
        anyOf: [EMAIL, { type: "string", properties: { a: {} } }],
      });
      expect(branches).toEqual([]);
    });

    it("declines a member whose properties are not an object", () => {
      // Members arrive as `unknown`, so this is reachable and must not throw.
      expect(
        resolveRootUnion({
          type: "object",
          anyOf: [EMAIL, { type: "object", properties: null as unknown }],
        }).branches,
      ).toEqual([]);
    });

    it("declines a member carrying a constraint the merge cannot apply", () => {
      // Same faithfulness test the `allOf` fold applies — otherwise a branch
      // whose nested `allOf: [false]` makes it unsatisfiable is offered as a
      // callable alternative.
      const { branches } = resolveRootUnion({
        type: "object",
        anyOf: [
          EMAIL,
          {
            type: "object",
            properties: { x: { type: "string" } },
            allOf: [false as unknown],
          },
        ],
      });
      expect(branches).toEqual([]);
    });

    it("declines an empty union", () => {
      expect(resolveRootUnion({ type: "object", anyOf: [] }).branches).toEqual(
        [],
      );
    });

    it("ignores an allOf member that is not an object", () => {
      const { base } = resolveRootUnion({
        type: "object",
        properties: { a: { type: "string" } },
        allOf: [null as unknown, 3 as unknown],
      });
      expect(Object.keys(base.properties ?? {})).toEqual(["a"]);
    });
  });

  describe("declaresAnyFields", () => {
    it("sees fields on a union the resolver declines", () => {
      // A declined union still HAS fields — reporting none would auto-invoke an
      // App tool with `{}` instead of asking for them.
      const schema = {
        type: "object" as const,
        anyOf: [EMAIL, { $ref: "#/$defs/SMS" }],
      };
      expect(resolveRootUnion(schema).branches).toEqual([]);
      expect(declaresAnyFields(schema)).toBe(true);
    });

    it("sees fields nested a level down", () => {
      expect(
        declaresAnyFields({
          type: "object",
          allOf: [{ type: "object", anyOf: [EMAIL, SMS] }],
        }),
      ).toBe(true);
    });

    it("reports none for a bare object schema", () => {
      expect(declaresAnyFields({ type: "object" })).toBe(false);
      expect(declaresAnyFields(undefined)).toBe(false);
    });
  });

  describe("selectBranchIndex", () => {
    const { branches } = resolveRootUnion({
      type: "object",
      anyOf: [EMAIL, SMS],
    });

    it("names the branch whose discriminator the values carry", () => {
      expect(selectBranchIndex(branches, { kind: "sms" })).toBe(1);
    });

    it("identifies a branch from the constants that were supplied", () => {
      // Both branches pin `version` as well; a deep link naming only `kind`
      // must still find its branch — the unsupplied constant is one this
      // identification exists to seed.
      const versioned = resolveRootUnion({
        type: "object",
        anyOf: [
          {
            type: "object",
            properties: {
              version: { const: "1" },
              kind: { const: "email" },
            },
          },
          {
            type: "object",
            properties: { version: { const: "1" }, kind: { const: "sms" } },
          },
        ],
      }).branches;
      expect(selectBranchIndex(versioned, { kind: "sms" })).toBe(1);
      // A supplied constant that disagrees is still evidence against.
      expect(selectBranchIndex(versioned, { version: "2", kind: "sms" })).toBe(
        null,
      );
    });

    it("reports none when the values identify nothing", () => {
      expect(selectBranchIndex(branches, {})).toBeNull();
      expect(selectBranchIndex(branches, { kind: "other" })).toBeNull();
    });

    it("reports none when two branches match", () => {
      // An ambiguous answer is worse than none: the caller falls back to the
      // first branch, where the picker and the values at least agree.
      const ambiguous = resolveRootUnion({
        type: "object",
        anyOf: [EMAIL, { ...EMAIL, properties: { ...EMAIL.properties } }],
      }).branches;
      expect(selectBranchIndex(ambiguous, { kind: "email" })).toBeNull();
    });

    it("reports none for a branch that pins nothing", () => {
      const unpinned = resolveRootUnion({
        type: "object",
        anyOf: [
          { type: "object", properties: { a: { type: "string" } } },
          { type: "object", properties: { b: { type: "string" } } },
        ],
      }).branches;
      expect(selectBranchIndex(unpinned, { a: "x" })).toBeNull();
    });
  });
});
