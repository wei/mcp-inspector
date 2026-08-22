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
  readSecretFilePermissions,
  tightenSecretFilePermissions,
} from "./file-secret-store.js";
import {
  KeyringSecretStore,
  probeKeyringAvailable,
  secretStoreIsDurable,
  SessionSecretStore,
  type SecretStore,
} from "./secret-store.js";

/** Env var naming an explicit store, bypassing the probe entirely. */
export const SECRET_STORE_ENV = "MCP_INSPECTOR_SECRET_STORE";

/** Env var overriding the secrets file location outright. */
export const SECRET_FILE_ENV = "MCP_INSPECTOR_SECRET_FILE";

/**
 * Env var relocating the Inspector's durable state directory. Already
 * honored by the web backend for OAuth tokens and `client.json`; the
 * secrets file follows it for the same reason, and because the mount check
 * below asks whether *that* directory survives. A container mounting only
 * the configured storage directory would otherwise be judged unmounted,
 * fall back to `memory`, and lose secrets the user had arranged to keep.
 */
export const STORAGE_DIR_ENV = "MCP_STORAGE_DIR";

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

/**
 * Default secrets file: `MCP_INSPECTOR_SECRET_FILE` if named outright,
 * otherwise `secrets.json` in the configured storage directory, otherwise
 * beside the catalog in `~/.mcp-inspector`.
 */
export function defaultSecretFilePath(): string {
  const override = process.env[SECRET_FILE_ENV]?.trim();
  if (override) return path.resolve(override);
  const storageDir = process.env[STORAGE_DIR_ENV]?.trim();
  if (storageDir) return path.resolve(storageDir, "secrets.json");
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
    // `/.dockerenv` is Docker's marker; `/run/.containerenv` is Podman's
    // equivalent and is the only one a rootless Podman container reliably
    // has. Missing it classified such a container as a host, which is the
    // wrong way round to be wrong: the fallback then writes a file into the
    // ephemeral writable layer and calls it durable.
    if (
      fsSync.existsSync("/.dockerenv") ||
      fsSync.existsSync("/run/.containerenv")
    ) {
      return true;
    }
  } catch {
    // A sandboxed / restricted filesystem. Fall through to the cgroup read.
  }
  try {
    const cgroup = fsSync.readFileSync("/proc/1/cgroup", "utf-8");
    // `libpod` is what Podman actually writes into cgroup paths
    // (`/machine.slice/libpod-<id>.scope`); the literal string "podman"
    // often does not appear at all.
    return /\b(docker|containerd|kubepods|podman|libpod|lxc)\b/.test(cgroup);
  } catch {
    // Not Linux, or /proc is not mounted. Not a container as far as we know.
    return false;
  }
}

/**
 * Nearest ancestor of `dir` that actually exists.
 *
 * The directory usually does not exist on a first run — `~/.mcp-inspector`
 * is created on demand — so every check below has to ask about the closest
 * thing that does. A volume mounted *at* the target path exists by
 * definition, so the common positive case needs no walk at all.
 */
function nearestExisting(dir: string): string | null {
  let current = path.resolve(dir);
  while (!fsSync.existsSync(current)) {
    const parent = path.dirname(current);
    /* v8 ignore next -- @preserve: the walk can only run out of ancestors if
       the filesystem root itself does not exist, which would mean the process
       has no cwd to have resolved against. Kept as the loop's termination
       guard rather than trusting that invariant. */
    if (parent === current) return null;
    current = parent;
  }
  return current;
}

/**
 * Mount points visible to this process, from `/proc/self/mountinfo`, or
 * `null` where that file cannot be read (macOS, Windows, a `/proc`-less
 * container).
 *
 * Field 5 of each line is the mount point, with spaces escaped as `\040`.
 * `/` is dropped: in a container that is the writable layer, which is
 * exactly what the durability question is asking *against*.
 */
function readMountPoints(): string[] | null {
  try {
    return fsSync
      .readFileSync("/proc/self/mountinfo", "utf-8")
      .split("\n")
      .map((line) => line.split(" ")[4])
      .filter((point): point is string => Boolean(point))
      .map((point) => point.replace(/\\040/g, " "))
      .filter((point) => point !== "/");
  } catch {
    return null;
  }
}

/**
 * Does `dir` live on something mounted over the root filesystem?
 *
 * Two mechanisms, because either one alone gets a realistic case wrong.
 *
 * **`/proc/self/mountinfo` first**, where it exists. It answers the question
 * actually being asked — "is this path *under* a mount" — rather than the
 * narrower "is this path *itself* a mount". The difference is a real
 * container layout: mounting a volume at `/home/node` leaves
 * `/home/node/.mcp-inspector` an ordinary subdirectory sharing its parent's
 * device, so a device-boundary test answers "not mounted" and demotes a
 * durable setup to session-only `memory`. Reading the mount table also sees
 * a bind mount that happens to come from the same device, which no `st_dev`
 * comparison can.
 *
 * **The `st_dev` comparison as the fallback**, and against `/` rather than
 * against the immediate parent — so a subdirectory of a mount is still
 * recognized. Outside a container this barely matters (the fallback there is
 * `file` either way); it matters in a `/proc`-less container, where being
 * wrong costs durability.
 *
 * Errors answer `false`, keeping the fallback conservative — `memory` in a
 * container — which never promises to keep a secret it then loses.
 */
export function isOnMountPoint(dir: string): boolean {
  try {
    const current = nearestExisting(dir);
    if (current === null) return false;

    const mounts = readMountPoints();
    if (mounts !== null) {
      return mounts.some(
        (point) => current === point || current.startsWith(`${point}/`),
      );
    }

    const parent = path.dirname(current);
    if (parent === current) return false; // `dir` resolved to the root itself
    return fsSync.statSync(current).dev !== fsSync.statSync("/").dev;
  } catch {
    // Permission denied, a racing unmount, or a platform where `dev` is not
    // meaningful.
    return false;
  }
}

/** Build the store named by `kind`, plus the descriptor that explains it. */
async function buildStore(
  kind: SecretStoreKind,
  reason: SecretStorageInfo["reason"],
  detail?: string,
): Promise<ResolvedSecretStore> {
  if (kind === "keyring") {
    return {
      store: new KeyringSecretStore(),
      info: { kind, reason, durable: true },
    };
  }
  if (kind === "memory") {
    // `SessionSecretStore`, not the bare `InMemorySecretStore` the tests
    // use: it reports `isDurable() === false`, which is what stops the
    // mcp.json / client.json migrations from stripping a plaintext secret
    // off disk in exchange for a copy that dies with this process.
    return {
      store: new SessionSecretStore(),
      info: { kind, reason, durable: false, detail },
    };
  }
  const filePath = defaultSecretFilePath();
  const store = new FileSecretStore({ filePath });
  // Repair a loosened mode on a pre-existing file, and — unlike before —
  // *verify* the result. The UI and the README both state the file is 0600,
  // so a file we could not tighten (owned by another user, on a read-only
  // mount) has to be reported rather than quietly described as protected.
  const perms = await tightenSecretFilePermissions(filePath);
  if (perms.state === "loose") {
    console.warn(
      `[mcp-inspector] The secrets file at ${filePath} is mode ${perms.mode.toString(8).padStart(4, "0")}, not 0600, and could not be tightened. Anyone who can read it can read the secrets in it.`,
    );
  }
  return {
    store,
    info: await describeFileStore(store, filePath, kind, reason, detail),
  };
}

/**
 * Build the descriptor for a file store by *looking at the file*.
 *
 * `store.encrypted` is what the next write will do; a file already on disk in
 * the clear stays readable until that write happens, and saying "File
 * (encrypted)" in the meantime is the one false reassurance this whole
 * subsystem exists not to give. With no file yet (or one we cannot parse) the
 * policy is all there is to report, and it is then accurate — the first write
 * creates the file in that mode.
 *
 * Split out from `buildStore` so it can be re-run: this is a property of a
 * file that changes underneath us, not a property of the selection.
 */
async function describeFileStore(
  store: FileSecretStore,
  filePath: string,
  kind: SecretStoreKind,
  reason: SecretStorageInfo["reason"],
  detail?: string,
): Promise<SecretStorageInfo> {
  const onDisk = await store.readOnDiskEncryption();
  const plaintext = onDisk === null ? !store.encrypted : onDisk === "none";
  // Re-checked here rather than captured at selection, for the same reason
  // the encryption state is: the mode can change under a running process,
  // and this descriptor is what the browser renders as fact. The *read-only*
  // half deliberately — describing must not chmod, least of all once per
  // page load on a file another process may be mid-write on. The repair
  // happens once, at selection.
  const perms = await readSecretFilePermissions(filePath);
  return {
    kind,
    reason,
    path: filePath,
    plaintext,
    ...(perms.state === "loose" ? { looseMode: perms.mode } : {}),
    // Only meaningful while the two disagree; omitted otherwise so the
    // payload does not carry a flag that says nothing.
    ...(plaintext && store.encrypted ? { pendingEncryption: true } : {}),
    durable: true,
    detail,
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
      const result = await buildStore(configured, "configured");
      warnAboutSecretStorage(result.info);
      return result;
    }
    const probe = await probeKeyringAvailable();
    if (probe.available) return buildStore("keyring", "default");

    const kind = chooseFallbackKind({
      container: isContainer(),
      mounted: isOnMountPoint(path.dirname(defaultSecretFilePath())),
    });
    const result = await buildStore(kind, "fallback", probe.detail);
    warnAboutSecretStorage(result.info);
    return result;
  })();
  return resolved;
}

/**
 * The active store's descriptor — for the banner and `GET /api/config`.
 *
 * The *selection* is cached, deliberately (see {@link resolveSecretStore}).
 * The descriptor is not, for the file store: `plaintext` and
 * `pendingEncryption` describe bytes on disk that this very process
 * changes. Cache them and the first `set` under a newly-set passphrase
 * encrypts the file while every subsequent `/api/config` keeps serving
 * "still unencrypted" until a restart — stale in the safe direction, but
 * stale about the one fact this surface exists to state. Re-deriving costs
 * one read of a small file per config fetch, which is once per page load.
 */
export async function getSecretStorageInfo(): Promise<SecretStorageInfo> {
  const { store, info } = await resolveSecretStore();
  if (info.kind !== "file" || !(store instanceof FileSecretStore)) return info;
  return describeFileStore(
    store,
    store.filePath,
    "file",
    info.reason,
    info.detail,
  );
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
  async isDurable(): Promise<boolean> {
    return secretStoreIsDurable(await this.target());
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
