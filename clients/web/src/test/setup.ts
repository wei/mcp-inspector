import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// Node 22+ exposes an experimental `localStorage` placeholder that overrides
// happy-dom's implementation. Without `--localstorage-file`, it's an empty
// stub with no methods, which breaks anything that calls setItem/getItem.
// Install a minimal in-memory Storage shim before any test runs.
class MemoryStorage implements Storage {
  private store = new Map<string, string>();
  get length(): number {
    return this.store.size;
  }
  clear(): void {
    this.store.clear();
  }
  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }
  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
}

Object.defineProperty(window, "localStorage", {
  configurable: true,
  value: new MemoryStorage(),
});

// Benign default `fetch`. Several components hit the backend on mount — e.g.
// the app reads `GET /api/config` via `useInitialConfig`.
// Under happy-dom (no server) those real requests 404 and log alarming
// `GET .../api/config 404 (Not Found)` lines that make a green run look broken.
// Returning an empty 200 keeps such *incidental* calls quiet. Tests that care
// about fetch install their own per-test spy/stub (e.g. `vi.spyOn(globalThis,
// "fetch")`), which Vitest only auto-reverts to this baseline if the test
// registers it through Vitest's mock APIs — this project doesn't set
// `restoreMocks` globally, so a test that mutates `globalThis.fetch` directly
// must restore it itself. Note the tradeoff: this default is permissive, so a
// test meaning to assert on a fetch FAILURE must set up its own rejecting/
// erroring stub rather than relying on the absence of a server.
Object.defineProperty(globalThis, "fetch", {
  configurable: true,
  writable: true,
  value: () =>
    Promise.resolve(
      new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ),
});

// happy-dom (v20) *does* implement `matchMedia`/`MediaQueryList`, so this isn't
// a polyfill for a missing API — it's a deliberate **override** of happy-dom's
// implementation, pinning `prefers-reduced-motion: reduce` and reporting `false`
// for every other query (preserving the historical absent-matchMedia layout
// behavior for `useMediaQuery`-driven code). Note this does *not*, on its own,
// disable Mantine transitions: `useTransition` only honors reduced motion when
// `theme.respectReducedMotion` is true, and Mantine 8 defaults it to `false`
// (the project theme doesn't override it). The actual protection against the
// #1760 post-teardown `window is not defined` leak is the leaked-timer safety
// net below — NOT `env="test"`, which an earlier version of this comment
// claimed. `env` is read only by `Transition.mjs`, and only at its *render*
// branch (`transitionDuration === 0 || env === "test"`); `useTransition()` is
// called before that check, since hooks cannot be conditional, so it still
// schedules real `window.setTimeout`s on every `mounted` change. Measured:
// opening a `<Modal>` through `renderWithMantine` schedules three 200ms timers
// (#1984). Tests that need specific media results still mock `@mantine/hooks`
// or stub `matchMedia` themselves.
Object.defineProperty(window, "matchMedia", {
  configurable: true,
  writable: true,
  // Partial `matchMedia` override: the members below are all the app touches.
  // The stub omits the rest of `MediaQueryList`, so the double cast bridges the
  // deliberately-incomplete shape. The `matches` regex is anchored to the
  // `reduce` form so the stub doesn't also answer `true` to
  // `(prefers-reduced-motion: no-preference)` (claiming both preferences at
  // once); Mantine only ever queries the `reduce` form.
  value: (query: string): MediaQueryList =>
    ({
      matches: /prefers-reduced-motion:\s*reduce/.test(query),
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList,
});

// ---------------------------------------------------------------------------
// Leaked-timer safety net (#1984)
//
// A `window.setTimeout` that outlives its test file fires after happy-dom has
// disposed that file's `window`, and React's `dispatchSetState` then throws an
// uncaught `ReferenceError: window is not defined`. Vitest attributes that to
// whichever file happened to be running, and one such error fails the ENTIRE
// run with every test passing — so it reads as a defect in an innocent file.
//
// Mantine's own hooks do clear their timers on unmount (`useTransition`'s
// `clearAllTimeouts`, `useLockScroll`'s effect cleanup), so this is not a
// library bug. It is a race: `clearAllTimeouts` cancels the *pending* rAF, but
// if that rAF callback is already in flight when the unmount lands,
// `cancelAnimationFrame` is a no-op and the callback goes on to schedule a
// `setTimeout` after cleanup has already run. Nothing owns that timer. It needs
// a loaded machine to hit, which is why it only ever appears in CI.
//
// Rather than chase each component, track every timer and clear whatever is
// still outstanding once the test's own teardown has had its turn. Ordering is
// load-bearing: this runs *after* `cleanup()` below, so legitimate unmount
// cleanups clear their own timers and only true leaks are left.
//
// Under `vi.useFakeTimers()` the wrapper is swapped out for vitest's fake
// implementation, so nothing is tracked while fake timers are installed — which
// is correct, since a fake timer cannot outlive the environment.
const pendingTimers = new Set<number>();
const realSetTimeout = window.setTimeout.bind(window);
const realClearTimeout = window.clearTimeout.bind(window);

window.setTimeout = ((
  handler: TimerHandler,
  timeout?: number,
  ...args: unknown[]
): number => {
  const id: number = realSetTimeout(
    (...cbArgs: unknown[]) => {
      pendingTimers.delete(id);
      if (typeof handler === "function") {
        handler(...cbArgs);
      }
    },
    timeout,
    ...args,
  );
  pendingTimers.add(id);
  return id;
  // happy-dom types `setTimeout` with Node's overloads (returning `Timeout`),
  // while the DOM lib types it as `number`. The implementation above honors the
  // DOM shape the app codes against; this cast bridges the two declarations,
  // which TS cannot relate structurally.
}) as unknown as typeof window.setTimeout;

window.clearTimeout = ((id?: number): void => {
  if (typeof id === "number") {
    pendingTimers.delete(id);
  }
  realClearTimeout(id);
  // Same DOM-vs-Node overload mismatch as `setTimeout` above.
}) as unknown as typeof window.clearTimeout;

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  // After cleanup(), anything still pending is a leak — drop it so it cannot
  // fire past this file's environment teardown.
  for (const id of pendingTimers) {
    realClearTimeout(id);
  }
  pendingTimers.clear();
});
