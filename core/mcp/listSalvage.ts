/**
 * Per-item salvage for paginated list results (#1909).
 *
 * The SDK validates a list result as a whole: one non-conforming element
 * rejects the entire response, so a server with a single malformed entry
 * appears to have NO tools/resources/templates/prompts at all. That is exactly
 * backwards for a debugging tool — the one thing the user needs to see is which
 * entry is wrong and why, and the other entries are still perfectly usable.
 *
 * A real report: a PHP server whose empty `annotations` object reaches the wire
 * as `[]` (`json_encode` of an empty array, or of `(array) new stdClass()`)
 * instead of `{}` made every resource template vanish behind "Couldn't load
 * resources" (#1909).
 *
 * The strict path is left alone. `InspectorClient.listAll*` still calls the
 * SDK's cache-aware aggregate first, and only falls back to a lenient re-walk
 * when that rejects a result it received — so a conforming server pays nothing,
 * and the fallback is a pure recovery path.
 *
 * Salvaging does NOT mean accepting: a salvaged entry is dropped from the list
 * and reported as {@link MalformedListItem}, and the Protocol entry is still
 * marked rejected. The Inspector keeps telling the truth about the response; it
 * just stops throwing away the valid part of it.
 */

import { z } from "zod/v4";
import { SdkError, SdkErrorCode } from "@modelcontextprotocol/client";

/**
 * One entry the Inspector dropped from a list result because it failed the
 * spec's schema for that primitive.
 */
export interface MalformedListItem {
  /** The list method that carried it, e.g. `"resources/templates/list"`. */
  method: string;
  /**
   * Zero-based position in the aggregated list. An entry too broken to carry a
   * name is still identifiable by where it sat in the response.
   */
  index: number;
  /** Best-effort label read off the raw entry, when it has a usable one. */
  label?: string;
  /** Why it was rejected — the first validation issue, with its field path. */
  reason: string;
}

/**
 * Whether a failed fetch is the CLIENT refusing a response it received, rather
 * than the request never producing one.
 *
 * This gates both `markResponseRejected` (#1953) and the salvage fallback
 * (#1909), and the distinction is load-bearing for each. For the Protocol-entry
 * marking: the correlation recovers the request id as "the last response
 * received for this method", which is only the failing exchange when a response
 * actually just arrived and was refused while decoding. A transport drop, a
 * timeout, or an aborted request produces no response frame at all — the
 * last-answered id then still points at some EARLIER, successful call, and
 * marking it would stamp "Rejected by the Inspector" onto an exchange that
 * succeeded. For the salvage fallback: re-walking the list only makes sense
 * when there IS a result to salvage; re-issuing the request after a timeout
 * would just double the wait before failing anyway.
 *
 * A server-sent JSON-RPC error is excluded for a different reason: it is a real
 * response, so the id would be right, but the failure is the server's. Its
 * entry already renders as an error from the error frame itself, and blaming
 * the Inspector for it would misattribute the cause.
 *
 * `SdkErrorCode.InvalidResult` is exactly "a result arrived and failed
 * validation for the negotiated era"; `UnsupportedResultType` is its sibling
 * for a `resultType` the codec has no handling for. Both are decisions the
 * client made about a frame in hand.
 */
export function isClientDecodeRejection(err: unknown): boolean {
  return (
    SdkError.isInstance(err) &&
    (err.code === SdkErrorCode.InvalidResult ||
      err.code === SdkErrorCode.UnsupportedResultType)
  );
}

/**
 * A list page parsed with everything except pagination left unvalidated.
 *
 * `looseObject` keeps the unknown keys, so the primitive array (`tools`,
 * `resources`, `resourceTemplates`, `prompts`) survives as `unknown` for
 * per-item validation. Only `nextCursor` is typed, because the walk itself
 * depends on it — if THAT is malformed the page is unusable and the strict
 * error should stand.
 */
export const LenientListPageSchema = z.looseObject({
  nextCursor: z.string().optional(),
});

export type LenientListPage = z.infer<typeof LenientListPageSchema>;

/**
 * Read the primitive array out of a leniently-parsed page.
 *
 * Returns `undefined` — NOT an empty array — when the member is missing or is
 * not an array, because those are different facts. An empty page is a normal
 * server answer; a page whose `tools` is the string `"invalid"` is a top-level
 * schema violation this fallback cannot explain, and reading it as "no entries"
 * would let the caller return a silently truncated list while the strict error
 * that was correct about it is discarded.
 */
export function rawItemsOf(
  page: LenientListPage,
  itemsKey: string,
): unknown[] | undefined {
  const value = (page as Record<string, unknown>)[itemsKey];
  return Array.isArray(value) ? value : undefined;
}

/**
 * Best-effort human label for a raw entry: whichever identifying string field
 * it happens to carry. Undefined when the entry is too broken to have one (a
 * bare string, a number, a null) — the caller falls back to the index.
 */
export function labelForRawItem(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["name", "uriTemplate", "uri", "title"]) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  return undefined;
}

/**
 * One-line summary of why an entry failed: the first issue, prefixed with its
 * field path so `annotations` is named rather than left for the reader to find
 * in a wall of JSON. The path is relative to the entry, not the response, since
 * the entry is what we're reporting on.
 */
export function describeIssues(error: z.ZodError): string {
  const [issue] = error.issues;
  /* v8 ignore next -- zod never produces a failed parse with zero issues; guards against an empty message if it ever did */
  if (!issue) return "did not match the expected shape";
  const path = issue.path.join(".");
  const detail = expectedDetail(issue);
  const message = detail ? `${issue.message} (${detail})` : issue.message;
  return path.length > 0 ? `${path}: ${message}` : message;
}

/**
 * `expected object` — appended because the issue's own message cannot be relied
 * on to carry it. zod's browser build reports a bare "Invalid input" where Node
 * says "Invalid input: expected object, received array", and the expected type
 * is the whole diagnostic: without it the warning says something is wrong but
 * not what would be right. Skipped when the message already spells it out, so
 * the Node text doesn't end up saying it twice.
 */
function expectedDetail(issue: z.core.$ZodIssue): string | undefined {
  if (!("expected" in issue) || typeof issue.expected !== "string") {
    return undefined;
  }
  const detail = `expected ${issue.expected}`;
  return issue.message.includes(detail) ? undefined : detail;
}

/**
 * Validate a page's entries one at a time, keeping the ones that pass.
 *
 * `startIndex` is the running count across pages, so an index in the report
 * refers to the aggregated list the user sees rather than resetting per page.
 */
export function salvageListItems<T>({
  method,
  items,
  schema,
  startIndex = 0,
}: {
  method: string;
  items: unknown[];
  schema: z.ZodType<T>;
  startIndex?: number;
}): { valid: T[]; malformed: MalformedListItem[] } {
  const valid: T[] = [];
  const malformed: MalformedListItem[] = [];
  items.forEach((item, offset) => {
    const parsed = schema.safeParse(item);
    if (parsed.success) {
      valid.push(parsed.data);
      return;
    }
    const label = labelForRawItem(item);
    malformed.push({
      method,
      index: startIndex + offset,
      ...(label !== undefined && { label }),
      reason: describeIssues(parsed.error),
    });
  });
  return { valid, malformed };
}

/**
 * Summary line used for the Protocol entry's rejection reason, so the Network /
 * Protocol view still says the response was non-conforming even though the list
 * rendered (#1953 + #1909).
 */
export function summarizeMalformed(malformed: MalformedListItem[]): string {
  const [first] = malformed;
  /* v8 ignore next -- callers only summarize a non-empty set */
  if (!first) return "";
  const where = first.label ?? `index ${first.index}`;
  const rest = malformed.length > 1 ? ` (+${malformed.length - 1} more)` : "";
  return `Dropped ${malformed.length} malformed ${
    malformed.length === 1 ? "entry" : "entries"
  } — ${where}: ${first.reason}${rest}`;
}
