import { useCallback, useRef, useSyncExternalStore } from "react";

/**
 * The slice of a state store `useStoreSnapshot` needs, declared structurally
 * rather than as a concrete class so every list/log hook can share it without
 * threading its item type through. `TypedEventTarget` satisfies it, and the
 * `E` parameter is what makes a mistyped event name a compile error: the
 * concrete stores declare `getEventRevision(type: keyof EventMap & string)`,
 * so a store is assignable to `SnapshotStore<"toolsChange">` only when that
 * name is really in its event map.
 */
export interface SnapshotStore<E extends string> {
  getEventRevision(type: E): number;
  addEventListener(type: E, listener: (event: Event) => void): void;
  removeEventListener(type: E, listener: (event: Event) => void): void;
}

/**
 * Subscribe to one event on one state store and read a value from it (#1955).
 *
 * This replaces the `useState(read(prop)) + useEffect(re-read; subscribe)`
 * shape every list/log hook in this directory used to carry. That shape has
 * two defects, both invisible in the common case and both fixed here:
 *
 * 1. **A stale frame when the store prop changes.** Switching servers hands
 *    the hook a different store, but the effect that re-reads it runs *after*
 *    the render commits — so React paints one frame of the previous server's
 *    tools, then corrects itself. `useSyncExternalStore` reads during render,
 *    so the swap lands in the same frame.
 * 2. **A missed update between render and subscribe.** An event dispatched in
 *    that gap was lost, because the snapshot was taken before the listener
 *    was attached. React re-checks the snapshot immediately after subscribing,
 *    which closes the window — provided the snapshot is read from the live
 *    store rather than from something the (not-yet-attached) listener would
 *    have had to invalidate. That is why the cache below keys off the store's
 *    own dispatch counter and not off a dirty flag set by our listener.
 *
 * It is the same reasoning `useListError` documents; that hook needs no cache
 * because its snapshot is the stored `Error` instance itself.
 *
 * ## Why a revision counter
 *
 * `useSyncExternalStore` requires `getSnapshot` to return a referentially
 * stable value across reads that mean "no change" — otherwise every read looks
 * like a new value and React re-renders forever. These stores return a
 * defensive copy (`getTools()` is `[...this.items]`), so the raw getter cannot
 * be used directly. Caching against `getEventRevision(event)` gives an O(1)
 * check that is exact in both directions: unchanged revision returns the
 * identical value, and any dispatch produces a fresh one — including a
 * dispatch that mutated an entry *inside* the list, which a contents
 * comparison could not detect (see `TypedEventTarget.getEventRevision`).
 *
 * ## Caller contract
 *
 * `read` and `whenAbsent` should be module-scope constants, not values built
 * in the component body. They are `getSnapshot` dependencies, so a fresh
 * closure or a fresh `[]` literal per render makes React re-run its
 * snapshot check every render. It stays *correct* if they aren't — the cache
 * is keyed on the store and its revision, not on these — but there is no
 * reason to pay for it.
 *
 * @param store       the state store, or `null` when no server is active
 * @param event       the store event that signals this value changed
 * @param read        reads the value out of a non-null store
 * @param whenAbsent  the value to report while `store` is `null`
 */
export function useStoreSnapshot<
  E extends string,
  S extends SnapshotStore<E>,
  V,
>(store: S | null, event: E, read: (store: S) => V, whenAbsent: V): V {
  // One cache cell per hook instance. Written from `getSnapshot`, which React
  // calls during render — that is the documented shape for a cached
  // `getSnapshot`, and it is safe here because the cell is a pure memo of
  // (store, revision) that any render can recompute identically.
  const cache = useRef<{
    store: S | null;
    revision: number;
    value: V;
  } | null>(null);

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (!store) return () => {};
      store.addEventListener(event, onStoreChange);
      return () => {
        store.removeEventListener(event, onStoreChange);
      };
    },
    [store, event],
  );

  const getSnapshot = useCallback((): V => {
    // Read the revision from the live store on every call, so an event that
    // arrived while nothing was listening is still visible here.
    const revision = store ? store.getEventRevision(event) : 0;
    const cached = cache.current;
    if (
      cached &&
      Object.is(cached.store, store) &&
      cached.revision === revision
    ) {
      return cached.value;
    }
    const value = store ? read(store) : whenAbsent;
    cache.current = { store, revision, value };
    return value;
  }, [store, event, read, whenAbsent]);

  // Server snapshot: the same read. These stores are browser/Node runtime
  // objects with no SSR path, and passing the same getter keeps hydration
  // consistent rather than throwing on a server render.
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
