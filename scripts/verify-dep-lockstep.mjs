#!/usr/bin/env node
// Durable guard for the "one version per install-crossing dependency" invariant
// (#1896). v2 is not an npm workspace: the root and each `clients/*` carry their
// own `node_modules`, so the *same* package can resolve to two different
// versions in one process — or, worse, in one `tsc` program.
//
// That second case is what this guard exists for. A client's
// `tsconfig.test.json` compiles first-party sources that live *outside* the
// client (`test-servers/src`, `core/`), and those files resolve their
// dependencies from the **root** install while the client's own sources resolve
// from the client install. When the two copies are the same version the
// duplication is harmless; when they skew, TypeScript must relate two
// structurally-distinct declarations of the same type.
//
// For most packages that is merely redundant work. For a deeply
// recursive-generic type surface it is exponential: zod `4.3.6` (root) against
// zod `4.4.3` (clients/web) made `tsc -b` in `clients/web` exhaust the 4GB
// default heap outright (`FATAL ERROR: Ineffective mark-compacts near heap
// limit`) via `TS2589 Type instantiation is excessively deep`, because every
// `@modelcontextprotocol/*` schema is built out of zod generics. Aligning the
// two copies — changing nothing else — returned the build to its baseline cost.
//
// The candidate set is DERIVED, not hand-listed: it is the packages imported by
// the shared first-party TypeScript — `core/`, `test-servers/src`, and the
// root-owned `vitest.shared.mts` — the surfaces compiled into more than one
// client's program. Skew is then denied by default, with a small
// allowlist of packages verified to tolerate it (below). A dependency that
// starts skewing therefore fails `validate` and forces a decision, rather than
// surfacing months later as an unexplained OOM.
//
// KNOWN BOUNDARY (#1965): the candidate set covers packages the shared sources
// name *directly*. A package whose declarations reach the program only through
// another package's `.d.ts` is invisible here — `@modelcontextprotocol/sdk` is
// the live example, skewed root 1.29.0 vs `clients/web` 1.30.0 and present in
// web's program from both installs, yet never written in first-party code
// (the shared sources import the split `@modelcontextprotocol/client|core|…`).
// Two derivations were measured for closing this. A lockfile dependency
// closure is unusable — 155 packages, 25 of them skewed, nearly all irrelevant
// tooling (`chai`, `qs`, `iconv-lite`) — and it misses the SDK anyway. Reading
// what actually lands in each program (`tsc --listFilesOnly`, keeping packages
// present under two install roots) is both correct and small: 15 for
// `clients/web`, ~10 once nested duplicates are dropped. That is the right
// derivation and is tracked separately, since it changes what the guard
// measures and surfaces skews needing their own decisions.

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { builtinModules, createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { rootReachesScript } from "./lib/npm-scripts.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

// The first-party source trees that are compiled into more than one install's
// `tsc` program, and so define which dependencies can appear twice in one
// program. `core/` is consumed by every client via the `@inspector/core` alias;
// `test-servers/src` is pulled into the web and cli test projects.
const SHARED_SOURCE_DIRS = ["core", "test-servers/src"];

// Individual root-owned TypeScript files that are shared the same way but sit
// outside those trees. `vitest.shared.mts` is imported by every client's vitest
// config, and `verify:typecheck-coverage` already treats it as shared
// non-client source. It imports only Node built-ins today — which is precisely
// why omitting it would go unnoticed until a third-party import appeared there,
// resolved from the root, and skewed (Copilot, #1962).
const SHARED_SOURCE_FILES = ["vitest.shared.mts"];

// Packages whose cross-install skew is verified benign, each with the reason.
// This is an allowlist of *names*, not of version pairs, so an ordinary patch
// float within one of these does not churn the file — while any package NOT
// listed here failing the check is a genuine, unreviewed new skew.
//
// Being listed is NOT a blanket exemption: it tolerates skew only *within a
// major version*. Each rationale below establishes that a patch/minor
// difference is harmless, which is not evidence that a React 18-vs-19 or Hono
// 4-vs-5 split across installs would be — that is a different type surface, and
// it fails like anything else (Copilot, #1962).
//
// The admission test is the one the zod incident established: does the
// package's public type surface consist of deeply recursive generics that
// first-party code relates across the boundary? If yes it must stay in
// lockstep; if no, a patch-level difference costs nothing.
const TOLERATED_SKEW = new Map([
  [
    "react",
    "Types are shallow interfaces (`ReactNode`, `FC`), not recursive generics; the runtime copies never meet — each client bundles its own.",
  ],
  [
    "hono",
    "Only used behind first-party wrappers in `core/mcp/remote/node`; its generic router types are not related across the boundary.",
  ],
  [
    "jose",
    "Consumed as flat function calls in `core/auth`; no generic type flows between installs.",
  ],
  [
    "@modelcontextprotocol/ext-apps",
    "Plain interface/constant surface for the MCP Apps UI protocol; no generic instantiation to blow up.",
  ],
]);

/** Package names that are Node built-ins (with or without the `node:` prefix). */
const BUILTINS = new Set([
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
]);

// A bare package specifier: optional `@scope/`, then a name, then any subpath.
// Anchored so prose that happens to sit after the word `from` in a comment
// ("from cwd omitted") cannot be mistaken for an import.
const PACKAGE_SPECIFIER = /^(?:(@[^/\s]+)\/)?([^@/\s][^/\s]*)(?:\/.*)?$/;

/**
 * The bare package name a module specifier resolves to — `@scope/name` or
 * `name`, with any subpath dropped (`zod/v4` → `zod`). Returns null for
 * relative paths, built-ins, URLs, and anything not shaped like a specifier.
 */
export function packageNameOf(specifier) {
  if (typeof specifier !== "string" || specifier === "") return null;
  if (specifier.startsWith(".") || specifier.startsWith("/")) return null;
  if (BUILTINS.has(specifier)) return null;
  const m = PACKAGE_SPECIFIER.exec(specifier);
  if (!m) return null;
  const name = m[1] ? `${m[1]}/${m[2]}` : m[2];
  // A protocol-ish specifier (`node:test`, `file:`, `data:`) is not a package.
  if (name.includes(":")) return null;
  return name;
}

// Specifiers are extracted with TypeScript's own `preProcessFile` rather than
// by regex (Copilot, #1962 — raised across three review rounds, and correctly).
// A regex scan gets both directions wrong: it *misses* valid syntax (an
// `import x = require(…)` in a `.cts`, an import-attributes argument, a comment
// between tokens — each a silent miss, so the package never enters the
// candidate set and its skew passes), and it *invents* names from prose, since
// `// adapted from "react"` is indistinguishable from an import to a pattern
// that can't tell code from a comment. Every widening of the regex traded one
// of those failures for the other.
//
// `preProcessFile` is TypeScript's lightweight pre-parse scanner — not a full
// parse and no type checking — and it is exactly built for this: it returns
// every module specifier, handling all import forms, trivia, strings, and
// regex literals correctly, and it never sees a comment as code.
//
// typescript is resolved from `clients/web`, which already carries it; the root
// has no TS dependency of its own. The `createRequire` base is load-bearing —
// a bare `import("typescript")` would resolve relative to `scripts/`, not the
// cwd (the same reason `smoke-web-browser.mjs` resolves playwright this way).
let tsCache;
function typescript() {
  if (!tsCache) {
    const require_ = createRequire(
      path.join(repoRoot, "clients", "web", "package.json"),
    );
    try {
      tsCache = require_("typescript");
    } catch (cause) {
      // Fail with the cause, not a bare MODULE_NOT_FOUND: the realistic way to
      // get here is a root install run with INSPECTOR_SKIP_CLIENT_INSTALL=1,
      // which leaves `clients/web/node_modules` empty. Silently skipping the
      // check instead would be worse — an unrun guard guards nothing.
      throw new Error(
        "verify:dep-lockstep — could not resolve `typescript` from clients/web. " +
          "Run `npm install` at the repo root (the postinstall cascade installs each client); " +
          "if you set INSPECTOR_SKIP_CLIENT_INSTALL=1, this guard cannot run.",
        { cause },
      );
    }
  }
  return tsCache;
}

/**
 * The package(s) a `/// <reference types="x" />` directive can resolve to
 * (Copilot, #1962). Such a directive pulls in declarations exactly like an
 * import does, but TypeScript reports it separately from `importedFiles`, so
 * reading only the latter would let a referenced package skew unseen.
 *
 * Both candidates are returned because the directive name is the *type* name,
 * not the package: `node` resolves to `@types/node`, while a package shipping
 * its own declarations resolves to itself. Returning both over-approximates,
 * which is the safe direction — whichever isn't installed drops out. A scoped
 * name mangles as `@scope/pkg` → `@types/scope__pkg`, TypeScript's convention.
 */
export function typeReferencePackageNames(directive) {
  const name = packageNameOf(directive);
  if (!name) return [];
  const scoped = /^@([^/]+)\/(.+)$/.exec(name);
  const typesName = scoped
    ? `@types/${scoped[1]}__${scoped[2]}`
    : `@types/${name}`;
  return [name, typesName];
}

/**
 * Every third-party package name whose declarations a blob of TypeScript source
 * pulls in — via an import of any form, or a triple-slash type reference.
 * Over-approximating is safe (a name absent from every lockfile contributes
 * nothing downstream — `@inspector/core` is a build-time alias, not a package,
 * and drops out that way); under-approximating is not, since a missed package
 * never enters the candidate set and its skew would pass silently.
 */
export function importedPackageNames(source) {
  const names = new Set();
  // (source, readImportFiles, detectJavaScriptImports) — the latter two make it
  // report `require(…)` and dynamic imports as well as static ones.
  const { importedFiles, typeReferenceDirectives } =
    typescript().preProcessFile(source, true, true);
  for (const { fileName } of importedFiles) {
    const name = packageNameOf(fileName);
    if (name) names.add(name);
  }
  for (const { fileName } of typeReferenceDirectives ?? [])
    for (const name of typeReferencePackageNames(fileName)) names.add(name);
  return names;
}

/**
 * Top-level installed versions of every package in a parsed lockfile, keyed by
 * package name. Only `node_modules/<pkg>` entries count — a *nested*
 * `node_modules/a/node_modules/b` is npm resolving a transitive conflict inside
 * one install, which is routine and not what this guard is about.
 */
export function topLevelLockVersions(lock) {
  const versions = new Map();
  for (const [entryPath, entry] of Object.entries(lock?.packages ?? {})) {
    const m = /^node_modules\/(@[^/]+\/[^/]+|[^@/][^/]*)$/.exec(entryPath);
    if (!m || typeof entry?.version !== "string") continue;
    versions.set(m[1], entry.version);
  }
  return versions;
}

/**
 * Whether a parsed lockfile has the shape this guard can read: a
 * `lockfileVersion` 2+ `packages` table, keyed by install path with `""` for
 * the root project.
 *
 * This is checked rather than tolerated because the gate is deny-by-default and
 * `topLevelLockVersions` returns an empty map for anything else. An unreadable
 * lockfile would otherwise contribute no holders, and a real skew among the
 * remaining installs would be reported as aligned — the gate failing *open*,
 * which is the one way it must never fail (Copilot, #1962). A v1 lockfile
 * (`dependencies` only, no `packages`) lands here too, correctly: this guard
 * cannot read it, so it must say so rather than skip the install.
 */
export function hasReadableLockShape(lock) {
  const packages = lock?.packages;
  if (typeof packages !== "object" || packages === null) return false;
  return Object.prototype.hasOwnProperty.call(packages, "");
}

/**
 * Find candidate packages that resolve to more than one version across the
 * installs. `installs` is an array of `{ dir, versions }`. Returns one entry per
 * skewed package, sorted by name, each listing the version each install holds.
 * Packages present in fewer than two installs cannot skew and are skipped.
 */
export function findSkew(candidates, installs) {
  const skewed = [];
  for (const name of [...candidates].sort()) {
    const holders = installs
      .filter(({ versions }) => versions.has(name))
      .map(({ dir, versions }) => ({ dir, version: versions.get(name) }));
    if (holders.length < 2) continue;
    const distinct = new Set(holders.map((h) => h.version));
    if (distinct.size > 1) skewed.push({ name, holders });
  }
  return skewed;
}

/**
 * The major-version component of a lockfile version string. Prerelease and
 * build metadata are irrelevant here (`2.0.0-beta.5` → `2`). Returns null for
 * anything not starting with an integer, which is treated as "cannot prove same
 * major" and therefore fails rather than passes.
 */
export function majorOf(version) {
  const m = /^(\d+)\./.exec(String(version ?? ""));
  return m ? m[1] : null;
}

/**
 * Split skewed packages into the tolerated ones and the failures.
 *
 * Being on the allowlist tolerates skew only *within a major version*: each
 * entry's rationale establishes that a patch/minor difference is benign, which
 * says nothing about a major split, where the type surface itself changes. So a
 * listed package whose holders disagree on major is still a failure.
 */
export function partitionSkew(skewed, tolerated = TOLERATED_SKEW) {
  const isTolerated = (s) => {
    if (!tolerated.has(s.name)) return false;
    const majors = new Set(s.holders.map((h) => majorOf(h.version)));
    return majors.size === 1 && !majors.has(null);
  };
  return {
    failures: skewed.filter((s) => !isTolerated(s)),
    ignored: skewed.filter(isTolerated),
  };
}

// The TypeScript extensions the shared trees can hold. Deliberately the same
// four `verify:format-coverage` and `verify:typecheck-coverage` gate on: a
// `.mts`/`.cts` under `core/` or `test-servers/src` is typechecked like any
// other source, so its imports must reach the candidate set too. None exist
// under those trees today, which is exactly why omitting them would go
// unnoticed until a new shared dependency arrived through one and skewed.
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"];

/**
 * Whether a repo-relative path is shared first-party TypeScript — under one of
 * the shared trees, or one of the individually-named shared files.
 */
export function isSharedSourceFile(file) {
  if (SHARED_SOURCE_FILES.includes(file)) return true;
  if (!SOURCE_EXTENSIONS.some((ext) => file.endsWith(ext))) return false;
  // Anchored on a path boundary so a sibling whose name merely starts with a
  // shared dir (`core-internal/`, `test-servers/src-legacy/`) isn't swept in.
  return SHARED_SOURCE_DIRS.some((dir) => file.startsWith(`${dir}/`));
}

/**
 * Which configured shared sources contributed no file to `files`. Each dir and
 * each individually-named file must be represented; an aggregate count can't
 * see one of them going missing, because the others keep the total nonzero.
 */
export function sourcesWithNoFiles(
  files,
  dirs = SHARED_SOURCE_DIRS,
  named = SHARED_SOURCE_FILES,
) {
  const missingDirs = dirs.filter(
    (dir) => !files.some((f) => f.startsWith(`${dir}/`)),
  );
  const missingNamed = named.filter((name) => !files.includes(name));
  return [...missingDirs, ...missingNamed];
}

/** Tracked TypeScript files under the shared first-party source trees. */
function sharedSourceFiles() {
  const out = execFileSync(
    "git",
    [
      "ls-files",
      "--",
      ...SHARED_SOURCE_DIRS.map((d) => `${d}/**`),
      ...SHARED_SOURCE_FILES,
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
  return out.split("\n").filter(isSharedSourceFile);
}

/**
 * The installs to compare: the repo root plus every `clients/*` that carries a
 * lockfile. Discovered from disk rather than listed, so a new client is covered
 * without editing this guard (the same enrollment style as
 * `verify:typecheck-coverage`).
 */
function installDirs() {
  const clientsDir = path.join(repoRoot, "clients");
  const clients = existsSync(clientsDir)
    ? readdirSync(clientsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => `clients/${e.name}`)
        .sort()
    : [];
  return ["."]
    .concat(clients)
    .filter((dir) => existsSync(path.join(repoRoot, dir, "package-lock.json")));
}

/**
 * Run the guard. Prints its verdict and `process.exit(1)`s on any failure.
 * Called only when this file is executed directly — importing it (for tests)
 * gives access to the pure helpers above without running any of this.
 */
export function main() {
  const rootScripts = JSON.parse(
    readFileSync(path.join(repoRoot, "package.json"), "utf8"),
  ).scripts;

  // Vouch for a sibling guard: a guard cannot detect being unrun itself, but the
  // three can vouch for one another, so dropping any single one from `validate`
  // is caught by another. `verify:format-coverage` vouches for this one in turn.
  if (!rootReachesScript(rootScripts, "verify:format-coverage")) {
    console.error(
      "verify:dep-lockstep — the root `validate` no longer runs `verify:format-coverage` (a sibling guard). Restore it.",
    );
    process.exit(1);
  }

  const files = sharedSourceFiles();
  // Per-source, not an aggregate count (Copilot, #1962): `vitest.shared.mts`
  // alone keeps the total nonzero, so a moved or renamed `core/` would leave
  // the guard checking a near-empty candidate set and passing. Every configured
  // source must contribute, or the enumeration is broken.
  const empty = sourcesWithNoFiles(files);
  if (empty.length > 0) {
    console.error(
      `verify:dep-lockstep — ${empty.length} configured shared source(s) matched no tracked file:\n`,
    );
    for (const source of empty) console.error(`  ${source}`);
    console.error(
      "\nThe guard would derive its candidates from an incomplete set and pass on skew it should catch." +
        "\nA path was moved or renamed — fix SHARED_SOURCE_DIRS / SHARED_SOURCE_FILES in this file.",
    );
    process.exit(1);
  }

  const candidates = new Set();
  for (const file of files) {
    const source = readFileSync(path.join(repoRoot, file), "utf8");
    for (const name of importedPackageNames(source)) candidates.add(name);
  }

  const dirs = installDirs();
  const locks = dirs.map((dir) => {
    const file = path.join(repoRoot, dir, "package-lock.json");
    let lock;
    try {
      lock = JSON.parse(readFileSync(file, "utf8"));
    } catch (cause) {
      // Unparseable is the same failure as unreadable — say which file, rather
      // than dying on a raw SyntaxError with no path in it.
      throw new Error(
        `verify:dep-lockstep — could not parse ${dir}/package-lock.json.`,
        { cause },
      );
    }
    return { dir, lock };
  });

  // Refuse to compare against a lockfile whose shape we can't read, instead of
  // treating it as an install that holds nothing — see `hasReadableLockShape`.
  const unreadable = locks.filter(({ lock }) => !hasReadableLockShape(lock));
  if (unreadable.length > 0) {
    console.error(
      `verify:dep-lockstep — ${unreadable.length} lockfile(s) are not in a readable format:\n`,
    );
    for (const { dir } of unreadable)
      console.error(`  ${dir}/package-lock.json`);
    console.error(
      "\nThis guard reads the `packages` table of a lockfileVersion 2+ lockfile. Without it the install" +
        "\ncontributes no versions, so a real skew among the others would be reported as aligned — the gate" +
        "\nfailing open. Regenerate the lockfile with a current npm (`npm install`).",
    );
    process.exit(1);
  }

  const installs = locks.map(({ dir, lock }) => ({
    dir,
    versions: topLevelLockVersions(lock),
  }));

  const { failures, ignored } = partitionSkew(findSkew(candidates, installs));

  if (failures.length > 0) {
    console.error(
      `verify:dep-lockstep — ${failures.length} ${failures.length === 1 ? "dependency resolves" : "dependencies resolve"} to different versions across installs:\n`,
    );
    let anyListed = false;
    for (const { name, holders } of failures) {
      // A package already on the allowlist reached here only by skewing across
      // a MAJOR boundary, so say that rather than advising an entry that exists.
      const listed = TOLERATED_SKEW.has(name);
      anyListed ||= listed;
      console.error(
        `  ${name}${listed ? "  (allowlisted — but this is a MAJOR skew)" : ""}`,
      );
      for (const { dir, version } of holders)
        console.error(`    ${version}  (${dir})`);
    }
    const shared = [...SHARED_SOURCE_DIRS, ...SHARED_SOURCE_FILES].join(", ");
    console.error(
      "\nThese packages' types are compiled into a single `tsc` program from two installs" +
        `\n(${shared} resolve from the root, a client's own sources from the client),` +
        "\nso a version skew makes TypeScript relate two structurally-distinct copies of the same" +
        "\ntype. For a recursive-generic surface like zod that is what exhausted the tsc heap in #1896.",
    );
    console.error(
      "\nAlign them — `npm install <pkg>@<version>` in each install that declares the package, so all" +
        "\nlockfiles agree. (Don't add it to an install that doesn't declare it: a package absent from an" +
        "\ninstall can't skew.) If instead its types genuinely cannot blow up, add it to TOLERATED_SKEW in" +
        "\nscripts/verify-dep-lockstep.mjs with the reason. See AGENTS.md.",
    );
    if (anyListed)
      console.error(
        "\nNote: an allowlisted package is tolerated only WITHIN a major version — the rationale for one" +
          "\nestablishes that a patch/minor difference is benign, not that a major split is. Align the major.",
      );
    process.exit(1);
  }

  const note = ignored.length > 0 ? `, ${ignored.length} tolerated` : "";
  console.log(
    `verify:dep-lockstep — OK: ${candidates.size} install-crossing dependencies agree across ${installs.length} installs${note}.`,
  );
}

// Run only when executed directly (`node scripts/verify-dep-lockstep.mjs`);
// importing this file (tests) exposes the pure helpers without running the guard.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main();
