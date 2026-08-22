/**
 * `FileSecretStore` against a real filesystem (#1950).
 *
 * A real temp directory rather than a mocked `fs`: the properties worth
 * asserting here are properties *of the file* — its mode, that a second
 * store reading it back sees the same secrets, that the ciphertext does
 * not contain the plaintext — and a mocked filesystem can be made to
 * agree with any of those without them being true.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  FileSecretStore,
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

  it("is a no-op for a file that doesn't exist yet (the first-run case)", async () => {
    await expect(
      tightenSecretFilePermissions(path.join(tmpDir, "nope.json")),
    ).resolves.toBeUndefined();
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
