import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import type { JsonObject } from "@inspector/core/json/jsonUtils.js";
import { JsonObjectInput } from "./JsonObjectInput";

/**
 * The component is controlled, so every story drives it through a small
 * stateful wrapper — otherwise the box would not accept a keystroke and the
 * play functions could not exercise the draft behavior at all.
 */
function ControlledJsonObjectInput({ initial }: { initial: JsonObject }) {
  const [value, setValue] = useState<JsonObject>(initial);
  return (
    <JsonObjectInput
      label="Request metadata"
      aria-label="Request metadata JSON"
      value={value}
      onChange={setValue}
    />
  );
}

const meta: Meta<typeof ControlledJsonObjectInput> = {
  title: "Elements/JsonObjectInput",
  component: ControlledJsonObjectInput,
};

export default meta;
type Story = StoryObj<typeof ControlledJsonObjectInput>;

/** A structured payload renders as formatted JSON, nesting intact. */
export const Populated: Story = {
  args: {
    initial: {
      tenant: "acme",
      trace: { id: "abc123", sampled: true },
      features: ["apps", "tasks"],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const box = await canvas.findByLabelText("Request metadata JSON");
    await expect(JSON.parse((box as HTMLTextAreaElement).value)).toEqual({
      tenant: "acme",
      trace: { id: "abc123", sampled: true },
      features: ["apps", "tasks"],
    });
  },
};

/** An empty payload opens as `{}` and carries no error. */
export const Empty: Story = {
  args: { initial: {} },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const box = await canvas.findByLabelText("Request metadata JSON");
    await expect(box).toHaveValue("{}");
    await expect(canvas.queryByText(/Not valid JSON/)).toBeNull();
  },
};

/**
 * Half-typed text is displayed as typed and flagged, rather than being
 * re-escaped back into the box each keystroke (the #1928 failure this draft
 * split exists to avoid).
 */
export const InvalidDraft: Story = {
  args: { initial: {} },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const box = await canvas.findByLabelText("Request metadata JSON");
    await userEvent.clear(box);
    await userEvent.type(box, '{{"a":');
    await expect(box).toHaveValue('{"a":');
    await expect(await canvas.findByText(/Not valid JSON/)).toBeVisible();
  },
};

/** Valid JSON that is not an object is rejected with its own message. */
export const NotAnObject: Story = {
  args: { initial: {} },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const box = await canvas.findByLabelText("Request metadata JSON");
    await userEvent.clear(box);
    await userEvent.type(box, "[[1,2]");
    await expect(
      await canvas.findByText(/Must be a JSON object/),
    ).toBeVisible();
  },
};
