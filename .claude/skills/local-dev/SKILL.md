---
name: local-dev
description: Getting the Inspector running locally, and the reasoning behind its dependency rules. Which install to run and which script starts each client (web, cli, tui, launcher); why v2 is not an npm workspace; how the @inspector/core alias works; and why the placement rules in AGENTS.md are what they are — what each one is defending against, what it looked like when it was violated, and how to tell you have hit one.
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
`node_modules`, and a consumer never needs it because the tarball ships
**prebuilt** artifacts (each client's `build/`, plus `clients/web/dist` and
`clients/web/static`) rather than sources to compile. Set
`INSPECTOR_SKIP_CLIENT_INSTALL=1` to skip it. The `files` allowlist itself is
[`docs/publishing.md`](../../../docs/publishing.md).

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
- **Web** — **two** configs, because the client is two builds:
  `clients/web/vite.config.ts` for the browser app, and
  `clients/web/tsup.runner.config.ts` for the Node backend runner, which
  defines the alias itself. Dependency or debugging work on the runner belongs
  in the tsup config, not the Vite one (Copilot).

## Where a dependency goes

**The rules are in [`AGENTS.md`](../../../AGENTS.md) → Dependency placement, and
they are not restated here.** Read them there and come back for the *why* — what
each rule is defending against, what it looked like when it was violated, and how
to tell you have hit one.

Work the rules in order: which manifest declares it, then `dependencies` vs
`devDependencies`, then whether the bundlers must also externalise it.

### Why `core/`'s runtime dependencies are root-only

A per-client declaration installs a **second copy** that drifts from the root's.
Not theoretical: it put two versions of `ext-apps` (1.7.4 / 1.7.5) and of the
transitive v1 `@modelcontextprotocol/sdk` (1.29.0 / 1.30.0) in the tree at once
(#1970). A second copy of `client`/`core` is exactly the failure the `dedupe` +
`server.deps.inline` workaround in `vitest.shared.mts` exists for.

The same reasoning extends to anything reached only through root-owned code that
has no manifest of its own (`test-servers/src`, `core/`). #2195 made that the
general case: `ajv`, `atomically`, `chokidar`, `hono`, `@napi-rs/keyring`,
`pino`, `react` and `zod` moved to the root, joining `proper-lockfile` and
`undici`, which were already there.

Keep two distinctions straight, because AGENTS.md's rules split on them:

- **Root-declared is not the same as `core/`-imported.** `commander`, `open` and
  `@hono/node-server` are root `dependencies` too, but they are reached only
  from client code. Only the `core/` set has to appear in *all three* bundler
  `external` lists.
- **Root-declared is not the same as aliased.** The `vitest.shared.mts` pins and
  the `clients/web/tsconfig.*.json` `paths` cover the packages whose resolution
  is genuinely ambiguous — a transitive copy sits in the client install, or the
  importer is `core/`, which has no manifest to resolve from. A package that
  resolves unambiguously by walk-up (`ajv`, `commander`, `open`, `undici`,
  `zod`) is deliberately absent from both.

The point of deleting the client-side copies rather than merely keeping them in
step is that **a package installs only into an install root that declares it**.
Aligned duplicate declarations still drift the next time someone bumps one of
them; no declaration at all cannot. `npm run verify:dep-lockstep` is the detector
for the skew, and consolidation is what removes the opportunity.

Two consequences that read as bugs and are not:

- **`clients/cli` and `clients/launcher` declare no runtime dependencies.** Their
  manifests carry `devDependencies` only. Everything they import at runtime is
  root-declared and resolves by walking up from the client directory.
- **A client's `node_modules` still contains some of these names.** They arrive
  transitively (`chokidar` under `vite`, `react` as a peer of `react-dom` and
  `ink`). That is why the `vitest.shared.mts` pins matter: an unpinned specifier
  would resolve the nearest copy, which is the transitive one, not the root's.

When a package moves to the root, its `vitest.shared.mts` pin has to move with
it — a `path.resolve(dirname, …)` pin left behind points at a directory that no
longer exists, or (for the transitive cases above) at the duplicate the pin was
supposed to rule out.

**`react` and `react-dom` are the exception, and stay pinned per client.** They
are a matched pair — `react-dom` reaches into React internals — and `react-dom`
is still web-declared, so npm resolves it and its React peer together inside
`clients/web/node_modules` (19.2.8 today, against the root's 19.2.7). Pointing
`react` at the root while `react-dom` resolves from the client would pair a
renderer with a React it was not installed against, which is the same split the
pin exists to prevent, arrived at from the other side. `dedupe` still collapses
each install to one copy, which is what actually has to hold.

### Why runtime consumption decides `dependencies`

The client builds externalise npm packages, so a published install resolves them
from the **root** manifest — and devDependencies are not installed for
consumers. A runtime import parked there therefore **breaks the published
package while passing every local check**, which is the worst shape a mistake
can take here.

Two live examples worth knowing:

- `express` is test-only, so it is a devDependency.
- `vite` and `@vitejs/plugin-react` look like build tooling but are root
  `dependencies`, because `clients/web/server/start-vite-dev-server.ts` imports
  them at runtime for `--web --dev`. Moving them would break that for consumers
  while every local check stayed green.

### Why a root dependency must also be externalised

tsup and Vite externalise what the **client's** `package.json` declares, and a
root-only dependency is in none of them — so it is **bundled**, silently. For a
CJS package inlined into an ESM bundle that is fatal: esbuild leaves a
`Dynamic require of "path" is not supported` shim that throws at *import* time,
so the binary dies before it parses a flag (`proper-lockfile`, #2082).

`undici` (#2067) is the worse variant, because it is `import()`ed lazily: the
binary boots fine and only the proxied path dies — with esbuild's rewritten
specifier (`import("./undici-HXPKCIY3.js")`) meaning **no user-side install can
ever satisfy it**. It was declared in `clients/cli/package.json`, so the CLI
looked correct while web and TUI silently inlined 1.05 MB of it.

**How to tell.** The ordinary tiers cannot: unit and integration tests run
against source, where the real package is on the resolution path, and the smokes
never take the lazy path. `npm run verify:bundle-externals` reads the **built
output** for exactly this reason — the config and the output disagreed for four
releases.

⚠️ **Probing by hand with `node -e` falsely succeeds.** `node -e` exposes a
global `require` that satisfies esbuild's `typeof require !== "undefined"`
guard, so the chunk looks loadable when it is not. Reproduce from a real `.mjs`
file.

### Why React-rendering packages are the exception

An externalised package resolves its own `react` from wherever npm placed
**it** — beside a React satisfying *that package's* peer range, which is looser
than ours in every case here. `ink-form` and `ink-scroll-view` declare `">=18"`,
so a consumer's React 18 satisfies them and hoists them while our React 19 nests
underneath: the bundle renders through one React, those packages call hooks on
another, and the TUI crashes on the first hook (#1952).

`ink` is exempt on **cost** (~1.4 MB of `react-reconciler` + `yoga-layout`, plus
a `createRequire` banner). ⚠️ **Never justify that exemption by a peer range** —
it briefly read "its `">=19"` peer keeps npm honest", which is false: a consumer
pinning React 19.0 satisfies `">=19"` while a narrower range of ours nests
underneath. What makes it safe is the *root `react` range staying open to the
whole major*, so npm can dedupe. `clients/tui/__tests__/tsupConfig.test.ts`
enforces the whole split, the exemption included.

### Why a version skew is worth aligning rather than working around

Because v2 is not a workspace, the same package can appear **twice in one `tsc`
program** — a client's own install plus the root's, reached through `core/` or
`test-servers/src`. At the same version that is harmless; on a skew TypeScript
must relate two structurally-distinct declarations, which for a
recursive-generic surface is exponential. A zod `4.3.6` / `4.4.3` skew exhausted
the 4 GB tsc heap outright with `TS2589` (#1896).

⚠️ **Raising the heap hides the class rather than fixing it.** Align the
versions; `npm run verify:dep-lockstep` is the guard, and it derives its
candidate set from what actually enters each `tsc` program, so a package whose
declarations arrive only through another package's `.d.ts` is still seen.

### Why `overrides` beats `npm audit fix`

`tsup@8.5.1` declares `esbuild: ^0.27.0`, and the advisory covers
`0.27.3 - 0.28.0` with `0.27.7` the last 0.27.x — so there is no *upward* escape
inside that range, and `npm audit fix` "resolves" it by silently **downgrading**
to `0.27.2` across three installs (~700 lines of lockfile churn for a low-severity
dev-only advisory; tried and reverted in #2058). The override forces one deduped
copy above the range instead.

Two costs: it puts `tsup` on an esbuild **major it does not declare**, so
`npm run build` — not `npm audit` — is the real gate on such a pin; and it is
invisible to the audit once clean, so **drop it when `tsup` widens its range**
rather than carrying it forever.
