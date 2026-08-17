import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { KeyValueRows } from "./KeyValueRows";

const meta: Meta<typeof KeyValueRows> = {
  title: "Elements/KeyValueRows",
  component: KeyValueRows,
  args: {
    entityLabel: "header",
    onChange: fn(),
    onRemove: fn(),
  },
};

export default meta;
type Story = StoryObj<typeof KeyValueRows>;

// Each row's controls carry a row-scoped accessible name, so a screen reader
// can tell one row's key box from another's.
export const Populated: Story = {
  args: {
    items: [
      { key: "Cookie", value: "branch=feature-x" },
      { key: "X-Env", value: "dev" },
    ],
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    const value = await canvas.findByRole("textbox", {
      name: "header value, Cookie",
    });
    await expect(value).toHaveValue("branch=feature-x");

    await userEvent.click(
      canvas.getByRole("button", { name: "Remove header, X-Env" }),
    );
    await expect(args.onRemove).toHaveBeenCalledWith(1);
  },
};

// A row whose key is still blank falls back to a positional name rather than
// announcing nothing.
export const BlankKeyRow: Story = {
  args: { items: [{ key: "", value: "" }] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("textbox", { name: "header name, row 1" }),
    ).toBeInTheDocument();
  },
};

// An empty list renders nothing — callers draw their own empty-state hint.
export const Empty: Story = {
  args: { items: [] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryAllByRole("textbox")).toHaveLength(0);
  },
};
