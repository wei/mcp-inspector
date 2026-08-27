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
 * Whether the draft text writes a whole number out in full that `JSON.parse`
 * cannot represent exactly.
 *
 * `isSerializableJson` catches a literal too large to represent at all —
 * `1e400` parses to `Infinity` and writes back as `null`. This catches the
 * quieter one: `{"id":9007199254740993}` parses to `…992`, and
 * `{"id":1000000000000000000001}` parses to `1e21` and is written back as
 * `1e+21`. Either way the editor shows digits the wire will not carry.
 * Snowflake-style ids are the realistic case.
 *
 * It reads the **source text**, which is the only place the answer exists: the
 * parsed number has already lost whatever it lost, so nothing about its value
 * distinguishes `1000000000000000000001` from `1e21`. An earlier attempt
 * inferred it from `String(value)` and was wrong in both directions — it
 * refused `2^54` (written in full and exactly representable) and accepted every
 * full-form literal at or above 1e21, where JS switches to exponent form.
 *
 * Only integer literals written out in full are checked. An exponent or a
 * fraction is a double by nature and is sent as the double it parsed to, so
 * nothing is lost between typing and sending — and `{"n":1e308}` stays
 * acceptable, which `parseJsonObjectDraft`'s own tests pin.
 */
export function hasImpreciseIntegerLiteral(text: string): boolean {
  for (const literal of jsonNumberLiterals(text)) {
    if (!/^-?\d+$/.test(literal)) continue;
    // BigInt on both sides, so the comparison is exact: `Number(literal)` is an
    // integer-valued double, and converting it back shows what survived.
    if (BigInt(literal) !== BigInt(Number(literal))) return true;
  }
  return false;
}

/** Matches one JSON number token, anchored where the scan currently stands. */
const JSON_NUMBER = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

/**
 * The numeric literals of a JSON document, in source order, skipping anything
 * inside a string.
 *
 * The string-skipping is the whole reason this is a scanner rather than a
 * regex over the text: `{"id":"9007199254740993"}` carries those digits as a
 * *string*, which is sent back exactly as written and must not be refused.
 * Object keys are strings too, so they are skipped by the same rule.
 */
function* jsonNumberLiterals(text: string): Generator<string> {
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === '"') {
      index = readStringToken(text, index).next;
      continue;
    }
    if (char === "-" || (char >= "0" && char <= "9")) {
      JSON_NUMBER.lastIndex = index;
      const match = JSON_NUMBER.exec(text);
      /* v8 ignore next -- the sticky pattern always matches from a digit or a
         `-`, which is the only way this branch is entered. */
      if (!match) break;
      yield match[0];
      index = JSON_NUMBER.lastIndex;
      continue;
    }
    index += 1;
  }
}

/**
 * Read one JSON string token starting at the opening quote.
 *
 * Returns where the token ends and its raw source, escapes intact — the caller
 * decodes only when it needs the *value*, which for a key it does: `"a"` and
 * `"\u0061"` name the same member, so comparing the raw forms would miss a
 * duplicate written the second way.
 *
 * Shared by both scanners here so the escape handling — a backslash consumes
 * the next character, including a closing quote — is written once.
 */
function readStringToken(
  text: string,
  start: number,
): { raw: string; next: number } {
  let index = start + 1;
  while (index < text.length) {
    const char = text[index];
    if (char === "\\") {
      index += 2;
      continue;
    }
    index += 1;
    if (char === '"') break;
  }
  return { raw: text.slice(start, index), next: index };
}

/**
 * The first object member name this document declares twice, or `null`.
 *
 * `JSON.parse` accepts duplicate names and keeps the last silently, so
 * `{"role":"user","role":"admin"}` becomes `{"role":"admin"}` — a document that
 * renders, and submits, as *less* than it says. In a read-only view that is the
 * Inspector hiding what the server sent; in a draft it is the editor showing
 * more than the wire will carry. Neither is acceptable, and nothing else here
 * detects it, because by the time `JSON.parse` returns the evidence is gone.
 *
 * Scoped per object, so `{"a":{"a":1}}` and `[{"a":1},{"a":2}]` are fine — the
 * repeat has to be within one set of braces.
 */
export function findDuplicateObjectKey(text: string): string | null {
  // One frame per open brace or bracket; `null` marks an array, whose members
  // are not named and so cannot collide.
  const stack: (Set<string> | null)[] = [];
  let expectKey = false;
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === '"') {
      const { raw, next } = readStringToken(text, index);
      const frame = stack[stack.length - 1];
      if (expectKey && frame) {
        let name: string;
        try {
          name = JSON.parse(raw) as string;
        } catch {
          // An unterminated string at the end of a half-typed draft. There is
          // no key here to compare, and the parse will report the real problem.
          return null;
        }
        if (frame.has(name)) return name;
        frame.add(name);
        expectKey = false;
      }
      index = next;
      continue;
    }
    if (char === "{") {
      stack.push(new Set());
      expectKey = true;
    } else if (char === "[") {
      stack.push(null);
      expectKey = false;
    } else if (char === "}" || char === "]") {
      stack.pop();
      expectKey = false;
    } else if (char === ",") {
      // Only an object's separator introduces a name; an array's does not.
      expectKey = stack[stack.length - 1] != null;
    }
    index += 1;
  }
  return null;
}

/** The message every draft parser uses for {@link findDuplicateObjectKey}. */
export function duplicateKeyError(key: string): string {
  return `\`${key}\` appears twice in the same object — JSON keeps only the last, so part of this would not be sent`;
}

/**
 * The message every draft parser uses for {@link hasImpreciseIntegerLiteral}.
 *
 * Phrased as "cannot be represented exactly" rather than naming the safe-integer
 * range, because the range is not the rule: a whole number past ±(2^53 − 1) that
 * *is* exactly representable — 2^54, say — round-trips and is accepted.
 */
export const IMPRECISE_INTEGER_ERROR =
  "This whole number cannot be represented exactly — it is rounded when parsed, so a different value would be sent";

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
  if (hasImpreciseIntegerLiteral(text)) {
    return { ok: false, error: IMPRECISE_INTEGER_ERROR };
  }
  const duplicate = findDuplicateObjectKey(text);
  if (duplicate !== null) {
    return { ok: false, error: duplicateKeyError(duplicate) };
  }
  return { ok: true, value: parsed };
}
