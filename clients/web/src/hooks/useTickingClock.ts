import { useEffect, useState } from "react";

/**
 * A clock that starts at `seed` and advances to the wall clock once per
 * `intervalMs` while the component is mounted (#2318).
 *
 * For rendering "N seconds ago" from a snapshot stamped with its own
 * `capturedAt`: the first render reads the snapshot's clock (pure — no
 * `Date.now()` in render, which `react-hooks/purity` reports), and the
 * interval then keeps the displayed durations moving while the panel stays
 * open. The seed also floors the result, so a snapshot newer than the last
 * tick is never rendered against a clock that predates it — a duration
 * cannot go negative, and a freshly captured snapshot reads as fresh until the
 * next tick catches up.
 *
 * A timer is exactly the "synchronize with an external system" case an effect
 * exists for; the state is set only from the interval callback, never in the
 * effect body, so the first paint is not followed by a corrective re-render.
 * `enabled: false` installs no timer at all and returns the seed.
 */
export function useTickingClock(
  seed: number,
  intervalMs = 1000,
  enabled = true,
): number {
  const [now, setNow] = useState(seed);
  useEffect(() => {
    // No timer for a consumer with nothing to tick — a component that
    // renders no durations must not pay for a repeating interval.
    if (!enabled) return;
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs, enabled]);
  return Math.max(now, seed);
}
