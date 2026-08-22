/**
 * `FileSecretStore` against a real filesystem (#1950).
 *
 * A real temp directory rather than a mocked `fs`: the properties worth
 * asserting here are properties *of the file* — its mode, that a second
 * store reading it back sees the same secrets, that the ciphertext does
 * not contain the plaintext — and a mocked filesystem can be made to
 * agree with any of those without them being true.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync } from "node:fs";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  acquireLock,
  FileSecretStore,
  readSecretFilePermissions,
  SecretFileLockTimeoutError,
  SecretFileKeyMismatchError,
  tightenSecretFilePermissions,
} from "@inspector/core/auth/node/file-secret-store.js";
import { SecretStoreUnavailableError } from "@inspector/core/auth/node/secret-store.js";
import { SECRET_FIELD_OAUTH_CLIENT_SECRET } from "@inspector/core/auth/secret-fields.js";
import { describeSecretStoreContract } from "./secretStoreContract.js";

let tmpDir: string;
const filePath = (): string => path.join(tmpDir, "secrets.json");

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "inspector-secrets-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// Both modes must satisfy the same contract — encryption is a property of
// the bytes on disk, not of the interface, and a caller must not be able to
// tell which one it got.
describeSecretStoreContract(
  "FileSecretStore (plaintext)",
  () => new FileSecretStore({ filePath: filePath() }),
);
describeSecretStoreContract(
  "FileSecretStore (encrypted)",
  () => new FileSecretStore({ filePath: filePath(), passphrase: "hunter2" }),
);

describe("FileSecretStore persistence", () => {
  it("a second store instance reads what the first wrote", async () => {
    const a = new FileSecretStore({ filePath: filePath() });
    await a.set("alpha", SECRET_FIELD_OAUTH_CLIENT_SECRET, "shh");
    const b = new FileSecretStore({ filePath: filePath() });
    expect(await b.get("alpha", SECRET_FIELD_OAUTH_CLIENT_SECRET)).toBe("shh");
  });

  it("round-trips through a real encrypt/decrypt cycle across instances", async () => {
    const a = new FileSecretStore({
      filePath: filePath(),
      passphrase: "hunter2",
    });
    await a.set("alpha", SECRET_FIELD_OAUTH_CLIENT_SECRET, "shh");
    const b = new FileSecretStore({
      filePath: filePath(),
      passphrase: "hunter2",
    });
    expect(await b.get("alpha", SECRET_FIELD_OAUTH_CLIENT_SECRET)).toBe("shh");
  });

  it("writes the file 0600", async () => {
    const store = new FileSecretStore({ filePath: filePath() });
    await store.set("alpha", SECRET_FIELD_OAUTH_CLIENT_SECRET, "shh");
    const stat = await fs.stat(filePath());
    // Windows does not model POSIX modes; asserting there would fail for a
    // reason that has nothing to do with this code.
    if (process.platform !== "win32") {
      expect(stat.mode & 0o777).toBe(0o600);
    }
  });

  it("concurrent sets do not lose each other (the read-modify-write race)", async () => {
    // The route handlers write a server's fields with `Promise.all`, so this
    // is the ordinary path. Without the internal queue both calls read the
    // same empty map and the second write drops the first entry.
    const store = new FileSecretStore({ filePath: filePath() });
    await Promise.all([
      store.set("alpha", "env:A", "1"),
      store.set("alpha", "env:B", "2"),
      store.set("alpha", "env:C", "3"),
    ]);
    expect(await store.get("alpha", "env:A")).toBe("1");
    expect(await store.get("alpha", "env:B")).toBe("2");
    expect(await store.get("alpha", "env:C")).toBe("3");
  });

  it("keeps the file after the last entry is deleted", async () => {
    // The file's presence records which encryption mode this install settled
    // on; unlinking it would let a later write silently switch modes.
    const store = new FileSecretStore({ filePath: filePath() });
    await store.set("alpha", SECRET_FIELD_OAUTH_CLIENT_SECRET, "shh");
    await store.deleteAllForServer("alpha");
    await expect(fs.stat(filePath())).resolves.toBeDefined();
  });
});

describe("FileSecretStore at rest", () => {
  it("plaintext mode stores the value readably (the state the warning is about)", async () => {
    const store = new FileSecretStore({ filePath: filePath() });
    expect(store.encrypted).toBe(false);
    await store.set("alpha", SECRET_FIELD_OAUTH_CLIENT_SECRET, "super-secret");
    const raw = await fs.readFile(filePath(), "utf-8");
    expect(raw).toContain("super-secret");
    expect(JSON.parse(raw).encryption).toBe("none");
  });

  it("encrypted mode leaves neither the value nor the account name on disk", async () => {
    const store = new FileSecretStore({
      filePath: filePath(),
      passphrase: "hunter2",
    });
    expect(store.encrypted).toBe(true);
    await store.set("alpha", SECRET_FIELD_OAUTH_CLIENT_SECRET, "super-secret");
    const raw = await fs.readFile(filePath(), "utf-8");
    expect(raw).not.toContain("super-secret");
    // The account names are encrypted too — that's why the map is encrypted
    // as a unit rather than value-by-value, since the key list would
    // otherwise index which servers hold which kind of secret.
    expect(raw).not.toContain("alpha");
    expect(raw).not.toContain(SECRET_FIELD_OAUTH_CLIENT_SECRET);
    const parsed = JSON.parse(raw);
    expect(parsed.encryption).toBe("aes-256-gcm");
    expect(parsed.kdf.algorithm).toBe("scrypt");
  });

  it("treats a blank passphrase as no passphrase", async () => {
    // `MCP_INSPECTOR_SECRET_KEY=` in a compose file means "off", not a
    // zero-length key — and silently encrypting with "" would be worse than
    // either reading.
    expect(
      new FileSecretStore({ filePath: filePath(), passphrase: "   " })
        .encrypted,
    ).toBe(false);
  });

  it("upgrades an existing plaintext file to encrypted on the next write", async () => {
    const plain = new FileSecretStore({ filePath: filePath() });
    await plain.set("alpha", "env:A", "1");
    const encrypted = new FileSecretStore({
      filePath: filePath(),
      passphrase: "hunter2",
    });
    // Reads the plaintext file it inherited...
    expect(await encrypted.get("alpha", "env:A")).toBe("1");
    // ...and the next write carries the old entry into the encrypted form,
    // so setting the env var does not strand the secrets already stored.
    await encrypted.set("alpha", "env:B", "2");
    const raw = await fs.readFile(filePath(), "utf-8");
    expect(JSON.parse(raw).encryption).toBe("aes-256-gcm");
    expect(await encrypted.get("alpha", "env:A")).toBe("1");
  });
});

describe("FileSecretStore failure handling", () => {
  const writeEncryptedFixture = async (): Promise<void> => {
    const store = new FileSecretStore({
      filePath: filePath(),
      passphrase: "right-key",
    });
    await store.set("alpha", SECRET_FIELD_OAUTH_CLIENT_SECRET, "shh");
  };

  it("get returns null when the passphrase is wrong (read tolerance)", async () => {
    await writeEncryptedFixture();
    const store = new FileSecretStore({
      filePath: filePath(),
      passphrase: "wrong-key",
    });
    expect(await store.get("alpha", SECRET_FIELD_OAUTH_CLIENT_SECRET)).toBe(
      null,
    );
  });

  it("set refuses rather than overwriting a file it cannot decrypt", async () => {
    await writeEncryptedFixture();
    const store = new FileSecretStore({
      filePath: filePath(),
      passphrase: "wrong-key",
    });
    await expect(store.set("alpha", "env:A", "1")).rejects.toBeInstanceOf(
      SecretFileKeyMismatchError,
    );
    // The original secrets survive: the refusal is the whole point.
    const original = new FileSecretStore({
      filePath: filePath(),
      passphrase: "right-key",
    });
    expect(await original.get("alpha", SECRET_FIELD_OAUTH_CLIENT_SECRET)).toBe(
      "shh",
    );
  });

  it("set names the missing passphrase when the key was removed entirely", async () => {
    await writeEncryptedFixture();
    const store = new FileSecretStore({ filePath: filePath() });
    await expect(store.set("alpha", "env:A", "1")).rejects.toThrow(
      /MCP_INSPECTOR_SECRET_KEY is not set/,
    );
  });

  it("reads a plaintext file that carries no secrets key as empty", async () => {
    // A hand-edited (or hand-created) file is the realistic source of this
    // shape, and it must read as "no secrets yet" rather than throwing: the
    // document is well-formed and declares its encryption mode, so the only
    // thing missing is entries. Flattening it to `{}` is also what lets the
    // next `set` add one instead of refusing.
    await fs.writeFile(
      filePath(),
      JSON.stringify({ version: 1, encryption: "none" }),
      "utf-8",
    );
    const store = new FileSecretStore({ filePath: filePath() });
    expect(await store.get("alpha", SECRET_FIELD_OAUTH_CLIENT_SECRET)).toBe(
      null,
    );
    await store.set("alpha", SECRET_FIELD_OAUTH_CLIENT_SECRET, "shh");
    expect(await store.get("alpha", SECRET_FIELD_OAUTH_CLIENT_SECRET)).toBe(
      "shh",
    );
  });

  it("refuses a file written by a newer format version", async () => {
    // Readable as far as the plaintext branch is concerned, which is the trap:
    // accepting it means the next write rewrites it as version 1 and silently
    // drops whatever the newer format added. Same refusal the encrypted branch
    // already gives, so the answer doesn't depend on which mode the newer
    // writer happened to choose.
    await fs.writeFile(
      filePath(),
      JSON.stringify({
        version: 2,
        encryption: "none",
        secrets: { "a:b": "1" },
      }),
      "utf-8",
    );
    const store = new FileSecretStore({ filePath: filePath() });
    expect(await store.get("a", "b")).toBe(null);
    await expect(store.set("a", "b", "2")).rejects.toThrow(/version 2/);
    // The bytes are still there — nothing was destroyed to answer the write.
    const raw = JSON.parse(await fs.readFile(filePath(), "utf-8")) as {
      version: number;
    };
    expect(raw.version).toBe(2);
  });

  it("delete stays silent on a file it cannot decrypt", async () => {
    await writeEncryptedFixture();
    const store = new FileSecretStore({
      filePath: filePath(),
      passphrase: "wrong-key",
    });
    await expect(
      store.delete("alpha", SECRET_FIELD_OAUTH_CLIENT_SECRET),
    ).resolves.toBeUndefined();
    await expect(store.deleteAllForServer("alpha")).resolves.toBeUndefined();
  });

  it("set reports a corrupt file rather than silently replacing it", async () => {
    await fs.writeFile(filePath(), "{ not json", "utf-8");
    const store = new FileSecretStore({ filePath: filePath() });
    await expect(store.set("alpha", "env:A", "1")).rejects.toBeInstanceOf(
      SecretStoreUnavailableError,
    );
    expect(await store.get("alpha", "env:A")).toBe(null);
  });

  it("set reports a file written by a newer format version", async () => {
    // The forward-compat case: a newer Inspector's file, opened by an older
    // one. Refusing beats truncating it to the entries we happen to parse.
    // The version is checked before the encryption mode, so this is the
    // message even though the cipher is also unrecognized — the version is
    // the more actionable of the two ("upgrade"), and it is the reason the
    // file is unreadable regardless of what the cipher turned out to be.
    await fs.writeFile(
      filePath(),
      JSON.stringify({ version: 99, encryption: "chacha20-poly1305" }),
      "utf-8",
    );
    const store = new FileSecretStore({ filePath: filePath() });
    await expect(store.set("alpha", "env:A", "1")).rejects.toThrow(
      /format version 99/,
    );
  });

  it("set reports an unrecognized cipher at a version it does understand", async () => {
    // The other half: a file this build's version check accepts, whose
    // encryption mode it has no code for. A different failure with different
    // advice, so it must not collapse into the version message.
    await fs.writeFile(
      filePath(),
      JSON.stringify({ version: 1, encryption: "chacha20-poly1305" }),
      "utf-8",
    );
    const store = new FileSecretStore({ filePath: filePath() });
    await expect(store.set("alpha", "env:A", "1")).rejects.toThrow(
      /unsupported format/,
    );
  });

  it("set reports a truncated ciphertext payload", async () => {
    await writeEncryptedFixture();
    const parsed = JSON.parse(await fs.readFile(filePath(), "utf-8"));
    parsed.data = "only-one-part";
    await fs.writeFile(filePath(), JSON.stringify(parsed), "utf-8");
    const store = new FileSecretStore({
      filePath: filePath(),
      passphrase: "right-key",
    });
    await expect(store.set("alpha", "env:A", "1")).rejects.toBeInstanceOf(
      SecretFileKeyMismatchError,
    );
  });

  it("reports a file whose KDF parameters are unusable", async () => {
    // scrypt rejects on out-of-grammar cost parameters (`N` must be a power of
    // two > 1). Those parameters come off disk, so this is a corrupt-file case
    // reachable without touching the crypto call site — and it must land as a
    // refusal, not as an exception escaping the derivation.
    await writeEncryptedFixture();
    const parsed = JSON.parse(await fs.readFile(filePath(), "utf-8"));
    parsed.kdf.N = 3;
    await fs.writeFile(filePath(), JSON.stringify(parsed), "utf-8");
    const store = new FileSecretStore({
      filePath: filePath(),
      passphrase: "right-key",
    });
    expect(await store.get("alpha", SECRET_FIELD_OAUTH_CLIENT_SECRET)).toBe(
      null,
    );
    await expect(store.set("alpha", "env:A", "1")).rejects.toBeInstanceOf(
      SecretFileKeyMismatchError,
    );
  });

  it("reports a read failure that isn't a missing file", async () => {
    // A directory where the file should be: `readStoreFile` only translates
    // ENOENT into "no file yet", so anything else must surface as a refusal
    // rather than being read as an empty store and overwritten.
    const asDir = path.join(tmpDir, "as-dir");
    await fs.mkdir(asDir);
    const store = new FileSecretStore({ filePath: asDir });
    await expect(store.set("alpha", "env:A", "1")).rejects.toBeInstanceOf(
      SecretStoreUnavailableError,
    );
  });

  it("a rejected set leaves the same store usable for later operations", async () => {
    // The internal queue swallows failures on its chain so one rejection can't
    // strand every subsequent call on that store — the returned promise still
    // rejects, which is what the caller sees.
    await writeEncryptedFixture();
    const store = new FileSecretStore({
      filePath: filePath(),
      passphrase: "wrong-key",
    });
    await expect(store.set("alpha", "env:A", "1")).rejects.toThrow();
    expect(await store.get("alpha", "env:A")).toBe(null);
    await expect(store.delete("alpha", "env:A")).resolves.toBeUndefined();
    await expect(store.set("alpha", "env:B", "2")).rejects.toThrow();
  });

  it("delete is a no-op when the file exists but holds no matching entry", async () => {
    const store = new FileSecretStore({ filePath: filePath() });
    await store.set("alpha", "env:A", "1");
    await store.delete("beta", "env:A");
    await store.deleteAllForServer("gamma");
    expect(await store.get("alpha", "env:A")).toBe("1");
  });

  it("set reports an unreachable location instead of failing silently", async () => {
    // A path whose parent is a *file*: the read fails with ENOTDIR rather
    // than the ENOENT that means "no file yet", so this lands on the read
    // refusal. It is the class the 503 exists for — fixable outside the
    // process.
    const blocker = path.join(tmpDir, "blocker");
    await fs.writeFile(blocker, "x", "utf-8");
    const store = new FileSecretStore({
      filePath: path.join(blocker, "secrets.json"),
    });
    await expect(store.set("alpha", "env:A", "1")).rejects.toThrow(
      /Could not read the secrets file/,
    );
  });

  // A read that succeeds (or reports "no file yet") followed by a write that
  // fails — a read-only mount, a full disk, a permissions change since
  // startup. Reproduced with a non-writable directory, which requires not
  // being root: `chmod` is advisory to uid 0, so under root the write would
  // succeed and the assertion would be wrong rather than merely unexercised.
  // CI runs as an unprivileged user, which is where the coverage gate is
  // enforced.
  const asRoot = process.getuid?.() === 0;
  it.skipIf(asRoot || process.platform === "win32")(
    "set reports a write failure distinctly from a read failure",
    async () => {
      const dir = path.join(tmpDir, "locked");
      await fs.mkdir(dir);
      await fs.chmod(dir, 0o555);
      try {
        const store = new FileSecretStore({
          filePath: path.join(dir, "secrets.json"),
        });
        // Nothing is there to read, so the failure is unambiguously the write.
        await expect(store.set("alpha", "env:A", "1")).rejects.toThrow(
          /Could not write the secrets file/,
        );
      } finally {
        // Restore write permission or the afterEach `rm -rf` can't clean up.
        await fs.chmod(dir, 0o755);
      }
    },
  );

  it("a rejected set does not poison later sets on the same store", async () => {
    // The internal queue swallows on the chain but not on the returned
    // promise; without that, one failure would strand every subsequent write.
    const blocked = path.join(tmpDir, "blocker");
    await fs.writeFile(blocked, "x", "utf-8");
    const bad = new FileSecretStore({
      filePath: path.join(blocked, "secrets.json"),
    });
    await expect(bad.set("alpha", "env:A", "1")).rejects.toThrow();

    // A different store on a good path still works, and so does a second
    // write on the failing one's successor.
    const store = new FileSecretStore({ filePath: filePath() });
    await store.set("alpha", "env:A", "1");
    await store.set("alpha", "env:B", "2");
    expect(await store.get("alpha", "env:A")).toBe("1");
    expect(await store.get("alpha", "env:B")).toBe("2");
  });
});

describe("tightenSecretFilePermissions", () => {
  it("repairs a loosened mode on an existing file", async () => {
    if (process.platform === "win32") return;
    await fs.writeFile(filePath(), "{}", "utf-8");
    await fs.chmod(filePath(), 0o644);
    await tightenSecretFilePermissions(filePath());
    expect((await fs.stat(filePath())).mode & 0o777).toBe(0o600);
  });

  it("readSecretFilePermissions reports the mode without changing it", async () => {
    // The descriptor is rebuilt on every GET /api/config, so the function it
    // calls must not chmod — once per page load, on a file another process
    // may be mid-write on. The repair belongs at startup.
    const store = new FileSecretStore({ filePath: filePath() });
    await store.set("alpha", "env:A", "1");
    await fs.chmod(filePath(), 0o644);
    expect(await readSecretFilePermissions(filePath())).toEqual({
      state: "loose",
      mode: 0o644,
    });
    // Still 0644 — reading did not quietly repair it.
    expect((await fs.stat(filePath())).mode & 0o777).toBe(0o644);
  });

  it("reports absent, not a failure, for a file that doesn't exist yet", async () => {
    // The first-run case. Nothing to tighten and nothing to warn about —
    // `writeStoreFile` creates the file 0600.
    await expect(
      tightenSecretFilePermissions(path.join(tmpDir, "nope.json")),
    ).resolves.toEqual({ state: "absent" });
  });

  it("reports a mode it could not fix, instead of claiming 0600", async () => {
    // The case the caller has to hear about: the docs and the footer both say
    // the file is 0600, so a file we failed to tighten must be surfaced rather
    // than silently described as protected.
    //
    // Driven through a fresh module whose `chmod` rejects — a test cannot
    // readily own a file it lacks permission to chmod, and vitest cannot spy
    // on a `node:fs/promises` export because the ESM namespace is not
    // configurable.
    const store = new FileSecretStore({ filePath: filePath() });
    await store.set("alpha", "env:A", "1");
    await fs.chmod(filePath(), 0o644);

    vi.resetModules();
    vi.doMock("node:fs/promises", async () => {
      const actual =
        await vi.importActual<typeof import("node:fs/promises")>(
          "node:fs/promises",
        );
      return {
        ...actual,
        default: actual,
        chmod: vi.fn(() =>
          Promise.reject(new Error("EPERM: operation not permitted")),
        ),
      };
    });
    try {
      const mod =
        await import("@inspector/core/auth/node/file-secret-store.js");
      expect(await mod.tightenSecretFilePermissions(filePath())).toEqual({
        state: "loose",
        mode: 0o644,
      });
    } finally {
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }
  });
});

describe("readOnDiskEncryption", () => {
  it("reports what the file is, not what the store would write", async () => {
    // The whole reason it exists: these two disagree for a full session after
    // a passphrase is added to an install that already has a plaintext file.
    const plain = new FileSecretStore({ filePath: filePath() });
    await plain.set("alpha", SECRET_FIELD_OAUTH_CLIENT_SECRET, "shh");

    const withKey = new FileSecretStore({
      filePath: filePath(),
      passphrase: "hunter2",
    });
    expect(withKey.encrypted).toBe(true);
    expect(await withKey.readOnDiskEncryption()).toBe("none");

    await withKey.set("alpha", "env:A", "1");
    expect(await withKey.readOnDiskEncryption()).toBe("aes-256-gcm");
  });

  it("answers null for an absent, unparseable, or unrecognized file", async () => {
    const store = new FileSecretStore({ filePath: filePath() });
    expect(await store.readOnDiskEncryption()).toBe(null);

    await fs.writeFile(filePath(), "{not json", "utf-8");
    expect(await store.readOnDiskEncryption()).toBe(null);

    await fs.writeFile(
      filePath(),
      JSON.stringify({ version: 1, encryption: "rot13" }),
      "utf-8",
    );
    expect(await store.readOnDiskEncryption()).toBe(null);
  });

  it("needs no passphrase — it reads the envelope, never the payload", async () => {
    // A store whose key is wrong still has to be describable in the UI.
    const writer = new FileSecretStore({
      filePath: filePath(),
      passphrase: "right-key",
    });
    await writer.set("alpha", SECRET_FIELD_OAUTH_CLIENT_SECRET, "shh");
    const keyless = new FileSecretStore({ filePath: filePath() });
    expect(await keyless.readOnDiskEncryption()).toBe("aes-256-gcm");
  });
});

/**
 * Write a genuinely-encrypted secrets file whose decrypted payload is
 * `payload` — including payloads the store would never produce.
 *
 * Hand-rolled against the documented format rather than driven through the
 * store, because the whole point is to reach a state the store's own writer
 * cannot create: an authentic ciphertext (right passphrase, valid GCM tag)
 * carrying the wrong shape. Anything less would test the key check instead
 * of the shape check.
 */
async function writeEncryptedFixtureWithPayload(
  payload: unknown,
  passphrase: string,
): Promise<void> {
  const salt = crypto.randomBytes(16);
  const kdf = {
    algorithm: "scrypt",
    salt: salt.toString("base64"),
    N: 16384,
    r: 8,
    p: 1,
  };
  const key: Buffer = await new Promise((resolve, reject) => {
    crypto.scrypt(
      passphrase,
      salt,
      32,
      { N: kdf.N, r: kdf.r, p: kdf.p },
      (err, k) => (err ? reject(err) : resolve(k)),
    );
  });
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf-8"),
    cipher.final(),
  ]);
  const data = [iv, cipher.getAuthTag(), body]
    .map((b) => b.toString("base64"))
    .join(".");
  await fs.writeFile(
    filePath(),
    JSON.stringify({ version: 1, encryption: "aes-256-gcm", kdf, data }),
    "utf-8",
  );
}

describe("payload shape validation", () => {
  // GCM proves who wrote the bytes, not what shape they parse to, and the
  // plaintext branch proves nothing at all — so neither may be cast.
  it("refuses a plaintext file whose secrets field is an array", async () => {
    // The array is the case a cast cannot survive: it passes `typeof
    // "object"`, takes the named assignment, and then `JSON.stringify` drops
    // every named property — so `set` would resolve having written a file
    // without the secret it was handed.
    await fs.writeFile(
      filePath(),
      JSON.stringify({ version: 1, encryption: "none", secrets: [] }),
      "utf-8",
    );
    const store = new FileSecretStore({ filePath: filePath() });
    await expect(store.set("alpha", "env:A", "1")).rejects.toThrow(/an array/);
    expect(await store.get("alpha", "env:A")).toBe(null);
  });

  it("refuses a plaintext file holding a non-string value", async () => {
    await fs.writeFile(
      filePath(),
      JSON.stringify({
        version: 1,
        encryption: "none",
        secrets: { "alpha:env:A": { nested: true } },
      }),
      "utf-8",
    );
    const store = new FileSecretStore({ filePath: filePath() });
    await expect(store.set("alpha", "env:B", "1")).rejects.toThrow(
      /non-string value for "alpha:env:A"/,
    );
  });

  it("refuses an authentic ciphertext that decodes to the wrong shape", async () => {
    // Encrypted with the right passphrase, so it decrypts cleanly and the
    // refusal can only come from the shape check. It must NOT surface as a key
    // mismatch, which would send the user to fix a passphrase that is working.
    await writeEncryptedFixtureWithPayload([], "hunter2");
    const store = new FileSecretStore({
      filePath: filePath(),
      passphrase: "hunter2",
    });
    expect(await store.get("alpha", "env:A")).toBe(null);
    const err = await store
      .set("alpha", "env:A", "1")
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SecretStoreUnavailableError);
    expect(err).not.toBeInstanceOf(SecretFileKeyMismatchError);
    expect((err as Error).message).toMatch(/an array/);
  });
});

describe("acquireLock", () => {
  it("excludes a second holder while the first is live", async () => {
    const target = path.join(tmpDir, "locked.json");
    const release = await acquireLock(target);
    let secondTaken = false;
    const second = acquireLock(target).then((r) => {
      secondTaken = true;
      return r;
    });
    // Still held: the waiter must not have been let through.
    await new Promise((r) => setTimeout(r, 60));
    expect(secondTaken).toBe(false);
    await release();
    await (
      await second
    )();
    expect(secondTaken).toBe(true);
  });

  it("steals a lock left behind by a killed process", async () => {
    // A container killed with SIGKILL leaves the directory. A lock only a
    // clean exit can release would turn that into permanently broken writes —
    // strictly worse than the race it prevents.
    const target = path.join(tmpDir, "stale.json");
    const lockDir = `${target}.lock`;
    await fs.mkdir(lockDir);
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(lockDir, old, old);
    const release = await acquireLock(target);
    await release();
  });

  it("creates the parent directory so a first write is locked too", async () => {
    // The first run has no secrets directory yet — `writeStoreFile` creates
    // it later. Without creating it here, mkdir failed ENOENT and the lock
    // was skipped, so two processes' *first* writes could both proceed
    // unlocked and overwrite each other. First writes are exactly when two
    // processes are most likely to start together.
    const target = path.join(tmpDir, "no-such-dir", "secrets.json");
    const release = await acquireLock(target, { pollMs: 10 });
    // A real lock was taken: a second acquisition must not be handed out.
    let secondTaken = false;
    // Held, not floated: an acquisition still running when the test ends
    // would race `afterEach` removing the temp directory.
    const second = acquireLock(target, { pollMs: 10 }).then((r) => {
      secondTaken = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 60));
    expect(secondTaken).toBe(false);
    await release();
    await (
      await second
    )();
  });

  it("releases only a lock it still owns", async () => {
    // A holder whose work outran the stale threshold must not delete the
    // next owner's lock on its way out — that would drop a third writer into
    // a section two processes believed they held.
    const target = path.join(tmpDir, "owned.json");
    const lockDir = `${target}.lock`;
    const release = await acquireLock(target);
    // Simulate a steal: someone judged us stale, removed our lock, and took
    // their own.
    await fs.rm(lockDir, { recursive: true, force: true });
    await fs.mkdir(lockDir);
    await fs.writeFile(path.join(lockDir, "owner"), "someone-else", "utf-8");
    await release();
    // Their lock is untouched.
    expect(await fs.readFile(path.join(lockDir, "owner"), "utf-8")).toBe(
      "someone-else",
    );
    await fs.rm(lockDir, { recursive: true, force: true });
  });

  it("fails the mutation rather than writing past a live holder", async () => {
    // Falling through to an unlocked write under contention would be the
    // worst possible moment for it: another writer is provably active. `set`
    // is allowed to hard-fail, so this surfaces as the documented 503.
    //
    // The holder heartbeats faster than it goes stale, so the waiter can
    // never mistake it for dead and must time out instead.
    const target = path.join(tmpDir, "contended.json");
    const timings = {
      staleMs: 400,
      timeoutMs: 250,
      heartbeatMs: 50,
      pollMs: 10,
    };
    const release = await acquireLock(target, timings);
    try {
      await expect(acquireLock(target, timings)).rejects.toBeInstanceOf(
        SecretFileLockTimeoutError,
      );
    } finally {
      await release();
    }
  });

  it("does not steal from a holder that is merely slow", async () => {
    // The heartbeat is what separates "dead" from "slow". Without it a
    // holder on a slow filesystem loses its lock mid-section and the lost
    // update comes straight back — so the waiter here must time out rather
    // than acquire, even though it waits well past the stale threshold.
    const target = path.join(tmpDir, "slow.json");
    const release = await acquireLock(target, {
      staleMs: 120,
      timeoutMs: 60_000,
      heartbeatMs: 20,
      pollMs: 10,
    });
    try {
      let stolen = false;
      // Held and settled below rather than floated, so the waiter cannot
      // still be running when `afterEach` removes the temp directory.
      const waiter = acquireLock(target, {
        staleMs: 120,
        timeoutMs: 400,
        pollMs: 10,
      })
        .then(async (r) => {
          stolen = true;
          await r();
        })
        .catch(() => {
          // Timed out, which is the expected outcome.
        });
      await waiter;
      expect(stolen).toBe(false);
    } finally {
      await release();
    }
  });

  it("does not steal a stale lock whose owner process is still alive", async () => {
    // An old mtime means the holder has not heartbeated lately, and there are
    // two very different reasons: it died, or it is alive but not running —
    // SIGSTOPed, event-loop-blocked, or on a machine that suspended. Taking
    // the lock on elapsed time alone would pull it out from under a live
    // critical section, which is the lost update the lock exists to prevent.
    const target = path.join(tmpDir, "suspended.json");
    const lockDir = `${target}.lock`;
    await fs.mkdir(lockDir, { recursive: true });
    // Stamp it with *this* process, which is definitionally alive, and age it
    // well past stale — the shape of a suspended holder.
    await fs.writeFile(
      path.join(lockDir, "owner"),
      JSON.stringify({
        token: "someone",
        pid: process.pid,
        host: os.hostname(),
      }),
      "utf-8",
    );
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(lockDir, old, old);

    await expect(
      acquireLock(target, { staleMs: 50, timeoutMs: 150, pollMs: 10 }),
    ).rejects.toBeInstanceOf(SecretFileLockTimeoutError);
    // Their lock survives the attempt.
    expect(existsSync(lockDir)).toBe(true);
    await fs.rm(lockDir, { recursive: true, force: true });
  });

  it("steals a stale lock whose owner process is gone", async () => {
    // The case the stealing exists for. A pid that no longer resolves is a
    // dead holder, and refusing to break its lock would turn one killed
    // container into permanently broken secret writes.
    const target = path.join(tmpDir, "dead.json");
    const lockDir = `${target}.lock`;
    await fs.mkdir(lockDir, { recursive: true });
    await fs.writeFile(
      path.join(lockDir, "owner"),
      // A pid that cannot be running: `kill(0)` answers ESRCH.
      JSON.stringify({ token: "gone", pid: 2 ** 31 - 1, host: os.hostname() }),
      "utf-8",
    );
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(lockDir, old, old);

    const release = await acquireLock(target, {
      staleMs: 50,
      timeoutMs: 2_000,
      pollMs: 10,
    });
    await release();
  });

  it("steals a stale lock stamped by another machine", async () => {
    // A shared filesystem: we cannot ask this host about that host's pid, so
    // the mtime is all there is. Refusing would make a lock nothing can ever
    // break.
    const target = path.join(tmpDir, "remote.json");
    const lockDir = `${target}.lock`;
    await fs.mkdir(lockDir, { recursive: true });
    await fs.writeFile(
      path.join(lockDir, "owner"),
      JSON.stringify({
        token: "elsewhere",
        pid: process.pid,
        host: "some-other-host",
      }),
      "utf-8",
    );
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(lockDir, old, old);

    const release = await acquireLock(target, {
      staleMs: 50,
      timeoutMs: 2_000,
      pollMs: 10,
    });
    await release();
  });

  it("cleans up and reports when it cannot stamp ownership", async () => {
    // mkdir succeeded, the owner write did not. Returning a no-op release
    // here would enter the critical section unlocked *and* leave the
    // directory behind, so every later writer queues behind an orphan nobody
    // can deliberately release.
    const target = path.join(tmpDir, "unstampable.json");
    vi.resetModules();
    vi.doMock("node:fs/promises", async () => {
      const actual =
        await vi.importActual<typeof import("node:fs/promises")>(
          "node:fs/promises",
        );
      return {
        ...actual,
        default: actual,
        writeFile: vi.fn((p: string, ...rest: unknown[]) =>
          String(p).endsWith(`${path.sep}owner`)
            ? Promise.reject(new Error("ENOSPC: no space left on device"))
            : (actual.writeFile as (...a: unknown[]) => Promise<void>)(
                p,
                ...rest,
              ),
        ),
      };
    });
    try {
      const mod =
        await import("@inspector/core/auth/node/file-secret-store.js");
      await expect(mod.acquireLock(target)).rejects.toThrow(
        /Could not initialize the lock/,
      );
      // And nothing is left obstructing the next writer.
      expect(existsSync(`${target}.lock`)).toBe(false);
    } finally {
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }
  });

  it("serializes concurrent writers through two independent store instances", async () => {
    // Two `FileSecretStore` objects have separate in-process queues, so this
    // is the cross-process race in miniature: without the file lock the second
    // write drops the first one's entry.
    const target = path.join(tmpDir, "shared.json");
    const a = new FileSecretStore({ filePath: target });
    const b = new FileSecretStore({ filePath: target });
    await Promise.all([
      a.set("alpha", "env:A", "1"),
      b.set("alpha", "env:B", "2"),
    ]);
    expect(await a.get("alpha", "env:A")).toBe("1");
    expect(await a.get("alpha", "env:B")).toBe("2");
  });
});

describe("tightenSecretFilePermissions reports what it could not fix", () => {
  it("says absent when there is no file yet", async () => {
    expect(await tightenSecretFilePermissions(filePath())).toEqual({
      state: "absent",
    });
  });

  it("says ok once the file is 0600", async () => {
    const store = new FileSecretStore({ filePath: filePath() });
    await store.set("alpha", "env:A", "1");
    await fs.chmod(filePath(), 0o644);
    expect(await tightenSecretFilePermissions(filePath())).toEqual({
      state: "ok",
    });
  });
});
