import { ActionIcon, Group, TextInput } from "@mantine/core";
import { ClearButton } from "../ClearButton/ClearButton";

export interface KeyValuePair {
  key: string;
  value: string;
}

export interface KeyValueRowsProps {
  items: KeyValuePair[];
  /**
   * Singular noun for one row ("header", "environment variable", …). Used only
   * to build each control's `aria-label`: the section heading and the "Key" /
   * "Value" placeholders are not programmatically associated with the inputs,
   * so without it an assistive technology cannot tell one list's key box from
   * another's, and the remove button announces only "X".
   */
  entityLabel: string;
  onChange: (index: number, key: string, value: string) => void;
  onRemove: (index: number) => void;
}

// Optional (non-required) clearable field — keeps the ClearButton clickable.
const ClearableTextInput = TextInput.withProps({
  rightSectionPointerEvents: "auto",
});

const RemoveIcon = ActionIcon.withProps({
  color: "red",
  variant: "subtle",
});

/**
 * Controlled editor for a list of `{ key, value }` pairs — the shape the
 * Inspector persists for custom headers, request metadata, and stdio
 * environment variables. Owns no state: every keystroke is reported through
 * `onChange(index, key, value)` and the caller re-renders with the new list.
 *
 * Shared by ServerSettingsForm (headers / metadata / env) and ServerConfigModal
 * (headers on the manual add form, #1915) so the two cannot drift.
 */
export function KeyValueRows({
  items,
  entityLabel,
  onChange,
  onRemove,
}: KeyValueRowsProps) {
  return (
    <>
      {items.map((item, index) => {
        const rowLabel = item.key.trim() || `row ${index + 1}`;
        return (
          <Group key={index} grow>
            <ClearableTextInput
              placeholder="Key"
              aria-label={`${entityLabel} name, ${rowLabel}`}
              value={item.key}
              onChange={(e) =>
                onChange(index, e.currentTarget.value, item.value)
              }
              rightSection={
                item.key ? (
                  <ClearButton
                    onClick={() => onChange(index, "", item.value)}
                  />
                ) : null
              }
            />
            <ClearableTextInput
              placeholder="Value"
              aria-label={`${entityLabel} value, ${rowLabel}`}
              value={item.value}
              onChange={(e) => onChange(index, item.key, e.currentTarget.value)}
              rightSection={
                item.value ? (
                  <ClearButton onClick={() => onChange(index, item.key, "")} />
                ) : null
              }
            />
            <RemoveIcon
              aria-label={`Remove ${entityLabel}, ${rowLabel}`}
              onClick={() => onRemove(index)}
            >
              X
            </RemoveIcon>
          </Group>
        );
      })}
    </>
  );
}
