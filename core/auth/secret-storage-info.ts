/**
 * The description of *where a typed secret ends up* — the one fact this
 * whole subsystem exists to make unmissable (#1950).
 *
 * Pure data plus its presentation helpers, deliberately kept out of
 * `core/auth/node/` so the browser can import it. The Node side resolves
 * the active store (`core/auth/node/secret-store-selection.ts`) and
 * produces one of these; it then travels three ways, and all three read
 * the same object so they cannot disagree:
 *
 *  1. the startup banner the launcher prints,
 *  2. `GET /api/config` → the web UI's settings-modal footers,
 *  3. the `SecretStore` doc comment's contract, in prose.
 *
 * A store's *kind* answers "where", `plaintext` answers "readable by
 * anyone who can read the file", and `durable` answers "will it still be
 * there next run". Those are three separate questions and a user asking
 * one of them is rarely helped by the answer to another, so none is
 * folded into the others.
 */

/** Which backend is holding secrets this session. */
export type SecretStoreKind = "keyring" | "file" | "memory";

/**
 * Why the active store is the active store. `configured` means the user
 * named it via `MCP_INSPECTOR_SECRET_STORE`; `default` means the keychain
 * was reachable and we used it; `fallback` means the keychain was *not*
 * reachable and we picked something that works instead — the case that
 * earns a loud banner, because it is the one where the answer to "where
 * did my secret go" changed without the user asking for it.
 */
export type SecretStoreReason = "configured" | "default" | "fallback";

export interface SecretStorageInfo {
  kind: SecretStoreKind;
  reason: SecretStoreReason;
  /**
   * Absolute path of the secrets file, for `kind: "file"` only. Shown in
   * the UI and the banner: a file-backed store whose location is a
   * mystery is barely better than no answer at all.
   */
  path?: string;
  /**
   * True when a file-backed store is writing secrets in the clear (no
   * `MCP_INSPECTOR_SECRET_KEY`). Always false for the other kinds — a
   * keychain is opaque to us and RAM is not "at rest" in the sense this
   * flag is about.
   */
  plaintext?: boolean;
  /**
   * True when secrets outlive the process. False only for `memory`, and
   * it is the *promise* being made rather than an implementation detail:
   * an in-memory store is honest precisely because it never claims
   * durability it cannot deliver in a container's writable layer.
   */
  durable: boolean;
  /**
   * Why the keychain was unreachable, when `reason === "fallback"`. Free
   * text from the underlying loader/binding — surfaced rather than
   * summarized, because the three realistic causes (missing libsecret, no
   * platform binary, a packaging mismatch) need different fixes and only
   * the raw message distinguishes them.
   */
  detail?: string;
}

/** Short label naming the store — the footer's primary text. */
export function secretStorageLabel(info: SecretStorageInfo): string {
  switch (info.kind) {
    case "keyring":
      return "OS keychain";
    case "file":
      return info.plaintext ? "File (unencrypted)" : "File (encrypted)";
    case "memory":
      return "Memory (this session only)";
  }
}

/**
 * How loudly to say it. `warn` is reserved for the two states a user
 * would want to know about before typing a secret — it is on disk in the
 * clear, or it is about to be lost on exit — so that the ordinary
 * keychain and encrypted-file cases stay quiet and the warning keeps its
 * meaning.
 */
export type SecretStorageTone = "neutral" | "warn";

export function secretStorageTone(info: SecretStorageInfo): SecretStorageTone {
  if (info.kind === "memory") return "warn";
  if (info.plaintext) return "warn";
  return "neutral";
}

/**
 * One sentence of consequence, or undefined when there is none worth
 * saying. Consequence, not mechanism: "will be lost when the Inspector
 * exits" is what a user can act on; "uses an in-memory Map" is not.
 */
export function secretStorageCaveat(
  info: SecretStorageInfo,
): string | undefined {
  if (info.kind === "memory") {
    return "Secrets are not written anywhere and are lost when the Inspector exits.";
  }
  if (info.plaintext) {
    return "Secrets are stored unencrypted (file mode 0600). Set MCP_INSPECTOR_SECRET_KEY to encrypt them.";
  }
  return undefined;
}

/**
 * The full sentence, for the startup banner and any single-line surface.
 * Built from the same three helpers the UI uses so the terminal and the
 * browser cannot drift into describing the same store differently.
 */
export function secretStorageSummary(info: SecretStorageInfo): string {
  const parts = [secretStorageLabel(info)];
  if (info.path) parts.push(`at ${info.path}`);
  if (info.reason === "fallback") {
    parts.push("— fell back from the OS keychain");
  }
  return parts.join(" ");
}
