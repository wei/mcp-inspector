# Where secrets are stored

The Inspector keeps a few values out of `mcp.json` and `client.json` and puts them in a **secret store** instead. This guide explains which store you get, why, where it lives, and how to change it. It applies to every runtime: a desktop install, a Linux server or SSH session, Android/Termux, and a container. For the container-specific parts (volumes, ownership), also read the [Docker guide](./docker.md).

## What counts as a secret

Three kinds of value are stored as secrets:

| Value                             | Saved from                             |
| --------------------------------- | -------------------------------------- |
| A server's OAuth client secret    | The server's OAuth settings            |
| The enterprise IdP client secret  | Client Settings (install-level)        |
| Each stdio server's `env:` value  | A stdio server's environment variables |

They are kept out of `mcp.json` so that sharing, committing or syncing the file does not leak credentials (#1356). When the Inspector saves an entry to a durable store, it leaves each `env` key in `mcp.json` with an empty value and omits the client secret; the real values live in the store. `headers` are **not** moved: they are saved in `mcp.json` exactly as written, so a header that carries a credential stays in the file. [MCP server configuration](./mcp-server-configuration.md) describes what that means for other tools reading the same file.

## How the store is chosen

Each process picks one store, once, the first time it needs it: the web backend at startup, the CLI and TUI on their first access to a secret. Every client (web, CLI and TUI) goes through the same selection, in this order:

1. **`MCP_INSPECTOR_SECRET_STORE`**, if it is `keyring`, `file` or `memory` (case-insensitive). That store is used and nothing is probed. An empty or whitespace-only value counts as unset. Any other value is ignored with a warning, and selection continues as if it were unset.
2. **The OS keychain**, if a probe can reach it: Keychain on macOS, Credential Manager on Windows, and the Secret Service (libsecret, for example GNOME Keyring or KWallet) on Linux. Entries are stored under the service name `mcp-inspector`. Most desktop installs stop here.
3. **A fallback**, when the probe fails. The Inspector says so on stderr when it selects the store, and names the store it picked (see [Where the active store is reported](#where-the-active-store-is-reported)):
   - `memory` if it is running in a container **and** the directory the secrets file would go in is not on a mounted volume, because a file in a container's writable layer is lost on `docker run --rm` and on every image update;
   - `file` everywhere else.

| Where you run it                                                        | Store                               | Secrets survive a restart? |
| ----------------------------------------------------------------------- | ----------------------------------- | -------------------------- |
| Desktop macOS or Windows, or Linux with a Secret Service running        | OS keychain                         | Yes                        |
| Linux without libsecret or a Secret Service                             | File (`secrets.json`, mode `0600`)  | Yes                        |
| Headless server or SSH session with no D-Bus session                    | File                                | Yes                        |
| Android/Termux                                                          | File                                | Yes                        |
| Container with **no volume** on the secrets directory                   | Memory                              | No, this session only      |
| Container **with** a volume on the secrets directory                    | File                                | Yes                        |
| Any of the above with `MCP_INSPECTOR_SECRET_STORE` set                  | The store you named                 | Not with `memory`; with `file` in a container, only if the file is on a volume |

The Inspector decides that it is in a container from `KUBERNETES_SERVICE_HOST`, Docker's `/.dockerenv`, Podman's `/run/.containerenv`, or the process's cgroup. The container check only chooses between `memory` and `file`; the mount check is what actually decides.

The choice is made once per process. Installing a keychain while the Inspector is running takes effect on the next start.

### The memory store

`memory` keeps secrets for this process only; nothing is written anywhere and they are gone when it exits. Because it is not durable, the Inspector does **not** remove plaintext values that are already in `mcp.json` or `client.json` while it is active: in that case the file on disk is still the durable copy. New or changed values are still kept out of the file.

## The file store

### Where the file is

The path is the first of these that applies:

1. `MCP_INSPECTOR_SECRET_FILE`, if set;
2. `secrets.json` inside `MCP_STORAGE_DIR`, if that is set;
3. `~/.mcp-inspector/secrets.json`.

⚠️ The default sits **beside** the default storage directory (`~/.mcp-inspector/storage`), not inside it. Setting `MCP_STORAGE_DIR` moves the secrets file together with the OAuth state (`oauth.json`), for every client. It also moves `client.json` for the **web** backend only; the CLI and TUI find `client.json` through `MCP_CLIENT_CONFIG_PATH` instead.

### Encryption

**A file store is unencrypted unless you give it a passphrase.** Set `MCP_INSPECTOR_SECRET_KEY` and the file is encrypted with AES-256-GCM, with the passphrase stretched by scrypt against a random salt that is regenerated on every write. Without it, the file is still mode `0600`, but anyone who can read the file can read the values. The startup log and the settings footer say so every session, as a warning.

**Use a high-entropy passphrase: generate it, don't choose it.** The random salt stops an attacker from precomputing a table, but it does nothing against guessing. The scrypt cost is deliberately low because the derivation runs on every read and write. Anyone who obtains `secrets.json` can therefore test candidate passphrases quickly and offline, so treat this value like any other credential, not like a memorable password.

**Adding a passphrase later is safe.** The next write upgrades an existing plaintext file in place. Until that write happens the existing values are still readable, and the banner and footer keep saying so. They do not report the file as encrypted just because the variable is now set.

**Changing or losing the passphrase is not safe.** A file that can no longer be decrypted is read as empty, and the Inspector **refuses to write to it** rather than replacing it with a new file that holds only your latest secret. To recover, restore the original passphrase, or delete the secrets file at its configured path (see [Where the file is](#where-the-file-is); the path is also shown in the startup warning and the settings footer) and enter the values again.

### Permissions

The Inspector writes the file with mode `0600` and tightens it again when the store is selected if something loosened it. If it _cannot_ tighten it (the file belongs to another user, or the mount is read-only), it says so in the log and the footer instead of continuing to describe the file as protected.

### Two Inspectors, one file

Within a process, changes are serialized per file path, so a web session's own concurrent saves cannot overwrite each other. Across processes, for example a CLI run next to a web session, each change takes an exclusive lock on `<secrets-file>.lock`, a lock directory beside the secrets file named after it (`secrets.json.lock` by default), for the whole read-modify-write. The lock uses [`proper-lockfile`](https://github.com/moxystudio/node-proper-lockfile), the same library npm uses for its own locks. The lock expires 10 seconds after its holder stops refreshing it, so an Inspector that is killed mid-save does not leave the file unwritable.

So two running Inspectors are genuinely serialized. What a lock file cannot make single-winner is the _takeover of a lock whose holder died_. That needs a compare-and-swap on a directory entry (`renameat2`), which Node does not expose, and `proper-lockfile` does not close that race either. The window only opens after a holder dies without releasing its lock.

The Inspector adds one check on top. Every lock-directory removal the library makes on its behalf, on release and from its exit handler, first checks that the directory is still the one it created (by inode and birth time, which survive the library's own refresh but not a delete-and-recreate). Without that check the removals are unconditional, so a holder whose lock had been replaced would delete the _winner's_ lock on the way out, turning one compromised writer into two unprotected ones. The check also reports the takeover as a warning. Treat all of this as **best-effort**: the check is still followed by a separate act, so it makes the destructive case rare rather than impossible, and it relies on filesystem metadata that not every filesystem reports.

That is why, under the lock, each change still reads the file, applies the change, writes, then reads back and compares the whole map. If something wrote in between, it re-applies the change to what is there now and retries, and it fails loudly after five lost rounds instead of reporting the value as saved. That check catches a clobber inside the takeover window. It also covers writers that no lock can order, because a lock only orders the writers that _take_ it: an editor, a restored backup, or an older Inspector.

If another process holds the lock and does not release it, the save **fails** rather than going ahead unlocked. It waits past the stale window first, so a crashed Inspector clears itself instead of failing everyone else's saves. When there is another writer you can see, writing anyway is the one case where continuing would lose the secret the save was meant to protect.

The same read-back check covers a lock that cannot be taken at all. The file store exists for machines where the usual mechanism is missing, so when a directory cannot hold a lock file (a read-only `$HOME`, or a mount owned by another uid), the save goes ahead unlocked with a warning. Otherwise every save would fail on exactly the setups this store was written for.

## Getting a keychain back

If you install libsecret (or start a Secret Service) on a machine that was using the file store, the next start probes successfully, selects the keychain, and **moves the contents of `secrets.json` into it**:

- **The keychain wins on conflict.** A value already in the keychain is kept and the file's value is not copied, because it is treated as the older copy. Only entries the keychain does not have are written.
- **The file is removed only when every entry is accounted for**, meaning each one either was already in the keychain or was written there. If any entry could not be handled, or a keychain read or write fails, the file is left as it was and the next start tries again. A file with no entries is also left in place.
- **An unreadable file is not deleted.** If the file cannot be decrypted (the passphrase changed or is now unset), the Inspector reports it and leaves the file in place.

A successful move prints a message naming the file it removed. The same hand-off runs when you select the keychain explicitly with `MCP_INSPECTOR_SECRET_STORE=keyring`. It does not run in the other direction: choosing `file` or `memory` does not copy anything out of the keychain.

## Where the active store is reported

- **When the store is selected** (at startup for the web backend, on first use for the CLI and TUI), every client prints a warning on stderr if it falls back from the keychain, including the keychain error, and another if the file is unencrypted, has loose permissions, or cannot be read. The web client's startup banner also has a `Secrets:` line on every run.
- **`GET /api/config`** (web) includes a `secretStorage` object describing the active store.
- **In the web UI**, a footer at the bottom of the **Client Settings**, **Server Settings** and **Add / Edit / Clone server** dialogs names the store, and turns into a warning when it is memory-only, unencrypted, loosely permissioned, or unreadable. It is shown where you type a secret, not only once at startup.

## Changing the store

| To                                         | Set                                                                  |
| ------------------------------------------ | -------------------------------------------------------------------- |
| Always use the keychain                    | `MCP_INSPECTOR_SECRET_STORE=keyring`                                 |
| Use a file even though a keychain exists   | `MCP_INSPECTOR_SECRET_STORE=file`                                    |
| Never write secrets to disk                | `MCP_INSPECTOR_SECRET_STORE=memory`                                  |
| Put the file somewhere else                | `MCP_INSPECTOR_SECRET_FILE=/path/to/secrets.json`, or `MCP_STORAGE_DIR` |
| Encrypt the file                           | `MCP_INSPECTOR_SECRET_KEY=<generated passphrase>`                    |

Every variable is also listed in [Environment variables](./environment-variables.md#secret-store).
