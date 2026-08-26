import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import type { Tool } from "@modelcontextprotocol/client";
import { lintToolSchemas } from "@inspector/core/json/schemaLint.js";
import { SchemaFindingsList } from "./SchemaFindingsList";

/** Lint a schema fixture the way the real panels do, so the stories show the
 * module's own wording rather than hand-written findings that could drift. */
function findingsFor(tool: Partial<Tool>) {
  return lintToolSchemas({ name: "info", ...tool } as Tool);
}

const meta: Meta<typeof SchemaFindingsList> = {
  title: "Elements/SchemaFindingsList",
  component: SchemaFindingsList,
};

export default meta;
type Story = StoryObj<typeof SchemaFindingsList>;

/** The reported case: Go's `jsonschema` emits `true` for an `interface{}`. */
export const BareTrueProperty: Story = {
  args: {
    findings: findingsFor({
      outputSchema: {
        type: "object",
        properties: { data: true, topic: { type: "string" } },
      },
    } as Partial<Tool>),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Schema portability (1)")).toBeVisible();
    await expect(canvas.getByText("error")).toBeVisible();
    await expect(
      canvas.getByText("outputSchema.properties.data"),
    ).toBeVisible();
  },
};

/** Warning-only: an array-form `type`, legal but read unevenly. */
export const TypeUnionWarning: Story = {
  args: {
    findings: findingsFor({
      inputSchema: {
        type: "object",
        properties: { show_ids: { type: ["null", "boolean"] } },
      },
    } as Partial<Tool>),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("warning")).toBeVisible();
    await expect(canvas.queryByText("error")).toBeNull();
  },
};

/** Both severities on one tool, which is what a real problem server looks like. */
export const Mixed: Story = {
  args: {
    findings: findingsFor({
      inputSchema: {
        type: "object",
        properties: {
          show_ids: { type: ["null", "boolean"] },
          extra: {},
          ref: { $ref: "https://example.com/s.json" },
        },
      },
      outputSchema: { type: "object", properties: { data: true } },
    } as Partial<Tool>),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Schema portability (4)")).toBeVisible();
  },
};

/** The common case — nothing to say, so the section renders nothing at all. */
export const Clean: Story = {
  args: { findings: [] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByTestId("schema-findings")).toBeNull();
  },
};
