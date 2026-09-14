import { describe, it, expect, vi, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useTickingClock } from "./useTickingClock";

describe("useTickingClock", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads the seed on the first render, before any tick", () => {
    vi.useFakeTimers();
    vi.setSystemTime(5_000_000);
    const { result } = renderHook(() => useTickingClock(1_000_000));
    expect(result.current).toBe(1_000_000);
  });

  it("advances to the wall clock on each interval", () => {
    vi.useFakeTimers();
    vi.setSystemTime(5_000_000);
    const { result } = renderHook(() => useTickingClock(1_000_000, 1000));
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current).toBe(5_001_000);
    act(() => {
      vi.setSystemTime(5_010_000);
      // Advancing the fake timers also advances the fake clock.
      vi.advanceTimersByTime(1000);
    });
    expect(result.current).toBe(5_011_000);
  });

  it("never reads behind a seed newer than the last tick", () => {
    vi.useFakeTimers();
    vi.setSystemTime(5_000_000);
    const { result, rerender } = renderHook(
      ({ seed }) => useTickingClock(seed, 1000),
      { initialProps: { seed: 1_000_000 } },
    );
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current).toBe(5_001_000);
    // A fresher snapshot arrives before the next tick: it is what the caller
    // renders from, so it must not be measured against an older clock.
    rerender({ seed: 5_002_500 });
    expect(result.current).toBe(5_002_500);
  });

  it("installs no timer and returns the seed when disabled", () => {
    vi.useFakeTimers();
    vi.setSystemTime(5_000_000);
    const setSpy = vi.spyOn(globalThis, "setInterval");
    const { result, rerender } = renderHook(
      ({ enabled }) => useTickingClock(1_000_000, 1000, enabled),
      { initialProps: { enabled: false } },
    );
    expect(setSpy).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(result.current).toBe(1_000_000);
    // Enabling later starts the clock.
    rerender({ enabled: true });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current).toBe(5_004_000);
    setSpy.mockRestore();
  });

  it("stops ticking on unmount", () => {
    vi.useFakeTimers();
    const clearSpy = vi.spyOn(globalThis, "clearInterval");
    const { unmount } = renderHook(() => useTickingClock(0, 250));
    unmount();
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });
});
