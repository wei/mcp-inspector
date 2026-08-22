/**
 * Which {@link SecretStore} this process uses, and how the user finds out
 * (#1950).
 *
 * ## The policy
 *
 * `MCP_INSPECTOR_SECRET_STORE=keyring|file|memory` wins outright. With it
 * unset:
 *
 * 1. Probe the OS keychain. Reachable → use it. This is the overwhelming
 *    majority of runs and nothing changes for them.
 * 2. Unreachable → fall back, **loudly**. Which way we fall back depends
 *    on whether the file we would write is going to survive:
 *    - in a container whose secrets directory is *not* on a mount →
 *      `memory`;
 *    - otherwise → `file`.
 *
 * ## Why automatic
 *
 * Automatic fallback silently changes where a secret lives, which is a
 * real objection to make of a security-adjacent tool. But the objection
 * is to *silently*, not to *automatic*: requiring an env var before any
 * persistence works at all means the container user's first encounter is
 * a 503 with no hint that a working configuration exists — and the store
 * they would then be told to set is the one this code would have picked
 * anyway. So we take the friendly default and pay for it in noise. The
 * downgrade prints a banner, rides `GET /api/config`, and is named in the
 * footer of both settings modals — permanently, where the secret is
 * typed, rather than once at startup where the person typing it 20
 * minutes later will never see it.
 *
 * ## Why memory can be the better answer
 *
 * A file in a container's writable layer looks like persistence and isn't:
 * `docker run --rm` discards it, and so does any image update. An
 * in-memory store makes no such promise, and says so. Mounting a volume —
 * which the README already recommends for the catalog — flips the same
 * run to `file` with no configuration, because the mount is the user
 * stating that this directory is meant to survive.
 */

import * as fsSync from "node:fs";
import * as path from "node:path";
import {
  type SecretStorageInfo,
  type SecretStoreKind,
  secretStorageCaveat,
  secretStorageSummary,
} from "../secret-storage-info.js";
import {
  FileSecretStore,
  tightenSecretFilePermissions,
} from "./file-secret-store.js";
import {
  InMemorySecretStore,
  KeyringSecretStore,
  probeKeyringAvailable,
  type SecretStore,
} from "./secret-store.js";

/** Env var naming an explicit store, bypassing the probe entirely. */
export const SECRET_STORE_ENV = "MCP_INSPECTOR_SECRET_STORE";

/** Env var overriding the secrets file location. */
export const SECRET_FILE_ENV = "MCP_INSPECTOR_SECRET_FILE";

const KINDS: SecretStoreKind[] = ["keyring", "file", "memory"];

export interface ResolvedSecretStore {
  store: SecretStore;
  info: SecretStorageInfo;
}

/**
 * Parse {@link SECRET_STORE_ENV}. An unrecognized value returns undefined
 * (falling through to the automatic policy) after a warning rather than
 * throwing: a typo in a compose file should not stop the Inspector from
 * starting, and the user needs the correct spellings more than a stack.
 */
export function parseSecretStoreEnv(
  raw: string | undefined,
): SecretStoreKind | undefined {
  const value = raw?.trim().toLowerCase();
  if (!value) return undefined;
  if ((KINDS as string[]).includes(value)) return value as SecretStoreKind;
  console.warn(
    `[mcp-inspector] Ignoring ${SECRET_STORE_ENV}="${raw}": expected one of ${KINDS.join(", ")}.`,
  );
  return undefined;
}

/** Default secrets file: beside the catalog, in `~/.mcp-inspector`. */
export function defaultSecretFilePath(): string {
  const override = process.env[SECRET_FILE_ENV]?.trim();
  if (override) return path.resolve(override);
  const homeDir = process.env.HOME || process.env.USERPROFILE || ".";
  return path.join(homeDir, ".mcp-inspector", "secrets.json");
}

/**
 * Are we in a container?
 *
 * Three signals, any of which is sufficient, because no single one covers
 * the runtimes people actually use: `/.dockerenv` is Docker-specific and
 * absent under Podman and containerd; the `/proc/1/cgroup` scan catches
 * those but reads like the host's under cgroup v2 on some setups; and
 * `KUBERNETES_SERVICE_HOST` catches a pod regardless of runtime.
 *
 * A false positive here is cheap and a false negative is cheaper still —
 * this only *biases the fallback* between two working stores, and the
 * mount check below is what actually decides. Nothing about correctness
 * rests on getting this exactly right, which is why it is allowed to be a
 * heuristic at all.
 */
export function isContainer(): boolean {
  if (process.env.KUBERNETES_SERVICE_HOST) return true;
  try {
    if (fsSync.existsSync("/.dockerenv")) return true;
  } catch {
    // A sandboxed / restricted filesystem. Fall through to the cgroup read.
  }
  try {
    const cgroup = fsSync.readFileSync("/proc/1/cgroup", "utf-8");
    return /\b(docker|containerd|kubepods|podman|lxc)\b/.test(cgroup);
  } catch {
    // Not Linux, or /proc is not mounted. Not a container as far as we know.
    return false;
  }
}

/**
 * Is `dir` — or the nearest existing ancestor of it — a mount point?
 *
 * The test is `st_dev`: a mount is exactly the case where a directory sits
 * on a different device from its parent. That is what makes this work
 * regardless of *what* was mounted (named volume, bind mount, tmpfs) and
 * without parsing `/proc/mounts`, whose format and container-namespace
 * visibility vary.
 *
 * It walks to the nearest existing ancestor because the directory usually
 * does not exist yet on a first run — `~/.mcp-inspector` is created on
 * demand. A volume mounted *at* that path exists by definition, so the
 * common positive case is found immediately; the walk is what keeps the
 * common negative case from being answered by a missing-file error.
 *
 * `/` is its own parent and is trivially a "mount", so the loop stops
 * there and reports false: the container's root filesystem is the writable
 * layer this whole check exists to distinguish *against*.
 */
export function isOnMountPoint(dir: string): boolean {
  try {
    let current = path.resolve(dir);
    // Walk up to the first path that exists.
    while (!fsSync.existsSync(current)) {
      const parent = path.dirname(current);
      /* v8 ignore next -- @preserve: the walk can only run out of ancestors
         if the filesystem root itself does not exist, which would mean the
         process has no cwd to have resolved against. Kept as the loop's
         termination guard rather than trusting that invariant. */
      if (parent === current) return false;
      current = parent;
    }
    const parent = path.dirname(current);
    if (parent === current) return false; // reached `/`
    return fsSync.statSync(current).dev !== fsSync.statSync(parent).dev;
  } catch {
    // Permission denied, a racing unmount, or a platform where `dev` is not
    // meaningful. "Not a mount" keeps the fallback on the conservative side
    // (memory in a container), which never loses a secret it promised to keep.
    return false;
  }
}

/** Build the store named by `kind`, plus the descriptor that explains it. */
function buildStore(
  kind: SecretStoreKind,
  reason: SecretStorageInfo["reason"],
  detail?: string,
): ResolvedSecretStore {
  if (kind === "keyring") {
    return {
      store: new KeyringSecretStore(),
      info: { kind, reason, durable: true },
    };
  }
  if (kind === "memory") {
    return {
      store: new InMemorySecretStore(),
      info: { kind, reason, durable: false, detail },
    };
  }
  const filePath = defaultSecretFilePath();
  const store = new FileSecretStore({ filePath });
  // Repair a loosened mode on a pre-existing file before anything reads or
  // writes it. Fire-and-forget: it is a best-effort tightening (it swallows
  // every failure), and blocking selection on a chmod would make an
  // unwritable file a startup problem rather than a `set`-time one.
  void tightenSecretFilePermissions(filePath);
  return {
    store,
    info: {
      kind,
      reason,
      path: filePath,
      plaintext: !store.encrypted,
      durable: true,
      detail,
    },
  };
}

/**
 * Pick the fallback store for a host with no keychain. Exported for the
 * tests, which drive the container/mount predicates directly rather than
 * trying to make a real container appear.
 */
export function chooseFallbackKind(opts: {
  container: boolean;
  mounted: boolean;
}): SecretStoreKind {
  return opts.container && !opts.mounted ? "memory" : "file";
}

/**
 * Print the fallback / plaintext warnings.
 *
 * `console.warn` rather than the pino file logger deliberately: the person
 * who needs this is watching a terminal or `docker logs`, and store
 * selection happens before (and independently of) any logger being
 * configured.
 */
export function warnAboutSecretStorage(info: SecretStorageInfo): void {
  if (info.reason === "fallback") {
    console.warn(
      `\n[mcp-inspector] The OS keychain is not available, so secrets will be kept in: ${secretStorageSummary(info)}.` +
        (info.detail
          ? `\n[mcp-inspector] Keychain error: ${info.detail}`
          : "") +
        `\n[mcp-inspector] Set ${SECRET_STORE_ENV}=keyring|file|memory to choose explicitly.`,
    );
  }
  const caveat = secretStorageCaveat(info);
  if (caveat) console.warn(`[mcp-inspector] ${caveat}`);
}

let resolved: Promise<ResolvedSecretStore> | undefined;

/**
 * Resolve the active store, once per process.
 *
 * Cached because the probe is a native round-trip and, more importantly,
 * because the answer must not differ between two callers: the banner, the
 * `/api/config` payload, and the store actually doing the writing are
 * three consumers of one decision, and a re-probe that flipped would have
 * the UI describing a store nobody is using. There is no reset seam for
 * the same reason a platform does not grow a keychain mid-run; tests get a
 * fresh module (and so a fresh cache) via `vi.resetModules()`.
 */
export function resolveSecretStore(): Promise<ResolvedSecretStore> {
  resolved ??= (async (): Promise<ResolvedSecretStore> => {
    const configured = parseSecretStoreEnv(process.env[SECRET_STORE_ENV]);
    if (configured) {
      const result = buildStore(configured, "configured");
      warnAboutSecretStorage(result.info);
      return result;
    }
    const probe = await probeKeyringAvailable();
    if (probe.available) return buildStore("keyring", "default");

    const kind = chooseFallbackKind({
      container: isContainer(),
      mounted: isOnMountPoint(path.dirname(defaultSecretFilePath())),
    });
    const result = buildStore(kind, "fallback", probe.detail);
    warnAboutSecretStorage(result.info);
    return result;
  })();
  return resolved;
}

/** The active store's descriptor — for the banner and `GET /api/config`. */
export async function getSecretStorageInfo(): Promise<SecretStorageInfo> {
  return (await resolveSecretStore()).info;
}

/**
 * A `SecretStore` that resolves the real one on first use.
 *
 * Selection is async (it probes the keychain) but every existing default
 * is a synchronous `new KeyringSecretStore()` in the middle of an options
 * object — `core/mcp/node/servers.ts`, `core/client/runner.ts`,
 * `core/mcp/remote/node/server.ts`. Making those async would ripple
 * through their callers to no benefit, since each method is already async
 * and can simply await the selection it needs. So the indirection lives
 * here, in one place, instead of in three signatures.
 */
class DeferredSecretStore implements SecretStore {
  private async target(): Promise<SecretStore> {
    return (await resolveSecretStore()).store;
  }
  async get(serverId: string, field: string): Promise<string | null> {
    return (await this.target()).get(serverId, field);
  }
  async set(serverId: string, field: string, value: string): Promise<void> {
    await (await this.target()).set(serverId, field, value);
  }
  async delete(serverId: string, field: string): Promise<void> {
    await (await this.target()).delete(serverId, field);
  }
  async deleteAllForServer(serverId: string): Promise<void> {
    await (await this.target()).deleteAllForServer(serverId);
  }
}

/**
 * The default store for production call sites — what `new
 * KeyringSecretStore()` used to be. Every one of them now routes through
 * the same selection, so the CLI, the TUI, and the web backend cannot end
 * up writing to different places on the same box.
 */
export function defaultSecretStore(): SecretStore {
  return new DeferredSecretStore();
}
