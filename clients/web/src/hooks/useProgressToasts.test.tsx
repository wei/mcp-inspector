import { describe, it, expect, beforeEach, vi } from "vitest";
import { act } from "react";
import type { InspectorClient } from "@inspector/core/mcp/index.js";
import { renderWithMantine } from "../test/renderWithMantine";
import { progressToastId } from "../utils/toasts/progressToasts";
import { useProgressToasts } from "./useProgressToasts";

// Spy on the toast layer so these assert the show/update calls without
// mounting Mantine's <Notifications/> portal.
const { notificationsMock } = vi.hoisted(() => ({
  notificationsMock: {
    show: vi.fn(),
    update: vi.fn(),
    hide: vi.fn(),
    clean: vi.fn(),
  },
}));
vi.mock("@mantine/notifications", () => ({
  notifications: notificationsMock,
}));

/**
 * The hook only ever calls `add/removeEventListener`, so a bare `EventTarget`
 * is a faithful stand-in for the client — the events are real DOM events and
 * the listener wiring under test is the real wiring.
 */
function fakeClient(): InspectorClient & EventTarget {
  return new EventTarget() as unknown as InspectorClient & EventTarget;
}

function harness(client: InspectorClient & EventTarget) {
  function Probe({ c }: { c: InspectorClient | null }) {
    useProgressToasts(c);
    return null;
  }
  const { rerender, unmount } = renderWithMantine(<Probe c={client} />);
  return {
    progress: (progressToken: string, progress: number, total?: number) =>
      act(() => {
        client.dispatchEvent(
          new CustomEvent("progressNotification", {
            detail: { progressToken, progress, total },
          }),
        );
      }),
    swapClient: (next: InspectorClient | null) =>
      act(() => rerender(<Probe c={next} />)),
    unmount: () => act(() => unmount()),
  };
}

describe("useProgressToasts", () => {
  beforeEach(() => {
    notificationsMock.show.mockClear();
    notificationsMock.update.mockClear();
    notificationsMock.hide.mockClear();
  });

  it("does nothing without a client", () => {
    function Probe() {
      useProgressToasts(null);
      return null;
    }
    renderWithMantine(<Probe />);
    expect(notificationsMock.show).not.toHaveBeenCalled();
  });

  it("shows one toast for a stream's first tick", () => {
    const h = harness(fakeClient());
    h.progress("tok-1", 1, 4);
    expect(notificationsMock.show).toHaveBeenCalledTimes(1);
    expect(notificationsMock.show.mock.calls[0][0]).toMatchObject({
      id: progressToastId("tok-1"),
      title: "Tool progress",
    });
  });

  it("updates that toast on the next tick rather than stacking a new one", () => {
    const h = harness(fakeClient());
    h.progress("tok-1", 1, 4);
    h.progress("tok-1", 2, 4);
    expect(notificationsMock.show).toHaveBeenCalledTimes(1);
    expect(notificationsMock.update).toHaveBeenCalledTimes(1);
    expect(notificationsMock.update.mock.calls[0][0]).toMatchObject({
      id: progressToastId("tok-1"),
    });
  });

  it("gives each stream its own toast", () => {
    const h = harness(fakeClient());
    h.progress("tok-1", 1);
    h.progress("tok-2", 1);
    expect(notificationsMock.show).toHaveBeenCalledTimes(2);
    expect(notificationsMock.update).not.toHaveBeenCalled();
  });

  it("re-shows a stream whose toast the user closed", () => {
    const h = harness(fakeClient());
    h.progress("tok-1", 1);
    const { onClose } = notificationsMock.show.mock.calls[0][0] as {
      onClose: () => void;
    };
    onClose();
    h.progress("tok-1", 2);
    expect(notificationsMock.show).toHaveBeenCalledTimes(2);
    expect(notificationsMock.update).not.toHaveBeenCalled();
  });

  it("hides the live toasts when the client is swapped out", () => {
    const h = harness(fakeClient());
    h.progress("tok-1", 1);
    h.progress("tok-2", 1);
    h.swapClient(null);
    expect(notificationsMock.hide).toHaveBeenCalledWith(
      progressToastId("tok-1"),
    );
    expect(notificationsMock.hide).toHaveBeenCalledWith(
      progressToastId("tok-2"),
    );
  });

  it("stops listening to the old client after a swap", () => {
    const first = fakeClient();
    const h = harness(first);
    h.swapClient(fakeClient());
    notificationsMock.show.mockClear();
    act(() => {
      first.dispatchEvent(
        new CustomEvent("progressNotification", {
          detail: { progressToken: "tok-1", progress: 1 },
        }),
      );
    });
    expect(notificationsMock.show).not.toHaveBeenCalled();
  });

  it("hides the live toasts on unmount", () => {
    const h = harness(fakeClient());
    h.progress("tok-1", 1);
    h.unmount();
    expect(notificationsMock.hide).toHaveBeenCalledWith(
      progressToastId("tok-1"),
    );
  });
});
