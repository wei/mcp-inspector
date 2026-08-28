import {
  NodeOAuthStorage,
  resetNodeOAuthStorageCache,
} from "@inspector/core/auth/node/storage-node.js";
import {
  revokeStoredOAuthTokens,
  selectRevocableToken,
  type TokenRevocationOutcome,
} from "@inspector/core/auth/revocation.js";
import { createProxyFetch } from "@inspector/core/mcp/node/proxyFetch.js";

/** Same canonicalisation as CLI `normalizeServerUrl` (avoid cycles). */
function normalizeServerUrl(serverUrl: string): string {
  try {
    return new URL(serverUrl).href;
  } catch {
    return serverUrl;
  }
}

/**
 * Delete stored OAuth state for an HTTP(S) server URL from the shared store
 * (`--relogin`) so the next connect cannot silently reuse tokens. This removes
 * the store entry (not a per-run ignore). No-op when `serverUrl` is missing.
 *
 * Clears **both** the raw URL and the `new URL().href`-normalised form. Runtime
 * OAuth storage is keyed by the transport's raw `url` string, while some writers
 * (and earlier clear paths) use the normalised key — mirroring
 * `findStoredServerState` in `cli.ts`, which already tries both on read.
 */
export async function clearStoredAuthForRelogin(
  serverUrl: string | undefined,
  options?: { revoke?: boolean },
): Promise<TokenRevocationOutcome | undefined> {
  if (!serverUrl?.trim()) return undefined;
  const raw = serverUrl.trim();
  const normalized = normalizeServerUrl(raw);
  const storage = new NodeOAuthStorage();
  // RFC 7009 (#2144): revoke before the clear, since the token, the client
  // credentials and the discovered `revocation_endpoint` all live in the store
  // this is about to empty. Best-effort — the outcome is returned for the
  // caller to report, never thrown, so `--relogin` succeeds regardless.
  //
  // Both spellings are cleared below, so both are revoked from — a stale entry
  // under the other key is a live grant at the authorization server, and
  // deleting it locally without revoking is exactly the leak this closes. The
  // normalised key goes first because that is the precedence `findStoredServerState`
  // reads with, so the grant actually in use is the one whose outcome is
  // reported; a second key holding the *same* token is skipped rather than
  // revoked twice.
  const revocation =
    options?.revoke === false
      ? undefined
      : await revokeStoredKeys(storage, [normalized, raw]);
  await storage.clear(raw);
  if (normalized !== raw) {
    await storage.clear(normalized);
  }
  // Drop the in-process singleton so the next connect cannot reuse a cleared
  // entry from the NodeOAuthStorage cache.
  resetNodeOAuthStorageCache();
  return revocation;
}

/**
 * Revoke every distinct grant held under `keys`, in order, and report the first
 * key that had something to revoke.
 *
 * Both keys are about to be deleted, so both are revoked from: a stale entry
 * under the other spelling is still a live grant at the authorization server,
 * and deleting it locally without revoking is the leak this whole change
 * closes. Two keys holding the *same* token are one grant, so the duplicate is
 * skipped rather than producing a second request for something already ended —
 * but only once one has actually been *revoked*, since a failed or unsupported
 * attempt has ended nothing and the other key may hold the credentials that
 * would have worked.
 *
 * Reporting prefers a **failure** over any earlier success — a grant still live
 * at the authorization server is what the user needs to hear about, and an
 * earlier success would otherwise silence the warning. Failing that, it is the
 * first key's outcome that was not "nothing to do", which with `keys` in
 * `findStoredServerState` precedence means the grant the CLI would actually
 * have connected with. When no key holds a token, the last "nothing to do"
 * answer is returned so the caller can still tell "no tokens" from "this
 * authorization server advertises no revocation endpoint".
 */
async function revokeStoredKeys(
  storage: NodeOAuthStorage,
  keys: string[],
): Promise<TokenRevocationOutcome | undefined> {
  const fetchFn = createProxyFetch() ?? fetch;
  const revokedTokens = new Set<string>();
  let reported: TokenRevocationOutcome | undefined;
  let lastSkip: TokenRevocationOutcome | undefined;
  for (const key of new Set(keys)) {
    // This read is OUTSIDE `revokeStoredOAuthTokens`'s own best-effort catch,
    // so it needs its own: `getTokens` parses through `OAuthTokensSchema` and
    // rejects on a persisted token that no longer validates. Letting that
    // escape would abandon the *local* delete `--relogin` promises, over a
    // grant we could not have revoked anyway.
    let token: string | undefined;
    try {
      token = selectRevocableToken(await storage.getTokens(key))?.token;
    } catch (err) {
      reported ??= {
        status: "failed",
        detail: err instanceof Error ? err.message : String(err),
      };
      continue;
    }
    if (token !== undefined && revokedTokens.has(token)) continue;
    const outcome = await revokeStoredOAuthTokens({
      serverUrl: key,
      storage,
      fetchFn,
    });
    if (outcome.status === "skipped" && outcome.reason === "no_tokens") {
      lastSkip = outcome;
      continue;
    }
    // Only a token the authorization server actually accepted counts as spent.
    // Marking one revoked on a `failed` or `no_endpoint` outcome would skip a
    // duplicate entry under the other key that may carry usable metadata or
    // credentials — the one chance left to end that grant.
    if (token !== undefined && outcome.status === "revoked") {
      revokedTokens.add(token);
    }
    // A failure outranks an earlier success for reporting: a grant that is
    // still live is what the user needs to hear about, and reporting the
    // success would print no warning while a stale grant survives.
    if (outcome.status === "failed") {
      if (reported?.status !== "failed") reported = outcome;
    } else {
      reported ??= outcome;
    }
  }
  return reported ?? lastSkip;
}
