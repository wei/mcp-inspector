import { describe, it, expect } from "vitest";
import { resolveRootUnion } from "@inspector/core/json/rootUnion.js";

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
    expect(branches[0].ownFields).toEqual(["kind", "address"]);
    expect(branches[1].ownFields).toEqual(["kind", "phone"]);
  });

  it("strips the composition keywords it has absorbed", () => {
    const { base, branches } = resolveRootUnion({
      type: "object",
      anyOf: [EMAIL, SMS],
    });
    expect(base.anyOf).toBeUndefined();
    expect(branches[0].schema.anyOf).toBeUndefined();
  });

  it("prefers oneOf when a schema carries both", () => {
    const { branches } = resolveRootUnion({
      type: "object",
      oneOf: [EMAIL],
      anyOf: [EMAIL, SMS],
    });
    expect(branches).toHaveLength(1);
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

  it("lets a branch's declaration win a name collision with the root", () => {
    const { branches } = resolveRootUnion({
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      anyOf: [{ type: "object", properties: { id: { type: "number" } } }, SMS],
    });
    expect(branches[0].schema.properties?.id).toEqual({ type: "number" });
    // `required` unions rather than duplicating.
    expect(branches[0].schema.required).toEqual(["id"]);
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
});
