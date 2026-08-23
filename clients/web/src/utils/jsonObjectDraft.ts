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
  return { ok: true, value: parsed };
}
