# Copilot review instructions — MCP Inspector

> **`AGENTS.md` is the source of truth.** This file is a review-focused distillation of it, kept in sync by hand — see "Keep documentation files up to date" in `AGENTS.md`. Where the two disagree, `AGENTS.md` wins, and the drift is a bug worth flagging in review.

The Inspector ships as one package with three clients (**Web**, **CLI**, **TUI**) over a shared `core/`, consumed via the `@inspector/core` build-time alias. v2 is **not** an npm workspace: the root and each `clients/*` keep their own `package.json` and `node_modules`.

## TypeScript

- **Never use `any`.** Not in types, not in casts, not in generics.
- **Never suppress errors to satisfy the linter or compiler** — no disabling `no-unused-vars` / `no-explicit-any` in config, and no `// @ts-nocheck` or `// @ts-ignore` (`@typescript-eslint/ban-ts-comment` rejects these across every surface).
- **Avoid double casts (`as unknown as T`).** They erase all type safety and usually mean the real type is being worked around. Prefer a type guard, a narrower single cast, or fixing the underlying type. If genuinely unavoidable (a documented gap in a third-party type, or bridging structurally-identical shapes TS can't relate), it **must** carry an inline comment justifying why it's safe and why nothing better exists. An unjustified `as unknown as` is not acceptable in review.
- Prefer inference, type guards, and precise annotations over assertions.
- An `_` prefix is the intentionally-unused marker (`argsIgnorePattern` / `varsIgnorePattern` / `caughtErrorsIgnorePattern`).
- **Never float a promise.** `@typescript-eslint/no-floating-promises` is `error` in all five ESLint scopes, so every promise must be awaited, `.catch(…)`-terminated, returned, or explicitly discarded with `void`. Prefer **holding and settling** it — a floated rejection surfaces in an unrelated file as an SDK-internal stack, which is how two un-held `callTool` calls failed the whole `npm run local:gate` chain (#1947). Reach for `void` only when the callee already owns its failures (it ends in a `catch`) or the caller genuinely cannot await (a sync effect body, an Ink key handler), and say which in a comment. In Storybook play functions, `expect(...)` from `storybook/test` is instrumented and returns a promise — it must be awaited.

## React and UI (web client)

The web client is built from **presentational ("dumb") components** — they take data and callbacks as props and hold display logic only. No data fetching or client state inside them; state comes from the `@inspector/core` hooks wired near the top of the tree. A component that reaches for a store or fetches directly is a review finding.

Styling is **Mantine-first**, in this strict order of preference: component props → theme variants → CSS classes (last resort).

- **Never use inline styles.**
- **Never use raw color literals** — no hex (`#ddd`), no `rgba()`. Use the `--inspector-*` CSS custom properties from `App.css :root` (e.g. `c: 'var(--inspector-text-primary)'`). If no token fits, add one to `:root` first.
- **Avoid `div` and bare HTML for layout.** Use Mantine `Box`, `Group`, `Stack`, `Flex`, `Paper`.
- **Never add a CSS class when the styles can be component props or a theme variant.** Flat CSS properties (margin, padding, background, border, color, font-size) belong in the theme (`src/theme/<Component>.ts`, via `Component.extend()`). `App.css` may contain **only** what the theme cannot express: `@keyframes`, pseudo-selectors (`:hover`, `:focus`), cross-component hover relationships, nested child selectors for third-party HTML output, and styles for native elements (`img`, `iframe`).
- When a theme variant needs a class for nested/pseudo selectors, assign it via `classNames` in the theme extension — never a manual `className` in JSX for theme-styled components.

### The `.withProps()` rule

**Declare a named subcomponent constant via `.withProps()` whenever an inline Mantine element carries two or more _static_ props.** This applies to single-use elements too — "it's only used once" is not an exemption.

- **Static** = a literal configuring **styling, layout, or behavior**: `size="sm"`, `c="dimmed"`, `fw={500}`, `gap="xs"`, `justify="space-between"`, `variant="light"`, `withBorder`, `readOnly`, `striped`.
- **Not counted:** dynamic props (`value`, `on*`, `children`, `key`, `ref`, anything whose value is a variable) — pass these at the call site; and per-instance **content/accessibility** literals (`label`, `description`, `placeholder`, `title`, `aria-label`, `role`) — these never by themselves trigger extraction.

```tsx
const CardContent = Group.withProps({
  flex: 1,
  align: "flex-start",
  justify: "space-between",
  wrap: "nowrap",
});
```

**Legitimate exceptions** (each stays inline, with a one-line comment saying why):

- **`Box`** — does not support `.withProps()`. Use `Group`/`Stack`/`Flex`/`Text`/`Paper`/`UnstyledButton`/`Image` instead, chosen by purpose. A `Box` that genuinely needs a non-flex primitive (`component="iframe"`, `display="grid"`) stays inline.
- **`Accordion`** — a compound, `multiple`-discriminated generic; `.withProps()` loses its JSX call signature and fails to type.
- **Headless, non-`factory()` components** such as `Transition` — no Styles API, so no `.withProps` static at all.
- **`data-*` attributes** — not part of a component's typed props, so excess-property-checked out of a `withProps` literal. Pass at the call site.
- **Anything that isn't a Mantine factory component** — a `react-icons` glyph, another library's component, or a first-party plain `export function`.

### State and effects

- **Never reset or re-sync local state from a prop inside a `useEffect`.** `useEffect(() => setX(prop), [prop])` paints the stale value first and renders twice; it is an error under `react-hooks/set-state-in-effect`.
- Use **`useValueChange(value, onChange)`** (`src/hooks/useValueChange.ts`) — React's documented "adjusting state during render" pattern. It does not fire on the first render; seed the state with `useState`. The comparison is `Object.is`, so pass a **referentially stable** value — a primitive key (id/name/URI) or a memoized one, never a fresh object literal.
- The `onChange` runs **during render**, so it must be pure — `setState` and nothing else. No fetches, DOM writes, logging, ref mutation, or parent callbacks; a render can be replayed or abandoned.
- Effects remain correct for real external-system synchronization (DOM measurement, rAF, subscriptions, timers).
- **Subscribing to an `@inspector/core` state store is `useSyncExternalStore`, never `useState` + a subscribing `useEffect`** — that shape re-seeds state from the store prop, so it carries the same stale frame plus a window where an event dispatched between render and subscribe is lost. `useValueChange` is web-only and `core/react/` is shared with the CLI and TUI.
- Use **`useStoreSnapshot(store, event, read, whenAbsent)`** (`core/react/useStoreSnapshot.ts`), once per value, when the getter returns a **fresh value per read** (a defensive copy, or a freshly built object) — nearly all of them. When the snapshot is **already referentially stable**, subscribe directly and skip the helper, as `useListError` does with its `Error | null`. `read`/`whenAbsent` must be **referentially stable** — they are part of the cache key. `read` is a function, so module scope; `whenAbsent` needs a module-scope constant only when it is an object or array, since a primitive fallback (`false`, `undefined`, a string) is stable already and is passed inline in these hooks. An unstable one fails **quietly** — no throw, no React warning, no extra render, just a fresh value each render that defeats downstream memoization.
- The snapshot is cached against the store's per-event dispatch counter (`TypedEventTarget.getEventRevision`), **not** its contents — a contents compare cannot see a dispatch that mutated an entry already in the list. Don't replace it with a shallow compare.
- The store is the source of truth; the event is only the signal. A test firing a store event must set the value on the store first, and a fake store must extend the real `TypedEventTarget` (a bare `EventTarget` lacks `getEventRevision`).

### Theme files vs. element components

Both exist and do different jobs. Theme files (`src/theme/<Component>.ts`) customize a Mantine primitive **app-wide**. Element components (`src/components/elements/`) add **domain semantics** on top of primitives.

- Element components import from `@mantine/core`, **not** from `src/theme/` — the theme layer is applied transparently by the provider.
- **Never push domain-specific variant logic into theme files** (annotation types, transport types, …). Domain variants belong to the element component that owns those semantics.

## Where code goes (web client)

**`utils` = functions that compute; `lib` = things that instantiate, adapt, or touch the environment.** If it does I/O or wraps a subsystem it's `lib`; if it's a pure transform it's `utils`.

- `src/utils/` — pure, side-effect-free. Also: pure shared domain types and their constructors; diagnostic `console.warn`/`error` does **not** count as a side effect; type-only imports from `@inspector/core`, and re-exporting pure functions/constants from core, are both fine.
- `src/lib/` — infrastructure, integration, stateful adapters: composes subsystems, wraps the core **runtime**, touches DOM / `window` / `sessionStorage`, or produces side effects.
- Cross-directory imports go **one way: `lib → utils`**, never the reverse.
- `src/types/` is only for ambient `.d.ts` module stubs — not a home for new domain types.
- ⚠️ The coverage `include` is a **whitelist** naming `components` / `hooks` / `theme` / `lib` / `utils` / `server` (plus the `core/*` runtime). A module placed outside those directories silently falls out of the ≥90% gate. Flag new top-level files or new grab-bag directories.

## Dependency placement

- **The MCP SDK packages (`@modelcontextprotocol/client`, `core`, `server`, `server-legacy`, `ext-apps`) belong in the root `package.json` only.** Adding one to a `clients/*/package.json` is a review finding: Node resolution walks up, so the root install already serves every client, and a per-client entry installs a second copy that drifts (it produced two versions of `ext-apps`, and of the transitive v1 SDK, at once — #1970) and reintroduces the duplicate-copy failure `vitest.shared.mts` has a `dedupe` workaround for.
- **The v1 `@modelcontextprotocol/sdk` is not a dependency of this repo** and must not become one. It is a peer of `ext-apps`, present in lock files only.
- Dependencies reached only through **root-owned code with no manifest** (`test-servers/src`, `core/`) are declared at the root and aliased to the **repo root** in `vitest.shared.mts` — as `express` and `yaml` are — not to `<client>/node_modules` like the other pins there.
- **A dependency that renders React components must be bundled into the client that uses it, and is then not a root dependency.** An externalized package resolves its own `react` from wherever npm placed it in the _consumer's_ tree, beside a React satisfying _its_ peer range — looser than ours, which is all it takes to split React. `ink-form`/`ink-scroll-view` declare `">=18"`, so a consumer's React 18 satisfies them, the TUI ends up with two React instances, and it crashes on the first hook (#1952). Both are inlined via `noExternal` in `clients/tui/tsup.config.ts`. **`ink` is the one exemption, justified by cost (~1.4MB) — never by a peer range**: flag any claim that `">=19"` keeps npm from misplacing it, which is false and was in this repo once. What keeps it safe is the **root `react` range staying open to the whole major (`^19.0.0`)** so npm can dedupe with a consumer's pinned React 19; treat narrowing that range as reopening the bug. `clients/tui/__tests__/tsupConfig.test.ts` enforces the split, the root-declaration of exempt packages, and that range.
- **Which section is a separate question from which manifest.** A package `core/` imports at runtime must be in root **`dependencies`**: client builds externalize npm packages, so a published install resolves them from the root manifest and devDependencies are absent there. Only test/build-only packages (`express`) belong in `devDependencies`. Flag a runtime `core/` import added to `devDependencies` — it passes every local check and breaks the published package.
- **A root-declared package that `core/` imports at runtime must also be named in each client's bundler `external` list** — `clients/{cli,tui}/tsup.config.ts` and `clients/web/tsup.runner.config.ts`, all three. Bundlers externalize what the _client's_ manifest declares, and these packages are root-only by rule, so omitting them means they get bundled. For a CJS package inlined into an ESM bundle that is fatal: esbuild's `Dynamic require of "path" is not supported` shim throws at import time and the binary dies before parsing a flag (#2082, `proper-lockfile`). Flag a new root runtime dependency that is not added to all three. This has broken twice — `undici` slipped past #2082 because it _was_ declared in `clients/cli/package.json`, so the CLI looked fine while the web and TUI bundles inlined 1.05MB of it, unloadably (#2067). `npm run verify:bundle-externals` now guards it from the **built output**; flag any change that would weaken or skip that guard.
- **Pin a transitive dependency past its parent's declared range with an `overrides` entry — never with `npm audit fix`.** When the advisory range has no upward escape inside the parent's range, `npm audit fix` resolves it by silently *downgrading* (esbuild 0.27.7 → 0.27.2 across three installs, #2058/#2062). Flag that in a diff. An override puts a bundler on a major it does not declare, so the gate for one is `npm run build`, not `npm audit`; a lockfile diff accompanying it should touch that package's entries only. Flag an override added without a note saying when it can be dropped.

## Tests and the coverage gate

- **All new or modified code needs tests.** The per-file gate is **≥ 90% on all four dimensions** — lines, statements, functions, **and branches** — enforced in CI for `clients/{web,cli,tui,launcher}` and the gated `core/` runtime.
- **Never lower the gate** to accommodate an unreachable branch. Annotate at the source with a justified `/* v8 ignore … -- <reason> */`. Acceptable reasons: happy-dom-inherent paths (Mantine portal mounts, `useMediaQuery` fallbacks, `typeof window` SSR guards), React StrictMode effect-replay blocks, and provably-dead defensive guards. Anything else is a missing test.
- **Suppress expected error output** from the console in tests that exercise error paths.

### Test placement

- **Web:** side-by-side by default — `<Name>.test.tsx` next to the source. A web-owned test under `src/test/` instead of beside its source is a bug. `src/test/` is only for what can't be co-located: tests of the repo-root `core/` package (`src/test/core/…`, mirroring core's layout), the `integration` project (`src/test/integration/…` — placement _is_ the manifest), and shared test infrastructure.
- **CLI / TUI / launcher:** **all** tests live in a top-level `__tests__/` directory. A co-located `src/**/*.test.*` lands in no tsconfig project and fails `verify:typecheck-coverage`.

### Rendering components in tests

- **Always render through `renderWithMantine`** from `src/test/renderWithMantine.tsx`. A hand-rolled bare `MantineProvider` skips the project theme and the helper's options, and drifts from every other test. (It does _not_ reintroduce the timer-leak class — an older version of this rule said so; the leaked-timer net in `setup.ts` is global and covers every unit test regardless of how it renders.)
- For a forced color scheme, pass the option — `renderWithMantine(ui, { colorScheme: "dark" })` — rather than a hand-rolled `defaultColorScheme` provider.
- Only when asserting _mid-flight_ transition state, use `renderWithMantineTransitions`, passing `settleMs` derived from the component's real animation duration. Do **not** combine it with `vi.useFakeTimers()`, and use the `unmount()` it returns if the test unmounts the tree itself.

## Gates and PR hygiene

- `npm run format` before committing; **`npm run local:gate` before pushing** (`validate` → `coverage` → `verify:build-gate` → `verify:bundle-externals` → `smoke` → `smoke:web:firefox` → `local:storybook`; the Firefox step is local-only and not mirrored in GitHub CI). The gate is named `local:` rather than `ci` on purpose and has **no alias** (#2146) — `npm run ci` is gone, and a workflow that invokes a `local:*` script, a non-Chromium engine pass, `smoke:web:engine`, or sets `SMOKE_BROWSER` to a non-Chromium value fails `test:scripts` via `scripts/lib/workflow-gate.mjs` — as does naming either family through a workflow expression (`smoke:web:${{ matrix.browser }}`). It parses the workflow and scans only the executable paths — `run:` scalars, a custom `shell:` command template (step, and `defaults.run.shell` at workflow/job level, since Actions runs it *around* the script), and `env:` / `container.env:` / `with:` values, with YAML aliases resolved — so metadata is not a finding. Flag any diff that adds one of those to `.github/workflows/**`, or that reintroduces a `ci`/`ci:*` root script. `npm run validate` is the fast inner-loop check and is **not** a substitute — it runs `test`, not `test:coverage`, so it does zero coverage gating. The canonical CI-vs-local table is in the root README ("Two tiers: GitHub CI and the local gate").
- **A dependency bump must land in every install that declares it.** v2 is not a workspace — the root and each `clients/*` have their own `node_modules`, and a client's test project compiles `core/` and `test-servers/src` (which resolve from the **root**) alongside the client's own sources. Bumping a shared dependency in one manifest only puts two versions of it in one `tsc` program; for a recursive-generic surface like zod that exhausts the tsc heap (#1896). `verify:dep-lockstep` fails the build on this — it derives its candidates from what each `tsc` program actually resolves (`tsc --listFilesOnly`, keeping packages that reach one program from two installs), so a package reached only through another package's `.d.ts` counts too (#1965) — so a PR bumping a package the shared sources pull in should update the root **and every client that already lists it** — not every client unconditionally, since a package absent from an install can't skew and adding it there would be a spurious dependency.
- **A test or smoke must not touch real user state.** The web smokes run against a throwaway catalog via the shared `scripts/lib/prod-web-server.mjs` helper, never the developer's `~/.mcp-inspector/mcp.json` (#1977); the cli/tui smokes drive a temp `--catalog`; `pack:verify`'s `--web` child sets its own `MCP_CATALOG_PATH` for the same reason (#2003 — its App deep link persists a server row). Anything that boots the web backend and then *navigates* it needs that isolation, not just the scripts named `smoke:*`. A new smoke spawning its own server, or teardown that removes a work dir without first awaiting `stopChild` (the #1801 race — `child-cleanup.mjs` exports both halves and both are required), should be flagged.
- **A smoke must assert the thing survives, not that it started.** `smoke:tui` runs the Ink TUI under a pseudoterminal (`scripts/lib/pty.mjs`) and requires it to still be running `SMOKE_TUI_SURVIVE_MS` after its first frame (`scripts/lib/render-smoke.mjs`) — because it previously settled OK on first paint while the TUI was exiting 1 ~40ms later with `Raw mode is not supported`, and won that race on every machine (#2147). Flag anything that collapses the survival wait back into "resolve on the marker", and any new smoke whose only assertion is that a process printed something once. A smoke walks only its own happy path, so the branch that matters — started, then died — belongs in a `scripts/lib/*.test.mjs` driven against a stub (as with `announced-child.mjs` #2000 and `ensure-test-servers.mjs` #2111), not in the smoke.
- **The headless web smokes are engine-parameterized, not Chromium-only.** `smoke:web:browser` / `smoke:web:app` / `smoke:web:elicit` take their engine from `SMOKE_BROWSER` (chromium — the default — firefox, webkit). **GitHub CI runs Chromium only; Firefox runs in the local pre-push gate** via `smoke:web:firefox` (#2086 — a CI job was trialled and removed for never disagreeing with Chromium across a dozen runs, and moved into `npm run local:gate` instead). They exist because the MCP Apps sandbox is built out of the primitives that diverge between engines: `srcdoc` CSP inheritance, nested sandboxed iframes, `Permissions-Policy`, cross-frame `postMessage`. Nothing else covers that — `sandbox-csp.test.ts` asserts a policy *string*, and no Storybook story reaches the sandbox at all. Flag a new browser-driven script that launches Playwright itself instead of going through `scripts/lib/headless-browser.mjs`, an unrecognized-engine path that falls back to Chromium rather than failing (it would claim coverage that never ran), or a launch-failure message naming the wrong engine. `pack:verify` is pinned to Chromium on purpose — it is a packaging check, as is **`smoke:web:tabs`** (#2148), the connected-flow smoke for the Tools / Resources / Prompts tabs: those are ordinary React and Mantine rather than the sandbox, so it is deliberately **outside `ENGINE_SMOKES`** and pins `chromium` on **both** halves of its npm script — install and launch. Flag a supposedly single-engine script that reads ambient `SMOKE_BROWSER` (an ambient value must not be able to redirect a gated tier), or one whose install and launch engines can disagree.

- **A browser-driven smoke asserts `data-*` attributes, never visible copy** (#2148). Each screen exposes a readiness contract — `data-app-status` for Apps, and `data-tool-count` / `data-call-status` and their Resources / Prompts equivalents for the core tabs, tabulated in `clients/web/README.md`. Copy-based waits fail on the next rewording, and as an opaque timeout rather than a mismatch. Two things to flag: a new smoke matching on text or a heading, and an assertion that stops at an **RPC status** where the issue asked for something to *render* — `data-read-status="ok"` flips the moment `resources/read` resolves and stays true with the preview panel deleted, so the rendered-panel testid must be asserted alongside it. Each attribute name is pinned by a screen unit test so a rename fails there, not in a five-minute gate. Shared drive steps belong in `scripts/lib/` (the deep link lives in `deep-link-connect.mjs`): `parseDeepLink` *ignores* a link it cannot validate rather than reporting one, so a copied-and-drifted link fails as a silent connect timeout.
- **Build output is never a gate target.** Lint, format, and typecheck read first-party source only; everything a build writes (`clients/*/build`, `clients/web/dist`, `storybook-static`, `coverage`, `test-servers/build`, `core/**/{build,dist}`, `*.tsbuildinfo`) stays out via each scope's `globalIgnores`, `format` globs, and tsconfig `include`. Gating generated code reports defects in vendored third-party source that nobody can fix, and a rule promotion turns that warning into a `validate` failure (#2043). Flag a PR that adds a build location without ignoring it in the same change, that widens an ignore to silence a finding in first-party code, or that adds a build directory to a tsconfig `include` to make a generated `.d.ts` resolve. Note the coverage guards don't catch this — they assert source is _covered_, not that output is _excluded_.
- **Lint has no warning tier.** Every `lint` script runs `--max-warnings 0`, so a warning fails `validate` exactly as an error does (#2085) — a `warn`-level `react-hooks/exhaustive-deps` finding otherwise let a stale-closure bug pass the pre-push gate and reach review. Flag a PR that silences a finding to make the gate pass (widening a `globalIgnores`, dropping a rule, or an inline disable with no justification comment); the fix is the defect, not the message. A rule meant to be enforced should be set to `error` rather than left at `warn` and carried by the flag.
- **Every PR references an issue**, first body line `Closes #<ISSUE_NUMBER>`.
- **Every PR carries exactly one version label**, `v1` or `v2`, matching its base branch.
- **Commits carry a `Signed-off-by:` trailer.** The DCO check is a hard merge gate and fails on a single unsigned commit; it matches the trailer against the author _or_ committer, and skips only merge and bot commits. Use `git commit -s` — note `format.signOff` does _not_ sign `git commit` (only `format-patch`). Repairing pushed commits means `git rebase HEAD~<n> --signoff` + `git push --force-with-lease`; remediation commits are not enabled on this repo.
- Update the relevant `README.md` / `AGENTS.md` when a change adds, removes, renames, or repurposes a file or folder, changes the structure or tech stack, or introduces a command, dependency, or architectural pattern.

## What to prioritize in review

1. Correctness and security — this backend spawns local processes and proxies outbound requests, so anything touching auth, origin validation, host binding, or the proxy's SSRF controls deserves close reading.
2. Type-safety violations (`any`, suppressions, unjustified double casts).
3. Missing or thin tests against the ≥90% four-dimension gate, and modules placed outside the gated directories.
4. Mantine convention violations — inline styles, raw colors, unnecessary CSS classes, missing `.withProps()` extraction.
5. Docs that contradict the change.
