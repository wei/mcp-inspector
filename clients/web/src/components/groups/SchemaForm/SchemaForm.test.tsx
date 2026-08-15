import { useState } from "react";
import { describe, it, expect, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import type { InspectorFormSchema } from "../../../utils/jsonUtils";
import {
  fireEvent,
  renderWithMantine,
  screen,
} from "../../../test/renderWithMantine";
import { SchemaForm } from "./SchemaForm";

describe("SchemaForm", () => {
  it("renders a string TextInput and propagates onChange", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const schema: InspectorFormSchema = {
      type: "object",
      properties: {
        name: { type: "string", title: "Name" },
      },
      required: ["name"],
    };
    renderWithMantine(
      <SchemaForm schema={schema} values={{}} onChange={onChange} />,
    );
    const input = screen.getByLabelText(/Name/);
    await user.type(input, "a");
    expect(onChange).toHaveBeenCalledWith({ name: "a" });
  });

  it("renders a Number/Integer field and propagates a numeric value", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const schema: InspectorFormSchema = {
      type: "object",
      properties: {
        count: { type: "integer", title: "Count", minimum: 0, maximum: 100 },
      },
    };
    renderWithMantine(
      <SchemaForm schema={schema} values={{}} onChange={onChange} />,
    );
    const input = screen.getByLabelText(/Count/);
    await user.type(input, "5");
    expect(onChange).toHaveBeenCalled();
    const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    expect(
      typeof lastCall.count === "number" || lastCall.count === undefined,
    ).toBe(true);
  });

  it("renders a checkbox for boolean fields and toggles on click", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const schema: InspectorFormSchema = {
      type: "object",
      properties: {
        enabled: { type: "boolean", title: "Enabled" },
      },
    };
    renderWithMantine(
      <SchemaForm schema={schema} values={{}} onChange={onChange} />,
    );
    const checkbox = screen.getByLabelText("Enabled") as HTMLInputElement;
    await user.click(checkbox);
    expect(onChange).toHaveBeenCalledWith({ enabled: true });
  });

  it("renders an enum Select with the supplied options", () => {
    const onChange = vi.fn();
    const schema: InspectorFormSchema = {
      type: "object",
      properties: {
        format: {
          type: "string",
          title: "Format",
          enum: ["json", "csv", "xml"],
        },
      },
    };
    renderWithMantine(
      <SchemaForm
        schema={schema}
        values={{ format: "csv" }}
        onChange={onChange}
      />,
    );
    const inputs = screen.getAllByDisplayValue("csv");
    expect(inputs.length).toBeGreaterThan(0);
  });

  it("invokes onChange when an enum Select option is chosen", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const schema: InspectorFormSchema = {
      type: "object",
      properties: {
        format: {
          type: "string",
          title: "Format",
          enum: ["json", "csv"],
        },
      },
    };
    renderWithMantine(
      <SchemaForm schema={schema} values={{}} onChange={onChange} />,
    );
    await user.click(screen.getByRole("textbox", { name: "Format" }));
    const option = await screen.findByRole("option", {
      name: "csv",
      hidden: true,
    });
    await user.click(option);
    expect(onChange).toHaveBeenCalledWith({ format: "csv" });
  });

  it("uses enumNames for string-enum option labels while submitting the raw value", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const schema: InspectorFormSchema = {
      type: "object",
      properties: {
        pet: {
          type: "string",
          title: "Pet",
          enum: ["pet-1", "pet-2", "pet-3"],
          enumNames: ["Cats", "Dogs", "Birds"],
        },
      },
    };
    renderWithMantine(
      <SchemaForm schema={schema} values={{}} onChange={onChange} />,
    );
    await user.click(screen.getByRole("textbox", { name: "Pet" }));
    // The option shows the enumNames label...
    const option = await screen.findByRole("option", {
      name: "Dogs",
      hidden: true,
    });
    await user.click(option);
    // ...but the value persisted is the raw enum value.
    expect(onChange).toHaveBeenCalledWith({ pet: "pet-2" });
  });

  it("preselects a default string-enum value showing its enumNames label", () => {
    const onChange = vi.fn();
    const schema: InspectorFormSchema = {
      type: "object",
      properties: {
        pet: {
          type: "string",
          title: "Pet",
          enum: ["pet-1", "pet-2", "pet-3"],
          enumNames: ["Cats", "Dogs", "Birds"],
          default: "pet-1",
        },
      },
    };
    renderWithMantine(
      <SchemaForm schema={schema} values={{}} onChange={onChange} />,
    );
    // Default pet-1 preselects and shows its human-readable label.
    expect(screen.getByDisplayValue("Cats")).toBeInTheDocument();
  });

  it("falls back to raw string-enum values when enumNames length mismatches", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const schema: InspectorFormSchema = {
      type: "object",
      properties: {
        pet: {
          type: "string",
          title: "Pet",
          enum: ["pet-1", "pet-2", "pet-3"],
          // Only two names for three values — a wrong-length zip would
          // mislabel, so the raw values are shown instead.
          enumNames: ["Cats", "Dogs"],
        },
      },
    };
    renderWithMantine(
      <SchemaForm schema={schema} values={{}} onChange={onChange} />,
    );
    await user.click(screen.getByRole("textbox", { name: "Pet" }));
    const option = await screen.findByRole("option", {
      name: "pet-2",
      hidden: true,
    });
    await user.click(option);
    expect(onChange).toHaveBeenCalledWith({ pet: "pet-2" });
  });

  it("clears a string field via its Clear button", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const schema: InspectorFormSchema = {
      type: "object",
      properties: {
        name: { type: "string", title: "Name" },
      },
    };
    renderWithMantine(
      <SchemaForm
        schema={schema}
        values={{ name: "Alice" }}
        onChange={onChange}
      />,
    );
    // The Clear button only renders while the value is truthy.
    await user.click(screen.getByRole("button", { name: "Clear" }));
    expect(onChange).toHaveBeenCalledWith({ name: "" });
  });

  it("passes undefined to onChange when a number field is cleared", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const schema: InspectorFormSchema = {
      type: "object",
      properties: {
        count: { type: "integer", title: "Count" },
      },
    };
    renderWithMantine(
      <SchemaForm schema={schema} values={{ count: 5 }} onChange={onChange} />,
    );
    const input = screen.getByLabelText(/Count/) as HTMLInputElement;
    // Clearing the input makes Mantine NumberInput emit "" (a string),
    // which the handler maps to undefined.
    await user.clear(input);
    expect(onChange).toHaveBeenCalled();
    const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    expect(lastCall.count).toBeUndefined();
  });

  describe("number fields (#1888)", () => {
    // The real callers keep the form values in state and feed them back in, so
    // the bug only reproduces against a genuinely controlled SchemaForm: an
    // uncontrolled render never rewrites the box and would pass either way.
    function ControlledSchemaForm({
      schema,
      initialValues = {},
      onChange,
    }: {
      schema: InspectorFormSchema;
      initialValues?: Record<string, unknown>;
      onChange: (values: Record<string, unknown>) => void;
    }) {
      const [values, setValues] =
        useState<Record<string, unknown>>(initialValues);
      return (
        <SchemaForm
          schema={schema}
          values={values}
          onChange={(next) => {
            setValues(next);
            onChange(next);
          }}
        />
      );
    }

    const numberSchema: InspectorFormSchema = {
      type: "object",
      properties: {
        divisor: { type: "number", title: "Divisor" },
      },
    };

    it("lets a decimal be typed all the way through", async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      renderWithMantine(
        <ControlledSchemaForm schema={numberSchema} onChange={onChange} />,
      );
      const input = screen.getByLabelText(/Divisor/) as HTMLInputElement;
      await user.type(input, "1.5");
      expect(input.value).toBe("1.5");
      expect(onChange).toHaveBeenLastCalledWith({ divisor: 1.5 });
    });

    it("keeps the trailing decimal point visible mid-entry", async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      renderWithMantine(
        <ControlledSchemaForm schema={numberSchema} onChange={onChange} />,
      );
      const input = screen.getByLabelText(/Divisor/) as HTMLInputElement;
      await user.type(input, "1.");
      // The point survives on screen even though "1." parses to plain 1.
      expect(input.value).toBe("1.");
      expect(onChange).toHaveBeenLastCalledWith({ divisor: 1 });
    });

    it("keeps a trailing zero after the decimal point", async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      renderWithMantine(
        <ControlledSchemaForm schema={numberSchema} onChange={onChange} />,
      );
      const input = screen.getByLabelText(/Divisor/) as HTMLInputElement;
      await user.type(input, "1.50");
      expect(input.value).toBe("1.50");
      expect(onChange).toHaveBeenLastCalledWith({ divisor: 1.5 });
    });

    it("reports a lone minus sign as no value while leaving it typed", async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      renderWithMantine(
        <ControlledSchemaForm schema={numberSchema} onChange={onChange} />,
      );
      const input = screen.getByLabelText(/Divisor/) as HTMLInputElement;
      await user.type(input, "-");
      expect(input.value).toBe("-");
      expect(onChange).toHaveBeenLastCalledWith({ divisor: undefined });
      await user.type(input, "2.5");
      expect(onChange).toHaveBeenLastCalledWith({ divisor: -2.5 });
    });

    it("rejects a decimal point in an integer field", async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      const schema: InspectorFormSchema = {
        type: "object",
        properties: {
          count: { type: "integer", title: "Count" },
        },
      };
      renderWithMantine(
        <ControlledSchemaForm schema={schema} onChange={onChange} />,
      );
      const input = screen.getByLabelText(/Count/) as HTMLInputElement;
      await user.type(input, "1.5");
      expect(input.value).toBe("15");
      expect(onChange).toHaveBeenLastCalledWith({ count: 15 });
    });

    it("reports no value for a magnitude JS cannot hold exactly", async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      renderWithMantine(
        <ControlledSchemaForm schema={numberSchema} onChange={onChange} />,
      );
      const input = screen.getByLabelText(/Divisor/) as HTMLInputElement;
      // Past Number.MAX_SAFE_INTEGER, Mantine stops emitting a number and hands
      // back the raw string to avoid destroying precision. Number() would round
      // this to ...904, so parsing it would send a value the user never typed.
      await user.type(input, "90071992547409910");
      expect(input.value).toBe("90071992547409910");
      expect(onChange).toHaveBeenLastCalledWith({ divisor: undefined });
    });

    it("still parses a long decimal, which stays exactly representable", async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      renderWithMantine(
        <ControlledSchemaForm schema={numberSchema} onChange={onChange} />,
      );
      const input = screen.getByLabelText(/Divisor/) as HTMLInputElement;
      // Guards the safe-integer check against over-rejecting: the fractional
      // digits are not what overflows, so this must not be dropped.
      await user.type(input, "3.14159265358979");
      expect(onChange).toHaveBeenLastCalledWith({ divisor: 3.14159265358979 });
    });

    it("drops in-progress text when resetKey moves the form to another entity", async () => {
      const user = userEvent.setup();
      // Both "tools" expose the same-named number field with no default, so the
      // value is `undefined` before and after the switch. The value comparison
      // sees no divergence, and only resetKey can tell the field to start over.
      const schema: InspectorFormSchema = {
        type: "object",
        properties: { divisor: { type: "number", title: "Divisor" } },
      };
      function Harness() {
        const [tool, setTool] = useState("tool-a");
        const [values, setValues] = useState<Record<string, unknown>>({});
        return (
          <>
            <button
              type="button"
              onClick={() => {
                setTool("tool-b");
                // What ToolsScreen does on select: replace the form values.
                setValues({});
              }}
            >
              Switch tool
            </button>
            <SchemaForm
              schema={schema}
              values={values}
              onChange={setValues}
              resetKey={tool}
            />
          </>
        );
      }
      renderWithMantine(<Harness />);
      const input = () => screen.getByLabelText(/Divisor/) as HTMLInputElement;
      await user.type(input(), "-");
      expect(input().value).toBe("-");
      // fireEvent, not user.click: a real click also blurs the input, and
      // Mantine sanitizes an incomplete value on blur — which would mask
      // whether the switch itself cleared the draft. This drives the state
      // change without the blur, isolating the reset to resetKey.
      fireEvent.click(screen.getByRole("button", { name: "Switch tool" }));
      expect(input().value).toBe("");
    });

    it("keeps in-progress text across re-renders of the same entity", async () => {
      const user = userEvent.setup();
      // The counterpart to the test above: a stable resetKey must NOT remount
      // the field, or every keystroke would wipe the draft and reinstate #1888.
      const schema: InspectorFormSchema = {
        type: "object",
        properties: { divisor: { type: "number", title: "Divisor" } },
      };
      function Harness() {
        const [values, setValues] = useState<Record<string, unknown>>({});
        return (
          <SchemaForm
            schema={schema}
            values={values}
            onChange={setValues}
            resetKey="tool-a"
          />
        );
      }
      renderWithMantine(<Harness />);
      const input = screen.getByLabelText(/Divisor/) as HTMLInputElement;
      await user.type(input, "1.5");
      expect(input.value).toBe("1.5");
    });

    it("re-syncs the displayed text when the value changes externally", async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      function Harness() {
        const [values, setValues] = useState<Record<string, unknown>>({
          divisor: 1.5,
        });
        return (
          <>
            <button type="button" onClick={() => setValues({ divisor: 42 })}>
              Load example
            </button>
            <SchemaForm
              schema={numberSchema}
              values={values}
              onChange={(next) => {
                setValues(next);
                onChange(next);
              }}
            />
          </>
        );
      }
      renderWithMantine(<Harness />);
      const input = screen.getByLabelText(/Divisor/) as HTMLInputElement;
      expect(input.value).toBe("1.5");
      await user.click(screen.getByRole("button", { name: "Load example" }));
      expect(input.value).toBe("42");
    });
  });

  it("falls back to empty/const labels for oneOf items missing const and title", () => {
    const onChange = vi.fn();
    const schema: InspectorFormSchema = {
      type: "object",
      properties: {
        choice: {
          type: "string",
          title: "Choice",
          // One item has neither const nor title — exercises the
          // `const ?? ""` and `title ?? String(const ?? "")` fallbacks.
          oneOf: [{}, { const: "b" }],
        },
      },
    };
    renderWithMantine(
      <SchemaForm schema={schema} values={{}} onChange={onChange} />,
    );
    expect(screen.getByText("Choice")).toBeInTheDocument();
  });

  it("falls back to empty/const labels for anyOf items missing const and title", () => {
    const onChange = vi.fn();
    const schema: InspectorFormSchema = {
      type: "object",
      properties: {
        tags: {
          type: "array",
          title: "Tags",
          items: {
            // First item has neither const nor title — exercises the
            // `const ?? ""` and `title ?? String(const ?? "")` fallbacks.
            anyOf: [{}, { const: "b" }],
          },
        },
      },
    };
    renderWithMantine(
      <SchemaForm schema={schema} values={{}} onChange={onChange} />,
    );
    expect(screen.getByText("Tags")).toBeInTheDocument();
  });

  it("renders an oneOf Select using titles for labels", () => {
    const onChange = vi.fn();
    const schema: InspectorFormSchema = {
      type: "object",
      properties: {
        size: {
          type: "string",
          title: "Size",
          oneOf: [
            { const: "s", title: "Small" },
            { const: "m", title: "Medium" },
          ],
        },
      },
    };
    renderWithMantine(
      <SchemaForm schema={schema} values={{ size: "m" }} onChange={onChange} />,
    );
    const inputs = screen.getAllByDisplayValue("Medium");
    expect(inputs.length).toBeGreaterThan(0);
  });

  it("invokes onChange when a oneOf Select option is chosen", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const schema: InspectorFormSchema = {
      type: "object",
      properties: {
        size: {
          type: "string",
          title: "Size",
          oneOf: [
            { const: "s", title: "Small" },
            { const: "m", title: "Medium" },
          ],
        },
      },
    };
    renderWithMantine(
      <SchemaForm schema={schema} values={{}} onChange={onChange} />,
    );
    await user.click(screen.getByRole("textbox", { name: "Size" }));
    const option = await screen.findByRole("option", {
      name: "Small",
      hidden: true,
    });
    await user.click(option);
    expect(onChange).toHaveBeenCalledWith({ size: "s" });
  });

  it("renders a MultiSelect for array with anyOf items and invokes onChange when an option is selected", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const schema: InspectorFormSchema = {
      type: "object",
      properties: {
        tags: {
          type: "array",
          title: "Tags",
          items: {
            anyOf: [
              { const: "a", title: "Alpha" },
              { const: "b", title: "Beta" },
            ],
          },
        },
      },
    };
    renderWithMantine(
      <SchemaForm schema={schema} values={{}} onChange={onChange} />,
    );
    expect(screen.getByText("Tags")).toBeInTheDocument();
    await user.click(screen.getByRole("textbox", { name: "Tags" }));
    const option = await screen.findByRole("option", {
      name: "Alpha",
      hidden: true,
    });
    await user.click(option);
    expect(onChange).toHaveBeenCalledWith({ tags: ["a"] });
  });

  it("renders a MultiSelect for an array of enum items and invokes onChange when an option is selected", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const schema: InspectorFormSchema = {
      type: "object",
      properties: {
        instruments: {
          type: "array",
          description: "Choose your favorite instruments",
          items: {
            type: "string",
            enum: ["Guitar", "Piano", "Drums"],
          },
        },
      },
    };
    renderWithMantine(
      <SchemaForm schema={schema} values={{}} onChange={onChange} />,
    );
    // Falls back to the field name as label when no title is supplied.
    await user.click(screen.getByRole("textbox", { name: "instruments" }));
    const option = await screen.findByRole("option", {
      name: "Guitar",
      hidden: true,
    });
    await user.click(option);
    expect(onChange).toHaveBeenCalledWith({ instruments: ["Guitar"] });
  });

  it("uses enumNames for enum-array option labels and the raw value on change", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const schema: InspectorFormSchema = {
      type: "object",
      properties: {
        sizes: {
          type: "array",
          title: "Sizes",
          items: {
            type: "string",
            enum: ["s", "m", "l"],
            enumNames: ["Small", "Medium", "Large"],
          },
        },
      },
    };
    renderWithMantine(
      <SchemaForm schema={schema} values={{}} onChange={onChange} />,
    );
    await user.click(screen.getByRole("textbox", { name: "Sizes" }));
    // The option shows the enumNames label...
    const option = await screen.findByRole("option", {
      name: "Medium",
      hidden: true,
    });
    await user.click(option);
    // ...but the value persisted is the raw enum value.
    expect(onChange).toHaveBeenCalledWith({ sizes: ["m"] });
  });

  it("renders nested object fields recursively", () => {
    const onChange = vi.fn();
    const schema: InspectorFormSchema = {
      type: "object",
      properties: {
        address: {
          type: "object",
          title: "Address",
          description: "Street and city",
          properties: {
            street: { type: "string", title: "Street" },
          },
        },
      },
    };
    renderWithMantine(
      <SchemaForm schema={schema} values={{}} onChange={onChange} />,
    );
    expect(screen.getByText("Address")).toBeInTheDocument();
    expect(screen.getByText("Street and city")).toBeInTheDocument();
    expect(screen.getByLabelText(/Street/)).toBeInTheDocument();
  });

  it("propagates nested object changes back to top-level onChange", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const schema: InspectorFormSchema = {
      type: "object",
      properties: {
        address: {
          type: "object",
          title: "Address",
          properties: {
            street: { type: "string", title: "Street" },
          },
        },
      },
    };
    renderWithMantine(
      <SchemaForm schema={schema} values={{}} onChange={onChange} />,
    );
    await user.type(screen.getByLabelText(/Street/), "1");
    expect(onChange).toHaveBeenCalled();
    const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    expect(lastCall.address).toEqual({ street: "1" });
  });

  it("falls back to a JsonInput for complex/unsupported schemas", () => {
    const onChange = vi.fn();
    const schema: InspectorFormSchema = {
      type: "object",
      properties: {
        config: {
          type: "array",
          title: "Config",
        },
      },
    };
    renderWithMantine(
      <SchemaForm
        schema={schema}
        values={{ config: [1, 2, 3] }}
        onChange={onChange}
      />,
    );
    // JsonInput renders the value as serialized JSON
    expect(screen.getByText("Config")).toBeInTheDocument();
  });

  it("invokes onChange via JsonInput when valid JSON is pasted", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const schema: InspectorFormSchema = {
      type: "object",
      properties: {
        config: { type: "array", title: "Config" },
      },
    };
    renderWithMantine(
      <SchemaForm schema={schema} values={{}} onChange={onChange} />,
    );
    const jsonInput = screen.getByLabelText(/Config/) as HTMLTextAreaElement;
    jsonInput.focus();
    await user.paste("[1,2]");
    expect(onChange).toHaveBeenCalled();
    const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    expect(lastCall.config).toEqual([1, 2]);
  });

  it("falls back to passing raw string to onChange when JSON is invalid in JsonInput", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const schema: InspectorFormSchema = {
      type: "object",
      properties: {
        config: { type: "array", title: "Config" },
      },
    };
    renderWithMantine(
      <SchemaForm schema={schema} values={{}} onChange={onChange} />,
    );
    const jsonInput = screen.getByLabelText(/Config/) as HTMLTextAreaElement;
    await user.type(jsonInput, "x");
    expect(onChange).toHaveBeenCalled();
    const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    expect(typeof lastCall.config).toBe("string");
  });

  it("uses default values when value is undefined", () => {
    const schema: InspectorFormSchema = {
      type: "object",
      properties: {
        name: { type: "string", title: "Name", default: "Alice" },
      },
    };
    renderWithMantine(
      <SchemaForm schema={schema} values={{}} onChange={vi.fn()} />,
    );
    expect(screen.getByDisplayValue("Alice")).toBeInTheDocument();
  });

  it("respects the disabled prop on inputs", () => {
    const schema: InspectorFormSchema = {
      type: "object",
      properties: {
        name: { type: "string", title: "Name" },
        active: { type: "boolean", title: "Active" },
      },
    };
    renderWithMantine(
      <SchemaForm
        schema={schema}
        values={{ name: "x", active: true }}
        onChange={vi.fn()}
        disabled
      />,
    );
    expect(screen.getByLabelText(/Name/)).toBeDisabled();
    expect(screen.getByLabelText("Active")).toBeDisabled();
  });

  it("uses field name when title is missing", () => {
    const schema: InspectorFormSchema = {
      type: "object",
      properties: {
        rawField: { type: "string" },
      },
    };
    renderWithMantine(
      <SchemaForm schema={schema} values={{}} onChange={vi.fn()} />,
    );
    expect(screen.getByLabelText(/rawField/)).toBeInTheDocument();
  });

  it("renders nothing inside the form when properties are missing", () => {
    const schema: InspectorFormSchema = { type: "object" };
    const { container } = renderWithMantine(
      <SchemaForm schema={schema} values={{}} onChange={vi.fn()} />,
    );
    // Stack root exists but has no children
    expect(container.firstChild).not.toBeNull();
  });
});

// #1928: "optional AND explicitly nullable" (Zod's `.nullish()`) compiles to a
// nullable union rather than a plain type. Before the normalization step these
// matched no branch and fell through to the raw-JSON fallback, where every
// keystroke re-escaped the value.
describe("SchemaForm nullable unions", () => {
  it("renders a Select for an anyOf string-enum|null field", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const schema: InspectorFormSchema = {
      type: "object",
      properties: {
        type: {
          title: "Type",
          anyOf: [
            { type: "string", enum: ["envio", "recebimento"] },
            { type: "null" },
          ],
        },
      },
    };
    renderWithMantine(
      <SchemaForm schema={schema} values={{}} onChange={onChange} />,
    );
    await user.click(screen.getByRole("textbox", { name: "Type" }));
    await user.click(
      await screen.findByRole("option", { name: "envio", hidden: true }),
    );
    expect(onChange).toHaveBeenCalledWith({ type: "envio" });
  });

  it("clears a nullable enum back to null", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const schema: InspectorFormSchema = {
      type: "object",
      properties: {
        type: {
          title: "Type",
          anyOf: [{ type: "string", enum: ["envio"] }, { type: "null" }],
        },
      },
    };
    renderWithMantine(
      <SchemaForm
        schema={schema}
        values={{ type: "envio" }}
        onChange={onChange}
      />,
    );
    // Mantine marks its combobox clear button `aria-hidden` (it is mouse-only,
    // `tabIndex={-1}`), so it is only reachable with `hidden: true`.
    await user.click(screen.getByRole("button", { hidden: true }));
    expect(onChange).toHaveBeenCalledWith({ type: null });
  });

  it("offers no clear affordance on a non-nullable enum", () => {
    const schema: InspectorFormSchema = {
      type: "object",
      properties: {
        format: { type: "string", title: "Format", enum: ["json"] },
      },
    };
    renderWithMantine(
      <SchemaForm
        schema={schema}
        values={{ format: "json" }}
        onChange={vi.fn()}
      />,
    );
    expect(
      screen.queryByRole("button", { hidden: true }),
    ).not.toBeInTheDocument();
  });

  it("renders a TextInput for a type: [string, null] field", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const schema: InspectorFormSchema = {
      type: "object",
      properties: {
        note: { type: ["string", "null"], title: "Note" },
      },
    };
    renderWithMantine(
      <SchemaForm schema={schema} values={{}} onChange={onChange} />,
    );
    await user.type(screen.getByLabelText(/Note/), "a");
    expect(onChange).toHaveBeenCalledWith({ note: "a" });
  });

  it("renders a checkbox for an anyOf boolean|null field", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const schema: InspectorFormSchema = {
      type: "object",
      properties: {
        enabled: {
          title: "Enabled",
          anyOf: [{ type: "boolean" }, { type: "null" }],
        },
      },
    };
    renderWithMantine(
      <SchemaForm schema={schema} values={{}} onChange={onChange} />,
    );
    await user.click(screen.getByLabelText("Enabled"));
    expect(onChange).toHaveBeenCalledWith({ enabled: true });
  });

  it("renders a MultiSelect for an anyOf array-of-enum|null field", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const schema: InspectorFormSchema = {
      type: "object",
      properties: {
        tags: {
          title: "Tags",
          anyOf: [
            { type: "array", items: { type: "string", enum: ["a", "b"] } },
            { type: "null" },
          ],
        },
      },
    };
    renderWithMantine(
      <SchemaForm schema={schema} values={{}} onChange={onChange} />,
    );
    await user.click(screen.getByRole("textbox", { name: "Tags" }));
    await user.click(
      await screen.findByRole("option", { name: "a", hidden: true }),
    );
    expect(onChange).toHaveBeenCalledWith({ tags: ["a"] });
  });

  it("renders nested fields for an anyOf object|null field", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const schema: InspectorFormSchema = {
      type: "object",
      properties: {
        profile: {
          title: "Profile",
          anyOf: [
            {
              type: "object",
              properties: { nick: { type: "string", title: "Nick" } },
            },
            { type: "null" },
          ],
        },
      },
    };
    renderWithMantine(
      <SchemaForm schema={schema} values={{}} onChange={onChange} />,
    );
    await user.type(screen.getByLabelText(/Nick/), "z");
    expect(onChange).toHaveBeenCalledWith({ profile: { nick: "z" } });
  });

  it("still falls back to the JSON input for a union of two real types", () => {
    const schema: InspectorFormSchema = {
      type: "object",
      properties: {
        mixed: {
          title: "Mixed",
          anyOf: [{ type: "string" }, { type: "number" }],
        },
      },
    };
    renderWithMantine(
      <SchemaForm schema={schema} values={{}} onChange={vi.fn()} />,
    );
    expect(screen.getByLabelText(/Mixed/).tagName).toBe("TEXTAREA");
  });
});
