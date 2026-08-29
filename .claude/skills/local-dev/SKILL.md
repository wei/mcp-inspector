---
name: local-dev
description: Getting the Inspector running locally and adding dependencies to it. Which install to run and which script starts each client (web, cli, tui, launcher); why v2 is not an npm workspace; how the @inspector/core alias works; and where a new dependency must be declared — root vs client, dependencies vs devDependencies, and the bundler `external` lists a root package must also appear in.
disable-model-invocation: false
---

# Local development

The **rules** a reviewer cites (TypeScript, Mantine/React, testing, the gate)
stay in [`AGENTS.md`](../../../AGENTS.md). This skill is how to get the thing
running and where a package goes.

## Install

Requires Node `>=22.19.0`.

```sh
npm install     # at the REPO ROOT
```

v2 is **not** an npm workspace — each client under `clients/*` keeps its own
`package.json` and `node_modules`. A single root `npm install` is still all you
need: the root `postinstall` (`scripts/install-clients.mjs`) cascades
`npm install` into `clients/web`, `clients/cli`, `clients/tui`, and
`clients/launcher`.

- **Fresh clone:** `npm install` at the root.
- **After a pull that changes a client's dependencies:** re-run `npm install` at
  the root to re-sync every client.

The cascade is dev-only — it exits early when the package is installed under
`node_modules`, and the published tarball ships only each client's `build/`. Set
`INSPECTOR_SKIP_CLIENT_INSTALL=1` to skip it.

⚠️ **In a git worktree, do a real `npm install`.** A symlinked `node_modules`
passes lint, tests and coverage, then fails every Storybook story file on Vite's
`fs.allow`.

## Running

For day-to-day **web** iteration, run Vite directly — fast HMR, no launcher
build needed:

```sh
cd clients/web && npm run dev
```

The launcher-driven scripts run the **built** launcher, so `npm run build`
first:

```sh
npm run build        # web → cli → tui → launcher
npm run web          # prod web launcher against clients/web/dist
npm run web:dev      # web launcher in --dev mode (Vite)
```

Individual builds: `build:web`, `build:cli`, `build:tui`, `build:launcher`. The
web build produces both the browser SPA (`clients/web/dist`, Vite) and the Node
prod-server runner (`clients/web/build`, tsup).

To run the CLI or TUI: `node clients/launcher/build/index.js --cli …` /
`--tui …`.

## The `@inspector/core` alias

`core/` holds the logic shared by all three clients and intentionally has **no
`package.json`** — it is not published on its own. Each client bundles it via a
build-time alias:

- **CLI / TUI** — `esbuildOptions.alias` in `tsup.config.ts` maps
  `@inspector/core` → the repo `core/` directory, with
  `noExternal: [/^@inspector\/core/]` inlining it.
- **Web** — the same alias in `clients/web/vite.config.ts`, for both the browser
  app and the Node backend runner.

## Where a dependency goes

Three independent questions. Get them in this order.

### 1. Which manifest declares it?

**The MCP SDK packages — `@modelcontextprotocol/client`, `core`, `server`,
`server-legacy`, `ext-apps` — are declared in the repo-root `package.json` and
nowhere else.** Node resolution walks up, so the root install already serves
every client; a per-client declaration installs a *second copy* that drifts. That
is not theoretical — it put two versions of `ext-apps` and of the transitive v1
`@modelcontextprotocol/sdk` in the tree at once (#1970), and a second copy of
`client`/`core` is exactly the failure the `dedupe` + `server.deps.inline`
workaround in `vitest.shared.mts` exists for.

The same rule covers anything reached only through **root-owned code with no
manifest of its own** (`test-servers/src`, `core/`): declare it at the root, and
alias it to the **repo root** in `vitest.shared.mts`. `express` and `yaml` are
the two today.

⚠️ The v1 SDK (`@modelcontextprotocol/sdk`) is **not** a dependency of this repo
and must not become one. It appears in the lock files only as a `"peer": true`
entry pulled in by `ext-apps`.

### 2. `dependencies` or `devDependencies`?

Follows from who consumes it **at runtime**, not from where it is declared:

- A package `core/` imports at runtime → root **`dependencies`**. The client
  builds externalize npm packages, so a published install resolves them from the
  root manifest, and devDependencies are not installed for consumers — a runtime
  import parked there breaks the published package while passing every local
  check.
- A package only the tests, the test servers, or the build tooling need →
  **`devDependencies`** (`express`).
- `vite` and `@vitejs/plugin-react` are root **`dependencies`** on purpose:
  `clients/web/server/start-vite-dev-server.ts` imports them at runtime for
  `--web --dev`, and `tsup.runner.config.ts` externalizes both.

### 3. Does it also need adding to the bundler `external` lists?

**Yes, if `core/` imports it at runtime.** tsup and Vite externalize what the
*client's* `package.json` declares, and a root-only dependency is in none of
them — so it gets **bundled**, silently. For a CJS package inlined into an ESM
bundle that is fatal: esbuild leaves a `Dynamic require of "path" is not
supported` shim that throws at import time.

The three lists are `clients/cli/tsup.config.ts`,
`clients/tui/tsup.config.ts`, and `clients/web/tsup.runner.config.ts` — add it
to **all three**, since which client reaches it is a function of what `core/`
imports, not of what the client's own code names.

**`npm run verify:bundle-externals` enforces this.** It reads the **built
output**, not the config (the two disagreed for four releases), over the union of
each client's `external` array and the root manifest's `dependencies`. Note the
ordinary test tiers cannot catch this class: unit and integration tests run
against source, and the smokes never take the lazy-`import()` path.

⚠️ Probing it by hand with `node -e` **falsely succeeds** — `node -e` exposes a
global `require` that satisfies esbuild's guard. Reproduce from a real `.mjs`
file.

### The exception: a dependency that renders React must be bundled

An externalized package resolves its own `react` from wherever npm placed *it*,
beside a React satisfying **that package's** peer range — looser than ours in
every case here, which is all it takes to split React. `ink-form` and
`ink-scroll-view` declare `">=18"`; the bundle renders through one React, those
packages call hooks on another, and the TUI crashes on the first hook (#1952).
Both are inlined by `clients/tui/tsup.config.ts` (`noExternal`) and declared
only in `clients/tui/package.json`.

**`ink` is the single exemption, justified by cost** (~1.4MB), not by safety.
Never justify an exemption by a peer range. What makes it safe is that the root
`react` range stays open to the whole major (`^19.0.0`), so npm can dedupe our
React with a consumer's. `clients/tui/__tests__/tsupConfig.test.ts` enforces all
of it.

### One version per install-crossing dependency

Because v2 is not a workspace, the same package can appear **twice in one `tsc`
program** (a client's own install plus the root's, reached through `core/` or
`test-servers/src`). At the same version that is harmless; on a skew TypeScript
must relate two structurally-distinct declarations, which for a recursive-generic
surface is exponential — a zod `4.3.6`/`4.4.3` skew exhausted the 4GB tsc heap
(#1896).

**Raising the heap hides this class; align the versions instead** — bump it in
every install that *declares* it (not all four unconditionally; a package absent
from an install can't skew). `npm run verify:dep-lockstep` is the guard.

### Pinning a transitive dependency

Reach for an `overrides` entry before `npm audit fix`.
`clients/{web,cli,tui}/package.json` each override `esbuild` to `^0.28.2`
because `tsup@8.5.1` declares `^0.27.0` and the advisory has no upward escape
inside that range — `npm audit fix` "resolves" it by silently *downgrading*.
Two costs: it puts `tsup` on an esbuild major it does not declare, so `npm run
build` is the real gate on such a pin; and it is invisible to the audit once
clean, so **drop it when `tsup` widens its range** rather than carrying it
forever.
