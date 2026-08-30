import { useCallback, useEffect, useState } from "react";
import type { OAuthStorage } from "../auth/storage.js";
import {
  clearEmaIdpSession,
  getEmaIdpLoginState,
  normalizeIdpIssuer,
  type EmaIdpLoginState,
} from "../auth/ema/idpSession.js";

export interface UseEmaIdpLoginStateResult {
  loginState: EmaIdpLoginState;
  refresh: () => Promise<void>;
  logout: () => void;
}

/**
 * Read and clear EMA IdP session state for Client Settings UX.
 * Pass `active: true` while the settings surface is open to refresh on open.
 */
export function useEmaIdpLoginState(
  storage: OAuthStorage,
  issuer: string | undefined,
  active: boolean,
): UseEmaIdpLoginStateResult {
  const normalizedIssuer = issuer ? normalizeIdpIssuer(issuer) : "";
  const [loginState, setLoginState] = useState<EmaIdpLoginState>("none");

  const refresh = useCallback(async () => {
    if (!normalizedIssuer) {
      setLoginState("none");
      return;
    }
    setLoginState(await getEmaIdpLoginState(storage, normalizedIssuer));
  }, [storage, normalizedIssuer]);

  useEffect(() => {
    if (!active) return;
    // Reading the persisted IdP session *is* the external system this effect
    // exists to synchronize with, and the read is asynchronous: the
    // `loginState` commit happens in a continuation after
    // `getEmaIdpLoginState` resolves. `set-state-in-effect` follows the call
    // into `refresh` without modelling the `await`, so it reports every
    // "fetch on open" effect alike — verified against a minimal hook whose
    // only setState is after an `await`. The one commit here that *is*
    // synchronous is the no-issuer reset to "none", which settles in a single
    // extra render rather than cascading.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async read of an external store
    void refresh();
  }, [active, refresh]);

  const logout = useCallback(() => {
    if (!normalizedIssuer) return;
    void clearEmaIdpSession(storage, normalizedIssuer)
      .then(() => {
        setLoginState("none");
      })
      .catch(() => {
        // Clearing the persisted IdP session failed (e.g. the storage backend
        // is unreachable). Swallow the rejection so it does not surface as an
        // unhandled promise, and leave loginState unchanged so the UI keeps
        // reflecting the still-present session rather than falsely showing
        // signed-out.
      });
  }, [storage, normalizedIssuer]);

  return { loginState, refresh, logout };
}
