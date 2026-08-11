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
// `core/` and `test-servers/src`, the two first-party surfaces compiled into
// more than one client's program. Skew is then denied by default, with a small
// allowlist of packages verified to tolerate it (below). A dependency that
// starts skewing therefore fails `validate` and forces a decision, rather than
// surfacing months later as an unexplained OOM.

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { builtinModules } from "node:module";
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

// Packages whose cross-install skew is verified benign, each with the reason.
// This is an allowlist of *names*, not of version pairs, so an ordinary patch
// float within one of these does not churn the file — while any package NOT
// listed here failing the check is a genuine, unreviewed new skew.
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

// `from "x"` (import and re-export), a side-effect `import "x"`, and a dynamic
// `import("x")`. Only these three forms introduce a dependency's *types*.
const SPECIFIER_FORMS = [
  /\bfrom\s*["']([^"']+)["']/g,
  /\bimport\s+["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
];

/**
 * Every third-party package name imported by a blob of TypeScript source.
 * Deliberately a regex scan rather than a parse: it only needs to over- rather
 * than under-approximate, since a name absent from every lockfile contributes
 * nothing downstream (`@inspector/core` is a build-time alias, not a package,
 * and drops out that way).
 */
export function importedPackageNames(source) {
  const names = new Set();
  for (const re of SPECIFIER_FORMS) {
    for (const m of source.matchAll(re)) {
      const name = packageNameOf(m[1]);
      if (name) names.add(name);
    }
  }
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

/** Split skewed packages into the tolerated ones and the failures. */
export function partitionSkew(skewed, tolerated = TOLERATED_SKEW) {
  return {
    failures: skewed.filter((s) => !tolerated.has(s.name)),
    ignored: skewed.filter((s) => tolerated.has(s.name)),
  };
}

// The TypeScript extensions the shared trees can hold. Deliberately the same
// four `verify:format-coverage` and `verify:typecheck-coverage` gate on: a
// `.mts`/`.cts` under `core/` or `test-servers/src` is typechecked like any
// other source, so its imports must reach the candidate set too. None exist
// under those trees today, which is exactly why omitting them would go
// unnoticed until a new shared dependency arrived through one and skewed.
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"];

/** Whether a repo-relative path is a TypeScript source of a shared tree. */
export function isSharedSourceFile(file) {
  if (!SOURCE_EXTENSIONS.some((ext) => file.endsWith(ext))) return false;
  // Anchored on a path boundary so a sibling whose name merely starts with a
  // shared dir (`core-internal/`, `test-servers/src-legacy/`) isn't swept in.
  return SHARED_SOURCE_DIRS.some((dir) => file.startsWith(`${dir}/`));
}

/** Tracked TypeScript files under the shared first-party source trees. */
function sharedSourceFiles() {
  const out = execFileSync(
    "git",
    ["ls-files", "--", ...SHARED_SOURCE_DIRS.map((d) => `${d}/**`)],
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
  if (files.length === 0) {
    console.error(
      `verify:dep-lockstep — found no tracked sources under ${SHARED_SOURCE_DIRS.join(", ")}. The guard would check nothing; fix the enumeration.`,
    );
    process.exit(1);
  }

  const candidates = new Set();
  for (const file of files) {
    const source = readFileSync(path.join(repoRoot, file), "utf8");
    for (const name of importedPackageNames(source)) candidates.add(name);
  }

  const dirs = installDirs();
  const installs = dirs.map((dir) => ({
    dir,
    versions: topLevelLockVersions(
      JSON.parse(
        readFileSync(path.join(repoRoot, dir, "package-lock.json"), "utf8"),
      ),
    ),
  }));

  const { failures, ignored } = partitionSkew(findSkew(candidates, installs));

  if (failures.length > 0) {
    console.error(
      `verify:dep-lockstep — ${failures.length} ${failures.length === 1 ? "dependency resolves" : "dependencies resolve"} to different versions across installs:\n`,
    );
    for (const { name, holders } of failures) {
      console.error(`  ${name}`);
      for (const { dir, version } of holders)
        console.error(`    ${version}  (${dir})`);
    }
    console.error(
      "\nThese packages' types are compiled into a single `tsc` program from two installs" +
        `\n(${SHARED_SOURCE_DIRS.join(" and ")} resolve from the root, a client's own sources from the client),` +
        "\nso a version skew makes TypeScript relate two structurally-distinct copies of the same" +
        "\ntype. For a recursive-generic surface like zod that is what exhausted the tsc heap in #1896.",
    );
    console.error(
      "\nAlign them — `npm install <pkg>@<version>` in each install so all lockfiles agree — or, if this" +
        "\npackage's types genuinely cannot blow up, add it to TOLERATED_SKEW in scripts/verify-dep-lockstep.mjs" +
        "\nwith the reason. See AGENTS.md.",
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
