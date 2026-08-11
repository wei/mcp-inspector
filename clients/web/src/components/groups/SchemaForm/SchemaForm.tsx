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
import type { InspectorFormSchema } from "../../../utils/jsonUtils";

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
 * Interpret whatever Mantine's `NumberInput` reported as the JSON value for the
 * field. It emits a `number` once the text parses cleanly, and the **raw string**
 * while it does not — `""` when cleared, but also the in-progress `"1."`, `"-"`,
 * and `"1e"`. Anything that is not a finite number becomes `undefined`, which is
 * how an absent optional argument is represented everywhere else in this form.
 */
function toNumericValue(raw: string | number): number | undefined {
  if (typeof raw === "number") {
    return Number.isFinite(raw) ? raw : undefined;
  }
  if (raw.trim() === "") {
    return undefined;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
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
}: SchemaFormProps) {
  const properties = schema.properties ?? {};
  const requiredFields = schema.required ?? [];

  function handleFieldChange(fieldName: string, fieldValue: unknown) {
    onChange({ ...values, [fieldName]: fieldValue });
  }

  function renderField(fieldName: string, fieldSchema: InspectorFormSchema) {
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
          value={(rawValue as string) ?? null}
          onChange={(val) => handleFieldChange(fieldName, val)}
        />
      );
    }

    // string with oneOf
    if (fieldSchema.type === "string" && fieldSchema.oneOf) {
      const data = fieldSchema.oneOf.map((item) => ({
        value: String(item.const ?? ""),
        label: item.title ?? String(item.const ?? ""),
      }));
      return (
        <Select
          key={fieldName}
          label={label}
          description={description}
          withAsterisk={isRequired}
          disabled={disabled}
          data={data}
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
          key={fieldName}
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
    if (fieldSchema.type === "array" && fieldSchema.items?.anyOf) {
      const data = fieldSchema.items.anyOf.map((item) => ({
        value: String(item.const ?? ""),
        label: item.title ?? String(item.const ?? ""),
      }));
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
            />
          </IndentedStack>
        </Stack>
      );
    }

    // fallback: JsonInput for complex schemas
    return (
      <SchemaJsonInput
        key={fieldName}
        label={label}
        description={description}
        withAsterisk={isRequired}
        disabled={disabled}
        value={rawValue !== undefined ? serializeJson(rawValue) : ""}
        onChange={(val) => {
          try {
            handleFieldChange(fieldName, JSON.parse(val));
          } catch {
            handleFieldChange(fieldName, val);
          }
        }}
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
