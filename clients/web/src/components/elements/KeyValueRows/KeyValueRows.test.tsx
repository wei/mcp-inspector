import { describe, it, expect, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { renderWithMantine, screen } from "../../../test/renderWithMantine";
import { KeyValueRows } from "./KeyValueRows";

describe("KeyValueRows", () => {
  function setup(items: { key: string; value: string }[]) {
    const onChange = vi.fn();
    const onRemove = vi.fn();
    renderWithMantine(
      <KeyValueRows
        items={items}
        entityLabel="header"
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
      screen.getByRole("textbox", { name: "header name, Cookie" }),
    ).toHaveValue("Cookie");
    expect(
      screen.getByRole("textbox", { name: "header value, Cookie" }),
    ).toHaveValue("a=1");
    // A key that is blank (or only whitespace) falls back to its position.
    expect(
      screen.getByRole("textbox", { name: "header name, row 2" }),
    ).toBeInTheDocument();
  });

  it("reports key and value edits with the row index", async () => {
    const user = userEvent.setup({ delay: null });
    const { onChange } = setup([{ key: "X", value: "1" }]);

    await user.type(
      screen.getByRole("textbox", { name: "header name, X" }),
      "Y",
    );
    expect(onChange).toHaveBeenLastCalledWith(0, "XY", "1");

    await user.type(
      screen.getByRole("textbox", { name: "header value, X" }),
      "2",
    );
    expect(onChange).toHaveBeenLastCalledWith(0, "X", "12");
  });

  it("clears a key or a value through its Clear button", async () => {
    const user = userEvent.setup({ delay: null });
    const { onChange } = setup([{ key: "X", value: "1" }]);

    const clearButtons = screen.getAllByRole("button", { name: "Clear" });
    await user.click(clearButtons[0]!);
    expect(onChange).toHaveBeenLastCalledWith(0, "", "1");

    await user.click(clearButtons[1]!);
    expect(onChange).toHaveBeenLastCalledWith(0, "X", "");
  });

  it("omits the Clear button for an empty key or value", () => {
    setup([{ key: "", value: "" }]);
    expect(screen.queryAllByRole("button", { name: "Clear" })).toHaveLength(0);
  });

  it("removes the clicked row", async () => {
    const user = userEvent.setup({ delay: null });
    const { onRemove } = setup([
      { key: "A", value: "1" },
      { key: "B", value: "2" },
    ]);

    await user.click(screen.getByRole("button", { name: "Remove header, B" }));
    expect(onRemove).toHaveBeenCalledWith(1);
  });
});
