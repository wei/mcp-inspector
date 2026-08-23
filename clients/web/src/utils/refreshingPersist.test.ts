import { describe, it, expect, vi } from "vitest";
import { refreshingPersist } from "./refreshingPersist";

describe("refreshingPersist", () => {
  it("refreshes after the persist resolves, not before", async () => {
    // Ordering is the point: refreshing first would re-fetch the descriptor
    // that the pending write is about to invalidate, which is the stale read
    // this wrapper exists to prevent, one step earlier.
    const order: string[] = [];
    const persist = vi.fn(async () => {
      order.push("persist");
    });
    const refresh = vi.fn(() => {
      order.push("refresh");
    });

    await refreshingPersist(persist, refresh)();

    expect(order).toEqual(["persist", "refresh"]);
  });

  it("passes every argument through unchanged", async () => {
    // The server-settings caller is `(id, settings)`; the wrapper must be
    // transparent or it silently drops the entry it was meant to save.
    // Typed rather than given placeholder parameters: this scope's eslint
    // does not honour the `_` prefix, and the signature is what matters.
    const persist = vi
      .fn<(id: string, settings: unknown) => Promise<void>>()
      .mockResolvedValue(undefined);
    const settings = { headers: [] };
    await refreshingPersist(persist, vi.fn())("srv-1", settings);
    expect(persist).toHaveBeenCalledWith("srv-1", settings);
  });

  it("does not refresh when the persist fails, and propagates the error", async () => {
    // A save that threw did not write, so there is nothing new to describe —
    // and the caller is mid-error-handling, which is the wrong moment to
    // repaint state that did not change.
    const boom = new Error("keychain unavailable");
    const persist = vi.fn().mockRejectedValue(boom);
    const refresh = vi.fn();

    await expect(refreshingPersist(persist, refresh)()).rejects.toBe(boom);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("returns a function usable as a persist callback more than once", async () => {
    const persist = vi.fn(async () => {});
    const refresh = vi.fn();
    const wrapped = refreshingPersist(persist, refresh);

    await wrapped();
    await wrapped();

    expect(persist).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});
