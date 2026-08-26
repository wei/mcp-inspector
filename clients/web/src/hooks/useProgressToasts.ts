import { useEffect, useRef } from "react";
import { notifications } from "@mantine/notifications";
import type {
  InspectorClient,
  InspectorClientEventMap,
} from "@inspector/core/mcp/index.js";
import type { TypedEventGeneric } from "@inspector/core/mcp/typedEventTarget.js";
import {
  formatProgressToastMessage,
  PROGRESS_TOAST_AUTOCLOSE_MS,
  progressToastId,
} from "../utils/toasts/progressToasts";

/**
 * Surface incoming `notifications/progress` as toasts so the user can watch a
 * long-running tool's progress while staying on the tool view — the v2
 * replacement for v1's always-visible "Server Notifications" shelf (#1414).
 *
 * The full notification history still lives in the Protocol tab; these toasts
 * are the at-a-glance, in-context signal. Toasts are keyed by progress stream
 * (see `progressToastId`) and replaced per tick, so a chatty server updates one
 * toast rather than stacking one per tick.
 */
export function useProgressToasts(inspectorClient: InspectorClient | null) {
  // Which progress streams currently have a live toast. Entries are removed
  // when their toast closes (auto-dismiss or user). A ref (not state) because
  // it is incidental bookkeeping that must not trigger re-renders.
  const progressToastIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!inspectorClient) return;
    const liveToastIds = progressToastIdsRef.current;
    const onProgress = (
      event: TypedEventGeneric<InspectorClientEventMap, "progressNotification">,
    ) => {
      const detail = event.detail;
      const id = progressToastId(detail.progressToken);
      const message = formatProgressToastMessage(detail);
      if (liveToastIds.has(id)) {
        notifications.update({
          id,
          title: "Tool progress",
          message,
          color: "blue",
          autoClose: PROGRESS_TOAST_AUTOCLOSE_MS,
        });
        return;
      }
      liveToastIds.add(id);
      notifications.show({
        id,
        title: "Tool progress",
        message,
        color: "blue",
        autoClose: PROGRESS_TOAST_AUTOCLOSE_MS,
        onClose: () => liveToastIds.delete(id),
      });
    };
    inspectorClient.addEventListener("progressNotification", onProgress);
    return () => {
      inspectorClient.removeEventListener("progressNotification", onProgress);
      // Dismiss any still-visible progress toasts when the client is swapped
      // out, then drop the stream bookkeeping. Hiding them (rather than letting
      // them auto-close up to PROGRESS_TOAST_AUTOCLOSE_MS later) keeps a stale
      // "Tool progress" toast from lingering into the next session, and avoids
      // a race where the lingering toast's `onClose` would later delete an id
      // from the *new* session's set and trigger a duplicate-id re-show.
      liveToastIds.forEach((id) => notifications.hide(id));
      liveToastIds.clear();
    };
  }, [inspectorClient]);
}
