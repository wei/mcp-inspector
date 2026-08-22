/**
 * File-backed {@link SecretStore} — the persistence answer for a box with
 * no reachable OS keychain (#1950): the published container (no D-Bus
 * session, #1848), Android/Termux (no platform binary, #1905), and a
 * minimal Linux install without libsecret.
 *
 * **This partially reverses #1356 on purpose.** That change moved
 * `oauthClientSecret` *out of* `mcp.json` and into the keychain to get it
 * off disk. Writing secrets back to disk here is therefore a decision, not
 * an oversight, and it is bounded three ways: the file is separate from
 * `mcp.json` (so a user pasting their catalog into an issue does not paste
 * their secrets), it is written `0600`, and it is encrypted whenever
 * `MCP_INSPECTOR_SECRET_KEY` is set. What it buys is the alternative:
 * before this, those users could not persist a secret at all — `set` threw
 * and the route answered 503.
 *
 * **Format.** One JSON document, whose whole secret map is encrypted as a
 * unit rather than value-by-value:
 *
 * ```json
 * { "version": 1, "encryption": "none", "secrets": { "srv:field": "s3cr3t" } }
 * { "version": 1, "encryption": "aes-256-gcm",
 *   "kdf": { "algorithm": "scrypt", "salt": "…", "N": 16384, "r": 8, "p": 1 },
 *   "data": "<iv>.<authTag>.<ciphertext>" }
 * ```
 *
 * Encrypting the map as a unit — not each value — is what hides the
 * *account names* too. Those are `${serverId}:${field}`, so a per-value
 * scheme would leave a readable index of which servers you use and which
 * of them you hold an OAuth client secret for. That index is worth
 * roughly as much to an attacker as some of the values.
 *
 * **Key.** `MCP_INSPECTOR_SECRET_KEY` is a passphrase, not a key: it is
 * stretched with scrypt against a per-file random salt stored beside the
 * ciphertext, so the same passphrase produces a different key for a
 * different file and a precomputed table buys an attacker nothing.
 *
 * That is **not** a licence to use a short, memorable one. The salt
 * defeats precomputation; it does nothing against guessing, and the cost
 * parameters below are deliberately cheap (a few milliseconds, since the
 * derivation runs on every read and write). Anyone who steals
 * `secrets.json` can therefore try candidate passphrases quickly and
 * offline. Use a high-entropy value — generated, not chosen — the same as
 * you would for any other credential.
 *
 * **Availability contract — identical to `KeyringSecretStore`'s**, because
 * callers must not have to know which store they got. `get` is tolerant
 * (returns `null` on any failure), `delete` no-ops, and `set` is the only
 * operation that hard-fails, throwing {@link SecretStoreUnavailableError}
 * — the moment where a value would actually be lost. Routes translate that
 * to a 503 the same way they already do for the keychain.
 *
 * The one failure worth calling out is the *key mismatch*: a file written
 * encrypted, opened later with the passphrase changed or removed. Reads go
 * quiet (`null`, per the contract) but writes must not — writing would
 * replace a file full of still-valid secrets with one holding a single new
 * one, destroying data to satisfy a request that was only ever additive.
 * So `set` refuses and says which of the two things to fix.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import { readStoreFile, writeStoreFile } from "../../storage/store-io.js";
import {
  SecretStoreUnavailableError,
  type SecretStore,
} from "./secret-store.js";

/**
 * Promisified `scrypt`. Hand-wrapped rather than `promisify`d because the
 * overload carrying the cost parameters is not the one `promisify`'s types
 * pick up, and the alternative — `scryptSync` — blocks the event loop for
 * the duration of the derivation on every read and write.
 */
const scrypt = (
  passphrase: string,
  salt: Buffer,
  keylen: number,
  options: crypto.ScryptOptions,
): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    crypto.scrypt(passphrase, salt, keylen, options, (err, key) => {
      /* v8 ignore next -- @preserve: node validates the cost parameters
         synchronously (an out-of-grammar `N` throws from the call itself,
         which the corrupt-KDF test exercises), so this asynchronous channel
         is left for allocation failure — not provokable deterministically. */
      if (err) reject(err);
      else resolve(key);
    });
  });

const FORMAT_VERSION = 1;
const CIPHER = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
/** scrypt defaults. `N` is the only one that meaningfully costs time; 2^14
 * derives in a few milliseconds, which is invisible next to the file I/O it
 * accompanies and is derived once per read/write rather than per secret. */
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;

/** Env var holding the passphrase. Absent → the file is written in the clear. */
export const SECRET_KEY_ENV = "MCP_INSPECTOR_SECRET_KEY";

interface KdfParams {
  algorithm: "scrypt";
  salt: string;
  N: number;
  r: number;
  p: number;
}

interface SecretFile {
  version: number;
  encryption: "none" | "aes-256-gcm";
  kdf?: KdfParams;
  secrets?: Record<string, string>;
  data?: string;
}

const buildAccount = (serverId: string, field: string): string =>
  `${serverId}:${field}`;

/**
 * Assert that a decoded payload really is a `Record<string, string>`.
 *
 * Neither branch of {@link FileSecretStore.readMap} can trust its input: the
 * plaintext `secrets` field is whatever the file says, and a decrypted
 * payload only proves the *bytes* were authentic — GCM verifies who wrote
 * them, not what shape they parse to.
 *
 * An array is the case that shows why a cast is not enough. `[]` passes
 * `typeof === "object"`, so `map[account] = value` assigns a named property
 * to it, and `JSON.stringify` then drops every named property of an array —
 * so `set` resolves successfully having written a file that does not contain
 * the secret it was given. Silent loss on the one operation whose entire
 * contract is that it does not lose things.
 */
function asSecretMap(value: unknown, filePath: string): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SecretStoreUnavailableError(
      `The secrets file at ${filePath} does not hold a secret map (found ${Array.isArray(value) ? "an array" : typeof value}). Refusing to write, which would replace it. Move the file aside to start over.`,
    );
  }
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") {
      throw new SecretStoreUnavailableError(
        `The secrets file at ${filePath} holds a non-string value for "${key}". Refusing to write, which would replace it. Move the file aside to start over.`,
      );
    }
  }
  return { ...(value as Record<string, string>) };
}

/**
 * Thrown when a file was written encrypted and the current passphrase
 * cannot open it. A distinct type so `set` can refuse with advice that
 * fits, instead of the generic "could not write" that would send someone
 * looking at permissions.
 */
export class SecretFileKeyMismatchError extends SecretStoreUnavailableError {
  constructor(filePath: string, hasKey: boolean) {
    super(
      hasKey
        ? `The secrets file at ${filePath} could not be decrypted with the current ${SECRET_KEY_ENV}. Refusing to write, which would overwrite the existing secrets. Restore the original passphrase, or delete the file to start over.`
        : `The secrets file at ${filePath} is encrypted but ${SECRET_KEY_ENV} is not set. Refusing to write, which would overwrite the existing secrets. Set the passphrase this file was written with, or delete the file to start over.`,
    );
    this.name = "SecretFileKeyMismatchError";
  }
}

const encodeParts = (iv: Buffer, tag: Buffer, body: Buffer): string =>
  `${iv.toString("base64")}.${tag.toString("base64")}.${body.toString("base64")}`;

/**
 * Split a `<iv>.<tag>.<ciphertext>` payload, rejecting anything that is not
 * exactly three parts. `split(".")` on a truncated or extended payload
 * otherwise yields buffers of the wrong length, and `createDecipheriv`
 * reports that as a generic error further away from the cause.
 */
function decodeParts(
  payload: string,
): { iv: Buffer; tag: Buffer; body: Buffer } | null {
  const parts = payload.split(".");
  if (parts.length !== 3) return null;
  const [iv, tag, body] = parts as [string, string, string];
  return {
    iv: Buffer.from(iv, "base64"),
    tag: Buffer.from(tag, "base64"),
    body: Buffer.from(body, "base64"),
  };
}

/**
 * How long a lock may be held before another process treats it as
 * abandoned. Generous next to the work it guards (a read, one scrypt
 * derivation, an atomic write — single-digit milliseconds), because the
 * cost of being wrong is asymmetric: waiting a second too long is
 * invisible, while stealing a live lock reintroduces the very race the
 * lock exists to close.
 */
const LOCK_STALE_MS = 10_000;
/** Total time to wait for a lock before giving up and reporting it. */
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_POLL_MS = 25;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Take an exclusive, cross-process lock on `filePath`.
 *
 * `mkdir` is the primitive rather than a lock *file*: it is atomic and
 * fails with `EEXIST` on every POSIX filesystem and on Windows, and it
 * needs no `O_EXCL` open-flag juggling. Returns the release function.
 *
 * **Stale locks are stolen, and that is not optional.** A container killed
 * with SIGKILL leaves the directory behind, and a lock that can only be
 * released by a cooperative exit would make one `docker kill` brick secret
 * writes permanently — turning a rare lost-write race into a permanent
 * outage, which is a strictly worse failure. Staleness is judged by the
 * directory's mtime.
 *
 * Never throws for lock-infrastructure reasons alone. If the lock cannot
 * be created at all (a read-only mount, a filesystem without mkdir
 * semantics we can rely on), the caller proceeds unlocked: the in-process
 * queue still protects the common single-process case, and refusing to
 * write would deny a real user a real secret in order to prevent a race
 * with a second process that may not exist.
 */
export async function acquireLock(
  filePath: string,
): Promise<() => Promise<void>> {
  const lockDir = `${filePath}.lock`;
  const noop = async (): Promise<void> => {};
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  for (;;) {
    try {
      await fs.mkdir(lockDir, { recursive: false });
      return async () => {
        try {
          await fs.rmdir(lockDir);
        } catch {
          // Already gone — another process judged us stale and stole it.
          // Nothing to undo, and nothing the caller can act on.
        }
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        // Not "someone else holds it" — the lock itself is unavailable.
        // Proceed unlocked rather than failing the write; see above.
        return noop;
      }
      try {
        const held = (await fs.stat(lockDir)).mtimeMs;
        if (Date.now() - held > LOCK_STALE_MS) {
          await fs.rmdir(lockDir);
          continue;
        }
      } catch {
        // The holder released it between our mkdir and our stat. Retry.
      }
      if (Date.now() >= deadline) return noop;
      await sleep(LOCK_POLL_MS);
    }
  }
}

export interface FileSecretStoreOptions {
  /** Absolute path of the secrets file. */
  filePath: string;
  /**
   * Passphrase. Defaults to `process.env[SECRET_KEY_ENV]`; an empty or
   * whitespace-only value counts as absent, since `MCP_INSPECTOR_SECRET_KEY=`
   * in a compose file is a user who meant "off", not a one-character key.
   */
  passphrase?: string;
}

export class FileSecretStore implements SecretStore {
  readonly filePath: string;
  private readonly passphrase: string | undefined;
  /**
   * Serializes read-modify-write cycles within this process. `writeStoreFile`
   * already makes each individual write atomic and ordered, but that is not
   * enough here: two concurrent `set`s would each read the same "before" map
   * and the second write would drop the first one's entry. The route handlers
   * write a server's fields with `Promise.all`, so this is the ordinary path,
   * not a race that needs contriving.
   */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: FileSecretStoreOptions) {
    this.filePath = options.filePath;
    const raw = options.passphrase ?? process.env[SECRET_KEY_ENV];
    this.passphrase = raw && raw.trim() ? raw : undefined;
  }

  /**
   * True when the *next write* will encrypt. This is the configured policy,
   * not the state of the file — see {@link readOnDiskEncryption}, which is
   * what the user-facing descriptor is built from.
   */
  get encrypted(): boolean {
    return this.passphrase !== undefined;
  }

  /**
   * What the file on disk is *currently* written as — `null` when there is
   * no file yet, or when it cannot be read or parsed.
   *
   * Separate from {@link encrypted} because the two genuinely disagree for a
   * whole session: adding `MCP_INSPECTOR_SECRET_KEY` to an install that
   * already has a plaintext file flips `encrypted` to true immediately,
   * while the bytes stay readable until the next `set`. A descriptor built
   * from the policy would tell that user "File (encrypted)" while their
   * existing secrets sat in the clear — the precise reassurance this whole
   * subsystem exists not to give.
   *
   * Reads the envelope only. It never decrypts, so it needs no passphrase
   * and answers correctly even when the key is wrong or missing — which is
   * also a state the UI has to describe rather than throw on.
   */
  async readOnDiskEncryption(): Promise<SecretFile["encryption"] | null> {
    try {
      const raw = await readStoreFile(this.filePath);
      if (raw === null) return null;
      const parsed = JSON.parse(raw) as SecretFile;
      return parsed.encryption === "none" || parsed.encryption === CIPHER
        ? parsed.encryption
        : null;
    } catch {
      // Absent, unreadable, or not JSON. "Unknown" is the honest answer, and
      // the caller falls back to reporting the configured policy — the only
      // thing that is knowable about a file nobody can read.
      return null;
    }
  }

  private async deriveKey(kdf: KdfParams): Promise<Buffer> {
    return scrypt(
      // Only reached when the passphrase is set — every caller checks first,
      // which is what makes the non-null assertion safe here rather than a
      // widened `string | undefined` threaded through the crypto helpers.
      this.passphrase as string,
      Buffer.from(kdf.salt, "base64"),
      KEY_BYTES,
      { N: kdf.N, r: kdf.r, p: kdf.p },
    );
  }

  /**
   * Read and decode the file into a plain map.
   *
   * Distinguishes three outcomes that callers treat differently: `null` for
   * "no file yet" (a first write should create one), a map for success, and a
   * throw for "there is a file and we cannot read it" — which must never be
   * flattened into an empty map, or `set` would cheerfully overwrite it.
   */
  private async readMap(): Promise<Record<string, string> | null> {
    const raw = await readStoreFile(this.filePath);
    if (raw === null) return null;

    let parsed: SecretFile;
    try {
      parsed = JSON.parse(raw) as SecretFile;
    } catch (err) {
      throw new SecretStoreUnavailableError(
        `The secrets file at ${this.filePath} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Version first, before either branch. A `{ version: 2, encryption:
    // "none" }` file is readable as far as the plaintext branch is concerned,
    // but reading it means the next write rewrites it as version 1 — silently
    // discarding whatever fields version 2 added. That is exactly the
    // destroy-to-satisfy-an-additive-request case the encrypted branch already
    // refuses, so it gets the same answer rather than a different one that
    // happens to depend on which encryption mode the newer writer chose.
    if (parsed.version !== FORMAT_VERSION) {
      throw new SecretStoreUnavailableError(
        `The secrets file at ${this.filePath} declares format version ${String(parsed.version)}, but this Inspector only understands version ${FORMAT_VERSION}. It was probably written by a newer Inspector; upgrade, or move the file aside to start over.`,
      );
    }

    if (parsed.encryption === "none") {
      // A plaintext file read by a store that now has a passphrase is fine and
      // deliberately not an error: the next write re-encrypts it, so setting
      // the env var upgrades an existing file in place. Until that write
      // lands the file really is still readable, which is why
      // `readOnDiskEncryption` exists — the descriptor must report the file,
      // not the intent.
      return asSecretMap(parsed.secrets ?? {}, this.filePath);
    }

    if (parsed.encryption !== CIPHER || !parsed.kdf || !parsed.data) {
      throw new SecretStoreUnavailableError(
        `The secrets file at ${this.filePath} declares an unsupported format (encryption="${String(parsed.encryption)}", version=${String(parsed.version)}). It may have been written by a newer Inspector.`,
      );
    }
    if (!this.passphrase)
      throw new SecretFileKeyMismatchError(this.filePath, false);

    const parts = decodeParts(parsed.data);
    if (!parts) throw new SecretFileKeyMismatchError(this.filePath, true);
    try {
      const key = await this.deriveKey(parsed.kdf);
      const decipher = crypto.createDecipheriv(CIPHER, key, parts.iv);
      decipher.setAuthTag(parts.tag);
      const plain = Buffer.concat([
        decipher.update(parts.body),
        decipher.final(),
      ]).toString("utf-8");
      return asSecretMap(JSON.parse(plain), this.filePath);
    } catch (err) {
      // A shape refusal is about the *contents*, not the key — it decrypted
      // fine. Rethrowing it as a key mismatch would send the user to fix a
      // passphrase that is working.
      if (err instanceof SecretStoreUnavailableError) throw err;
      // GCM authentication failure is what a wrong passphrase looks like, and
      // it is indistinguishable from a tampered/corrupt file — both mean "this
      // key does not open this file", which is what the message says.
      throw new SecretFileKeyMismatchError(this.filePath, true);
    }
  }

  private async writeMap(map: Record<string, string>): Promise<void> {
    let file: SecretFile;
    if (this.passphrase) {
      const kdf: KdfParams = {
        algorithm: "scrypt",
        // A fresh salt per write, not per file: rewriting with the same salt
        // and a fresh IV would still be safe for GCM, but re-salting costs one
        // scrypt derivation we were doing anyway and removes the question.
        salt: crypto.randomBytes(16).toString("base64"),
        N: SCRYPT_N,
        r: SCRYPT_R,
        p: SCRYPT_P,
      };
      const key = await this.deriveKey(kdf);
      const iv = crypto.randomBytes(IV_BYTES);
      const cipher = crypto.createCipheriv(CIPHER, key, iv);
      const body = Buffer.concat([
        cipher.update(JSON.stringify(map), "utf-8"),
        cipher.final(),
      ]);
      file = {
        version: FORMAT_VERSION,
        encryption: CIPHER,
        kdf,
        data: encodeParts(iv, cipher.getAuthTag(), body),
      };
    } else {
      file = { version: FORMAT_VERSION, encryption: "none", secrets: map };
    }
    // `writeStoreFile` creates the parent dir, writes atomically, and sets
    // 0600 — the same helper the OAuth token store uses, so the two files on
    // disk have identical permissions by construction rather than by
    // convention.
    await writeStoreFile(this.filePath, `${JSON.stringify(file, null, 2)}\n`);
  }

  /**
   * Run `fn` with the file to itself across *processes* as well.
   *
   * The in-process queue is necessary and not sufficient: a durable secrets
   * file is shared state, and a second Inspector on the same box — a CLI run
   * beside a web session is the ordinary case, not a contrived one — reads
   * the same "before" map and then atomically replaces the file, dropping
   * whatever the first process had just added. Both writes report success;
   * one secret is simply gone.
   *
   * Only mutations take the lock. Reads deliberately do not: `writeStoreFile`
   * is atomic (write-temp-then-rename), so a concurrent reader sees either the
   * old file or the new one and never a torn one, and making every `get`
   * contend on a lock would put a filesystem round-trip in front of the
   * request path for no correctness gain.
   */
  private async withFileLock<T>(fn: () => Promise<T>): Promise<T> {
    const release = await acquireLock(this.filePath);
    try {
      return await fn();
    } finally {
      await release();
    }
  }

  /** Run `fn` with the file to itself, so concurrent callers can't lose writes. */
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn);
    // Swallow on the chain only — the returned promise still rejects, so a
    // failed `set` surfaces to its caller while a later `set` is not poisoned
    // by it. This assignment is also why `this.queue` needs no `.catch()` of
    // its own above: it is only ever `Promise.resolve()` or an
    // already-swallowed promise, so it cannot reject.
    this.queue = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  async get(serverId: string, field: string): Promise<string | null> {
    try {
      const map = await this.serialize(() => this.readMap());
      return map?.[buildAccount(serverId, field)] ?? null;
    } catch {
      // Read tolerance, matching `KeyringSecretStore.get`: an unreadable store
      // and an absent entry are the same answer to the caller, and hard-failing
      // here would break every `GET /api/servers` on a box whose passphrase
      // changed.
      return null;
    }
  }

  async set(serverId: string, field: string, value: string): Promise<void> {
    await this.serialize(() =>
      this.withFileLock(async () => {
        let map: Record<string, string>;
        try {
          map = (await this.readMap()) ?? {};
        } catch (err) {
          // Already a typed refusal (unreadable file / key mismatch) —
          // rethrow rather than re-wrapping, so the specific advice survives.
          if (err instanceof SecretStoreUnavailableError) throw err;
          throw new SecretStoreUnavailableError(
            `Could not read the secrets file at ${this.filePath}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        map[buildAccount(serverId, field)] = value;
        try {
          await this.writeMap(map);
        } catch (err) {
          throw new SecretStoreUnavailableError(
            `Could not write the secrets file at ${this.filePath}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }),
    );
  }

  async delete(serverId: string, field: string): Promise<void> {
    await this.deleteWhere((key) => key === buildAccount(serverId, field));
  }

  async deleteAllForServer(serverId: string): Promise<void> {
    const prefix = `${serverId}:`;
    await this.deleteWhere((key) => key.startsWith(prefix));
  }

  /**
   * Shared delete body. Silent on every failure, matching the keyring store:
   * every reason a delete can fail collapses to "the entry isn't there
   * anymore", and `set` is the operation that reports a broken store.
   */
  private async deleteWhere(match: (key: string) => boolean): Promise<void> {
    try {
      await this.serialize(() =>
        this.withFileLock(async () => {
          const map = await this.readMap();
          if (!map) return;
          const keys = Object.keys(map).filter(match);
          if (keys.length === 0) return;
          for (const key of keys) delete map[key];
          // An emptied map keeps the file rather than unlinking it: its
          // presence is what records which encryption mode this install
          // settled on, so a later write can't silently switch modes on the
          // user.
          await this.writeMap(map);
        }),
      );
    } catch {
      // Intentionally silent — see the doc comment above.
    }
  }
}

/**
 * Best-effort permission repair for a pre-existing secrets file.
 *
 * `writeStoreFile` passes `mode: 0o600`, but a mode argument only applies
 * when the file is *created* — an atomic rename over a file someone made
 * `0644` by hand (or restored from a backup, or copied out of an image)
 * keeps the loose mode forever. Called once at store selection so the
 * guarantee the docs make is the guarantee on disk.
 *
 * Failures are swallowed: a file we cannot chmod is one we probably cannot
 * write either, and `set` is where that gets reported with context.
 */
export async function tightenSecretFilePermissions(
  filePath: string,
): Promise<SecretFilePermissionState> {
  try {
    await fs.chmod(filePath, 0o600);
  } catch {
    // Non-existent (the common case — nothing written yet), read-only mount,
    // or a platform without POSIX modes. The verification below decides
    // whether that mattered.
  }
  // Verify rather than assume. The chmod above is best-effort, but the UI and
  // the README both state the file is 0600 — so a file we failed to tighten
  // (owned by another user, on a read-only mount) must be *reported*, not
  // quietly described as protected. This is the one place that can tell the
  // difference, because it is the only one that looks at the file.
  try {
    const mode = (await fs.stat(filePath)).mode & 0o777;
    if (mode === 0o600) return { state: "ok" };
    return { state: "loose", mode };
  } catch {
    // No file yet — the common first run. `writeStoreFile` creates it 0600,
    // so there is nothing to warn about.
    return { state: "absent" };
  }
}

/**
 * Outcome of {@link tightenSecretFilePermissions}: the file is `0600`
 * (`ok`), does not exist yet (`absent`), or exists with a wider mode we
 * could not fix (`loose`) — the only case anyone needs to hear about.
 */
export type SecretFilePermissionState =
  | { state: "ok" }
  | { state: "absent" }
  | { state: "loose"; mode: number };
