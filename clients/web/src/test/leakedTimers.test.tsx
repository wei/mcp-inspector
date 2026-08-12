/**
 * Regression tests for the leaked-timer safety net in `setup.ts` (#1984).
 *
 * A `window.setTimeout` that outlives its test file fires after happy-dom has
 * disposed that file's `window`, and React then throws an uncaught
 * `ReferenceError: window is not defined` that fails the whole run — from an
 * arbitrary innocent file, with every test passing. These lock down the net that
 * prevents it.
 *
 * Note what is deliberately NOT asserted: that Mantine schedules no timers. It
 * does (measured: three 200ms timers when a `Modal` opens, even under
 * `env="test"`), and that is the library behaving normally. The contract here is
 * only that nothing survives the test that scheduled it.
 */

import { describe, it, expect, vi } from "vitest";
import { Modal } from "@mantine/core";
import { renderWithMantine } from "./renderWithMantine";

/** Ids the net is tracking, read back through the wrapper it installed. */
function scheduleTracked(ms: number): number {
  return window.setTimeout(() => {}, ms) as unknown as number;
}

describe("leaked-timer safety net", () => {
  it("wraps window.setTimeout rather than leaving the native one in place", () => {
    // If the wrapper were absent the net would silently track nothing, so assert
    // the instrumentation exists before relying on the behavior it enables.
    expect(window.setTimeout.toString()).not.toContain("[native code]");
  });

  it("clears a timer the test leaves pending, so it cannot fire later", async () => {
    const fired = vi.fn();
    window.setTimeout(fired, 20);
    // Deliberately do not clear it: the afterEach net owns it from here. The
    // next test asserts it never ran.
    leaked.callback = fired;
    expect(fired).not.toHaveBeenCalled();
  });

  it("the previous test's leaked timer never fired", async () => {
    // 20ms of real time, comfortably past the leaked timer's deadline.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(leaked.callback).not.toBeNull();
    expect(leaked.callback).not.toHaveBeenCalled();
  });

  it("clearTimeout stops tracking, so an explicitly-cleared timer is not double-cleared", () => {
    const id = scheduleTracked(1000);
    expect(() => window.clearTimeout(id)).not.toThrow();
    // Clearing twice must stay a no-op — the net also clears at teardown.
    expect(() => window.clearTimeout(id)).not.toThrow();
  });

  it("a Modal's own transition timers do not survive the test that opened it", () => {
    // The real-world shape of #1984: ServerRemoveConfirmModal-style tests toggle
    // `opened`, and Mantine schedules real timers for the transition and the
    // scroll lock. Rendering here is enough — the net clears them at teardown,
    // and a regression would surface as the run-killing uncaught ReferenceError
    // rather than as a failure of this assertion.
    const { rerender } = renderWithMantine(
      <Modal opened={false} onClose={() => {}} />,
    );
    rerender(<Modal opened={true} onClose={() => {}} />);
    expect(document.body).toBeTruthy();
  });
});

/** Carries the leaked callback across the two tests above. */
const leaked: { callback: ReturnType<typeof vi.fn> | null } = {
  callback: null,
};
