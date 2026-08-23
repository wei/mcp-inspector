import { useEffect, useId, useRef, useState } from "react";
import { Input, useComputedColorScheme } from "@mantine/core";
import type { Ace } from "ace-builds";
import AceEditor from "react-ace";
import ace from "ace-builds/src-noconflict/ace";
import "ace-builds/src-noconflict/mode-json";
import "ace-builds/src-noconflict/theme-github";
import "ace-builds/src-noconflict/theme-github_dark";
// `?url` so Vite emits the worker as its own asset and hands back a real URL.
// Without it Ace fetches `worker-json.js` from a path that does not exist in a
// bundled app, silently loses its annotations, and logs a fetch error.
import jsonWorkerUrl from "ace-builds/src-noconflict/worker-json.js?url";
import type { StrictJsonObject } from "@inspector/core/json/jsonUtils.js";
import { useValueChange } from "../../../hooks/useValueChange";
import { parseJsonObjectDraft } from "../../../utils/jsonObjectDraft";

// Module scope: registering the worker URL is global to Ace and idempotent, so
// it must not be repeated per mount.
ace.config.setModuleUrl("ace/mode/json_worker", jsonWorkerUrl);

/** Two-space canonical form — the same shape the catalog file is written in. */
function serialize(value: StrictJsonObject): string {
  return JSON.stringify(value, null, 2);
}

export interface JsonObjectInputProps {
  value: StrictJsonObject;
  onChange: (value: StrictJsonObject) => void;
  label?: string;
  description?: string;
  /**
   * Accessible name for the editor's text input. Ace labels its hidden
   * textarea "Cursor at row N" by default, which is a position readout rather
   * than a name — so this is what makes the control identifiable to a screen
   * reader, and what `getByLabelText` finds in a test.
   */
  ariaLabel: string;
  /** Rows shown before the editor grows; it autosizes between these bounds. */
  minLines?: number;
  maxLines?: number;
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
 * Built on Ace rather than a plain textarea because hand-writing JSON in a bare
 * box is the actual pain: Ace closes a brace when you open one, folds nested
 * objects, and — via its JSON worker — marks the offending line in the gutter
 * instead of reporting one message for the whole document.
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
 * The state is not silent, though: Ace flags the position in the gutter, and
 * the wrapper repeats the reason underneath.
 */
export function JsonObjectInput({
  value,
  onChange,
  label,
  description,
  ariaLabel,
  minLines = 6,
  maxLines = 24,
}: JsonObjectInputProps) {
  const [draft, setDraft] = useState(() => serialize(value));
  // The canonical JSON of the last value this component emitted.
  //
  // The re-sync below has to tell an *external* change apart from the parent
  // echoing back what we just sent it, and the draft alone cannot: while the
  // text is invalid it parses to nothing, so every parent change would look
  // external and overwrite what is being typed.
  //
  // That is not hypothetical. Ace's `setValue` — which is what a select-all
  // paste and any programmatic replace go through — fires *two* change events,
  // a remove then an insert. The remove leaves an empty document, which is a
  // valid `{}` and gets emitted; the insert then leaves invalid text. Comparing
  // against the draft, the `{}` echo reads as an external reset and wipes the
  // pasted text a keystroke after it lands.
  const [echoed, setEchoed] = useState(() => serialize(value));
  // `getInitialValueInEffect: false` so the first render already has the real
  // scheme; otherwise the editor mounts light and repaints, which is visible.
  const colorScheme = useComputedColorScheme("light", {
    getInitialValueInEffect: false,
  });

  // Re-sync only on a value this component did not produce, so an external
  // reset (switching servers, a reloaded catalog) reaches the editor while an
  // in-progress edit is left alone. Compared through canonical JSON because the
  // parent hands back a fresh object each time.
  // Text from the most recent change event in the current tick, and whether a
  // flush is already queued to consume it. Two refs rather than one nullable
  // one so the flush reads a plain `string` — folding them together would add
  // a null check that nothing can ever satisfy. See `handleChange`.
  const pendingTextRef = useRef("");
  const flushScheduledRef = useRef(false);

  /**
   * Coalesce the change events Ace fires within one edit, and act on the last.
   *
   * A replace — select-all-and-retype, or a paste over a selection — is a
   * *remove* followed by an *insert*, and Ace fires a change event for each.
   * Acting on the first would read the momentarily-empty document as the user
   * clearing the field, emit `{}` to the parent, and so wipe their saved
   * metadata the instant they selected it. If the replacement text then failed
   * to parse, `{}` is what they would be left with.
   *
   * A microtask is enough because both events are dispatched synchronously
   * inside the same edit, so the flush sees only the settled text.
   */
  const handleChange = (text: string) => {
    pendingTextRef.current = text;
    if (flushScheduledRef.current) return;
    flushScheduledRef.current = true;
    queueMicrotask(() => {
      flushScheduledRef.current = false;
      const settled = pendingTextRef.current;
      setDraft(settled);
      const result = parseJsonObjectDraft(settled);
      if (!result.ok) return;
      setEchoed(serialize(result.value));
      onChange(result.value);
    });
  };

  const wrapperId = useId();
  const editorRef = useRef<Ace.Editor | null>(null);

  const parsed = parseJsonObjectDraft(draft);
  useValueChange(serialize(value), (next) => {
    if (next === echoed) return;
    setDraft(next);
    // `echoed` has to advance to the value now on screen, not just to what this
    // component last emitted. Leaving it behind makes an external A → B → A
    // sequence stick on B: the second A matches the stale `echoed` from before
    // B arrived and is dismissed as our own echo.
    setEchoed(next);
  });

  // `Input.Wrapper` labels and describes a Mantine input through context. Ace
  // is not one — it renders its own DOM — so the wrapper's label and error node
  // exist but point at nothing, leaving the control unassociated with the error
  // a screen reader needs and its visible label inert on click.
  //
  // A genuine external-system sync, so an effect rather than `useValueChange`:
  // it writes to a DOM node React does not own. Giving the textarea the
  // wrapper's own id is what makes the `<label for>` focus the editor; the
  // error wiring follows Mantine's `${id}-error` naming.
  useEffect(() => {
    const element = editorRef.current?.textInput.getElement();
    /* v8 ignore next -- the ref is set in `onLoad`, which react-ace calls
       synchronously on mount, so this effect always sees an element. */
    if (!element) return;
    element.id = wrapperId;

    // Both the description and the error are rendered by the wrapper and both
    // describe this control, so both ids belong here — a supplied description
    // is otherwise never announced, and it must not be dropped just because the
    // draft went invalid. Mantine renders each only when its prop is set, so
    // referencing an absent one would point at nothing.
    const describedBy = [
      description === undefined ? null : `${wrapperId}-description`,
      parsed.ok ? null : `${wrapperId}-error`,
    ].filter((id) => id !== null);

    if (describedBy.length > 0) {
      element.setAttribute("aria-describedby", describedBy.join(" "));
    } else {
      element.removeAttribute("aria-describedby");
    }

    if (parsed.ok) {
      element.removeAttribute("aria-invalid");
    } else {
      element.setAttribute("aria-invalid", "true");
    }
  }, [wrapperId, parsed.ok, description]);

  return (
    <Input.Wrapper
      id={wrapperId}
      label={label}
      description={description}
      error={parsed.ok ? undefined : parsed.error}
      w="100%"
    >
      <AceEditor
        mode="json"
        theme={colorScheme === "dark" ? "github_dark" : "github"}
        // react-ace uses `name` as the editor container's DOM id, so a fixed
        // value would collide the moment two of these render — and it must also
        // differ from the id given to the textarea below, which is the one the
        // wrapper's `<label for>` points at.
        name={`${wrapperId}-editor`}
        value={draft}
        onChange={handleChange}
        width="100%"
        minLines={minLines}
        maxLines={maxLines}
        tabSize={2}
        showPrintMargin={false}
        editorProps={{ $blockScrolling: Infinity }}
        onLoad={(editor) => {
          editorRef.current = editor;
          // `textInputAriaLabel` alone is not enough: Ace composes the hidden
          // textarea's label as "<label>, Cursor at row N" inside
          // `TextInput.setAriaLabel`, and only recomputes it when the cursor
          // moves — so an option applied at mount does not reach the DOM until
          // the user clicks into the editor. Until then the control's only
          // accessible name is the position readout, which names nothing.
          // Setting it here and recomputing once is what makes the editor
          // identifiable from first paint.
          editor.setOption("textInputAriaLabel", ariaLabel);
          editor.textInput.setAriaLabel();
        }}
        setOptions={{
          // The JSON worker is what puts a marker on the offending line rather
          // than one message for the whole document.
          useWorker: true,
          // Closes a brace/bracket/quote when you open one, and skips over the
          // closing one you then type. On by default; named because it is half
          // of why this component exists.
          behavioursEnabled: true,
          // Roving-tabindex arrow-key navigation plus an Esc-to-exit-trap, so
          // the editor does not swallow Tab for keyboard users.
          enableKeyboardAccessibility: true,
          textInputAriaLabel: ariaLabel,
          showFoldWidgets: true,
          displayIndentGuides: true,
          useSoftTabs: true,
          scrollPastEnd: false,
        }}
      />
    </Input.Wrapper>
  );
}
