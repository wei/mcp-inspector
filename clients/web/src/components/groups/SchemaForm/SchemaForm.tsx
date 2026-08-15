import {
  Checkbox,
  JsonInput,
  MultiSelect,
  NumberInput,
  Select,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { useState } from "react";
import { ClearButton } from "../../elements/ClearButton/ClearButton";
import { useValueChange } from "../../../hooks/useValueChange";
import type {
  InspectorFormSchema,
  JsonSchemaConst,
} from "../../../utils/jsonUtils";
import { normalizeNullableUnion } from "@inspector/core/json/nullableUnion.js";

const FieldLabel = Text.withProps({
  fw: 500,
  size: "sm",
});

const FieldDescription = Text.withProps({
  size: "xs",
  c: "dimmed",
});

// Indented column for a nested object's sub-fields.
const IndentedStack = Stack.withProps({ gap: "sm", pl: "md" });

const SchemaJsonInput = JsonInput.withProps({
  formatOnBlur: true,
  autosize: true,
});

function serializeJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/**
 * Pair enum values with their non-standard `enumNames` titles into Mantine
 * `{ value, label }[]` option data. Falls back to bare enum values when
 * `enumNames` is absent or its length does not match `enum`, since a wrong-length
 * zip would mislabel options — worse than showing the raw values.
 */
function toEnumData(
  values: string[],
  names: string[] | undefined,
): string[] | { value: string; label: string }[] {
  if (names && names.length === values.length) {
    return values.map((value, index) => ({ value, label: names[index] }));
  }
  return values;
}

/**
 * Build `Select`/`MultiSelect` option data from a list of `oneOf`/`anyOf`
 * branches that are expected to be constants.
 *
 * Returns `null` when the branches are not usable as options, which sends the
 * field to the JSON fallback instead. Four ways that happens:
 *
 * - **A non-string `const`.** Mantine's select is string-valued, so
 *   `anyOf: [{ const: 1 }, { const: 2 }]` would submit `["1"]` where the
 *   schema says `[1]` — the same wrong-type-on-the-wire problem that keeps a
 *   numeric `enum` off the select path. An inspector must not misreport what
 *   it sends, so this stays on the JSON editor, where the value keeps its type.
 * - **No `const` at all.** An `anyOf` of *object* schemas — what
 *   `z.array(z.union([z.object(…), z.object(…)]))` compiles to — has no
 *   top-level `const` on any branch, so every option would be the empty
 *   string. Mantine **throws** on duplicate option values, which greys out the
 *   whole tool panel rather than degrading (#2007).
 * - **Duplicate values.** Two branches sharing a `const` throw the same way.
 * - **An empty option value**, which Mantine cannot render as selectable.
 *
 * A union of object shapes has no faithful dropdown anyway, so the JSON editor
 * is the honest widget for it rather than a lossy or crashing one.
 */
function toConstOptions(
  branches: (InspectorFormSchema | JsonSchemaConst)[],
): { value: string; label: string }[] | null {
  const options: { value: string; label: string }[] = [];
  const seen = new Set<string>();
  for (const branch of branches) {
    if (typeof branch.const !== "string") {
      return null;
    }
    const value = branch.const;
    if (value === "" || seen.has(value)) {
      return null;
    }
    seen.add(value);
    options.push({ value, label: branch.title ?? value });
  }
  return options.length > 0 ? options : null;
}

/**
 * Whether an enum `Select` should offer a clear affordance. Only a schema that
 * admits `null` does: clearing emits `null`, and an enum without a null branch
 * would reject it. Without this a nullable enum is a one-way door — once a
 * value is picked there is no way back to "no answer".
 */
function isClearable(fieldSchema: InspectorFormSchema): boolean {
  return fieldSchema.nullable === true;
}

/**
 * Interpret whatever Mantine's `NumberInput` reported as the JSON value for the
 * field. Anything that is not a finite number becomes `undefined`, which is how
 * an absent optional argument is represented everywhere else in this form.
 *
 * `NumberInput` emits a `number` only when the text both parses *and* is exactly
 * representable; otherwise it hands back the **raw string** (see its
 * `isValidNumber` guard). Two quite different situations produce a string, and
 * they are treated differently here:
 *
 * 1. **Mid-entry text** — `""` when cleared, plus `"1."`, `"1.50"`, and a lone
 *    `"-"`. These are parsed: `"1."` really does mean `1`. (Note that an
 *    exponent is *not* in this set — `NumberInput` masks input through
 *    `NumericFormat`, which rejects `e` outright, so `"1e"` can never be typed.)
 * 2. **Values JS cannot hold exactly** — anything at or beyond
 *    `Number.MAX_SAFE_INTEGER`. `Number("90071992547409910")` silently yields
 *    `90071992547409904`, so parsing here would send the server a number the
 *    user never entered. An inspector must not misreport what it transmits, so
 *    these report no value instead — which is also what this field did with such
 *    input before #1888, making it no regression. Preserving them properly needs
 *    an exact-serialization path down the whole `tools/call` chain, which is a
 *    separate concern from being able to type a decimal.
 */
function toNumericValue(raw: string | number): number | undefined {
  if (typeof raw === "number") {
    return Number.isFinite(raw) ? raw : undefined;
  }
  if (raw.trim() === "") {
    return undefined;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  // Case 2 above. The integer part is what overflows exact representation; the
  // fractional digits are bounded by the same guard and stay lossless.
  return Number.isSafeInteger(Math.trunc(parsed)) ? parsed : undefined;
}

/** Parse editor text, reporting `undefined` for anything that is not JSON yet. */
function parseJsonDraft(text: string): unknown {
  if (text.trim() === "") {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Structural equality for the draft/value re-sync, via canonical JSON. */
function isSameJson(a: unknown, b: unknown): boolean {
  if (a === undefined || b === undefined) {
    return a === b;
  }
  return serializeJson(a) === serializeJson(b);
}

interface SchemaJsonFieldProps {
  label: string;
  description?: string;
  withAsterisk: boolean;
  disabled: boolean;
  value: unknown;
  onChange: (value: unknown) => void;
}

/**
 * A `JsonInput` that keeps the text the user is typing, not just the value it
 * currently parses to.
 *
 * This field used to drive the box straight off the parent's value and, when
 * the text failed `JSON.parse`, store the **raw text** back as the value — which
 * the next render re-`JSON.stringify`d, adding a layer of escaping per
 * keystroke. Typing `[` gave `"["`, then `"\"[\""`, and the field was unusable
 * within a few characters. That compounding escape is the original #1928
 * symptom, and it lived in this fallback rather than in the dispatch.
 *
 * Routing nullable fields to real widgets removed the common way of *landing*
 * here, but it did not fix the editor — and #2007's fix deliberately sends a
 * union of object shapes to it, so the editor itself has to be typeable. Hence
 * the same split `SchemaNumberInput` uses: the raw text is the source of truth
 * for what is *displayed*, while the parent only ever sees parsed JSON.
 *
 * While the text is mid-edit and does not parse, the parent is told
 * `undefined` rather than handed the text. An inspector must not report a value
 * it cannot send, and `undefined` is how "no value supplied" is spelled
 * everywhere else in this form.
 */
function SchemaJsonField({
  value,
  onChange,
  ...inputProps
}: SchemaJsonFieldProps) {
  const [draft, setDraft] = useState(() =>
    value === undefined ? "" : serializeJson(value),
  );

  // Re-sync only when the parent's value genuinely diverges from what the draft
  // parses to, which leaves an external reset (a cleared form, a loaded
  // example) working while an in-progress `[` — whose parse is `undefined`,
  // matching the `undefined` we just emitted — is left alone.
  useValueChange(value, (next) => {
    if (!isSameJson(parseJsonDraft(draft), next)) {
      setDraft(next === undefined ? "" : serializeJson(next));
    }
  });

  return (
    <SchemaJsonInput
      {...inputProps}
      value={draft}
      onChange={(text) => {
        setDraft(text);
        onChange(parseJsonDraft(text));
      }}
    />
  );
}

interface SchemaNumberInputProps {
  label: string;
  description?: string;
  withAsterisk: boolean;
  disabled: boolean;
  value: number | undefined;
  min?: number;
  max?: number;
  allowDecimal: boolean;
  onChange: (value: number | undefined) => void;
}

/**
 * A `NumberInput` that keeps the text the user is typing, not just the number it
 * currently parses to.
 *
 * Driving `NumberInput` directly off the parent's numeric value makes a decimal
 * impossible to enter (#1888): typing `.` after `1` produces the unparseable
 * string `"1."`, the numeric value stays `1`, and the controlled `value` prop
 * immediately rewrites the box back to `"1"` — so the `.` vanishes and `1.5` can
 * never be reached. Trailing zeros (`"1.50"`) and a lone leading `"-"` fail the
 * same way.
 *
 * So the raw text is held here as the source of truth for what is *displayed*,
 * while the parent still only ever sees a `number | undefined`. The two are
 * re-synced only when the parent's value genuinely diverges from what the draft
 * parses to, which leaves an external reset (a cleared form, a loaded example)
 * working while an in-progress `"1."` — whose parse is `1`, matching the value we
 * just emitted — is left alone.
 *
 * That value comparison cannot see a reset to an *equal* value, so the caller is
 * additionally expected to vary this component's React key via `SchemaForm`'s
 * `resetKey` when it switches which entity the form edits. See the note on that
 * prop for the case it covers.
 */
function SchemaNumberInput({
  value,
  onChange,
  ...inputProps
}: SchemaNumberInputProps) {
  const [draft, setDraft] = useState<string | number>(value ?? "");

  useValueChange(value, (next) => {
    if (!Object.is(toNumericValue(draft), next)) {
      setDraft(next ?? "");
    }
  });

  return (
    <NumberInput
      {...inputProps}
      value={draft}
      onChange={(next) => {
        setDraft(next);
        onChange(toNumericValue(next));
      }}
    />
  );
}

export interface SchemaFormProps {
  schema: InspectorFormSchema;
  values: Record<string, unknown>;
  onChange: (values: Record<string, unknown>) => void;
  disabled?: boolean;
  /**
   * Stable identity of whatever this form is editing — a tool name, a request
   * id. Pass it whenever the same mounted form is reused for a *different*
   * entity, which is the case for the Tools tab: `ToolDetailPanel` is not keyed
   * by tool, so selecting another tool re-renders the same field components.
   *
   * It exists because the number field's draft/value re-sync compares parsed
   * numbers, and so cannot detect a reset to an equal value. Type `-` (draft
   * `"-"`, value `undefined`), then switch to a tool with a same-named number
   * field and no default: the value is `undefined` on both sides, no divergence
   * is seen, and the stale `-` would otherwise be left in the box for the new
   * tool to continue from. Varying `resetKey` remounts the field instead, so no
   * in-progress text can outlive the entity it was typed into.
   *
   * Omit it when the form is mounted fresh per entity (the elicitation panels),
   * where unmounting already discards the draft. The schema object itself is no
   * substitute — callers rebuild it every render, so its identity is unstable.
   */
  resetKey?: string;
}

function getDefaultValue(fieldSchema: InspectorFormSchema): unknown {
  if (fieldSchema.default !== undefined) {
    return fieldSchema.default;
  }
  return undefined;
}

function resolveValue(
  value: unknown,
  fieldSchema: InspectorFormSchema,
): unknown {
  if (value !== undefined) {
    return value;
  }
  return getDefaultValue(fieldSchema);
}

export function SchemaForm({
  schema,
  values,
  onChange,
  disabled = false,
  resetKey,
}: SchemaFormProps) {
  const properties = schema.properties ?? {};
  const requiredFields = schema.required ?? [];

  function handleFieldChange(fieldName: string, fieldValue: unknown) {
    onChange({ ...values, [fieldName]: fieldValue });
  }

  function renderField(fieldName: string, rawSchema: InspectorFormSchema) {
    // Flatten a nullable union (`anyOf: [X, {type:"null"}]`, `type: [X,"null"]`)
    // before dispatching. Every branch below tests a single `type` string, so
    // without this an "optional and explicitly nullable" field — what Zod's
    // `.nullish()` emits — matches nothing and falls through to the raw-JSON
    // fallback, which is unusable for a value the user has to type (#1928).
    const fieldSchema = normalizeNullableUnion(rawSchema);
    const isRequired = requiredFields.includes(fieldName);
    const label = fieldSchema.title ?? fieldName;
    const description = fieldSchema.description;
    const rawValue = resolveValue(values[fieldName], fieldSchema);

    // string with enum
    if (fieldSchema.type === "string" && fieldSchema.enum) {
      return (
        <Select
          key={fieldName}
          label={label}
          description={description}
          withAsterisk={isRequired}
          disabled={disabled}
          data={toEnumData(fieldSchema.enum, fieldSchema.enumNames)}
          clearable={isClearable(fieldSchema)}
          value={(rawValue as string) ?? null}
          onChange={(val) => handleFieldChange(fieldName, val)}
        />
      );
    }

    // string with oneOf
    const oneOfData = fieldSchema.oneOf
      ? toConstOptions(fieldSchema.oneOf)
      : null;
    if (fieldSchema.type === "string" && oneOfData) {
      const data = oneOfData;
      return (
        <Select
          key={fieldName}
          label={label}
          description={description}
          withAsterisk={isRequired}
          disabled={disabled}
          data={data}
          clearable={isClearable(fieldSchema)}
          value={(rawValue as string) ?? null}
          onChange={(val) => handleFieldChange(fieldName, val)}
        />
      );
    }

    // plain string
    if (fieldSchema.type === "string") {
      return (
        <TextInput
          key={fieldName}
          label={label}
          description={description}
          withAsterisk={isRequired}
          disabled={disabled}
          value={(rawValue as string) ?? ""}
          minLength={fieldSchema.minLength}
          maxLength={fieldSchema.maxLength}
          onChange={(event) =>
            handleFieldChange(fieldName, event.currentTarget.value)
          }
          rightSectionPointerEvents="auto"
          rightSection={
            rawValue ? (
              <ClearButton onClick={() => handleFieldChange(fieldName, "")} />
            ) : null
          }
        />
      );
    }

    // number or integer
    if (fieldSchema.type === "number" || fieldSchema.type === "integer") {
      return (
        <SchemaNumberInput
          // The only field holding local state, so the only one that has to be
          // remounted when `resetKey` says the form moved to another entity.
          key={resetKey === undefined ? fieldName : `${resetKey}:${fieldName}`}
          label={label}
          description={description}
          withAsterisk={isRequired}
          disabled={disabled}
          value={rawValue as number | undefined}
          min={fieldSchema.minimum}
          max={fieldSchema.maximum}
          // An `integer` field rejects the decimal point outright rather than
          // accepting a value the schema forbids.
          allowDecimal={fieldSchema.type === "number"}
          onChange={(val) => handleFieldChange(fieldName, val)}
        />
      );
    }

    // boolean
    if (fieldSchema.type === "boolean") {
      return (
        <Checkbox
          key={fieldName}
          label={label}
          description={description}
          disabled={disabled}
          checked={(rawValue as boolean) ?? false}
          onChange={(event) =>
            handleFieldChange(fieldName, event.currentTarget.checked)
          }
        />
      );
    }

    // array of enum values (multi-select)
    if (fieldSchema.type === "array" && fieldSchema.items?.enum) {
      const data = toEnumData(
        fieldSchema.items.enum,
        fieldSchema.items.enumNames,
      );
      return (
        <MultiSelect
          key={fieldName}
          label={label}
          description={description}
          withAsterisk={isRequired}
          disabled={disabled}
          data={data}
          value={(rawValue as string[]) ?? []}
          onChange={(val) => handleFieldChange(fieldName, val)}
        />
      );
    }

    // array with items having anyOf
    const itemsAnyOfData = fieldSchema.items?.anyOf
      ? toConstOptions(fieldSchema.items.anyOf)
      : null;
    if (fieldSchema.type === "array" && itemsAnyOfData) {
      const data = itemsAnyOfData;
      return (
        <MultiSelect
          key={fieldName}
          label={label}
          description={description}
          withAsterisk={isRequired}
          disabled={disabled}
          data={data}
          value={(rawValue as string[]) ?? []}
          onChange={(val) => handleFieldChange(fieldName, val)}
        />
      );
    }

    // nested object
    if (fieldSchema.type === "object" && fieldSchema.properties) {
      return (
        <Stack key={fieldName} gap="sm">
          <FieldLabel>{label}</FieldLabel>
          {description && <FieldDescription>{description}</FieldDescription>}
          <IndentedStack>
            <SchemaForm
              schema={fieldSchema}
              values={(rawValue as Record<string, unknown>) ?? {}}
              onChange={(nestedValues) =>
                handleFieldChange(fieldName, nestedValues)
              }
              disabled={disabled}
              // Sub-fields belong to the same entity, so they reset with it.
              resetKey={resetKey}
            />
          </IndentedStack>
        </Stack>
      );
    }

    // fallback: JsonInput for complex schemas
    return (
      <SchemaJsonField
        // Holds local draft state, so — like the number field — it has to be
        // remounted when `resetKey` says the form moved to another entity.
        key={resetKey === undefined ? fieldName : `${resetKey}:${fieldName}`}
        label={label}
        description={description}
        withAsterisk={isRequired}
        disabled={disabled}
        value={rawValue}
        onChange={(val) => handleFieldChange(fieldName, val)}
      />
    );
  }

  return (
    <Stack gap="sm">
      {Object.entries(properties).map(([fieldName, fieldSchema]) =>
        renderField(fieldName, fieldSchema),
      )}
    </Stack>
  );
}
