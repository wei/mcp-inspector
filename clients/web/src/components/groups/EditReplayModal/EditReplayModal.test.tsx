import { describe, it, expect, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { renderWithMantine, screen } from "../../../test/renderWithMantine";
import { getAceText, setAceText } from "../../../test/aceEditor";
import { EditReplayModal } from "./EditReplayModal";

const baseProps = {
  opened: true,
  method: "tools/call",
  onSend: vi.fn(),
  onClose: vi.fn(),
};

describe("EditReplayModal", () => {
  it("renders nothing while closed", () => {
    renderWithMantine(<EditReplayModal {...baseProps} opened={false} />);
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
  });

  it("seeds the editor with the entry's params and names the method", () => {
    renderWithMantine(
      <EditReplayModal {...baseProps} params={{ name: "echo" }} />,
    );
    expect(getAceText()).toBe('{\n  "name": "echo"\n}');
    expect(screen.getByText("tools/call")).toBeInTheDocument();
  });

  it("opens empty for a request that carried no params", () => {
    renderWithMantine(<EditReplayModal {...baseProps} method="tools/list" />);
    expect(getAceText()).toBe("");
    expect(screen.getByRole("button", { name: "Send" })).not.toBeDisabled();
  });

  it("sends the edited params and closes", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    const onClose = vi.fn();
    renderWithMantine(
      <EditReplayModal
        {...baseProps}
        params={{ name: "echo" }}
        onSend={onSend}
        onClose={onClose}
      />,
    );
    await setAceText('{"name":"add","arguments":{"a":1}}');
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(onSend).toHaveBeenCalledWith({
      name: "add",
      arguments: { a: 1 },
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // `null`, not `undefined`: the caller has to be able to tell "the user
  // cleared the editor" from "the user did not edit anything" (#2151).
  it("reports an emptied editor as no params at all", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    renderWithMantine(
      <EditReplayModal
        {...baseProps}
        params={{ name: "echo" }}
        onSend={onSend}
      />,
    );
    await setAceText("");
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(onSend).toHaveBeenCalledWith(null);
  });

  // Unlike the metadata editor, this modal has a commit gesture to gate — so
  // invalid text must disable it rather than silently sending the last value
  // that parsed.
  it("disables Send while the draft does not parse", async () => {
    renderWithMantine(
      <EditReplayModal {...baseProps} params={{ name: "echo" }} />,
    );
    await setAceText('{"name":');
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    expect(screen.getByText(/Not valid JSON/)).toBeInTheDocument();
  });

  it("disables Send for JSON that is not an object", async () => {
    renderWithMantine(<EditReplayModal {...baseProps} />);
    await setAceText("42");
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    expect(screen.getByText(/must be a JSON object/i)).toBeInTheDocument();
  });

  it("closes without sending when cancelled", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    const onClose = vi.fn();
    renderWithMantine(
      <EditReplayModal {...baseProps} onSend={onSend} onClose={onClose} />,
    );
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSend).not.toHaveBeenCalled();
  });

  // The draft belongs to the one opening of the modal it was typed in.
  // Reopening must show the entry's params again, not whatever was typed and
  // abandoned last time.
  it("reseeds from the entry when reopened", async () => {
    const { rerender } = renderWithMantine(
      <EditReplayModal {...baseProps} params={{ name: "echo" }} />,
    );
    await setAceText('{"name":"abandoned"}');

    rerender(
      <EditReplayModal
        {...baseProps}
        opened={false}
        params={{ name: "echo" }}
      />,
    );
    rerender(<EditReplayModal {...baseProps} params={{ name: "echo" }} />);
    expect(getAceText()).toBe('{\n  "name": "echo"\n}');
  });
});
