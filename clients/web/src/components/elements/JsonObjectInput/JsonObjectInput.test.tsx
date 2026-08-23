import { useState } from "react";
import { describe, it, expect, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { JsonObject } from "@inspector/core/json/jsonUtils.js";
import { renderWithMantine } from "../../../test/renderWithMantine";
import { JsonObjectInput } from "./JsonObjectInput";

const LABEL = "Payload JSON";

/** Controlled harness: the component never owns the value, only the draft. */
function Harness({
  initial,
  onChange,
}: {
  initial: JsonObject;
  onChange?: (v: JsonObject) => void;
}) {
  const [value, setValue] = useState<JsonObject>(initial);
  return (
    <>
      <JsonObjectInput
        aria-label={LABEL}
        value={value}
        onChange={(next) => {
          setValue(next);
          onChange?.(next);
        }}
      />
      <output data-testid="emitted">{JSON.stringify(value)}</output>
    </>
  );
}

function box() {
  return screen.getByLabelText(LABEL) as HTMLTextAreaElement;
}

describe("JsonObjectInput", () => {
  it("opens with the value serialized two-space, nesting intact", () => {
    renderWithMantine(<Harness initial={{ a: { b: [1, 2] } }} />);
    expect(box().value).toBe(
      '{\n  "a": {\n    "b": [\n      1,\n      2\n    ]\n  }\n}',
    );
  });

  it("emits the parsed object — a structured value stays structured", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderWithMantine(<Harness initial={{}} onChange={onChange} />);
    await user.clear(box());
    await user.type(box(), '{{"trace":{{"id":"x"},"n":3}');
    expect(onChange).toHaveBeenLastCalledWith({ trace: { id: "x" }, n: 3 });
  });

  it("shows the text as typed while it is invalid and does not emit", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderWithMantine(<Harness initial={{ keep: "me" }} onChange={onChange} />);
    // Append a stray character rather than clearing: clearing is itself a
    // valid edit (it means `{}`) and would emit, which is not what is under
    // test here.
    await user.click(box());
    await user.keyboard("{End}x");
    // Displayed verbatim — not re-escaped back through JSON.stringify.
    expect(box().value.endsWith("}x")).toBe(true);
    expect(
      screen.getByText("Not valid JSON — changes are not applied"),
    ).toBeInTheDocument();
    // Nothing emitted, so the caller still holds the last valid object.
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByTestId("emitted").textContent).toBe('{"keep":"me"}');
  });

  it("flags valid JSON that is not an object without emitting", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderWithMantine(<Harness initial={{ keep: "me" }} onChange={onChange} />);
    await user.clear(box());
    // The clear is a legitimate edit to `{}`; only what follows is under test.
    expect(onChange).toHaveBeenLastCalledWith({});
    onChange.mockClear();
    await user.type(box(), "[[1]");
    expect(screen.getByText(/Must be a JSON object/)).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("treats a cleared box as the empty object", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderWithMantine(<Harness initial={{ a: 1 }} onChange={onChange} />);
    await user.clear(box());
    expect(onChange).toHaveBeenLastCalledWith({});
    expect(screen.queryByText(/Not valid JSON/)).toBeNull();
  });

  it("re-syncs when the parent's value diverges from the draft", async () => {
    // An external reset (switching servers, a reloaded catalog) must reach the
    // box; an in-progress edit must not be overwritten by the value it emitted.
    function Externally() {
      const [value, setValue] = useState<JsonObject>({ a: 1 });
      return (
        <>
          <JsonObjectInput
            aria-label={LABEL}
            value={value}
            onChange={setValue}
          />
          <button onClick={() => setValue({ b: 2 })}>reset</button>
        </>
      );
    }
    const user = userEvent.setup();
    renderWithMantine(<Externally />);
    await user.click(screen.getByRole("button", { name: "reset" }));
    expect(JSON.parse(box().value)).toEqual({ b: 2 });
  });

  it("leaves an in-progress edit alone when the parent echoes it back", async () => {
    const user = userEvent.setup();
    renderWithMantine(<Harness initial={{}} />);
    await user.clear(box());
    // Typed without the closing brace auto-pair: the text is what the user has
    // so far, and the echo of the parsed value must not reformat it mid-edit.
    await user.type(box(), '{{"a":1}');
    expect(box().value).toBe('{"a":1}');
  });
});
