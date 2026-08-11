import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { StructuredOutputPanel } from "./StructuredOutputPanel";

const nested = {
  items: [
    { id: 1, name: "Item A", tags: ["foo", "bar"] },
    { id: 2, name: "Item B", tags: ["baz"] },
  ],
  total: 2,
};

const flat = {
  temperature: 25,
  unit: "C",
  city: "San Francisco",
};

// Long enough that the payload exceeds the section's max height and scrolls
// within it rather than pushing the rest of the result panel down.
const large = {
  rows: Array.from({ length: 60 }, (_, index) => ({
    id: index + 1,
    label: `Row ${index + 1}`,
    value: index * 7,
  })),
  total: 60,
};

const meta: Meta<typeof StructuredOutputPanel> = {
  title: "Groups/StructuredOutputPanel",
  component: StructuredOutputPanel,
};

export default meta;
type Story = StoryObj<typeof StructuredOutputPanel>;

export const Nested: Story = {
  args: {
    structuredContent: nested,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(
      canvas.getByRole("heading", { name: "Structured Output" }),
    ).toBeInTheDocument();
    // The section starts expanded, so the payload is visible without a click.
    // Asserted on the container's text: once the Prism grammar loads, the JSON
    // is split across per-token elements, so no single node holds the value.
    await waitFor(() =>
      expect(canvasElement.textContent).toContain('"Item A"'),
    );
  },
};

export const Flat: Story = {
  args: {
    structuredContent: flat,
  },
};

export const Large: Story = {
  args: {
    structuredContent: large,
  },
};

// Collapsing hides the payload; expanding brings it back.
export const Collapsed: Story = {
  args: {
    structuredContent: nested,
    defaultExpanded: false,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const toggle = canvas.getByRole("button", {
      name: "Expand structured output",
    });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(toggle);
    await waitFor(() =>
      expect(
        canvas.getByRole("button", { name: "Collapse structured output" }),
      ).toHaveAttribute("aria-expanded", "true"),
    );
    await waitFor(() =>
      expect(canvasElement.textContent).toContain('"Item A"'),
    );
  },
};
