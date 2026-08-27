import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent } from "storybook/test";
import { JsonEditor } from "./JsonEditor";

const meta: Meta<typeof JsonEditor> = {
  title: "Elements/JsonEditor",
  component: JsonEditor,
};

export default meta;
type Story = StoryObj<typeof JsonEditor>;

const SAMPLE = JSON.stringify(
  {
    trace: { id: "abc-123", sampled: true },
    tags: ["alpha", "beta"],
    retries: 3,
  },
  null,
  2,
);

/** The live editor instance, which Ace hangs off its container as `env.editor`. */
function aceEditor(canvasElement: HTMLElement): {
  focus(): void;
  getValue(): string;
} {
  const container = canvasElement.querySelector(".ace_editor");
  const editor = (
    container as
      | (HTMLElement & {
          env?: { editor?: { focus(): void; getValue(): string } };
        })
      | null
  )?.env?.editor;
  if (!editor) throw new Error("Ace editor not mounted");
  return editor;
}

/**
 * Stateful wrapper: the editor is controlled on text by every real consumer, so
 * a story without one would not accept a keystroke.
 *
 * Ace's *keyboard* behavior — auto-closing a brace, keeping an invalid draft
 * raw, the worker's gutter annotation — is covered by the `JsonObjectInput`
 * play functions, which drive this same editor through its object-shaped
 * wrapper. What is left to pin here is the read-only mode those cannot reach.
 */
function Editable({ initial }: { initial: string }) {
  const [text, setText] = useState(initial);
  return (
    <JsonEditor
      ariaLabel="Payload JSON"
      label="Payload"
      value={text}
      onChange={setText}
    />
  );
}

export const Editing: Story = {
  render: () => <Editable initial={SAMPLE} />,
};

export const Empty: Story = {
  render: () => <Editable initial="" />,
};

export const WithError: Story = {
  args: {
    ariaLabel: "Payload JSON",
    label: "Payload",
    value: '{"a":',
    description: "Sent with every request.",
    error: "Not valid JSON — changes are not applied",
    onChange: () => {},
  },
};

export const Disabled: Story = {
  args: {
    ariaLabel: "Payload JSON",
    label: "Payload",
    value: SAMPLE,
    disabled: true,
    onChange: () => {},
  },
};

/**
 * Display mode — what every read-only JSON payload in the app renders as
 * (#2151). It keeps the folding and the line numbers a large `tools/call`
 * result gains from, and takes no input.
 *
 * The keystroke assertion is the point: a read-only Ace editor is still
 * focusable and still owns a hidden textarea, so "does not edit" is a real
 * behavior to pin rather than a property of the markup.
 */
export const ReadOnly: Story = {
  args: {
    ariaLabel: "JSON content",
    value: SAMPLE,
    readOnly: true,
  },
  play: async ({ canvasElement }) => {
    const editor = aceEditor(canvasElement);
    editor.focus();
    await userEvent.keyboard("x");
    await expect(editor.getValue()).toBe(SAMPLE);
    // The caret is hidden too — a blinking cursor in a box that swallows every
    // keystroke reads as a broken field.
    await expect(
      canvasElement.querySelector(".json-editor-readonly"),
    ).not.toBeNull();
  },
};
