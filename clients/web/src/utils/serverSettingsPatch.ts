import type { InspectorServerSettings } from "@inspector/core/mcp/types.js";
import type { ServerConfigModalMode } from "../components/groups/ServerConfigModal/ServerConfigModal";
import type { KeyValuePair } from "../components/elements/KeyValueRows/KeyValueRows";

/**
 * Decide what `settings` node ServerConfigModal's submit should send for the
 * custom headers it just collected (#1915).
 *
 * Two rules, both load-bearing:
 *
 * 1. **Only an edit carries the target's other settings forward.** The
 *    backend replaces the whole node when one is sent, so an edit must
 *    re-send the fields the modal doesn't expose (metadata, timeouts, OAuth
 *    credentials, roots) or they'd be dropped. An **add or clone must not**:
 *    the modal's target in clone mode is the *source* server, so spreading it
 *    would copy that server's OAuth client secret and behavior flags onto a
 *    new entry the user only gave a URL and some headers.
 * 2. **`undefined` means "don't send the key at all", and that is the
 *    default.** Omitting `settings` makes the backend preserve the node it
 *    already has, which matters beyond convenience: what this modal holds is
 *    a snapshot taken when it opened, so writing it back on a save that did
 *    not touch a header would overwrite a metadata or OAuth change made in
 *    the settings form in the meantime. So the patch is sent only when the
 *    submitted headers actually differ from the stored ones — including the
 *    case where the last one was cleared, which does need the node rewritten.
 *
 * Lives here rather than inline in App.tsx so this seam is unit-testable:
 * App.tsx is outside the coverage gate, and the edit-vs-clone distinction is
 * exactly where credentials leaked before.
 *
 * @param emptySettings the app's blank settings shape, used as the base for an
 *   add or clone.
 */
export function buildHeaderSettingsPatch(
  mode: ServerConfigModalMode,
  existingSettings: InspectorServerSettings | undefined,
  headers: KeyValuePair[],
  emptySettings: InspectorServerSettings,
): InspectorServerSettings | undefined {
  const existing = mode === "edit" ? existingSettings : undefined;
  if (sameHeaders(existing?.headers ?? [], headers)) return undefined;
  return { ...(existing ?? emptySettings), headers };
}

/**
 * Order-sensitive pair-list equality. Order matters because it is what the
 * form round-trips and what the user sees, so a reorder is a real edit.
 */
function sameHeaders(a: KeyValuePair[], b: KeyValuePair[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((h, i) => h.key === b[i]?.key && h.value === b[i]?.value);
}
