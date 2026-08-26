import {
  Checkbox,
  Group,
  JsonInput,
  MultiSelect,
  NumberInput,
  Select,
  Stack,
  Text,
  rem,
  Textarea,
  type TextareaProps,
  TextInput,
} from "@mantine/core";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
} from "react";
import { ClearButton } from "../../elements/ClearButton/ClearButton";
import { EnlargeButton } from "../../elements/EnlargeButton/EnlargeButton";
import { useValueChange } from "../../../hooks/useValueChange";
import type {
  InspectorFormSchema,
  JsonSchemaConst,
} from "../../../utils/jsonUtils";
import {
  isStringEnum,
  normalizeNullableUnion,
} from "@inspector/core/json/nullableUnion.js";

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

// A string field after its enlarge button has been used (#2042). `autosize`
// grows it with the text rather than fixing a height the value may not fit, and
// `maxRows` caps that growth so a long value scrolls inside the field instead of
// pushing the rest of the form off screen.
const MultilineStringInput = Textarea.withProps({
  autosize: true,
  minRows: 3,
  maxRows: 12,
  rightSectionPointerEvents: "auto",
});

/**
 * A string field that has just been enlarged (#2042).
 *
 * Exists only to take focus on mount. This component mounts as a direct
 * consequence of the user enlarging the field — and whichever control they used
 * unmounts in the same commit, taking the focused element with it. Without this,
 * the user is left with focus on the document body, and the next Tab restarts
 * from the top of the page rather than continuing through the form.
 *
 * `caretAt` says where the caret goes. The keyboard route passes one, because
 * Enter inserts a newline at the user's selection and the caret belongs just
 * after it (#2138). Pointer activation passes none: a click carries no
 * meaningful position, so the caret falls to the end of whatever was already
 * typed — focusing a pre-filled text control does not agree across browsers on
 * where it lands, and the one answer that is never right is "before the text
 * the user just wrote".
 */
function EnlargedStringField({
  caretAt,
  ...props
}: TextareaProps & { caretAt?: number }) {
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Layout, not passive: a passive effect runs after paint, so the browser would
  // present at least one frame with focus on the document body — long enough for
  // a fast Tab to land somewhere else entirely.
  useLayoutEffect(() => {
    const node = inputRef.current;
    /* v8 ignore next -- an effect runs after mount, so the ref is always set */
    if (!node) return;
    node.focus();
    const caret = caretAt ?? node.value.length;
    node.setSelectionRange(caret, caret);
  }, [caretAt]);

  return <MultilineStringInput {...props} ref={inputRef} />;
}

// Holds the buttons a string field stacks in its `rightSection`. `nowrap` keeps
// them on one line inside a section only wide enough for the two.
const FieldActions = Group.withProps({ gap: 2, wrap: "nowrap" });

// Width of the string field's right section, which Mantine takes as a number it
// cannot derive from its content. Built from the parts rather than written as a
// pixel total, so it stays right if a button or the gap changes, and emitted as
// `rem` so it tracks a user's root font size rather than pinning to CSS pixels.
// The two button widths are what they measure at their current sizes (ActionIcon
// `sm` and CloseButton's default); the inset keeps them off the field's edge.
const ENLARGE_WIDTH = 22;
const CLEAR_WIDTH = 28;
const ACTION_GAP = 2;
const SECTION_INSET = 6;
const ONE_ACTION_WIDTH = rem(CLEAR_WIDTH + SECTION_INSET);
const TWO_ACTION_WIDTH = rem(
  ENLARGE_WIDTH + ACTION_GAP + CLEAR_WIDTH + SECTION_INSET,
);

// `keyCode` reported for a keydown the IME consumed — the pre-`isComposing`
// sentinel every browser still sets during composition. Only needed for the
// browsers whose composition events land too late for `isComposing` to help
// (#2138 review); a real Enter reports 13, so this cannot swallow one.
const IME_KEY_CODE = 229;

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

/**
 * How a field tells the enclosing `SchemaForm` whether the text it is holding
 * can be sent. Keyed by field name rather than closed over per field so the
 * reporter is referentially stable, which is what keeps the effect below from
 * re-subscribing on every render.
 */
type DraftValidityReporter = (fieldName: string, isValid: boolean) => void;

/**
 * Publish a field's draft validity to the enclosing `SchemaForm`.
 *
 * Reported from an effect rather than from the change handler because validity
 * also moves when the *parent* replaces the value — a cleared form or a loaded
 * example re-syncs the draft and makes invalid text valid again without the
 * user touching the field. Reporting during that render instead would mean
 * updating another component mid-render, which React rejects.
 *
 * The cleanup reports the field as valid again, so a field that goes away —
 * unmounted with the panel, or remounted under a new `resetKey` when the form
 * moves to another entity — cannot leave a stale draft blocking submission.
 */
function useDraftValidity(
  fieldName: string,
  isValid: boolean,
  onValidityChange: DraftValidityReporter,
): void {
  useEffect(() => {
    onValidityChange(fieldName, isValid);
    return () => onValidityChange(fieldName, true);
  }, [fieldName, isValid, onValidityChange]);
}

interface SchemaJsonFieldProps {
  fieldName: string;
  label: string;
  description?: string;
  withAsterisk: boolean;
  disabled: boolean;
  /**
   * The field's own entry in the form's values — **not** run through
   * `resolveValue`. A draft-holding field is handed the raw value and the
   * schema default separately; see `defaultValue` for why.
   */
  value: unknown;
  /** The schema `default`, used to seed the draft only. See `defaultValue`. */
  defaultValue: unknown;
  onChange: (value: unknown) => void;
  onValidityChange: DraftValidityReporter;
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
 *
 * That leaves invalid text and an empty field indistinguishable *to the value*,
 * so the field reports the difference two other ways: it says so on itself via
 * `error`, and it reports draft validity up through `onValidityChange` so the
 * enclosing form's caller can disable Execute/Open App/Submit (#2020). Without
 * the second channel an **optional** field's invalid text is simply dropped
 * from a submission the user was allowed to make.
 */
function SchemaJsonField({
  fieldName,
  value,
  defaultValue,
  onChange,
  onValidityChange,
  ...inputProps
}: SchemaJsonFieldProps) {
  const [draft, setDraft] = useState(() => {
    const initial = value === undefined ? defaultValue : value;
    return initial === undefined ? "" : serializeJson(initial);
  });

  // Re-sync only when the parent's value genuinely diverges from what the draft
  // parses to, which leaves an external reset (a cleared form, a loaded
  // example) working while an in-progress `[` — whose parse is `undefined`,
  // matching the `undefined` we just emitted — is left alone.
  //
  // The value compared here is the field's *raw* entry, never `resolveValue`'s
  // default substitution (#2026). Unsendable text reports `undefined`, and a
  // defaulted field resolves that straight back to its default — a change from
  // the previous value, so comparing against the resolved one would rewrite the
  // draft to the default and revert the keystroke. Almost every edit passes
  // through an unsendable state, so a defaulted array or object argument would
  // be uneditable.
  //
  // Would be, not was: this is latent under today's seeding, where
  // `collectSchemaDefaults` assigns `fieldSchema.default` itself, so the
  // substitution returns the *same reference* and `useValueChange` never fires.
  // It goes live as soon as the value is a structurally-equal but distinct
  // object — parsed from the wire or a deep link, or a nested-object default,
  // which `collectSchemaDefaults` rebuilds per call. `SchemaNumberInput` has no
  // such accidental protection, since a number compares by value.
  //
  // Either way the default belongs to what the field *opens* with, seeded
  // above, not to what is re-imposed while it is being typed into.
  useValueChange(value, (next) => {
    if (!isSameJson(parseJsonDraft(draft), next)) {
      setDraft(next === undefined ? "" : serializeJson(next));
    }
  });

  // Text that is present but does not parse yields no value, so the field would
  // otherwise submit as absent while the user is still looking at what they
  // typed. Saying so on the field keeps that from being silent; reporting it
  // upward is what keeps it from being submittable.
  const hasInvalidDraft =
    draft.trim() !== "" && parseJsonDraft(draft) === undefined;
  useDraftValidity(fieldName, !hasInvalidDraft, onValidityChange);

  return (
    <SchemaJsonInput
      {...inputProps}
      value={draft}
      error={
        hasInvalidDraft
          ? "Not valid JSON — this field will be omitted"
          : undefined
      }
      onChange={(text) => {
        setDraft(text);
        onChange(parseJsonDraft(text));
      }}
    />
  );
}

/**
 * Whether a number field's draft is text that cannot be sent.
 *
 * Anything non-empty that `toNumericValue` declines is invalid: a half-typed
 * `"-"`, and — the case that matters — an integer past `MAX_SAFE_INTEGER`,
 * which is deliberately dropped rather than silently rounded (see
 * `toNumericValue`). Both would otherwise submit as an absent argument while
 * the text sits in the box.
 */
function hasInvalidNumericDraft(draft: string | number): boolean {
  if (typeof draft === "number") {
    return false;
  }
  return draft.trim() !== "" && toNumericValue(draft) === undefined;
}

interface SchemaNumberInputProps {
  fieldName: string;
  label: string;
  description?: string;
  withAsterisk: boolean;
  disabled: boolean;
  /**
   * Raw, not `resolveValue`-substituted — see `SchemaJsonFieldProps.value`.
   *
   * `null` is admitted alongside `undefined` because a nullable number schema
   * produces it — by way of parent state, never by clearing the box — and the
   * two are not interchangeable here: `undefined` means "no value supplied"
   * and takes `defaultValue`, while `null` is a value and displays empty.
   */
  value: number | null | undefined;
  /** The schema `default`, used to seed the draft only (#2026). May be `null`. */
  defaultValue: number | null | undefined;
  min?: number;
  max?: number;
  allowDecimal: boolean;
  onChange: (value: number | undefined) => void;
  onValidityChange: DraftValidityReporter;
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
  fieldName,
  value,
  defaultValue,
  onChange,
  onValidityChange,
  ...inputProps
}: SchemaNumberInputProps) {
  // `undefined` means "no value supplied", which is what the default is for.
  // An explicit `null` is a value, so it must not be overwritten by a non-null
  // default; it displays as the empty box `resolveValue` produced before.
  // Hence the `undefined` test rather than `??`, matching `SchemaJsonField`.
  //
  // Clearing the box does *not* produce that `null` — `toNumericValue("")`
  // reports `undefined`, which is the behavior the "passes undefined to
  // onChange when a number field is cleared" test pins. A `null` reaches this
  // field only from parent state: a value received from the server, restored
  // from a deep link, or written by a caller for a nullable schema.
  const [draft, setDraft] = useState<string | number>(
    (value === undefined ? defaultValue : value) ?? "",
  );

  // Compared against the raw value, never the default-substituted one, for the
  // reason spelled out on `SchemaJsonField` (#2026): clearing this box reports
  // no value, which a defaulted field resolved straight back to its default —
  // so the box refilled itself and the argument could not be emptied.
  useValueChange(value, (next) => {
    if (!Object.is(toNumericValue(draft), next)) {
      setDraft(next ?? "");
    }
  });

  // Same split as the JSON field: text this client cannot send reports no value,
  // so it has to say so on the field and report it upward, or the argument is
  // dropped from a submission the user was allowed to make (#2020).
  const invalidDraft = hasInvalidNumericDraft(draft);
  useDraftValidity(fieldName, !invalidDraft, onValidityChange);

  return (
    <NumberInput
      {...inputProps}
      value={draft}
      error={
        invalidDraft ? "Not a number — this field will be omitted" : undefined
      }
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
  /**
   * Called with `true` while any field is holding text that cannot be sent —
   * unparseable JSON, or a number this client cannot represent exactly. Both
   * report their value as `undefined`, which is indistinguishable from an empty
   * field once it reaches `values`, so a caller cannot derive this from the
   * values it already has (#2020).
   *
   * Gate the submit action on it: `hasMissingRequiredFields` covers a field with
   * *no* value, and this covers a field whose visible text produced none. An
   * empty optional field is unaffected — it stays valid and submittable.
   *
   * The callback is read through a ref, so an inline closure is fine — it is
   * called when the answer changes, not on every render.
   */
  onValidityChange?: (hasInvalidDraft: boolean) => void;
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
  onValidityChange,
}: SchemaFormProps) {
  const properties = schema.properties ?? {};
  const requiredFields = schema.required ?? [];

  // The names of fields currently holding unsendable text. Held here rather
  // than in each field because only the form sees them all, and only the form
  // knows when the last one cleared.
  const [invalidFields, setInvalidFields] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  // The names of string fields the user has enlarged into a multiline text area
  // (#2042). One-way by design — see EnlargeButton — so a name only ever enters
  // this set.
  const [enlargedFields, setEnlargedFields] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  // Enlarging is a property of the field the user enlarged, not of the field
  // *name*, so it must not carry across to another entity's same-named field —
  // the same reasoning `resetKey` documents for the number field's draft. Reset
  // during render rather than in an effect so no frame paints the wrong shape.
  // Where the caret goes when a field's text area mounts, for the fields
  // enlarged by Enter (#2138). Absent for a field enlarged by the button, which
  // carries no position — see EnlargedStringField.
  const [enlargeCarets, setEnlargeCarets] = useState<
    Readonly<Record<string, number>>
  >({});

  useValueChange(resetKey, () => {
    setEnlargedFields(new Set());
    setEnlargeCarets({});
  });

  // Stable so a field's reporting effect subscribes once, not per render. The
  // updater returns the previous set unchanged when nothing moved, which is
  // what makes a nested form's inline callback safe to call repeatedly.
  const reportFieldValidity = useCallback<DraftValidityReporter>(
    (fieldName, isValid) => {
      setInvalidFields((previous) => {
        if (previous.has(fieldName) === !isValid) {
          return previous;
        }
        const next = new Set(previous);
        if (isValid) {
          next.delete(fieldName);
        } else {
          next.add(fieldName);
        }
        return next;
      });
    },
    [],
  );

  // Read through a ref so the callback's identity is not a dependency. It has
  // to be one or the other, and a *stable* dependency is what this needs: a
  // nested form is handed a fresh closure every render, and re-running the
  // effect for that alone would toggle the parent's state (cleanup, then
  // re-report), re-render this form, and loop forever.
  const notifyValidity = useRef(onValidityChange);
  useEffect(() => {
    notifyValidity.current = onValidityChange;
  });

  // The cleanup mirrors the one in `useDraftValidity`: a form that is no longer
  // rendered holds no drafts, so an unmounted nested form must not leave the
  // outer one blocked. It runs in the same commit as the re-report, so the
  // transient `false` is never rendered.
  const hasInvalidDraft = invalidFields.size > 0;
  useEffect(() => {
    notifyValidity.current?.(hasInvalidDraft);
    return () => notifyValidity.current?.(false);
  }, [hasInvalidDraft]);

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
      const clearButton = rawValue ? (
        <ClearButton onClick={() => handleFieldChange(fieldName, "")} />
      ) : null;
      const sharedProps = {
        label,
        description,
        withAsterisk: isRequired,
        disabled,
        value: (rawValue as string) ?? "",
        minLength: fieldSchema.minLength,
        maxLength: fieldSchema.maxLength,
        onChange: (
          event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
        ) => handleFieldChange(fieldName, event.currentTarget.value),
      };

      // Already enlarged: a text area, and no way back. The enlarge button is
      // gone rather than disabled — there is nothing left for it to do.
      if (enlargedFields.has(fieldName)) {
        return (
          <EnlargedStringField
            key={fieldName}
            {...sharedProps}
            caretAt={enlargeCarets[fieldName]}
            rightSectionWidth={ONE_ACTION_WIDTH}
            rightSection={clearButton}
          />
        );
      }

      const enlarge = () =>
        setEnlargedFields((previous) => new Set([...previous, fieldName]));

      // Enter both enlarges the field and enters the newline that was asked
      // for. Enlarging alone would consume the keystroke and leave the caret
      // where it was, so the next thing typed runs on from the last word — the
      // user pressed the key that means "new line" and got a reshaped box.
      //
      // The newline goes in at the field's own selection, exactly as it would
      // in a text area: split at the caret, and replace a selected range rather
      // than keeping it. Appending at the end instead would silently rewrite
      // the value whenever the caret was not already there — pressing Enter in
      // the middle of `abc|def` would produce `abcdef` with a trailing blank
      // line, which is not what any editor does and not what was asked for.
      //
      // A field with no room left for the newline is enlarged without one,
      // since the alternative is breaching a maxLength the schema states.
      const enlargeWithNewline = (input: HTMLInputElement) => {
        // The control's own value, not the form's. Two reasons, and the second
        // is the one that bites: it is the exact string the selection offsets
        // below index into, and it is always a string. `values` is a
        // `Record<string, unknown>` fed by whatever a server's schema declares,
        // so a non-string default on a string field (`default: 123`) arrives
        // here as a number — it renders as text, and would then throw on
        // `.slice`, turning a keystroke into a crashed panel.
        const current = input.value;
        // A control that cannot report a selection (`selectionStart` is null
        // for some input types) is treated as a caret at the end.
        const start = input.selectionStart ?? current.length;
        const end = input.selectionEnd ?? start;
        const next = `${current.slice(0, start)}\n${current.slice(end)}`;
        const fits =
          fieldSchema.maxLength === undefined ||
          next.length <= fieldSchema.maxLength;
        if (fits) handleFieldChange(fieldName, next);
        // The caret is recorded either way. The keyboard route always has a
        // real position, so dropping it when the newline does not fit would
        // send the caret to the end of a field the user was editing the middle
        // of — a second surprise on top of the newline they did not get.
        setEnlargeCarets((previous) => ({
          ...previous,
          [fieldName]: fits ? start + 1 : start,
        }));
        enlarge();
      };

      // The keyboard's way into multiline mode, now that the enlarge button is
      // out of the tab order (#2138). Enter is inert in this field — nothing
      // renders SchemaForm inside a `<form>`, so there is no implicit
      // submission to displace — and it is the very key a user presses trying
      // to enter the newline a single-line input swallows, which is what #2042
      // exists to fix. So the gesture that fails is the one that enlarges,
      // rather than a shortcut nobody would guess.
      //
      // Every condition below is load-bearing; none is incidental:
      //
      // - Shift+Enter is the other newline gesture, so it enlarges too.
      // - `isComposing` is the IME guard. Enter is also how a Japanese, Chinese
      //   or Korean input method commits the candidate being composed, and that
      //   keystroke means "accept this word", not "new line". Acting on it
      //   would enlarge the field and insert a stray newline every time such a
      //   user finished a word, making the field unusable for them.
      // - `keyCode === 229` is the same guard again, for WebKit. It is reported
      //   to fire `compositionend` *before* the committing keydown, which
      //   leaves `isComposing` already false by the time this runs; 229 is the
      //   pre-`isComposing` sentinel for "this key went to the IME" and is
      //   still set there. Kept despite `keyCode` being deprecated because
      //   nothing non-deprecated distinguishes that event, and it cannot misfire
      //   on a real Enter, which reports 13.
      // - The Ctrl/Cmd/Alt chords are deliberately left alone: those read as
      //   "submit" in a form, and a consumer binding one (run the tool) must
      //   not be overridden into enlarging a field instead.
      const handleEnlargeKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
        if (
          event.key !== "Enter" ||
          event.nativeEvent.isComposing ||
          event.keyCode === IME_KEY_CODE ||
          event.ctrlKey ||
          event.metaKey ||
          event.altKey
        ) {
          return;
        }
        event.preventDefault();
        enlargeWithNewline(event.currentTarget);
      };

      return (
        <TextInput
          key={fieldName}
          {...sharedProps}
          rightSectionPointerEvents="auto"
          rightSectionWidth={clearButton ? TWO_ACTION_WIDTH : ONE_ACTION_WIDTH}
          onKeyDown={handleEnlargeKeyDown}
          // Announces that the field carries a shortcut at all. A keyboard user
          // no longer meets the button by tabbing, so without this the binding
          // is undiscoverable rather than merely unlabelled.
          aria-keyshortcuts="Enter"
          rightSection={
            <FieldActions>
              <EnlargeButton
                ariaLabel={`Enlarge ${label}`}
                disabled={disabled}
                onClick={enlarge}
              />
              {clearButton}
            </FieldActions>
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
          fieldName={fieldName}
          label={label}
          description={description}
          withAsterisk={isRequired}
          disabled={disabled}
          // Raw and default kept apart, not pre-resolved (#2026). Both admit
          // `null`, which a nullable number schema really produces.
          value={values[fieldName] as number | null | undefined}
          defaultValue={
            getDefaultValue(fieldSchema) as number | null | undefined
          }
          min={fieldSchema.minimum}
          max={fieldSchema.maximum}
          // An `integer` field rejects the decimal point outright rather than
          // accepting a value the schema forbids.
          allowDecimal={fieldSchema.type === "number"}
          onChange={(val) => handleFieldChange(fieldName, val)}
          onValidityChange={reportFieldValidity}
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

    // array of enum values (multi-select). Gated on the members being strings
    // for the same reason `toConstOptions` is: `MultiSelect` is string-valued,
    // so `items: { enum: [1, 2] }` would submit `["1"]` where the schema says
    // `[1]`. Reachable from a nullable array since the collapse landed, which
    // is what makes the guard load-bearing rather than theoretical.
    const itemsEnum = fieldSchema.items?.enum;
    if (fieldSchema.type === "array" && isStringEnum(itemsEnum)) {
      const data = toEnumData(itemsEnum, fieldSchema.items?.enumNames);
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
              // A nested form's invalid draft is the outer form's invalid draft,
              // so it reports through the same channel under this field's name.
              onValidityChange={(nestedInvalid) =>
                reportFieldValidity(fieldName, !nestedInvalid)
              }
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
        fieldName={fieldName}
        label={label}
        description={description}
        withAsterisk={isRequired}
        disabled={disabled}
        // Raw and default kept apart, not pre-resolved (#2026).
        value={values[fieldName]}
        defaultValue={getDefaultValue(fieldSchema)}
        onChange={(val) => handleFieldChange(fieldName, val)}
        onValidityChange={reportFieldValidity}
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
