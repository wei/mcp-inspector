import { useCallback, useSyncExternalStore } from "react";
import type { ManagedListEventMap } from "../mcp/state/managedListState.js";
import type { TypedEventGeneric } from "../mcp/typedEventTarget.js";

/**
 * The slice of a managed list state this hook needs. Declared structurally
 * rather than as `ManagedListState<T, M>` so the four list hooks can share it
 * without threading their item type through — the error is the same shape for
 * all of them.
 */
export interface ManagedListErrorSource {
  getError(): Error | null;
  addEventListener(
    type: "errorChange",
    listener: (
      event: TypedEventGeneric<ManagedListEventMap, "errorChange">,
    ) => void,
  ): void;
  removeEventListener(
    type: "errorChange",
    listener: (
      event: TypedEventGeneric<ManagedListEventMap, "errorChange">,
    ) => void,
  ): void;
}

/**
 * Subscribe to a managed list state's last-fetch error (#1953).
 *
 * Shared by the four `useManaged*` hooks so a list load that fails — including
 * the connect-time one, which has no caller to await it — reaches the UI
 * instead of only the console. `null` means the last fetch succeeded.
 *
 * Built on `useSyncExternalStore` rather than the `useState` + `useEffect`
 * subscribe pattern the sibling hooks use. Re-syncing state from the `state`
 * prop inside an effect would render one frame carrying the PREVIOUS store's
 * error after `state` changes (switching servers) before the effect corrects
 * it — the "don't derive state from props in an effect" rule in AGENTS.md.
 * `useSyncExternalStore` has no such window: the snapshot is read during
 * render, so a store swap is reflected in the same frame, and it also closes
 * the gap where an error recorded between render and subscribe would be missed.
 *
 * The snapshot must be referentially stable across reads that mean "no change",
 * which it is: it returns the stored `Error` instance itself (or `null`), never
 * a fresh object.
 */
export function useManagedListError(
  state: ManagedListErrorSource | null,
): Error | null {
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (!state) return () => {};
      const listener = () => onStoreChange();
      state.addEventListener("errorChange", listener);
      return () => {
        state.removeEventListener("errorChange", listener);
      };
    },
    [state],
  );

  const getSnapshot = useCallback(() => state?.getError() ?? null, [state]);

  // Server snapshot: same read. The stores are browser/Node runtime objects
  // with no SSR path, and passing the same getter keeps hydration consistent
  // rather than throwing on a server render.
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
