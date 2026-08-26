import { useState } from "react";
import { describe, it, expect, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import type { InspectorFormSchema } from "../../../utils/jsonUtils";
import { toFormSchema } from "../../../utils/jsonUtils";
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
    const input = screen.getByRole("textbox", { name: /Name/ });
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
    expect(screen.getByRole("textbox", { name: /Street/ })).toBeInTheDocument();
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
    await user.type(screen.getByRole("textbox", { name: /Street/ }), "1");
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

  // The JSON field used to store unparseable text back as the *value*, which
  // the next render re-stringified — so each keystroke added a layer of
  // escaping (`[` → `"["` → `"\"[\""`). That compounding escape is #1928's
  // original symptom, and it lived here rather than in the dispatch. It matters
  // more since #2007, whose fix deliberately routes object unions to this
  // editor: a fallback nobody can type into is not a fallback.
  it("shows an error while the JSON draft does not parse", async () => {
    const user = userEvent.setup();
    const schema: InspectorFormSchema = {
      type: "object",
      properties: {
        config: { type: "array", title: "Config" },
      },
    };
    function Harness() {
      const [values, setValues] = useState<Record<string, unknown>>({});
      return (
        <SchemaForm schema={schema} values={values} onChange={setValues} />
      );
    }
    renderWithMantine(<Harness />);

    const jsonInput = screen.getByLabelText(/Config/) as HTMLTextAreaElement;
    await user.type(jsonInput, "[[1,");
    // Invalid text yields no value, so without this the field would submit as
    // absent while the user is still looking at what they typed.
    expect(screen.getByText(/Not valid JSON/)).toBeInTheDocument();

    await user.type(jsonInput, "2]");
    expect(screen.queryByText(/Not valid JSON/)).not.toBeInTheDocument();
  });

  it("shows no error for an empty optional field", () => {
    const schema: InspectorFormSchema = {
      type: "object",
      properties: {
        config: { type: "array", title: "Config" },
      },
    };
    renderWithMantine(
      <SchemaForm schema={schema} values={{}} onChange={vi.fn()} />,
    );
    expect(screen.queryByText(/Not valid JSON/)).not.toBeInTheDocument();
  });

  it("reports no value, not raw text, while the JSON is mid-edit", async () => {
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
    expect(onChange).toHaveBeenLastCalledWith({ config: undefined });
  });

  it("lets an array literal be typed one character at a time", async () => {
    const user = userEvent.setup();
    const schema: InspectorFormSchema = {
      type: "object",
      properties: {
        config: { type: "array", title: "Config" },
      },
    };
    // Drive the real controlled loop: each onChange feeds straight back in as
    // `values`, which is what turned the old handler's raw-text write into a
    // compounding re-escape.
    function Harness() {
      const [values, setValues] = useState<Record<string, unknown>>({});
      return (
        <SchemaForm schema={schema} values={values} onChange={setValues} />
      );
    }
    renderWithMantine(<Harness />);

    const jsonInput = screen.getByLabelText(/Config/) as HTMLTextAreaElement;
    // `[` is a userEvent keyboard descriptor, so it is escaped as `[[`.
    await user.type(jsonInput, '[[1,"a"]');

    // The box shows exactly what was typed — no injected quotes or backslashes.
    expect(jsonInput.value).toBe('[1,"a"]');
  });

  it("keeps an in-progress draft visible instead of rewriting it", async () => {
    const user = userEvent.setup();
    const schema: InspectorFormSchema = {
      type: "object",
      properties: {
        config: { type: "array", title: "Config" },
      },
    };
    function Harness() {
      const [values, setValues] = useState<Record<string, unknown>>({});
      return (
        <SchemaForm schema={schema} values={values} onChange={setValues} />
      );
    }
    renderWithMantine(<Harness />);

    const jsonInput = screen.getByLabelText(/Config/) as HTMLTextAreaElement;
    await user.type(jsonInput, "[[1,");
    // Unparseable so far, and it must survive the re-render untouched.
    expect(jsonInput.value).toBe("[1,");

    await user.type(jsonInput, "2]");
    expect(jsonInput.value).toBe("[1,2]");
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
    expect(screen.getByRole("textbox", { name: /Name/ })).toBeDisabled();
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
    expect(
      screen.getByRole("textbox", { name: /rawField/ }),
    ).toBeInTheDocument();
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

  // The other supported nullable encoding: keywords stay at the top level, so
  // the null sentinel sits inside the enum list rather than on a branch.
  it("renders a Select for a type: [string, null] enum, without a null option", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    // Built through `toFormSchema`, the same narrowing boundary every
    // production call site uses, rather than cast into `InspectorFormSchema`.
    // A `null` member is valid JSON Schema but outside that type's `string[]`
    // `enum`, and this fixture *is* wire data — so the honest way to introduce
    // it is the wire→form narrow, not a double cast that erases the mismatch.
    const schema = toFormSchema({
      type: "object",
      properties: {
        direction: {
          title: "Direction",
          type: ["string", "null"],
          enum: ["envio", "recebimento", null],
        },
      },
    });
    renderWithMantine(
      <SchemaForm schema={schema!} values={{}} onChange={onChange} />,
    );
    await user.click(screen.getByRole("textbox", { name: "Direction" }));
    const options = await screen.findAllByRole("option", { hidden: true });
    expect(options.map((option) => option.textContent)).toEqual([
      "envio",
      "recebimento",
    ]);
    await user.click(options[0]);
    expect(onChange).toHaveBeenCalledWith({ direction: "envio" });
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
    await user.type(screen.getByRole("textbox", { name: /Note/ }), "a");
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
    await user.type(screen.getByRole("textbox", { name: /Nick/ }), "z");
    expect(onChange).toHaveBeenCalledWith({ profile: { nick: "z" } });
  });

  // #2007: `z.array(z.union([z.object(…), z.object(…)]))` gives an `items.anyOf`
  // whose branches carry no top-level `const`, so every MultiSelect option was
  // the empty string — and Mantine *throws* on duplicate option values, greying
  // out the whole tool panel. The nullable form below is reachable only because
  // this PR now collapses it into `type: "array"`, so it has to be safe too.
  it("falls back to the JSON input for an array of object-union items", () => {
    const objectBranch = (name: string): InspectorFormSchema => ({
      type: "object",
      properties: { type: { type: "string", const: name } },
      required: ["type"],
    });
    const schema: InspectorFormSchema = {
      type: "object",
      properties: {
        items: {
          title: "Items",
          type: "array",
          items: { anyOf: [objectBranch("A"), objectBranch("B")] },
        },
      },
    };
    renderWithMantine(
      <SchemaForm schema={schema} values={{}} onChange={vi.fn()} />,
    );
    expect(screen.getByLabelText(/Items/).tagName).toBe("TEXTAREA");
  });

  it("falls back to the JSON input for a nullable array of object-union items", () => {
    const objectBranch = (name: string): InspectorFormSchema => ({
      type: "object",
      properties: { type: { type: "string", const: name } },
      required: ["type"],
    });
    const schema: InspectorFormSchema = {
      type: "object",
      properties: {
        items: {
          title: "Items",
          anyOf: [
            { type: "array", items: { anyOf: [objectBranch("A")] } },
            { type: "null" },
          ],
        },
      },
    };
    renderWithMantine(
      <SchemaForm schema={schema} values={{}} onChange={vi.fn()} />,
    );
    expect(screen.getByLabelText(/Items/).tagName).toBe("TEXTAREA");
  });

  // Mantine's select is string-valued, so a numeric const would submit "1" for
  // 1 — the same wrong-type-on-the-wire problem that keeps a numeric enum off
  // the select path.
  it("falls back to the JSON input for non-string anyOf consts", () => {
    const schema: InspectorFormSchema = {
      type: "object",
      properties: {
        items: {
          title: "Items",
          type: "array",
          items: { anyOf: [{ const: 1 }, { const: 2 }] },
        },
      },
    };
    renderWithMantine(
      <SchemaForm schema={schema} values={{}} onChange={vi.fn()} />,
    );
    expect(screen.getByLabelText(/Items/).tagName).toBe("TEXTAREA");
  });

  it("falls back to the JSON input when two anyOf branches share a const", () => {
    const schema: InspectorFormSchema = {
      type: "object",
      properties: {
        items: {
          title: "Items",
          type: "array",
          items: { anyOf: [{ const: "dup" }, { const: "dup" }] },
        },
      },
    };
    renderWithMantine(
      <SchemaForm schema={schema} values={{}} onChange={vi.fn()} />,
    );
    expect(screen.getByLabelText(/Items/).tagName).toBe("TEXTAREA");
  });

  it("falls back to a text input for a string oneOf with no consts", () => {
    const schema: InspectorFormSchema = {
      type: "object",
      properties: {
        mode: {
          title: "Mode",
          type: "string",
          oneOf: [{ type: "string" }, { type: "string" }],
        },
      },
    };
    renderWithMantine(
      <SchemaForm schema={schema} values={{}} onChange={vi.fn()} />,
    );
    expect(screen.getByRole("textbox", { name: /Mode/ }).tagName).toBe("INPUT");
  });

  it("still renders a MultiSelect when every anyOf branch has a distinct const", () => {
    const schema: InspectorFormSchema = {
      type: "object",
      properties: {
        items: {
          title: "Items",
          type: "array",
          items: { anyOf: [{ const: "a", title: "Alpha" }, { const: "b" }] },
        },
      },
    };
    renderWithMantine(
      <SchemaForm schema={schema} values={{}} onChange={vi.fn()} />,
    );
    expect(screen.getByRole("textbox", { name: "Items" })).toBeInTheDocument();
  });

  // Reachable only since the collapse landed: the nullable wrapper had no
  // top-level `type` before, so it fell to the JSON editor rather than into a
  // string-valued MultiSelect that would submit ["1"] for [1].
  it("falls back to the JSON input for a nullable array of numeric item enums", () => {
    // Wire data again — a numeric `enum` is valid JSON Schema but outside
    // `InspectorFormSchema`'s `string[]`, so it comes in through the narrow.
    const schema = toFormSchema({
      type: "object",
      properties: {
        levels: {
          title: "Levels",
          anyOf: [{ type: "array", items: { enum: [1, 2] } }, { type: "null" }],
        },
      },
    });
    renderWithMantine(
      <SchemaForm schema={schema!} values={{}} onChange={vi.fn()} />,
    );
    expect(screen.getByLabelText(/Levels/).tagName).toBe("TEXTAREA");
  });

  // The sibling enum rules null out even though the type list names it, so the
  // field must not get a clear button that emits a value the schema rejects.
  it("offers no clear button when a sibling enum excludes null", () => {
    const schema = toFormSchema({
      type: "object",
      properties: {
        direction: {
          title: "Direction",
          type: ["string", "null"],
          enum: ["envio", "recebimento"],
        },
      },
    });
    renderWithMantine(
      <SchemaForm
        schema={schema!}
        values={{ direction: "envio" }}
        onChange={vi.fn()}
      />,
    );
    expect(
      screen.queryByRole("button", { hidden: true }),
    ).not.toBeInTheDocument();
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

// #2020: a field holding text it cannot turn into a value reports `undefined`,
// which is exactly what an *empty* field reports. That makes the two states
// indistinguishable to the caller, so invalid text in an optional field was
// submittable and simply arrived at the server absent. The form reports draft
// validity directly so a submit gate can see what `values` cannot.
describe("SchemaForm draft validity (#2020)", () => {
  const jsonSchema: InspectorFormSchema = {
    type: "object",
    properties: {
      config: { type: "array", title: "Config" },
    },
  };

  function ValidityHarness({
    schema,
    onValidityChange,
    resetKey,
  }: {
    schema: InspectorFormSchema;
    onValidityChange: (hasInvalidDraft: boolean) => void;
    resetKey?: string;
  }) {
    const [values, setValues] = useState<Record<string, unknown>>({});
    return (
      <SchemaForm
        schema={schema}
        values={values}
        onChange={setValues}
        resetKey={resetKey}
        onValidityChange={onValidityChange}
      />
    );
  }

  it("reports an empty optional field as valid", () => {
    const onValidityChange = vi.fn();
    renderWithMantine(
      <ValidityHarness
        schema={jsonSchema}
        onValidityChange={onValidityChange}
      />,
    );
    expect(onValidityChange).toHaveBeenLastCalledWith(false);
  });

  it("reports an unparseable JSON draft, then clears it once the text parses", async () => {
    const user = userEvent.setup();
    const onValidityChange = vi.fn();
    renderWithMantine(
      <ValidityHarness
        schema={jsonSchema}
        onValidityChange={onValidityChange}
      />,
    );

    const jsonInput = screen.getByLabelText(/Config/) as HTMLTextAreaElement;
    await user.type(jsonInput, "[[1,");
    expect(onValidityChange).toHaveBeenLastCalledWith(true);

    await user.type(jsonInput, "2]");
    expect(onValidityChange).toHaveBeenLastCalledWith(false);
  });

  it("reports a number this client cannot send exactly, and says so on the field", async () => {
    const user = userEvent.setup();
    const onValidityChange = vi.fn();
    const schema: InspectorFormSchema = {
      type: "object",
      properties: {
        divisor: { type: "number", title: "Divisor" },
      },
    };
    renderWithMantine(
      <ValidityHarness schema={schema} onValidityChange={onValidityChange} />,
    );

    // Past MAX_SAFE_INTEGER the field reports no value rather than a rounded
    // one, so — like the JSON editor — the text on screen would otherwise be
    // submitted as an absent argument.
    const input = screen.getByLabelText(/Divisor/) as HTMLInputElement;
    await user.type(input, "90071992547409910");
    expect(onValidityChange).toHaveBeenLastCalledWith(true);
    expect(screen.getByText(/this field will be omitted/)).toBeInTheDocument();

    await user.clear(input);
    expect(onValidityChange).toHaveBeenLastCalledWith(false);
    expect(
      screen.queryByText(/this field will be omitted/),
    ).not.toBeInTheDocument();
  });

  it("stays invalid while any one field is invalid", async () => {
    const user = userEvent.setup();
    const onValidityChange = vi.fn();
    const schema: InspectorFormSchema = {
      type: "object",
      properties: {
        first: { type: "array", title: "First" },
        second: { type: "array", title: "Second" },
      },
    };
    renderWithMantine(
      <ValidityHarness schema={schema} onValidityChange={onValidityChange} />,
    );

    await user.type(screen.getByLabelText(/First/), "x");
    await user.type(screen.getByLabelText(/Second/), "y");
    expect(onValidityChange).toHaveBeenLastCalledWith(true);

    // One of the two recovering is not enough.
    await user.clear(screen.getByLabelText(/First/));
    expect(onValidityChange).toHaveBeenLastCalledWith(true);

    await user.clear(screen.getByLabelText(/Second/));
    expect(onValidityChange).toHaveBeenLastCalledWith(false);
  });

  it("surfaces a nested object's invalid draft through the outer form", async () => {
    const user = userEvent.setup();
    const onValidityChange = vi.fn();
    const schema: InspectorFormSchema = {
      type: "object",
      properties: {
        outer: {
          type: "object",
          title: "Outer",
          properties: {
            config: { type: "array", title: "Config" },
          },
        },
      },
    };
    renderWithMantine(
      <ValidityHarness schema={schema} onValidityChange={onValidityChange} />,
    );

    await user.type(screen.getByLabelText(/Config/), "x");
    expect(onValidityChange).toHaveBeenLastCalledWith(true);
  });

  it("clears a stale invalid draft when the form moves to another entity", async () => {
    const user = userEvent.setup();
    const onValidityChange = vi.fn();
    const { rerender } = renderWithMantine(
      <ValidityHarness
        schema={jsonSchema}
        onValidityChange={onValidityChange}
        resetKey="first_tool"
      />,
    );

    await user.type(screen.getByLabelText(/Config/), "x");
    expect(onValidityChange).toHaveBeenLastCalledWith(true);

    // Switching entities remounts the field, discarding its draft — so text
    // typed for the previous one must not keep the new one blocked.
    rerender(
      <ValidityHarness
        schema={jsonSchema}
        onValidityChange={onValidityChange}
        resetKey="second_tool"
      />,
    );
    expect(onValidityChange).toHaveBeenLastCalledWith(false);
  });

  it("reports valid when the form unmounts holding an invalid draft", async () => {
    const user = userEvent.setup();
    const onValidityChange = vi.fn();
    const { unmount } = renderWithMantine(
      <ValidityHarness
        schema={jsonSchema}
        onValidityChange={onValidityChange}
      />,
    );

    await user.type(screen.getByLabelText(/Config/), "x");
    expect(onValidityChange).toHaveBeenLastCalledWith(true);

    unmount();
    expect(onValidityChange).toHaveBeenLastCalledWith(false);
  });

  it("renders without a validity callback", async () => {
    const user = userEvent.setup();
    renderWithMantine(
      <SchemaForm schema={jsonSchema} values={{}} onChange={vi.fn()} />,
    );
    await user.type(screen.getByLabelText(/Config/), "x");
    expect(screen.getByText(/Not valid JSON/)).toBeInTheDocument();
  });
});

// Three separate reports of one defect: the JSON editor re-escaping the text
// being typed. #1853 saw it while typing an array, #1856 on the Backspace that
// first makes a valid array invalid, and #1885 on a nullable parameter whose
// default `null` had to be edited in place. All three come from the same
// mechanism — unparseable draft text stored back as the field's *value*, which
// the next controlled render re-`JSON.stringify`d, adding a layer of quotes and
// backslashes per keystroke.
//
// The mechanism was removed by the draft/value split in `SchemaJsonField`
// (#1928/#2007) and the nullable-union collapse that keeps a `T | null` field
// off this editor entirely (#1928). These lock each report's own reproduction
// to it, since the fixes were made for differently-framed issues and nothing
// otherwise pins the reported flows.
describe("JSON editor escaping (#1853, #1856, #1885)", () => {
  function EscapingHarness({
    schema,
    initial = {},
  }: {
    schema: InspectorFormSchema;
    initial?: Record<string, unknown>;
  }) {
    const [values, setValues] = useState<Record<string, unknown>>(initial);
    return <SchemaForm schema={schema} values={values} onChange={setValues} />;
  }

  // #1853: `batch_process_items`, typed character by character.
  it("types a string array through without escaping it (#1853)", async () => {
    const user = userEvent.setup();
    const schema: InspectorFormSchema = {
      type: "object",
      properties: {
        itemIds: {
          type: "array",
          title: "Item Ids",
          items: { type: "string" },
        },
      },
      required: ["itemIds"],
    };
    renderWithMantine(<EscapingHarness schema={schema} />);

    const jsonInput = screen.getByLabelText(/Item Ids/) as HTMLTextAreaElement;
    // `[` opens a userEvent keyboard descriptor, so it is escaped as `[[`.
    await user.type(jsonInput, '[["item-1","item-2"]');

    expect(jsonInput.value).toBe('["item-1","item-2"]');
    expect(jsonInput.value).not.toContain("\\");
  });

  // #1853 again, from the comment thread: the caret sitting *outside* the
  // quotes of a `""` value. One keystroke there made the draft invalid, which
  // is all it took — `""` + `a` rendered as `"\"\"a"`.
  it("keeps a keystroke typed outside a string's quotes literal (#1853)", async () => {
    const user = userEvent.setup();
    const schema: InspectorFormSchema = {
      type: "object",
      // No `type`, so the field lands on the JSON editor holding a string.
      properties: { note: { title: "Note" } },
    };
    renderWithMantine(
      <EscapingHarness schema={schema} initial={{ note: "" }} />,
    );

    const jsonInput = screen.getByRole("textbox", {
      name: /Note/,
    }) as HTMLTextAreaElement;
    await user.click(jsonInput);
    await user.keyboard("{End}a");

    expect(jsonInput.value).toBe('""a');
  });

  // #1856: `sum_numbers`, Backspace with the caret after the closing `]`.
  it("keeps the draft raw when Backspace invalidates an array (#1856)", async () => {
    const user = userEvent.setup();
    const schema: InspectorFormSchema = {
      type: "object",
      properties: {
        numbers: {
          type: "array",
          title: "Numbers",
          items: { type: "number" },
        },
      },
      required: ["numbers"],
    };
    renderWithMantine(
      <EscapingHarness schema={schema} initial={{ numbers: [1, 2] }} />,
    );

    const jsonInput = screen.getByLabelText(/Numbers/) as HTMLTextAreaElement;
    await user.click(jsonInput);
    await user.keyboard("{End}{Backspace}");

    // Exactly the seeded text minus its last character — the draft the reporter
    // expected, where the field instead showed a quoted, escaped string.
    expect(jsonInput.value).toBe("[\n  1,\n  2\n");

    // Each further edit compounded the escaping, so keep going.
    await user.keyboard("{Backspace}{Backspace}");
    expect(jsonInput.value).not.toContain("\\");
    expect(jsonInput.value.startsWith('"')).toBe(false);

    // And the draft is still live: closing it back up produces a real array.
    await user.keyboard("2]");
    expect(jsonInput.value).toBe("[\n  1,\n  2]");
  });

  // #1885: FastMCP's `b: int | None = None`, which compiles to an `anyOf` with
  // a null branch and `default: null`. The reporter was editing the literal
  // `null` token in a raw JSON box; collapsing the union routes the field to a
  // real number input, so there is no JSON token to edit in the first place.
  it("edits a nullable integer as a number input, not a null token (#1885)", async () => {
    const user = userEvent.setup();
    const schema: InspectorFormSchema = {
      type: "object",
      properties: {
        a: { type: "integer", title: "A" },
        b: {
          title: "B",
          anyOf: [{ type: "integer" }, { type: "null" }],
          default: null,
        },
      },
      required: ["a"],
    };
    // No seeded value: the `null` has to come from the schema's `default`,
    // which is where the reporter's did.
    renderWithMantine(<EscapingHarness schema={schema} />);

    const b = screen.getByLabelText(/^B$/) as HTMLInputElement;
    expect(b.tagName).toBe("INPUT");
    // `null` is rendered as "no value", not as four editable characters.
    expect(b.value).toBe("");

    await user.click(b);
    await user.keyboard("42{Backspace}");
    expect(b.value).toBe("4");
    expect(b.value).not.toContain("\\");
  });

  // The same nullable-with-`default: null` shape on a field the collapse still
  // sends to the JSON editor (an array union). Backspacing the `null` token
  // there is the exact keystroke sequence from #1885's recording.
  it("backspaces a null default in the JSON editor without escaping (#1885)", async () => {
    const user = userEvent.setup();
    const schema: InspectorFormSchema = {
      type: "object",
      properties: {
        cfg: {
          title: "Cfg",
          anyOf: [{ type: "array" }, { type: "null" }],
          default: null,
        },
      },
    };
    // Again unseeded, so the editor's opening `null` is the schema default
    // being resolved — the state the reporter's recording starts from.
    renderWithMantine(<EscapingHarness schema={schema} />);

    const jsonInput = screen.getByLabelText(/Cfg/) as HTMLTextAreaElement;
    expect(jsonInput.value).toBe("null");

    await user.click(jsonInput);
    await user.keyboard("{End}{Backspace}");
    expect(jsonInput.value).toBe("nul");

    await user.keyboard("{Backspace}{Backspace}{Backspace}");
    expect(jsonInput.value).toBe("");
    expect(jsonInput.value).not.toContain("\\");
  });
});

// A schema `default` is what a field *opens* with, not a value re-imposed on
// every unsendable draft. Unsendable text reports `undefined` by design, and
// `resolveValue` used to turn that straight back into the default — a change
// from the previous value, so the draft/value re-sync rewrote the box and
// reverted the keystroke.
//
// The two halves differed in how reachable they were, which the tests below
// mirror deliberately:
//
// - **The number field reverted in the app.** Numbers compare by value, so
//   clearing a defaulted box (value `3` → resolved default `30`) always fired
//   the re-sync and refilled itself.
// - **The JSON field was latent.** `collectSchemaDefaults` assigns
//   `fieldSchema.default` itself, so a field seeded from the schema holds the
//   *same reference* the substitution returns and nothing fires. It needs a
//   structurally-equal but distinct value object to become observable — which
//   is what parsed wire/deep-link values and rebuilt nested-object defaults
//   produce, and what these tests construct.
describe("SchemaForm defaulted fields (#2026)", () => {
  function DefaultHarness({
    schema,
    initial = {},
  }: {
    schema: InspectorFormSchema;
    initial?: Record<string, unknown>;
  }) {
    const [values, setValues] = useState<Record<string, unknown>>(initial);
    return <SchemaForm schema={schema} values={values} onChange={setValues} />;
  }

  const arrayWithDefault: InspectorFormSchema = {
    type: "object",
    properties: { tags: { type: "array", title: "Tags", default: ["a"] } },
  };

  it("opens the JSON editor on the schema default", () => {
    renderWithMantine(<DefaultHarness schema={arrayWithDefault} />);
    expect((screen.getByLabelText(/Tags/) as HTMLTextAreaElement).value).toBe(
      '[\n  "a"\n]',
    );
  });

  it("keeps a keystroke typed into a defaulted JSON field", async () => {
    const user = userEvent.setup();
    // Seeded with a value that is equal to the schema default but is not the
    // same object — how values parsed off the wire or out of a deep link
    // arrive. Sharing the reference (what `collectSchemaDefaults` produces) is
    // what keeps this latent rather than what makes it safe.
    renderWithMantine(
      <DefaultHarness schema={arrayWithDefault} initial={{ tags: ["a"] }} />,
    );

    const jsonInput = screen.getByLabelText(/Tags/) as HTMLTextAreaElement;
    await user.click(jsonInput);
    await user.keyboard("{End}x");

    // The invalid draft is the user's, not the default reasserting itself.
    expect(jsonInput.value).toBe('[\n  "a"\n]x');
  });

  it("lets a defaulted JSON field be edited to a new value", async () => {
    const user = userEvent.setup();
    // Distinct-object seed again, for the reason above.
    renderWithMantine(
      <DefaultHarness schema={arrayWithDefault} initial={{ tags: ["a"] }} />,
    );

    const jsonInput = screen.getByLabelText(/Tags/) as HTMLTextAreaElement;
    await user.clear(jsonInput);
    await user.type(jsonInput, '[["b"]');

    expect(jsonInput.value).toBe('["b"]');
    expect(screen.queryByText(/Not valid JSON/)).not.toBeInTheDocument();
  });

  it("lets a defaulted number field be emptied", async () => {
    const user = userEvent.setup();
    const schema: InspectorFormSchema = {
      type: "object",
      properties: { n: { type: "integer", title: "N", default: 30 } },
    };
    renderWithMantine(<DefaultHarness schema={schema} initial={{ n: 30 }} />);

    const n = screen.getByLabelText(/N/) as HTMLInputElement;
    expect(n.value).toBe("30");

    await user.click(n);
    await user.keyboard("{End}{Backspace}{Backspace}");

    // The box stays empty instead of refilling itself with the default.
    expect(n.value).toBe("");
  });

  // An explicit `null` is a value, not an absent one, so a non-null default
  // must not be substituted for it. Note the field itself never emits `null` —
  // clearing it reports `undefined` (pinned by "passes undefined to onChange
  // when a number field is cleared") — so this arrives from parent state: a
  // value received from the server, restored from a deep link, or written by a
  // caller for a nullable schema.
  it("shows an explicit null as empty, not as the default", () => {
    const schema: InspectorFormSchema = {
      type: "object",
      properties: {
        n: {
          title: "N",
          anyOf: [{ type: "integer" }, { type: "null" }],
          default: 30,
        },
      },
    };
    renderWithMantine(<DefaultHarness schema={schema} initial={{ n: null }} />);

    expect((screen.getByLabelText(/^N$/) as HTMLInputElement).value).toBe("");
  });

  it("still re-syncs a defaulted field when the value changes externally", async () => {
    function ExternalHarness() {
      const [values, setValues] = useState<Record<string, unknown>>({
        tags: ["a"],
      });
      return (
        <>
          <SchemaForm
            schema={arrayWithDefault}
            values={values}
            onChange={setValues}
          />
          <button type="button" onClick={() => setValues({ tags: ["z"] })}>
            load example
          </button>
        </>
      );
    }
    const user = userEvent.setup();
    renderWithMantine(<ExternalHarness />);

    const jsonInput = screen.getByLabelText(/Tags/) as HTMLTextAreaElement;
    await user.click(screen.getByRole("button", { name: "load example" }));
    expect(jsonInput.value).toBe('[\n  "z"\n]');
  });
});

// A plain `<input>` swallows Enter, so a string argument could not be given a
// value containing newlines (#2042). Each string field carries an enlarge button
// that swaps it for a text area, one-way.
describe("SchemaForm multiline strings (#2042)", () => {
  const stringSchema: InspectorFormSchema = {
    type: "object",
    properties: {
      note: { type: "string", title: "Note", maxLength: 40 },
    },
  };

  function StringHarness({ resetKey }: { resetKey?: string }) {
    const [values, setValues] = useState<Record<string, unknown>>({});
    return (
      <SchemaForm
        schema={stringSchema}
        values={values}
        onChange={setValues}
        resetKey={resetKey}
      />
    );
  }

  it("renders a single-line input with an enlarge button by default", () => {
    renderWithMantine(<StringHarness />);
    expect(screen.getByRole("textbox", { name: /Note/ }).tagName).toBe("INPUT");
    expect(
      screen.getByRole("button", { name: "Enlarge Note" }),
    ).toBeInTheDocument();
  });

  it("swaps the input for a text area that accepts newlines", async () => {
    const user = userEvent.setup();
    renderWithMantine(<StringHarness />);

    await user.click(screen.getByRole("button", { name: "Enlarge Note" }));

    const textarea = screen.getByRole("textbox", {
      name: /Note/,
    }) as HTMLTextAreaElement;
    expect(textarea.tagName).toBe("TEXTAREA");
    await user.type(textarea, "one{Enter}two");
    expect(textarea.value).toBe("one\ntwo");
  });

  it("carries the constraints of the field it replaced", async () => {
    const user = userEvent.setup();
    renderWithMantine(<StringHarness />);
    await user.click(screen.getByRole("button", { name: "Enlarge Note" }));
    expect(screen.getByRole("textbox", { name: /Note/ })).toHaveAttribute(
      "maxlength",
      "40",
    );
  });

  it("is one-way — the enlarge button is gone once used", async () => {
    const user = userEvent.setup();
    renderWithMantine(<StringHarness />);
    await user.click(screen.getByRole("button", { name: "Enlarge Note" }));
    expect(
      screen.queryByRole("button", { name: "Enlarge Note" }),
    ).not.toBeInTheDocument();
  });

  it("keeps the clear button working after enlarging", async () => {
    const user = userEvent.setup();
    renderWithMantine(<StringHarness />);

    await user.type(screen.getByRole("textbox", { name: /Note/ }), "typed");
    await user.click(screen.getByRole("button", { name: "Enlarge Note" }));
    const textarea = screen.getByRole("textbox", {
      name: /Note/,
    }) as HTMLTextAreaElement;
    expect(textarea.value).toBe("typed");

    await user.click(screen.getByRole("button", { name: "Clear" }));
    expect(textarea.value).toBe("");
  });

  it("shows no clear button until the field holds a value", async () => {
    const user = userEvent.setup();
    renderWithMantine(<StringHarness />);
    expect(
      screen.queryByRole("button", { name: "Clear" }),
    ).not.toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: /Note/ }), "x");
    expect(screen.getByRole("button", { name: "Clear" })).toBeInTheDocument();
  });

  // Enlarging belongs to the field the user enlarged, not to its name — the
  // same reasoning resetKey documents for the number field's draft.
  it("goes back to a single-line input when resetKey moves to another entity", async () => {
    const user = userEvent.setup();
    const { rerender } = renderWithMantine(<StringHarness resetKey="tool-a" />);

    await user.click(screen.getByRole("button", { name: "Enlarge Note" }));
    expect(screen.getByRole("textbox", { name: /Note/ }).tagName).toBe(
      "TEXTAREA",
    );

    rerender(<StringHarness resetKey="tool-b" />);
    expect(screen.getByRole("textbox", { name: /Note/ }).tagName).toBe("INPUT");
  });

  it("stays enlarged while resetKey is unchanged", async () => {
    const user = userEvent.setup();
    const { rerender } = renderWithMantine(<StringHarness resetKey="tool-a" />);

    await user.click(screen.getByRole("button", { name: "Enlarge Note" }));
    rerender(<StringHarness resetKey="tool-a" />);
    expect(screen.getByRole("textbox", { name: /Note/ }).tagName).toBe(
      "TEXTAREA",
    );
  });

  it("gives each field's enlarge button a distinct accessible name", () => {
    renderWithMantine(
      <SchemaForm
        schema={{
          type: "object",
          properties: {
            note: { type: "string", title: "Note" },
            summary: { type: "string", title: "Summary" },
          },
        }}
        values={{}}
        onChange={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Enlarge Note" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Enlarge Summary" }),
    ).toBeInTheDocument();
  });

  // The button unmounts in the same commit that mounts the text area, so
  // without an explicit hand-off a keyboard user is left focused on nothing.
  it("moves focus into the text area, caret last, when activated", async () => {
    const user = userEvent.setup();
    renderWithMantine(<StringHarness />);

    await user.type(screen.getByRole("textbox", { name: /Note/ }), "typed");
    await user.tab();
    expect(screen.getByRole("button", { name: "Enlarge Note" })).toHaveFocus();
    await user.keyboard("{Enter}");

    const textarea = screen.getByRole("textbox", {
      name: /Note/,
    }) as HTMLTextAreaElement;
    expect(textarea.tagName).toBe("TEXTAREA");
    expect(textarea).toHaveFocus();
    expect(textarea.selectionStart).toBe("typed".length);

    // And the caret really is at the end: typing appends rather than prepends.
    await user.keyboard("{Enter}more");
    expect(textarea.value).toBe("typed\nmore");
  });

  // A disabled form (a tool call in flight) must be inert as a whole: a live
  // button there would swap in a text area that mounts disabled, cannot take
  // focus, and so drops keyboard focus to the document.
  it("disables the enlarge button along with the field", () => {
    renderWithMantine(
      <SchemaForm
        schema={stringSchema}
        values={{}}
        onChange={vi.fn()}
        disabled
      />,
    );
    expect(screen.getByRole("button", { name: "Enlarge Note" })).toBeDisabled();
  });
  describe("a root-level union (#2123)", () => {
    const UNION_SCHEMA: InspectorFormSchema = {
      type: "object",
      properties: { note: { type: "string", title: "Note" } },
      anyOf: [
        {
          type: "object",
          properties: {
            kind: { type: "string", const: "email" },
            address: { type: "string", title: "Address" },
          },
          required: ["kind", "address"],
        },
        {
          type: "object",
          properties: {
            kind: { type: "string", const: "sms" },
            phone: { type: "string", title: "Phone" },
          },
          required: ["kind", "phone"],
        },
      ],
    };

    it("renders the first branch's fields with a picker, not an empty form", () => {
      renderWithMantine(
        <SchemaForm schema={UNION_SCHEMA} values={{}} onChange={vi.fn()} />,
      );
      expect(screen.getByRole("textbox", { name: /Note/ })).toBeTruthy();
      expect(screen.getByRole("textbox", { name: /Address/ })).toBeTruthy();
      expect(screen.queryByRole("textbox", { name: /Phone/ })).toBeNull();
      expect(
        (screen.getByRole("textbox", { name: /Variant/ }) as HTMLInputElement)
          .value,
      ).toBe("email");
    });

    it("switches to the chosen branch's fields", async () => {
      const user = userEvent.setup();
      renderWithMantine(
        <SchemaForm schema={UNION_SCHEMA} values={{}} onChange={vi.fn()} />,
      );
      await user.click(screen.getByRole("textbox", { name: /Variant/ }));
      await user.click(screen.getByRole("option", { name: "sms" }));
      expect(screen.getByRole("textbox", { name: /Phone/ })).toBeTruthy();
      expect(screen.queryByRole("textbox", { name: /Address/ })).toBeNull();
    });

    it("drops the outgoing branch's values and seeds the incoming branch's const", async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      renderWithMantine(
        <SchemaForm
          schema={UNION_SCHEMA}
          values={{ note: "hi", kind: "email", address: "a@b.c" }}
          onChange={onChange}
        />,
      );
      await user.click(screen.getByRole("textbox", { name: /Variant/ }));
      await user.click(screen.getByRole("option", { name: "sms" }));
      // `address` belongs to a shape this call is no longer making, so it must
      // not ride along invisibly into the submitted arguments.
      expect(onChange).toHaveBeenCalledWith({ note: "hi", kind: "sms" });
    });

    it("renders a const-pinned field read-only", () => {
      renderWithMantine(
        <SchemaForm
          schema={UNION_SCHEMA}
          values={{ kind: "email" }}
          onChange={vi.fn()}
        />,
      );
      const kind = screen.getByRole("textbox", {
        name: /kind/,
      }) as HTMLInputElement;
      expect(kind.readOnly).toBe(true);
      expect(kind.value).toBe("email");
    });

    it("renders a non-string constant read-only too", () => {
      // Reached before the number/boolean dispatch, so neither offers a value
      // the `const` forbids.
      renderWithMantine(
        <SchemaForm
          schema={{
            type: "object",
            properties: {
              n: { type: "number", const: 7, title: "N" },
              b: { type: "boolean", const: true, title: "B" },
            },
          }}
          values={{}}
          onChange={vi.fn()}
        />,
      );
      expect(
        (screen.getByRole("textbox", { name: /N/ }) as HTMLInputElement).value,
      ).toBe("7");
      expect(
        (screen.getByRole("textbox", { name: /B/ }) as HTMLInputElement).value,
      ).toBe("true");
    });

    it("keeps a const out of an enum select", () => {
      // A schema carrying both would otherwise reach the select and offer the
      // enum's other members, each of which the `const` rejects.
      renderWithMantine(
        <SchemaForm
          schema={{
            type: "object",
            properties: {
              mode: {
                type: "string",
                const: "fast",
                enum: ["fast", "slow"],
                title: "Mode",
              },
            },
          }}
          values={{}}
          onChange={vi.fn()}
        />,
      );
      const mode = screen.getByRole("textbox", {
        name: /Mode/,
      }) as HTMLInputElement;
      expect(mode.readOnly).toBe(true);
      expect(mode.value).toBe("fast");
    });

    it("renders no picker for a single-branch union but still shows its fields", () => {
      const schema: InspectorFormSchema = {
        type: "object",
        anyOf: [
          {
            type: "object",
            properties: { only: { type: "string", title: "Only" } },
          },
        ],
      };
      renderWithMantine(
        <SchemaForm schema={schema} values={{}} onChange={vi.fn()} />,
      );
      expect(screen.getByRole("textbox", { name: /Only/ })).toBeTruthy();
      expect(screen.queryByRole("textbox", { name: /Variant/ })).toBeNull();
    });

    it("renders root allOf fields", () => {
      const schema: InspectorFormSchema = {
        type: "object",
        allOf: [
          {
            type: "object",
            properties: { merged: { type: "string", title: "Merged" } },
          },
        ],
      };
      renderWithMantine(
        <SchemaForm schema={schema} values={{}} onChange={vi.fn()} />,
      );
      expect(screen.getByRole("textbox", { name: /Merged/ })).toBeTruthy();
    });

    it("returns to the first branch when resetKey says the form moved on", async () => {
      const user = userEvent.setup();
      const { rerender } = renderWithMantine(
        <SchemaForm
          schema={UNION_SCHEMA}
          values={{}}
          onChange={vi.fn()}
          resetKey="tool-a"
        />,
      );
      await user.click(screen.getByRole("textbox", { name: /Variant/ }));
      await user.click(screen.getByRole("option", { name: "sms" }));
      expect(screen.getByRole("textbox", { name: /Phone/ })).toBeTruthy();

      rerender(
        <SchemaForm
          schema={UNION_SCHEMA}
          values={{}}
          onChange={vi.fn()}
          resetKey="tool-b"
        />,
      );
      expect(screen.getByRole("textbox", { name: /Address/ })).toBeTruthy();
      expect(screen.queryByRole("textbox", { name: /Phone/ })).toBeNull();
    });

    it("clamps a selection the next schema's shorter union cannot hold", async () => {
      const user = userEvent.setup();
      const { rerender } = renderWithMantine(
        <SchemaForm schema={UNION_SCHEMA} values={{}} onChange={vi.fn()} />,
      );
      await user.click(screen.getByRole("textbox", { name: /Variant/ }));
      await user.click(screen.getByRole("option", { name: "sms" }));

      // No `resetKey`, so nothing resets the selection: index 1 must be clamped
      // rather than reaching past the end of a one-branch union.
      const shorter: InspectorFormSchema = {
        type: "object",
        anyOf: [
          {
            type: "object",
            properties: { solo: { type: "string", title: "Solo" } },
          },
        ],
      };
      rerender(<SchemaForm schema={shorter} values={{}} onChange={vi.fn()} />);
      expect(screen.getByRole("textbox", { name: /Solo/ })).toBeTruthy();
    });
  });
});
