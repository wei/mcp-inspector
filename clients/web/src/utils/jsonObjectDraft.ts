import type { StrictJsonObject } from "@inspector/core/json/jsonUtils.js";
import { isSerializableJson } from "@inspector/core/json/jsonUtils.js";

/**
 * What a JSON-object editor's draft text currently means: the object to emit,
 * or why it cannot be emitted.
 */
export type JsonObjectDraft =
  | { ok: true; value: StrictJsonObject }
  | { ok: false; error: string };

/**
 * A plain JSON object, i.e. not an array and not a scalar.
 *
 * The `StrictJsonObject` narrowing is sound because the only caller parses with
 * `JSON.parse`, whose output cannot contain `undefined` — the value that
 * separates the strict type from `JsonValue`.
 */
export function isJsonObject(value: unknown): value is StrictJsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Whether `JSON.parse` dropped digits from a whole number written out in full.
 *
 * `isSerializableJson` catches a literal too large to *represent* — `1e400`
 * parses to `Infinity` and writes back as `null`. This catches the quieter one:
 * a whole number past 2^53−1 parses to the nearest double, so
 * `{"id":9007199254740993}` becomes `…992` with no error anywhere. The draft
 * still shows what was typed, which is what makes it a misreport rather than a
 * formatting difference — the editor displays one value and the wire carries
 * another. Snowflake-style ids are the realistic case.
 *
 * Two conditions, and the second is what keeps this from over-reaching:
 *
 * - **An unsafe whole number.** A fractional value is a double by nature and is
 *   sent as the double it parsed to, so nothing is lost between typing and
 *   sending.
 * - **Whose shortest representation is written out in full.** JS switches to
 *   exponent form at 1e21, so a value that stringifies as `1e+308` was typed in
 *   exponent form, where the parsed double *is* the value the user asked for.
 *   Without this, `{"n":1e308}` — a legitimate `_meta` value — would be
 *   refused, which `parseJsonObjectDraft`'s own tests pin against.
 *
 * It still refuses the rare full-form integer past 2^53−1 that happens to be
 * exactly representable (2^54, say), because nothing here can tell it apart
 * from one that lost digits without the original literal. That errs toward
 * refusing a sendable value rather than misreporting an unsendable one, which
 * is the same trade `toNumericValue` makes for the schema form's number input.
 */
export function hasRoundedInteger(value: unknown): boolean {
  if (typeof value === "number") {
    return (
      Number.isInteger(value) &&
      !Number.isSafeInteger(value) &&
      !String(value).includes("e")
    );
  }
  if (Array.isArray(value)) return value.some(hasRoundedInteger);
  if (value !== null && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some(
      hasRoundedInteger,
    );
  }
  return false;
}

/** The message every draft parser uses for {@link hasRoundedInteger}. */
export const ROUNDED_INTEGER_ERROR =
  "Whole numbers must be within ±(2^53 − 1) — a longer one is rounded when parsed, so a different value would be sent";

/**
 * Read a JSON-object editor's draft text.
 *
 * Empty text is the object `{}` rather than an error — clearing the box is how
 * "send nothing" is spelled, and an empty editor wearing a red error would read
 * as broken.
 *
 * The two failure modes are reported separately because they are different
 * mistakes: text that is not JSON at all is usually mid-edit, while text that
 * is valid JSON but not an object (`[1,2]`, `"a"`, `42`) is a shape the caller
 * cannot use no matter how finished it is.
 *
 * Lives in `utils` rather than beside its component because it is a pure
 * transform — and because exporting it from the component's module trips
 * `react-refresh/only-export-components`.
 */
export function parseJsonObjectDraft(text: string): JsonObjectDraft {
  if (text.trim() === "") return { ok: true, value: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: "Not valid JSON — changes are not applied" };
  }
  if (!isJsonObject(parsed)) {
    return {
      ok: false,
      error: "Must be a JSON object (`{ … }`) — changes are not applied",
    };
  }
  // `JSON.parse` accepts numeric literals it cannot represent: `1e400` parses
  // to `Infinity`, which `JSON.stringify` then writes as `null`. Accepting it
  // here would show the user one value and send another.
  if (!isSerializableJson(parsed)) {
    return {
      ok: false,
      error:
        "Numbers must be finite — a value like `1e400` overflows and would be sent as null",
    };
  }
  if (hasRoundedInteger(parsed)) {
    return { ok: false, error: ROUNDED_INTEGER_ERROR };
  }
  return { ok: true, value: parsed };
}
