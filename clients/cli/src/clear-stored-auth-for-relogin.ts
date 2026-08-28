import {
  NodeOAuthStorage,
  resetNodeOAuthStorageCache,
} from "@inspector/core/auth/node/storage-node.js";
import {
  revokeStoredOAuthTokens,
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
  // Only the key that actually holds the state is revoked from: the two keys
  // below are two spellings of one server, so revoking from both would send a
  // second request for a grant the first one already ended.
  const revocation =
    options?.revoke === false
      ? undefined
      : await revokeFirstStoredKey(storage, [raw, normalized]);
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
 * Revoke against the first of `keys` that actually has a revocable token,
 * returning that attempt's outcome. Reports the last "nothing to do" answer
 * when no key holds one, so the caller can still distinguish "no tokens" from
 * "this authorization server advertises no revocation endpoint".
 */
async function revokeFirstStoredKey(
  storage: NodeOAuthStorage,
  keys: string[],
): Promise<TokenRevocationOutcome | undefined> {
  const fetchFn = createProxyFetch() ?? fetch;
  let last: TokenRevocationOutcome | undefined;
  for (const key of new Set(keys)) {
    const outcome = await revokeStoredOAuthTokens({
      serverUrl: key,
      storage,
      fetchFn,
    });
    if (!(outcome.status === "skipped" && outcome.reason === "no_tokens")) {
      return outcome;
    }
    last = outcome;
  }
  return last;
}
