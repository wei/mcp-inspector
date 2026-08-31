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

### Why the SDK packages are root-only

A per-client declaration installs a **second copy** that drifts from the root's.
Not theoretical: it put two versions of `ext-apps` (1.7.4 / 1.7.5) and of the
transitive v1 `@modelcontextprotocol/sdk` (1.29.0 / 1.30.0) in the tree at once
(#1970). A second copy of `client`/`core` is exactly the failure the `dedupe` +
`server.deps.inline` workaround in `vitest.shared.mts` exists for.

The same reasoning extends to anything reached only through root-owned code that
has no manifest of its own (`test-servers/src`, `core/`) — hence the repo-root
alias for those in `vitest.shared.mts`. `express` and `yaml` are the two today.

### Why the shared toolchain is root-only

Every client's `validate` shells out to `prettier`, `eslint`, `tsc` and `vitest`,
which makes them look like they belong beside the scripts that call them. They
do not need to be: `npm run` prepends **every ancestor** `node_modules/.bin` to
`PATH`, and Node and TypeScript walk parent `node_modules` /
`node_modules/@types` the same way — so a client that declares no toolchain at
all still resolves the root's copy. `clients/launcher` declares no
`devDependencies` whatsoever and its `validate` is unchanged.

What a per-client declaration *does* buy is a second copy free to drift, and it
had (#2196): `globals` sat at `^17.7.0` at the root against `^17.4.0` in all four
clients, and `typescript-eslint` at `^8.65.0` against `^8.56.1`. Nothing failed —
which is the point. A lint or format tool that differs per client makes the gate's
verdict a function of *where you ran it*, and the exact `prettier` pin (#1790)
only means something when there is one of it.

⚠️ The line is **used by every client**, not "used by one" and not "is it
toolchain". `tsx`, `playwright`, `storybook`, `happy-dom`, `ink-testing-library`,
`vite-node` and each client's own `@types/*` are toolchain too and stay where
they are — hoisting them would make every client install the union of all four.
So do the ones **more than one** client declares without all of them doing so:
`tsup` sits in web, cli and tui, and `vite` in web and tui on top of the root
*runtime* `dependency` that `--web --dev` needs. Neither is in scope here;
whether to consolidate them is a separate call with a separate rationale (`vite`
especially, since its root declaration is a `dependency`, not a
`devDependency`).

#### What the walk-up does *not* buy you

⚠️ **Deleting a client's declaration does not always delete the copy** — and
where a copy survives, it is the one that wins. Two mechanisms put one back,
neither of which the manifest mentions:

- **An unmet peer.** npm auto-installs a peer into the install that needs it, and
  a client install has no visibility into the root's tree, so the root's copy
  cannot satisfy it. Web's `eslint-plugin-react-refresh` / `eslint-plugin-storybook`
  and the TUI's `eslint-plugin-react-hooks` each pull a client-local `eslint`;
  web's Storybook/Vitest stack pulls a local `typescript` and `vitest`.
- **A hoisted transitive.** `@types/express` brings `@types/node` into web and
  cli's trees on its own.

Those copies sit *nearer* than the root's, so `clients/web/node_modules/.bin`
precedes the root bin directory on `PATH` and TypeScript resolves the nearest
`node_modules/@types`. Verify with `npm exec -- which eslint` from the client
rather than assuming — the assumption is what made the first cut of #2196 claim
more than it delivered (Copilot).

So the consolidation buys **one declaration and one place to bump**, not one copy
on disk. Each surviving copy is pinned by its holder's peer range rather than by
a second declaration of ours, which is why they agree today.

⚠️ **Nothing gates that automatically, and `verify:dep-lockstep` is not it.**
That guard derives its candidate set from what each `tsc` **program** resolves
(see below), so it sees only packages a program loads from two installs. A tool
*binary* — `eslint`, `prettier`, `vitest` — never enters a program, so it is
outside the candidate set no matter how far it drifts, and cli's `@types/node`
`24.13.1` against the root's `24.13.3` is a live skew that passes for the same
reason (no one program sees both). When you change what a client declares, check
by hand from that client:

```sh
cd clients/web && npm exec -- which eslint prettier tsc vitest
```

#### Why the vitest trio is pinned exactly

`@vitest/browser-playwright` declares an **exact** peer on `vitest` (`"vitest":
"4.1.10"`, not a range), so that package — not the root's range — decides which
`vitest` lands in `clients/web`. Left floating, the root resolves the newest
patch while web's peer stays pinned to the older one, and web's tests then run on
one `vitest` while loading a `@vitest/coverage-v8` provider built against
another. Both would still pass, which is the bad part.

So `vitest` and `@vitest/coverage-v8` at the root and `@vitest/browser-playwright`
in `clients/web` are all pinned **exactly**, and a bump edits all three in one
change — the same discipline as the exact `prettier` pin (#1790).

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
