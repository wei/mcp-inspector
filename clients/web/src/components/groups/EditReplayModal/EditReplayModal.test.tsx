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

  // `JSON.parse("1e400")` yields `Infinity`, which `JSON.stringify` writes back
  // as `null` — so Send would dispatch a number the user never typed while the
  // editor still showed what they wrote.
  it("disables Send for a number that cannot survive being sent", async () => {
    renderWithMantine(<EditReplayModal {...baseProps} />);
    await setAceText('{"limit":1e400}');
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    expect(screen.getByText(/Numbers must be finite/)).toBeInTheDocument();
  });

  // Replay dispatches through the typed client methods, so a param they have no
  // room for is dropped. Saying which, rather than seeding it into the editor,
  // is what keeps the modal from inviting an edit that Send discards.
  it("names the params replay cannot re-send", () => {
    renderWithMantine(
      <EditReplayModal
        {...baseProps}
        params={{ name: "echo" }}
        droppedParamKeys={["_meta"]}
      />,
    );
    expect(screen.getByText(/`_meta` is not re-sent/)).toBeInTheDocument();
  });

  it("says nothing when every param survives", () => {
    renderWithMantine(
      <EditReplayModal
        {...baseProps}
        params={{ name: "echo" }}
        droppedParamKeys={[]}
      />,
    );
    expect(screen.queryByText(/not re-sent/)).toBeNull();
  });

  it("agrees with its verb for several dropped params", () => {
    renderWithMantine(
      <EditReplayModal
        {...baseProps}
        params={{ cursor: "abc" }}
        droppedParamKeys={["_meta", "extra"]}
      />,
    );
    expect(
      screen.getByText(/`_meta`, `extra` are not re-sent/),
    ).toBeInTheDocument();
  });

  // Seeding from the projection is only half of it: a key the dispatcher does
  // not read can be *added* to the draft, and Send would then discard an edit
  // the user was looking at.
  it("disables Send for a key this method's dispatch would not read", async () => {
    renderWithMantine(
      <EditReplayModal {...baseProps} method="tools/list" params={undefined} />,
    );
    await setAceText('{"cursor":"abc","_meta":{"progressToken":1}}');
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    expect(
      screen.getByText(/`_meta` is not carried by tools\/list/),
    ).toBeInTheDocument();
  });

  it("re-enables Send once the unsupported key is removed", async () => {
    renderWithMantine(
      <EditReplayModal {...baseProps} method="tools/list" params={undefined} />,
    );
    await setAceText('{"cursor":"abc","_meta":{}}');
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();

    await setAceText('{"cursor":"abc"}');
    expect(screen.getByRole("button", { name: "Send" })).not.toBeDisabled();
    expect(screen.queryByText(/not carried by/)).toBeNull();
  });

  // The check is per method, not a fixed key list: `arguments` is read by a
  // tool call and by nothing on a list request.
  it("judges a key against the method it would be sent to", async () => {
    const { rerender } = renderWithMantine(
      <EditReplayModal {...baseProps} method="tools/call" />,
    );
    await setAceText('{"name":"echo","arguments":{"a":1}}');
    expect(screen.getByRole("button", { name: "Send" })).not.toBeDisabled();

    rerender(<EditReplayModal {...baseProps} method="tools/list" />);
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    expect(
      screen.getByText(/`name`, `arguments` are not carried by tools\/list/),
    ).toBeInTheDocument();
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
