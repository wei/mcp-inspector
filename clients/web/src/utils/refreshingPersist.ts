/**
 * Wrap a persist callback so it refreshes derived state after it succeeds.
 *
 * Written for one case (#1950): saving a secret can change what the secrets
 * file *is* — the first save under a newly-set passphrase re-encrypts a
 * pre-existing plaintext file — so the `secretStorage` descriptor behind the
 * settings-modal footer has to be re-fetched afterwards, or the footer keeps
 * reporting the state it had at page load.
 *
 * It exists as a named unit rather than two inline `await …; refresh()` pairs
 * in `App.tsx` because of where the coverage gate can reach. `App.tsx` is
 * deliberately outside the coverage `include` (a ~4.5k-line composition root),
 * so wiring written there is not exercised by anything: the hook's own tests
 * and the modal's own tests can both pass while the callback that connects
 * them is broken, leaving the security footer stale after exactly the write
 * that changed it. Review round 17 of #1950 caught that, after three earlier
 * rounds had each found a defect in this same path.
 *
 * `refresh` runs **only on success**. A persist that threw did not write, so
 * there is nothing new to describe, and re-fetching would just repaint the
 * state already on screen while the caller is handling the failure.
 */
export function refreshingPersist<Args extends unknown[]>(
  persist: (...args: Args) => Promise<void>,
  refresh: () => void,
): (...args: Args) => Promise<void> {
  return async (...args: Args) => {
    await persist(...args);
    refresh();
  };
}
