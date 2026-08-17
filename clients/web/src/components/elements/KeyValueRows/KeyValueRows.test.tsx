import { describe, it, expect, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { renderWithMantine, screen } from "../../../test/renderWithMantine";
import { KeyValueRows } from "./KeyValueRows";

describe("KeyValueRows", () => {
  function setup(items: { key: string; value: string }[], disabled?: boolean) {
    const onChange = vi.fn();
    const onRemove = vi.fn();
    renderWithMantine(
      <KeyValueRows
        items={items}
        entityLabel="header"
        disabled={disabled}
        onChange={onChange}
        onRemove={onRemove}
      />,
    );
    return { onChange, onRemove };
  }

  it("renders nothing for an empty list", () => {
    setup([]);
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
  });

  it("names each control by entity and row so rows are distinguishable", () => {
    setup([
      { key: "Cookie", value: "a=1" },
      { key: "", value: "" },
    ]);
    expect(
      screen.getByRole("textbox", { name: "header name, Cookie, row 1" }),
    ).toHaveValue("Cookie");
    expect(
      screen.getByRole("textbox", { name: "header value, Cookie, row 1" }),
    ).toHaveValue("a=1");
    // A blank (or whitespace-only) key leaves the position alone as the name.
    expect(
      screen.getByRole("textbox", { name: "header name, row 2" }),
    ).toBeInTheDocument();
  });

  it("reports key and value edits with the row index", async () => {
    const user = userEvent.setup({ delay: null });
    const { onChange } = setup([{ key: "X", value: "1" }]);

    await user.type(
      screen.getByRole("textbox", { name: "header name, X, row 1" }),
      "Y",
    );
    expect(onChange).toHaveBeenLastCalledWith(0, "XY", "1");

    await user.type(
      screen.getByRole("textbox", { name: "header value, X, row 1" }),
      "2",
    );
    expect(onChange).toHaveBeenLastCalledWith(0, "X", "12");
  });

  it("clears a key or a value through its own named Clear button", async () => {
    const user = userEvent.setup({ delay: null });
    const { onChange } = setup([{ key: "X", value: "1" }]);

    // A bare "Clear" repeated per field would be indistinguishable across
    // rows, so each clear button names the field it empties.
    await user.click(
      screen.getByRole("button", { name: "Clear header name, X, row 1" }),
    );
    expect(onChange).toHaveBeenLastCalledWith(0, "", "1");

    await user.click(
      screen.getByRole("button", { name: "Clear header value, X, row 1" }),
    );
    expect(onChange).toHaveBeenLastCalledWith(0, "X", "");
  });

  it("omits the Clear button for an empty key or value", () => {
    setup([{ key: "", value: "" }]);
    expect(screen.queryAllByRole("button", { name: /^Clear/ })).toHaveLength(0);
  });

  it("locks every control when disabled", () => {
    setup([{ key: "X", value: "1" }], true);
    expect(
      screen.getByRole("textbox", { name: "header name, X, row 1" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("textbox", { name: "header value, X, row 1" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Clear header name, X, row 1" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Remove header, X, row 1" }),
    ).toBeDisabled();
  });

  it("distinguishes two rows that share a key", () => {
    // Duplicate keys happen mid-edit, and a server can persist duplicate
    // metadata, so the key alone cannot identify a row.
    setup([
      { key: "Set-Cookie", value: "a=1" },
      { key: "Set-Cookie", value: "b=2" },
    ]);
    expect(
      screen.getByRole("textbox", { name: "header value, Set-Cookie, row 1" }),
    ).toHaveValue("a=1");
    expect(
      screen.getByRole("textbox", { name: "header value, Set-Cookie, row 2" }),
    ).toHaveValue("b=2");
  });

  it("removes the clicked row", async () => {
    const user = userEvent.setup({ delay: null });
    const { onRemove } = setup([
      { key: "A", value: "1" },
      { key: "B", value: "2" },
    ]);

    await user.click(
      screen.getByRole("button", { name: "Remove header, B, row 2" }),
    );
    expect(onRemove).toHaveBeenCalledWith(1);
  });
});
