import { describe, it, expect, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { TypedEventTarget } from "@inspector/core/mcp/typedEventTarget";
import { useStoreSnapshot } from "@inspector/core/react/useStoreSnapshot";

interface Item {
  label: string;
  seen?: boolean;
}

interface FakeStoreEventMap {
  itemsChange: Item[];
  otherChange: number;
}

/**
 * A minimal stand-in for the real state stores, reproducing the two properties
 * that make them awkward to read from `useSyncExternalStore`: the getter hands
 * back a fresh defensive copy on every call, and the list is mutated in place
 * (both by appending and, in `markSeen`, by mutating an entry the list already
 * holds — the shape `MessageLogState` uses when it folds a response into its
 * request entry).
 */
class FakeStore extends TypedEventTarget<FakeStoreEventMap> {
  private items: Item[] = [];

  getItems(): Item[] {
    return [...this.items];
  }

  add(label: string): void {
    this.items.push({ label });
    this.dispatchTypedEvent("itemsChange", this.getItems());
  }

  /** Mutate an existing entry in place, then announce it. */
  markSeen(label: string): void {
    const entry = this.items.find((i) => i.label === label);
    if (entry) entry.seen = true;
    this.dispatchTypedEvent("itemsChange", this.getItems());
  }

  /** A dispatch on a different event, to prove per-event isolation. */
  bumpOther(): void {
    this.dispatchTypedEvent("otherChange", 1);
  }
}

const NO_ITEMS: Item[] = [];
const readItems = (store: FakeStore): Item[] => store.getItems();

/**
 * The shared subscription primitive behind every list/log hook in
 * `core/react` (#1955). Its job is to read a store during render — closing
 * both the stale-frame-on-store-swap and the missed-update windows the old
 * `useState` + `useEffect` shape carried — while still handing
 * `useSyncExternalStore` a referentially stable snapshot.
 */
describe("useStoreSnapshot", () => {
  let store: FakeStore;

  beforeEach(() => {
    store = new FakeStore();
  });

  it("reports the fallback when there is no store", () => {
    const { result } = renderHook(() =>
      useStoreSnapshot(null, "itemsChange", readItems, NO_ITEMS),
    );
    expect(result.current).toBe(NO_ITEMS);
  });

  it("reads the store's current value on the first render", () => {
    store.add("a");
    const { result } = renderHook(() =>
      useStoreSnapshot(store, "itemsChange", readItems, NO_ITEMS),
    );
    expect(result.current).toEqual([{ label: "a" }]);
  });

  it("updates when the store dispatches its event", () => {
    const { result } = renderHook(() =>
      useStoreSnapshot(store, "itemsChange", readItems, NO_ITEMS),
    );
    expect(result.current).toEqual([]);

    act(() => store.add("a"));
    expect(result.current).toEqual([{ label: "a" }]);
  });

  it("returns the identical value across renders with no dispatch", () => {
    store.add("a");
    const { result, rerender } = renderHook(() =>
      useStoreSnapshot(store, "itemsChange", readItems, NO_ITEMS),
    );
    const first = result.current;

    rerender();
    rerender();

    // Identity, not equality: a fresh array per read is what makes
    // `useSyncExternalStore` loop, and what defeats every downstream memo.
    expect(result.current).toBe(first);
  });

  it("reflects a store swap in the same render, with no stale frame", () => {
    const next = new FakeStore();
    store.add("from-first");
    next.add("from-second");

    // Every render's value, captured during render rather than after commit —
    // the whole point is that no committed frame ever carries the previous
    // store's data.
    const rendered: Item[][] = [];
    const { rerender } = renderHook(
      ({ s }: { s: FakeStore }) => {
        const value = useStoreSnapshot(s, "itemsChange", readItems, NO_ITEMS);
        rendered.push(value);
        return value;
      },
      { initialProps: { s: store } },
    );
    expect(rendered.at(-1)).toEqual([{ label: "from-first" }]);

    const rendersBeforeSwap = rendered.length;
    rerender({ s: next });

    // Not one render after the swap carried the old store's list.
    expect(rendered.slice(rendersBeforeSwap)).not.toContainEqual([
      { label: "from-first" },
    ]);
    expect(rendered.at(-1)).toEqual([{ label: "from-second" }]);
  });

  it("picks up a change dispatched between the render and the subscribe", () => {
    // The second defect the conversion fixes: the old shape took its snapshot
    // during render and attached its listener in an effect, so anything the
    // store did in between was lost. Reproduce that window exactly, by having
    // the store change on its way into `addEventListener`.
    const racing = new FakeStore();
    const realAdd = racing.addEventListener.bind(racing);
    racing.addEventListener = ((
      type: "itemsChange",
      listener: (event: Event) => void,
    ) => {
      racing.add("slipped-in");
      realAdd(type, listener);
    }) as FakeStore["addEventListener"];

    const { result } = renderHook(() =>
      useStoreSnapshot(racing, "itemsChange", readItems, NO_ITEMS),
    );

    expect(result.current).toEqual([{ label: "slipped-in" }]);
  });

  it("re-reads when a dispatch mutated an entry the list already held", () => {
    // The `MessageLogState` fold: same entries, same length, same references —
    // only a field inside one of them changed. Caching against the dispatch
    // count rather than the contents is what keeps this visible.
    store.add("a");
    const { result } = renderHook(() =>
      useStoreSnapshot(store, "itemsChange", readItems, NO_ITEMS),
    );
    const before = result.current;

    act(() => store.markSeen("a"));

    expect(result.current).not.toBe(before);
    expect(result.current).toEqual([{ label: "a", seen: true }]);
  });

  it("ignores a dispatch of a different event on the same store", () => {
    store.add("a");
    const { result, rerender } = renderHook(() =>
      useStoreSnapshot(store, "itemsChange", readItems, NO_ITEMS),
    );
    const before = result.current;

    act(() => store.bumpOther());
    rerender();

    expect(result.current).toBe(before);
  });

  it("falls back when the store is taken away", () => {
    store.add("a");
    const { result, rerender } = renderHook(
      ({ s }: { s: FakeStore | null }) =>
        useStoreSnapshot(s, "itemsChange", readItems, NO_ITEMS),
      { initialProps: { s: store as FakeStore | null } },
    );
    expect(result.current).toEqual([{ label: "a" }]);

    rerender({ s: null });
    expect(result.current).toBe(NO_ITEMS);
  });

  it("stops listening on unmount", () => {
    const { result, unmount } = renderHook(() =>
      useStoreSnapshot(store, "itemsChange", readItems, NO_ITEMS),
    );
    const before = result.current;
    unmount();

    // No act(): after unmount there is nothing to re-render, and a listener
    // still attached here would be a leak rather than an update.
    store.add("a");
    expect(result.current).toBe(before);
  });

  it("unmounts cleanly with no store to unsubscribe from", () => {
    const { unmount } = renderHook(() =>
      useStoreSnapshot(null, "itemsChange", readItems, NO_ITEMS),
    );
    expect(() => unmount()).not.toThrow();
  });
});
