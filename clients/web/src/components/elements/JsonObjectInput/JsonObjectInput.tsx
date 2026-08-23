import { useState } from "react";
import { JsonInput } from "@mantine/core";
import type { JsonObject } from "@inspector/core/json/jsonUtils.js";
import { useValueChange } from "../../../hooks/useValueChange";
import { parseJsonObjectDraft } from "../../../utils/jsonObjectDraft";

const ObjectJsonInput = JsonInput.withProps({
  formatOnBlur: true,
  autosize: true,
  minRows: 4,
  spellCheck: false,
});

/** Two-space canonical form — the same shape the catalog file is written in. */
function serialize(value: JsonObject): string {
  return JSON.stringify(value, null, 2);
}

export interface JsonObjectInputProps {
  value: JsonObject;
  onChange: (value: JsonObject) => void;
  label?: string;
  description?: string;
  placeholder?: string;
  "aria-label"?: string;
  "data-testid"?: string;
}

/**
 * A JSON-object editor: the user types JSON, the parent receives the parsed
 * object.
 *
 * This is the editor for payloads whose *values* may be any JSON, which is why
 * it exists beside the key/value row editors used for headers and env. `_meta`
 * is the case that forced it (#1910) — nothing in the MCP spec restricts a
 * `_meta` value to a string, so a `{ key, value }` row editor cannot express
 * what the protocol allows.
 *
 * The text the user is typing is the source of truth for what is *displayed*;
 * the parent only ever sees a parsed object. That split is what makes the box
 * typeable: driving it off the parent's value and stringifying on every render
 * re-escapes half-typed text once per keystroke, which is the #1928 symptom.
 * `SchemaJsonField` in `SchemaForm.tsx` carries the same split for the same
 * reason — see the long comment there.
 *
 * While the text is invalid the parent is **not** told, so the last valid
 * object stands. The alternative — emitting `{}` — would silently discard a
 * user's configured metadata the moment they typed a stray character, and this
 * form has no Save button to gate instead: `onChange` writes straight through.
 * The state is not silent, though; the field says so on itself via `error`.
 */
export function JsonObjectInput({
  value,
  onChange,
  ...inputProps
}: JsonObjectInputProps) {
  const [draft, setDraft] = useState(() => serialize(value));

  // Re-sync only when the parent's value genuinely diverges from what the draft
  // parses to, so an external reset (switching servers, a reloaded catalog)
  // reaches the box while an in-progress edit is left alone. Compared through
  // canonical JSON because the parent hands back a fresh object each time.
  const parsed = parseJsonObjectDraft(draft);
  const draftJson = parsed.ok ? serialize(parsed.value) : null;
  useValueChange(serialize(value), (next) => {
    if (next !== draftJson) setDraft(next);
  });

  return (
    <ObjectJsonInput
      {...inputProps}
      value={draft}
      error={parsed.ok ? undefined : parsed.error}
      onChange={(text) => {
        setDraft(text);
        const result = parseJsonObjectDraft(text);
        if (result.ok) onChange(result.value);
      }}
    />
  );
}
