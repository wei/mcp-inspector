import { ActionIcon, Group, TextInput } from "@mantine/core";
import { ClearButton } from "../ClearButton/ClearButton";
import type { KeyValuePair } from "../../../utils/keyValuePairs";

// Re-exported for call sites that already import this component, so they need
// not know the type lives a layer down.
export type { KeyValuePair };

export interface KeyValueRowsProps {
  items: KeyValuePair[];
  /**
   * Singular noun for one row ("header", "environment variable", …). Used only
   * to build each control's `aria-label`: the section heading and the "Key" /
   * "Value" placeholders are not programmatically associated with the inputs,
   * so without it an assistive technology cannot tell one list's key box from
   * another's, and the remove button announces only "X". The clear buttons are
   * named the same way — a bare "Clear" repeated six times across three rows
   * tells a screen-reader user nothing about which field it empties.
   */
  entityLabel: string;
  /**
   * Lock every control in the list — used while a submit is in flight, so the
   * rows can't drift out of sync with the payload the caller already captured.
   */
  disabled?: boolean;
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
  disabled,
  onChange,
  onRemove,
}: KeyValueRowsProps) {
  return (
    <>
      {items.map((item, index) => {
        // The row number is always part of the label, not just a fallback for
        // a blank key: two rows can carry the SAME key (mid-edit, or a
        // duplicate a server legitimately persisted), and a key-only label
        // would give both rows' controls identical accessible names — the very
        // thing this labelling exists to prevent.
        const key = item.key.trim();
        const rowLabel = key ? `${key}, row ${index + 1}` : `row ${index + 1}`;
        return (
          <Group key={index} grow>
            <ClearableTextInput
              placeholder="Key"
              aria-label={`${entityLabel} name, ${rowLabel}`}
              value={item.key}
              disabled={disabled}
              onChange={(e) =>
                onChange(index, e.currentTarget.value, item.value)
              }
              rightSection={
                item.key ? (
                  <ClearButton
                    aria-label={`Clear ${entityLabel} name, ${rowLabel}`}
                    disabled={disabled}
                    onClick={() => onChange(index, "", item.value)}
                  />
                ) : null
              }
            />
            <ClearableTextInput
              placeholder="Value"
              aria-label={`${entityLabel} value, ${rowLabel}`}
              value={item.value}
              disabled={disabled}
              onChange={(e) => onChange(index, item.key, e.currentTarget.value)}
              rightSection={
                item.value ? (
                  <ClearButton
                    aria-label={`Clear ${entityLabel} value, ${rowLabel}`}
                    disabled={disabled}
                    onClick={() => onChange(index, item.key, "")}
                  />
                ) : null
              }
            />
            <RemoveIcon
              aria-label={`Remove ${entityLabel}, ${rowLabel}`}
              disabled={disabled}
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
