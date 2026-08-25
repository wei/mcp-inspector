/**
 * SEP-2350 scope helpers. Union / strict-superset algorithms come from
 * `@modelcontextprotocol/client`; Inspector-only persistence helpers stay local.
 */

import {
  computeScopeUnion as sdkComputeScopeUnion,
  isStrictScopeSuperset as sdkIsStrictScopeSuperset,
} from "@modelcontextprotocol/client";

/** Union space-delimited scope strings (order-preserving, deduped). */
export const computeScopeUnion = sdkComputeScopeUnion;

/**
 * Whether `union` contains a scope token not present in `current`.
 * When the AS omits `scope` on the token response, `current` is empty and any
 * non-empty union is a strict superset — step-up must re-authorize, not refresh.
 */
export const isStrictScopeSuperset = sdkIsStrictScopeSuperset;

/** The scope token whose presence makes the SDK force `prompt=consent`. */
export const OFFLINE_ACCESS_SCOPE = "offline_access";

/**
 * The scope to *request* when the `refresh_token` grant has been declined
 * (#2068).
 *
 * Declining the grant stops the SDK adding `offline_access`, but it cannot
 * remove one that is already in the scope — and the Inspector's own storage is
 * the way it gets there. A successful authorization persists the scope the AS
 * granted (`resolvePersistedScopeAfterGrant`), which for a default-on client
 * includes `offline_access`; the provider reloads that on the next connect and
 * hands it back to the SDK, which sees the token in scope and appends
 * `prompt=consent` again. So a server that authorized once before the opt-out
 * would keep hitting AADSTS90094 with the box unchecked — the exact failure the
 * setting exists to prevent.
 *
 * Dropping it from the *request* (not from storage) is what breaks that loop:
 * the next grant comes back without `offline_access` and the persisted scope
 * self-heals, while re-checking the box restores the old behavior from the
 * user's own configuration rather than from a value we destroyed.
 *
 * A scope the user explicitly configured is left alone — they asked for it, and
 * the web form warns that it keeps the consent prompt alive.
 */
export function scopeForDeclinedRefreshGrant(
  effectiveScope: string | undefined,
  configuredScope: string | undefined,
): string | undefined {
  if (!effectiveScope) return effectiveScope;
  const configured = configuredScope?.trim().split(/\s+/) ?? [];
  if (configured.includes(OFFLINE_ACCESS_SCOPE)) return effectiveScope;

  const kept = effectiveScope
    .trim()
    .split(/\s+/)
    .filter((token) => token !== "" && token !== OFFLINE_ACCESS_SCOPE);
  if (kept.length > 0) return kept.join(" ");

  // Filtering removed everything (the persisted scope was `offline_access`
  // alone). Returning `undefined` here would be read as "nothing stored" by
  // `OAuthManager.createOAuthProvider`, whose seeding branch then *writes* the
  // configured scope to storage — turning this request-only filter into a
  // silent overwrite of the persisted value, so re-enabling the grant could no
  // longer restore it. Hand back the configured scope instead: it is the right
  // thing to request, and it leaves storage alone.
  // Cannot itself contain `offline_access`: that case returned unchanged above.
  const fallback = configuredScope?.trim();
  if (fallback) return fallback;

  // Nothing configured either, so there is no value to preserve and the seeding
  // branch is inert (it requires a configured scope). `undefined` rather than
  // `""` so the SDK falls back to its own resolution instead of requesting an
  // empty scope.
  return undefined;
}

/**
 * Scope to persist after a successful token grant (RFC 6749 §5.1).
 * When the AS returns `scope`, it is the authoritative full grant.
 * When `scope` is omitted on success, granted equals what was requested.
 */
export function resolvePersistedScopeAfterGrant(
  grantedScope: string | undefined,
  requestedScope: string | undefined,
): string | undefined {
  const granted = grantedScope?.trim();
  if (granted) {
    return granted;
  }
  const requested = requestedScope?.trim();
  return requested || undefined;
}

/**
 * Scope coverage for satisfaction checks: prefer the token's explicit grant;
 * when omitted, fall back to stored scope (RFC implied grant on prior success).
 */
export function resolveEffectiveGrantedScope(
  storedScope: string | undefined,
  tokenScope: string | undefined,
): string | undefined {
  const granted = tokenScope?.trim();
  if (granted) {
    return granted;
  }
  return computeScopeUnion(storedScope, tokenScope);
}
