import {
  NodeOAuthStorage,
  resetNodeOAuthStorageCache,
} from "@inspector/core/auth/node/storage-node.js";
import {
  DEFAULT_REVOCATION_TIMEOUT_MS,
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
  // Both spellings are cleared below, so both are revoked from — a stale entry
  // under the other key is a live grant at the authorization server, and
  // deleting it locally without revoking is exactly the leak this closes. The
  // normalised key goes first because that is the precedence
  // `findStoredServerState` reads with, so the grant actually in use is the one
  // whose outcome is reported. They are deliberately not deduplicated; see
  // `revokeStoredKeys`.
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
 * Revoke every grant held under `keys`, in order, and report the outcome that
 * matters most.
 *
 * Both keys are about to be deleted, so both are revoked from: a stale entry
 * under the other spelling is still a live grant at the authorization server,
 * and deleting it locally without revoking is the leak this whole change
 * closes.
 *
 * There is deliberately **no** cross-key deduplication. It looked cheap — the
 * two keys are usually two spellings of one server — but it can only be done
 * by pre-reading a single token, and `revokeStoredOAuthTokens` enumerates every
 * issuer slot under a key. So a shared *active* token would have skipped the
 * second key entirely, taking any additional issuer-bound grant under it with
 * the local delete. A duplicate RFC 7009 request is harmless (§2.2 makes an
 * unknown token a success), which is a much better trade than a missed one.
 *
 * Reporting prefers a **failure** over any success — a grant still live at the
 * authorization server is what the user needs to hear about, and a success
 * would otherwise silence the warning. Failing that it is the first key's
 * outcome that was not "nothing to do", which with `keys` in
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
  // One budget across both keys, for the same reason `revokeStoredOAuthTokens`
  // shares one across grants: two keys would otherwise double the wait a user
  // feels before `--relogin` gets on with the local delete.
  const deadlineAt = Date.now() + DEFAULT_REVOCATION_TIMEOUT_MS;
  let reported: TokenRevocationOutcome | undefined;
  let lastSkip: TokenRevocationOutcome | undefined;
  for (const key of new Set(keys)) {
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) {
      reported ??= {
        status: "failed",
        detail: `the ${DEFAULT_REVOCATION_TIMEOUT_MS}ms revocation budget was exhausted before "${key}" was attempted`,
      };
      continue;
    }
    const outcome = await revokeStoredOAuthTokens({
      serverUrl: key,
      storage,
      fetchFn,
      timeoutMs: remainingMs,
    });
    if (outcome.status === "skipped" && outcome.reason === "no_tokens") {
      lastSkip = outcome;
      continue;
    }
    if (outcome.status === "failed") {
      if (reported?.status !== "failed") reported = outcome;
    } else {
      reported ??= outcome;
    }
  }
  return reported ?? lastSkip;
}
