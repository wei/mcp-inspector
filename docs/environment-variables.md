# Environment variables

Every environment variable that changes how the Inspector behaves at runtime, in one place. Set them in the shell that launches `mcp-inspector` (or with `-e` for the [Docker image](./docker.md)).

The **Read by** column names the client whose process reads the variable: **web** is the Node backend that `--web` starts (the browser itself reads no environment), **CLI** and **TUI** are those clients, and **launcher** is the `mcp-inspector` bin that picks one of them. A variable read in shared `core/` code is marked with every client that reaches it.

Unless a row says otherwise, an unset variable and an empty one behave the same.

## Authentication and network exposure

These guard the web backend, which spawns processes on request. Read [Host binding and the origin allow-list](../clients/web/README.md#host-binding--the-origin-allow-list) before widening any of them.

| Variable                          | Read by  | Default                   | Effect                                                                                                                                                                                                                                                                                                                                             |
| --------------------------------- | -------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MCP_INSPECTOR_API_TOKEN`         | web, CLI | a random token per launch | Bearer token guarding every `/api/*` route (`x-mcp-remote-auth: Bearer <token>`). Set it to use a known token instead of the generated one printed in the launch banner. The CLI reads it only to fill the `autoConnect` parameter of the deep link it emits.                                                                                   |
| `MCP_PROXY_AUTH_TOKEN`            | web      | —                         | **Deprecated** v1 name for `MCP_INSPECTOR_API_TOKEN`, used only when the new name is unset.                                                                                                                                                                                                                                                         |
| `DANGEROUSLY_OMIT_AUTH`           | web      | unset                     | Disables the API token entirely. ⚠️ **Any non-empty value turns auth off, including `false` and `0`** — unset the variable to keep auth on.                                                                                                                                                                                                         |
| `HOST`                            | web, CLI | `127.0.0.1`               | Address the web server binds. An all-interfaces host (`0.0.0.0`, `::`, and equivalent spellings) is **refused** unless `DANGEROUSLY_BIND_ALL_INTERFACES` is enabled. The CLI reads it only to build its deep link.                                                                                                                                  |
| `DANGEROUSLY_BIND_ALL_INTERFACES` | web      | off                       | Opts in to an all-interfaces `HOST`. Only `true` or `1` (case-insensitive) enable it, so `false` reads as off. The Docker image sets it.                                                                                                                                                                                                             |
| `ALLOWED_ORIGINS`                 | web      | the loopback origins      | Comma-separated origins allowed to call the API. **Replaces** the default list rather than adding to it, so list every form you browse from. Each entry must include the scheme (`http://localhost:6274`).                                                                                                                                         |

## Ports

The web client needs **fixed** ports: the origin allow-list and the MCP Apps sandbox CSP are both derived from them.

| Variable              | Read by  | Default | Effect                                                                                                                                                                                  |
| --------------------- | -------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLIENT_PORT`         | web, CLI | `6274`  | Web UI port. Must be an integer in 1–65535; `0` (a dynamic port) is rejected at startup.                                                                                                |
| `MCP_SANDBOX_PORT`    | web, CLI | `6275`  | Port of the MCP Apps sandbox server. An invalid value is ignored with a warning.                                                                                                        |
| `SERVER_PORT`         | web      | —       | v1's proxy port, now only a fallback for `MCP_SANDBOX_PORT` when that is unset.                                                                                                         |
| `MCP_APP_ORIGIN_PORT` | web, CLI | `6278`  | Port of the dedicated app-origin server, used only by an MCP App whose UI resource declares `_meta.ui.domain`. An invalid value is ignored with a warning.                              |

The CLI reads the three port variables and `HOST` only to build the deep link and port list it hands to a web session; it binds none of them.

## Behavior

| Variable                 | Read by       | Default                        | Effect                                                                                                                                                                                                                                                  |
| ------------------------ | ------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MCP_AUTO_OPEN_ENABLED`  | web, CLI, TUI | open                           | `false` never opens a browser; `true` always does. In the CLI and TUI it also governs the interactive OAuth flow, and `true` opens the browser even when stderr is not a TTY. Any other value behaves as unset.                                         |
| `MCP_CATALOG_PATH`       | web, CLI, TUI | `~/.mcp-inspector/mcp.json`    | Default writable catalog, used when no `--catalog` is given. The CLI honors it only when no ad-hoc target (positional command, `--server-url`, or `--transport`) is given. See [MCP server configuration](./mcp-server-configuration.md).            |
| `MCP_OAUTH_CALLBACK_URL` | CLI, TUI      | `http://127.0.0.1:6276/oauth/callback` | Loopback redirect URL for the CLI/TUI OAuth flow. `--callback-url` takes precedence.                                                                                                                                                    |
| `NO_COLOR`               | CLI           | unset                          | Any value disables ANSI styling in the CLI's human-readable output.                                                                                                                                                                                      |

## Storage and state

| Variable                         | Read by       | Default                                    | Effect                                                                                                                                                                                                                                                            |
| -------------------------------- | ------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MCP_STORAGE_DIR`                | web, CLI, TUI | `~/.mcp-inspector/storage`                 | Storage directory. Relocates the OAuth state file (`oauth.json`) and the secrets file (`secrets.json`) for every client. For the **web** backend it also relocates `client.json`; the CLI and TUI find `client.json` through `MCP_CLIENT_CONFIG_PATH` instead. |
| `MCP_INSPECTOR_OAUTH_STATE_PATH` | web, CLI, TUI | `<MCP_STORAGE_DIR>/oauth.json`             | Names the OAuth state file outright. Lookup order: this variable, then `<MCP_STORAGE_DIR>/oauth.json`, then `~/.mcp-inspector/storage/oauth.json`. ⚠️ Setting `MCP_STORAGE_DIR` alone does not isolate a run if this variable is also exported.             |
| `MCP_CLIENT_CONFIG_PATH`         | CLI, TUI      | `~/.mcp-inspector/storage/client.json`     | Install-level client config (CIMD, enterprise IdP). `--client-config` takes precedence.                                                                                                                                                                            |

## Secret store

Where server secrets (headers, client secrets) are kept. The details — the keychain probe, the file format, encryption and locking — are in the [Docker guide](./docker.md); these variables apply to every install, not only containers.

| Variable                     | Read by       | Default                         | Effect                                                                                                                                                                                                                                                 |
| ---------------------------- | ------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `MCP_INSPECTOR_SECRET_STORE` | web, CLI, TUI | probe the OS keychain           | `keyring`, `file`, or `memory` (case-insensitive) picks the store outright and skips the probe. Any other value is ignored with a warning.                                                                                                              |
| `MCP_INSPECTOR_SECRET_FILE`  | web, CLI, TUI | `<MCP_STORAGE_DIR>/secrets.json` | Path of the file store. Falls back to `secrets.json` in `MCP_STORAGE_DIR`, then to `~/.mcp-inspector/secrets.json`.                                                                                                                                |
| `MCP_INSPECTOR_SECRET_KEY`   | web, CLI, TUI | unset (file is plaintext, `0600`) | Passphrase that encrypts the file store. Use a generated, high-entropy value. ⚠️ Changing or losing it makes the existing file unreadable; see the Docker guide before rotating it.                                                                   |

When no store is configured, the choice also depends on whether the Inspector is running in a container, which it detects from `KUBERNETES_SERVICE_HOST` (or Docker's and Podman's marker files). That variable is set by the orchestrator, not by you.

## Logging and debugging

| Variable                | Read by  | Default            | Effect                                                                                                                                               |
| ----------------------- | -------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MCP_DEBUG` / `DEBUG`   | launcher | off                | Prints the full stack trace when the launcher exits on an error. Any value other than `0` or `false` (case-insensitive) turns it on.                 |
| `MCP_LOG_FILE`          | web      | unset (no log)     | Appends the web backend's structured (pino, JSON lines) log to this file, creating its directory if needed.                                          |
| `MCP_INSPECTOR_LOG_DIR` | TUI      | `~/.mcp-inspector` | Directory of the TUI's `auth.log`. The TUI logs to a file so its output does not corrupt the terminal UI.                                             |
| `LOG_LEVEL`             | TUI      | `info`             | Level of the TUI's `auth.log` (`trace`, `debug`, `info`, `warn`, `error`, `fatal`, `silent`).                                                        |

## Outbound proxy

| Variable                        | Read by       | Default | Effect                                                                                                                                                                                                                           |
| ------------------------------- | ------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HTTPS_PROXY` / `HTTP_PROXY`    | web, CLI, TUI | unset   | Route connections to remote HTTP/SSE servers, including OAuth discovery and token requests, through a proxy. Lowercase forms are honored too. See [HTTP proxy support](../clients/cli/README.md#http-proxy-support).     |
| `NO_PROXY`                      | web, CLI, TUI | unset   | Hosts exempted from the proxy.                                                                                                                                                                                                   |

## Node.js variables

These belong to Node, not the Inspector, but they are the answer to some common connection problems. Because the web client connects to MCP servers **from its Node backend**, not from the browser, they apply to all three clients.

### Connecting to a server with a self-signed certificate

A server at `https://localhost`, or anywhere else with a self-signed or privately issued certificate, fails to connect with a generic fetch error, because Node does not trust the certificate. Trusting the browser's exception does not help — the browser is not the one connecting ([#1936](https://github.com/modelcontextprotocol/inspector/issues/1936)).

**Prefer trusting the certificate's CA.** `NODE_EXTRA_CA_CERTS` adds certificates to the ones Node trusts, and leaves verification on for every other connection:

```sh
NODE_EXTRA_CA_CERTS=/path/to/your-ca.pem npx @modelcontextprotocol/inspector
```

For a self-signed certificate with no separate CA, point it at the certificate itself. Node reads the variable once at startup, so it must be set before launching.

**Or turn verification off, for local development only:**

```sh
NODE_TLS_REJECT_UNAUTHORIZED=0 npx @modelcontextprotocol/inspector
```

⚠️ This disables certificate verification for **every** TLS connection the Inspector process makes — every MCP server, every OAuth authorization server and token endpoint — not just the one you are testing, and Node prints a warning saying so. A connection that would have been refused for impersonation is then accepted. Never set it in a shell profile, a shared environment, or a deployment.

| Variable                       | Default | Effect                                                                                                    |
| ------------------------------ | ------- | --------------------------------------------------------------------------------------------------------- |
| `NODE_EXTRA_CA_CERTS`          | unset   | PEM file of extra CA certificates to trust, in addition to Node's bundled ones. Read once at startup.     |
| `NODE_TLS_REJECT_UNAUTHORIZED` | `1`     | `0` disables TLS certificate verification for the whole process. Development only.                        |
