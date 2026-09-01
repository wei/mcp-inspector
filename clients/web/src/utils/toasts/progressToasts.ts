import type { Progress, ProgressToken } from "@modelcontextprotocol/client";

// How long a progress toast lingers after its last tick. Each new tick on the
// same progress stream resets this window (via `notifications.update`), so a
// steady stream keeps one toast alive; the toast clears a few seconds after
// progress stops (i.e. the call finished or went quiet).
export const PROGRESS_TOAST_AUTOCLOSE_MS = 5000;

// Stable toast id for a progress stream. Notifications keyed by this id are
// replaced (not stacked) so a chatty server updates one toast per stream
// rather than flooding the corner. The injected `progressToken` correlates a
// stream with the request that triggered it; when absent (the common case —
// the inspector doesn't expose a caller token), all ticks share one toast.
export function progressToastId(token: ProgressToken | undefined): string {
  return `progress-${String(token ?? "default")}`;
}

// One-line toast body: "<message> — <progress> / <total> (NN%)". The fraction
// and percentage are omitted when the server sends no `total`.
export function formatProgressToastMessage(
  detail: Progress & { progressToken?: ProgressToken },
): string {
  const { progress, total, message } = detail;
  const ratio =
    total !== undefined && total > 0
      ? `${progress} / ${total} (${Math.round((progress / total) * 100)}%)`
      : `${progress}`;
  return message ? `${message} — ${ratio}` : ratio;
}
