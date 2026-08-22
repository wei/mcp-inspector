/**
 * The store-selection policy (#1950).
 *
 * The two questions this file exists to pin down are the ones a reviewer
 * would want proof of, because getting either wrong silently changes where
 * a user's secret goes:
 *
 *  1. an unreachable keychain falls back rather than failing, and says so;
 *  2. the fallback is `memory` in a container with nothing durable
 *     mounted, and `file` otherwise.
 *
 * `resolveSecretStore` caches its answer for the process, so each case
 * that exercises it goes through `vi.resetModules()` + a fresh dynamic
 * import — the same technique the keyring-unloadable cases in
 * `secret-store.test.ts` use, and for the same reason. The keychain probe
 * is mocked because CI has no libsecret; the container and mount
 * predicates are driven directly rather than through a real container,
 * which is what makes them worth exporting.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  chooseFallbackKind,
  isOnMountPoint,
  parseSecretStoreEnv,
  warnAboutSecretStorage,
} from "@inspector/core/auth/node/secret-store-selection.js";
import type { SecretStorageInfo } from "@inspector/core/auth/secret-storage-info.js";

const ENV_KEYS = [
  "MCP_INSPECTOR_SECRET_STORE",
  "MCP_INSPECTOR_SECRET_FILE",
  "MCP_INSPECTOR_SECRET_KEY",
  "MCP_STORAGE_DIR",
  "KUBERNETES_SERVICE_HOST",
];

let saved: Record<string, string | undefined>;
let tmpDir: string;

beforeEach(async () => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "inspector-selection-"));
});

afterEach(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await fs.rm(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/**
 * Load a fresh copy of the selection module with the keychain probe forced
 * to a given answer. Fresh because the resolution is cached per module
 * instance, which is exactly the behavior we don't want leaking between
 * cases.
 */
async function loadWithProbe(available: boolean, detail = "no D-Bus session") {
  vi.resetModules();
  vi.doMock("@inspector/core/auth/node/secret-store.js", async () => {
    const actual = await vi.importActual<
      typeof import("@inspector/core/auth/node/secret-store.js")
    >("@inspector/core/auth/node/secret-store.js");
    return {
      ...actual,
      probeKeyringAvailable: vi.fn(async () =>
        available ? { available: true } : { available: false, detail },
      ),
    };
  });
  return import("@inspector/core/auth/node/secret-store-selection.js");
}

describe("parseSecretStoreEnv", () => {
  it("accepts each kind, case- and whitespace-insensitively", () => {
    expect(parseSecretStoreEnv("keyring")).toBe("keyring");
    expect(parseSecretStoreEnv(" FILE ")).toBe("file");
    expect(parseSecretStoreEnv("Memory")).toBe("memory");
  });

  it("treats unset and blank as unset", () => {
    expect(parseSecretStoreEnv(undefined)).toBeUndefined();
    expect(parseSecretStoreEnv("  ")).toBeUndefined();
  });

  it("warns and falls through on a typo rather than refusing to start", () => {
    // A misspelled env var in a compose file should not be the reason the
    // Inspector won't boot — the automatic policy is a working default.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parseSecretStoreEnv("keychain")).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("keyring, file, memory"),
    );
  });
});

describe("chooseFallbackKind", () => {
  it("uses memory in a container with nothing mounted", () => {
    // The honest answer: a file in the writable layer is discarded by
    // `docker run --rm` and by any image update, so promising durability
    // there is worse than declining to.
    expect(chooseFallbackKind({ container: true, mounted: false })).toBe(
      "memory",
    );
  });

  it("uses file in a container once a volume is mounted", () => {
    // Mounting the volume *is* the user saying this directory should
    // survive, so no extra configuration should be needed to honor it.
    expect(chooseFallbackKind({ container: true, mounted: true })).toBe("file");
  });

  it("uses file outside a container, mounted or not", () => {
    expect(chooseFallbackKind({ container: false, mounted: false })).toBe(
      "file",
    );
    expect(chooseFallbackKind({ container: false, mounted: true })).toBe(
      "file",
    );
  });
});

describe("isContainer", () => {
  /**
   * Load the module with `node:fs` stubbed, so each detection signal can be
   * exercised on a developer's laptop. The three exist because no single one
   * covers the runtimes people use — Docker, Podman/containerd, and
   * Kubernetes each announce themselves differently.
   */
  async function loadWithFs(opts: {
    dockerenv?: boolean;
    cgroup?: string | Error;
  }) {
    vi.resetModules();
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      return {
        ...actual,
        existsSync: (p: string) =>
          p === "/.dockerenv" ? !!opts.dockerenv : actual.existsSync(p),
        readFileSync: (p: string, enc?: unknown) => {
          if (p === "/proc/1/cgroup") {
            if (opts.cgroup instanceof Error) throw opts.cgroup;
            if (opts.cgroup === undefined) throw new Error("ENOENT");
            return opts.cgroup;
          }
          return actual.readFileSync(p, enc as never);
        },
      };
    });
    return import("@inspector/core/auth/node/secret-store-selection.js");
  }

  afterEach(() => {
    vi.doUnmock("node:fs");
    vi.resetModules();
  });

  it("is true inside Kubernetes, without touching the filesystem", async () => {
    process.env.KUBERNETES_SERVICE_HOST = "10.0.0.1";
    const mod = await loadWithFs({});
    expect(mod.isContainer()).toBe(true);
  });

  it("is true when /.dockerenv exists", async () => {
    const mod = await loadWithFs({ dockerenv: true });
    expect(mod.isContainer()).toBe(true);
  });

  it("is true when a container runtime appears in /proc/1/cgroup", async () => {
    const mod = await loadWithFs({
      cgroup: "0::/system.slice/containerd.service\n",
    });
    expect(mod.isContainer()).toBe(true);
  });

  it("is false for a host cgroup line", async () => {
    const mod = await loadWithFs({
      cgroup: "0::/user.slice/user-1000.slice\n",
    });
    expect(mod.isContainer()).toBe(false);
  });

  it("is false when neither signal is readable (macOS, or no /proc)", async () => {
    // Not a container as far as we know — and a false negative is the cheap
    // direction, since it only biases the fallback between two working stores.
    const mod = await loadWithFs({ cgroup: new Error("ENOENT") });
    expect(mod.isContainer()).toBe(false);
  });
});

describe("isOnMountPoint", () => {
  it("is false for an ordinary directory", () => {
    expect(isOnMountPoint(tmpDir)).toBe(false);
  });

  it("is false for a path that doesn't exist yet, walking to its parent", () => {
    // The first-run shape: `~/.mcp-inspector` has not been created. Answering
    // from the nearest existing ancestor is what keeps this from being a
    // missing-file error at startup.
    expect(isOnMountPoint(path.join(tmpDir, "nope", "deeper"))).toBe(false);
  });

  it("is false when the path itself can't be resolved", () => {
    // A NUL byte makes `path.resolve` throw. Any failure to answer the
    // question resolves to "not a mount", which keeps a container on the
    // conservative side — memory, which never promises what it can't keep.
    expect(isOnMountPoint("bad\0path")).toBe(false);
  });

  it("is false at the filesystem root", () => {
    // `/` is its own parent and is trivially a mount — reporting true there
    // would make every container look like it had a volume.
    expect(isOnMountPoint(path.parse(process.cwd()).root)).toBe(false);
  });
});

describe("warnAboutSecretStorage", () => {
  const base: SecretStorageInfo = {
    kind: "keyring",
    reason: "default",
    durable: true,
  };

  it("says nothing for the ordinary keychain case", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    warnAboutSecretStorage(base);
    expect(warn).not.toHaveBeenCalled();
  });

  it("announces a fallback, names the cause, and points at the override", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    warnAboutSecretStorage({
      kind: "memory",
      reason: "fallback",
      durable: false,
      detail: "no D-Bus session",
    });
    const output = warn.mock.calls.flat().join("\n");
    expect(output).toContain("OS keychain is not available");
    expect(output).toContain("no D-Bus session");
    expect(output).toContain("MCP_INSPECTOR_SECRET_STORE");
    // The lossy-store caveat rides along — this is the "loud" half of
    // "automatic fallback with a loud banner".
    expect(output).toContain("lost when the Inspector exits");
  });

  it("warns about an unencrypted file even when it was explicitly chosen", () => {
    // `reason: "configured"` means the user picked `file`; it does not mean
    // they knew it would be unencrypted.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    warnAboutSecretStorage({
      kind: "file",
      reason: "configured",
      durable: true,
      plaintext: true,
      path: "/tmp/secrets.json",
    });
    expect(warn.mock.calls.flat().join("\n")).toContain(
      "MCP_INSPECTOR_SECRET_KEY",
    );
  });
});

describe("resolveSecretStore", () => {
  it("uses the keychain when the probe succeeds", async () => {
    const mod = await loadWithProbe(true);
    const { info } = await mod.resolveSecretStore();
    expect(info).toMatchObject({ kind: "keyring", reason: "default" });
  });

  it("caches the resolution so every consumer describes the same store", async () => {
    // The banner, `/api/config`, and the store doing the writing are three
    // readers of one decision; a re-probe that flipped would have the UI
    // naming a store nobody is using.
    const mod = await loadWithProbe(true);
    expect(await mod.resolveSecretStore()).toBe(await mod.resolveSecretStore());
  });

  it("falls back with a reason and a detail when the probe fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.MCP_INSPECTOR_SECRET_FILE = path.join(tmpDir, "secrets.json");
    const mod = await loadWithProbe(false, "Couldn't access platform storage");
    const { info, store } = await mod.resolveSecretStore();
    expect(info.reason).toBe("fallback");
    expect(info.detail).toContain("Couldn't access platform storage");
    // And the store it hands back actually works — the point of falling back.
    await store.set("alpha", "env:A", "1");
    expect(await store.get("alpha", "env:A")).toBe("1");
  });

  it("honors an explicit memory store without probing", async () => {
    process.env.MCP_INSPECTOR_SECRET_STORE = "memory";
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const mod = await loadWithProbe(true);
    const { info } = await mod.resolveSecretStore();
    expect(info).toMatchObject({
      kind: "memory",
      reason: "configured",
      durable: false,
    });
  });

  it("honors an explicit file store, reporting its path and encryption state", async () => {
    const target = path.join(tmpDir, "custom", "secrets.json");
    process.env.MCP_INSPECTOR_SECRET_STORE = "file";
    process.env.MCP_INSPECTOR_SECRET_FILE = target;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const mod = await loadWithProbe(true);
    const { info } = await mod.resolveSecretStore();
    expect(info).toMatchObject({
      kind: "file",
      reason: "configured",
      path: target,
      plaintext: true,
      durable: true,
    });
  });

  it("reports an encrypted file when the passphrase is set", async () => {
    process.env.MCP_INSPECTOR_SECRET_STORE = "file";
    process.env.MCP_INSPECTOR_SECRET_FILE = path.join(tmpDir, "secrets.json");
    process.env.MCP_INSPECTOR_SECRET_KEY = "hunter2";
    const mod = await loadWithProbe(true);
    const { info } = await mod.resolveSecretStore();
    expect(info.plaintext).toBe(false);
  });

  it("getSecretStorageInfo returns the same descriptor as the resolution", async () => {
    const mod = await loadWithProbe(true);
    const { info } = await mod.resolveSecretStore();
    expect(await mod.getSecretStorageInfo()).toBe(info);
  });
});

describe("defaultSecretStore", () => {
  it("delegates every operation to the resolved store", async () => {
    // The deferred wrapper exists so the synchronous `?? defaultSecretStore()`
    // call sites keep working; if it stopped forwarding, secrets would vanish
    // into an object nobody reads.
    process.env.MCP_INSPECTOR_SECRET_STORE = "memory";
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const mod = await loadWithProbe(true);
    const store = mod.defaultSecretStore();

    await store.set("alpha", "env:A", "1");
    await store.set("alpha", "env:B", "2");
    await store.set("beta", "env:A", "3");
    expect(await store.get("alpha", "env:A")).toBe("1");

    await store.delete("alpha", "env:A");
    expect(await store.get("alpha", "env:A")).toBe(null);

    await store.deleteAllForServer("alpha");
    expect(await store.get("alpha", "env:B")).toBe(null);
    expect(await store.get("beta", "env:A")).toBe("3");

    // And it is the *same* underlying store the resolution reports.
    const { store: resolvedStore } = await mod.resolveSecretStore();
    expect(await resolvedStore.get("beta", "env:A")).toBe("3");
  });
});

describe("defaultSecretFilePath", () => {
  it("resolves a relative override to an absolute path", async () => {
    // The path is shown in the UI footer, so a relative one would be
    // ambiguous about which directory it is relative to.
    process.env.MCP_INSPECTOR_SECRET_FILE = "./rel/secrets.json";
    const mod = await loadWithProbe(true);
    expect(path.isAbsolute(mod.defaultSecretFilePath())).toBe(true);
  });

  it("defaults to ~/.mcp-inspector/secrets.json", async () => {
    const mod = await loadWithProbe(true);
    expect(mod.defaultSecretFilePath()).toContain(
      path.join(".mcp-inspector", "secrets.json"),
    );
  });

  it("follows MCP_STORAGE_DIR when no explicit file is named", async () => {
    // The variable that already relocates OAuth tokens and client.json. A
    // container mounting only that directory must not be judged unmounted and
    // demoted to `memory` — the user arranged for exactly this directory to
    // survive.
    process.env.MCP_STORAGE_DIR = tmpDir;
    const mod = await loadWithProbe(true);
    expect(mod.defaultSecretFilePath()).toBe(path.join(tmpDir, "secrets.json"));
  });

  it("lets an explicit MCP_INSPECTOR_SECRET_FILE outrank MCP_STORAGE_DIR", async () => {
    // Naming the file outright is the more specific statement of the two.
    process.env.MCP_STORAGE_DIR = tmpDir;
    process.env.MCP_INSPECTOR_SECRET_FILE = path.join(tmpDir, "elsewhere.json");
    const mod = await loadWithProbe(true);
    expect(mod.defaultSecretFilePath()).toBe(
      path.join(tmpDir, "elsewhere.json"),
    );
  });
});

describe("the descriptor reports the file, not the write policy", () => {
  it("says plaintext while a pre-existing plaintext file is only *going* to be encrypted", async () => {
    // The transitional state: the passphrase is set, so the next write will
    // encrypt, but the bytes on disk are still readable. Reporting "File
    // (encrypted)" here is the one false reassurance this subsystem exists to
    // avoid.
    const filePath = path.join(tmpDir, "secrets.json");
    process.env.MCP_INSPECTOR_SECRET_FILE = filePath;
    process.env.MCP_INSPECTOR_SECRET_STORE = "file";
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const plain = await loadWithProbe(false);
    await plain.defaultSecretStore().set("alpha", "env:A", "1");

    // Same file, now with a passphrase configured.
    process.env.MCP_INSPECTOR_SECRET_KEY = "hunter2";
    const withKey = await loadWithProbe(false);
    const info = await withKey.getSecretStorageInfo();
    expect(info.plaintext).toBe(true);
    expect(info.pendingEncryption).toBe(true);

    // And the advice changes with it: telling someone to set a passphrase
    // they have already set is worse than saying nothing.
    const { secretStorageCaveat, secretStorageLabel } =
      await import("@inspector/core/auth/secret-storage-info.js");
    expect(secretStorageLabel(info)).toBe("File (unencrypted)");
    expect(secretStorageCaveat(info)).toMatch(/next time a secret is saved/);
  });

  it("says encrypted once the upgrading write has actually landed", async () => {
    const filePath = path.join(tmpDir, "secrets.json");
    process.env.MCP_INSPECTOR_SECRET_FILE = filePath;
    process.env.MCP_INSPECTOR_SECRET_STORE = "file";
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const plain = await loadWithProbe(false);
    await plain.defaultSecretStore().set("alpha", "env:A", "1");

    process.env.MCP_INSPECTOR_SECRET_KEY = "hunter2";
    const withKey = await loadWithProbe(false);
    await withKey.defaultSecretStore().set("alpha", "env:B", "2");

    const after = await loadWithProbe(false);
    const info = await after.getSecretStorageInfo();
    expect(info.plaintext).toBe(false);
    expect(info.pendingEncryption).toBeUndefined();
  });

  it("falls back to the write policy when there is no file yet", async () => {
    // Nothing on disk to describe, and the policy is then accurate: the first
    // write creates the file in exactly that mode.
    process.env.MCP_INSPECTOR_SECRET_FILE = path.join(tmpDir, "absent.json");
    process.env.MCP_INSPECTOR_SECRET_STORE = "file";
    process.env.MCP_INSPECTOR_SECRET_KEY = "hunter2";
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const mod = await loadWithProbe(false);
    const info = await mod.getSecretStorageInfo();
    expect(info.plaintext).toBe(false);
    expect(info.pendingEncryption).toBeUndefined();
  });
});
