// Table-driven tests for the pure helpers of the dep-lockstep guard (#1896).
// One case per rule the guard encodes — the comment names the rule, so a future
// change that relaxes one is visible as a deleted assertion rather than a quiet
// behavior shift. Run via `npm run test:scripts` (node:test; the root has no
// vitest harness).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  findSkew,
  hasReadableLockShape,
  importedPackageNames,
  isSharedSourceFile,
  majorOf,
  packageNameOf,
  partitionSkew,
  sourcesWithNoFiles,
  topLevelLockVersions,
} from "./verify-dep-lockstep.mjs";

test("isSharedSourceFile: all four TS extensions, not just .ts/.tsx", () => {
  // `.mts`/`.cts` are gated by `verify:format-coverage` and
  // `verify:typecheck-coverage` too. None exist under the shared trees today,
  // so dropping them here would go unnoticed until a new shared dependency
  // arrived through one — the skew this guard exists to catch (Copilot, #1962).
  for (const ext of [".ts", ".tsx", ".mts", ".cts"]) {
    assert.equal(isSharedSourceFile(`core/mcp/thing${ext}`), true, ext);
    assert.equal(
      isSharedSourceFile(`test-servers/src/thing${ext}`),
      true,
      `test-servers ${ext}`,
    );
  }
});

test("isSharedSourceFile: non-TS files and other trees are excluded", () => {
  const rejected = [
    "core/README.md", // not TypeScript
    "core/mcp/data.json",
    "clients/web/src/App.tsx", // a client's own sources resolve from the client
    "scripts/verify-dep-lockstep.mjs",
    "test-servers/configs/modern-http.json",
    // Path-boundary anchoring: a sibling dir whose name merely starts with a
    // shared dir's name must not be swept in.
    "core-internal/thing.ts",
    "test-servers/src-legacy/thing.ts",
  ];
  for (const file of rejected)
    assert.equal(isSharedSourceFile(file), false, file);
});

test("sourcesWithNoFiles: each configured source must contribute (Copilot, #1962)", () => {
  const dirs = ["core", "test-servers/src"];
  const named = ["vitest.shared.mts"];
  const complete = [
    "core/mcp/a.ts",
    "test-servers/src/b.ts",
    "vitest.shared.mts",
  ];
  assert.deepEqual(sourcesWithNoFiles(complete, dirs, named), []);

  // The failure an aggregate count can't see: `core/` moved, but the other two
  // sources keep `files.length` nonzero, so the guard would derive candidates
  // from an incomplete set and pass on skew it should catch.
  assert.deepEqual(
    sourcesWithNoFiles(
      ["test-servers/src/b.ts", "vitest.shared.mts"],
      dirs,
      named,
    ),
    ["core"],
  );
  assert.deepEqual(
    sourcesWithNoFiles(["core/mcp/a.ts", "test-servers/src/b.ts"], dirs, named),
    ["vitest.shared.mts"],
  );
  assert.deepEqual(sourcesWithNoFiles([], dirs, named), [
    "core",
    "test-servers/src",
    "vitest.shared.mts",
  ]);
});

test("sourcesWithNoFiles: a prefix sibling does not vouch for a dir", () => {
  // `core-internal/` starts with `core` but is not it — the boundary check has
  // to be on a path separator, or a renamed dir would look present.
  assert.deepEqual(sourcesWithNoFiles(["core-internal/a.ts"], ["core"], []), [
    "core",
  ]);
});

test("packageNameOf: bare names, scopes, and subpaths", () => {
  const cases = [
    ["zod", "zod"],
    ["zod/v4", "zod"], // subpath dropped — one package, one version
    ["@modelcontextprotocol/client", "@modelcontextprotocol/client"],
    ["@modelcontextprotocol/client/core", "@modelcontextprotocol/client"],
    ["react-dom/client", "react-dom"],
  ];
  for (const [input, expected] of cases)
    assert.equal(packageNameOf(input), expected, input);
});

test("packageNameOf: non-packages are rejected", () => {
  // Relative/absolute paths, built-ins with and without the `node:` prefix,
  // protocol specifiers, and prose that follows the word `from` in a comment.
  const rejected = [
    "./foo",
    "../core/mcp",
    "/abs/path",
    "fs",
    "path",
    "node:crypto",
    "node:test",
    "file:",
    "data:text/plain,x",
    "cwd omitted",
    "",
  ];
  for (const input of rejected)
    assert.equal(packageNameOf(input), null, JSON.stringify(input));
  assert.equal(packageNameOf(undefined), null);
});

test("importedPackageNames: CommonJS and awkward dynamic-import forms (Copilot, #1962)", () => {
  // Under-approximating is the dangerous direction: a package the scan misses
  // never enters the candidate set, so its skew passes the guard silently.
  // `.cts` sources in the shared trees use `import x = require(…)` as ordinary
  // syntax, and a dynamic import may carry import attributes or a static
  // template literal — none of which the original three patterns matched.
  const source = `
    import express = require("express");
    const yaml = require("yaml");
    const a = await import("undici", { with: { type: "json" } });
    const b = await import(\`jose\`);
  `;
  assert.deepEqual([...importedPackageNames(source)].sort(), [
    "express",
    "jose",
    "undici",
    "yaml",
  ]);
});

test("importedPackageNames: comment trivia between tokens (Copilot, #1962)", () => {
  // TypeScript allows a comment anywhere whitespace is legal, so all of these
  // are valid imports. Missing one is the dangerous direction: the package
  // never enters the candidate set and its skew passes the guard silently.
  const source = `
    import { a } from /* explanation */ "express";
    const b = await import(/* webpackIgnore: true */ "undici");
    const c = require(/* lazy */ "yaml");
    import /* side effect */ "pino";
  `;
  assert.deepEqual([...importedPackageNames(source)].sort(), [
    "express",
    "pino",
    "undici",
    "yaml",
  ]);
});

test("importedPackageNames: line-comment trivia, not just block (Copilot, #1962)", () => {
  // `//` runs to end-of-line and is legal in every position a block comment is,
  // so a specifier can sit on the next line and these are still valid imports.
  const source = [
    "import { a } from // reason",
    '  "express";',
    "const b = await import(// lazy",
    '  "undici");',
    "const c = require(// lazy",
    '  "yaml");',
  ].join("\n");
  assert.deepEqual([...importedPackageNames(source)].sort(), [
    "express",
    "undici",
    "yaml",
  ]);
});

test("importedPackageNames: static, side-effect, and dynamic forms; builtins and relatives dropped", () => {
  const source = `
    import { z } from "zod/v4";
    export type { Foo } from '@modelcontextprotocol/core';
    import "./side-effect.css";
    import "pino";
    const mod = await import("chokidar");
    import fs from "node:fs";
    import { helper } from "../local/helper";
  `;
  assert.deepEqual([...importedPackageNames(source)].sort(), [
    "@modelcontextprotocol/core",
    "chokidar",
    "pino",
    "zod",
  ]);
});

test("importedPackageNames: prose in comments never becomes a package (Copilot, #1962)", () => {
  // The regex scan this replaced could not tell code from a comment, so
  // `// adapted from "react"` added `react` to the candidate set — and if that
  // installed package were skewed, an unrelated comment would fail `validate`.
  // These use REAL package names, which is the case the old prose test missed:
  // it only passed because `cwd omitted` isn't a valid package name.
  const source = `
    // adapted from "react"
    /** Mirrors the behavior of "express", see require("yaml") below. */
    /** The excluded set derived from \\\`hono\\\`-style paths. */
    // const disabled = await import("undici");
    import { z } from "zod";
  `;
  assert.deepEqual([...importedPackageNames(source)], ["zod"]);
});

test("importedPackageNames: a specifier inside a string literal is not an import", () => {
  const source = `
    const msg = 'run require("chokidar") to load it';
    const re = /"jose"/;
    import { z } from "zod";
  `;
  assert.deepEqual([...importedPackageNames(source)], ["zod"]);
});

test("topLevelLockVersions: nested duplicates are ignored", () => {
  // A nested `node_modules/a/node_modules/b` is npm resolving a transitive
  // conflict *inside* one install — routine, and not the cross-install skew
  // this guard is about (`cosmiconfig`'s yaml@1 alongside the top-level yaml@2
  // is the live example).
  const lock = {
    packages: {
      "": { name: "root" },
      "node_modules/zod": { version: "4.4.3" },
      "node_modules/yaml": { version: "2.9.0" },
      "node_modules/cosmiconfig/node_modules/yaml": { version: "1.10.3" },
      "node_modules/@modelcontextprotocol/client": { version: "2.0.0-beta.5" },
      "node_modules/no-version": { resolved: "https://example.test/x.tgz" },
    },
  };
  assert.deepEqual([...topLevelLockVersions(lock)].sort(), [
    ["@modelcontextprotocol/client", "2.0.0-beta.5"],
    ["yaml", "2.9.0"],
    ["zod", "4.4.3"],
  ]);
});

test("topLevelLockVersions: a malformed or empty lockfile yields nothing", () => {
  // Safe as a pure helper *because* `hasReadableLockShape` rejects these before
  // any comparison — an empty map reaching `findSkew` is the fail-open path.
  for (const lock of [undefined, null, {}, { packages: {} }])
    assert.equal(topLevelLockVersions(lock).size, 0);
});

test("hasReadableLockShape: only a v2+ packages table with a root entry (Copilot, #1962)", () => {
  assert.equal(
    hasReadableLockShape({ lockfileVersion: 3, packages: { "": {} } }),
    true,
  );
  assert.equal(
    hasReadableLockShape({
      lockfileVersion: 2,
      packages: { "": {}, "node_modules/zod": { version: "4.4.3" } },
    }),
    true,
  );
  const rejected = [
    undefined,
    null,
    {},
    { packages: null },
    { packages: [] }, // an array has no `""` key
    { packages: {} }, // no root entry
    { packages: { "node_modules/zod": { version: "4.4.3" } } },
    { lockfileVersion: 1, dependencies: { zod: { version: "4.4.3" } } },
  ];
  for (const lock of rejected)
    assert.equal(hasReadableLockShape(lock), false, JSON.stringify(lock));
});

test("findSkew: reports a package held at two versions", () => {
  const installs = [
    { dir: ".", versions: new Map([["zod", "4.3.6"]]) },
    { dir: "clients/web", versions: new Map([["zod", "4.4.3"]]) },
    { dir: "clients/cli", versions: new Map([["zod", "4.4.3"]]) },
  ];
  assert.deepEqual(findSkew(new Set(["zod"]), installs), [
    {
      name: "zod",
      holders: [
        { dir: ".", version: "4.3.6" },
        { dir: "clients/web", version: "4.4.3" },
        { dir: "clients/cli", version: "4.4.3" },
      ],
    },
  ]);
});

test("findSkew: agreement and single-install packages are not skew", () => {
  const installs = [
    {
      dir: ".",
      versions: new Map([
        ["zod", "4.4.3"],
        ["express", "5.2.1"],
      ]),
    },
    { dir: "clients/web", versions: new Map([["zod", "4.4.3"]]) },
  ];
  // `express` lives in one install only, so it cannot skew — a package absent
  // from a client is not a finding.
  assert.deepEqual(findSkew(new Set(["zod", "express"]), installs), []);
});

test("findSkew: a candidate in no lockfile is inert", () => {
  // `@inspector/core` is a build-time alias, not a package; the scan picks it
  // up and it must drop out here rather than error.
  const installs = [
    { dir: ".", versions: new Map([["zod", "4.4.3"]]) },
    { dir: "clients/web", versions: new Map([["zod", "4.4.3"]]) },
  ];
  assert.deepEqual(findSkew(new Set(["@inspector/core"]), installs), []);
});

test("findSkew: results are sorted by package name", () => {
  const installs = [
    {
      dir: ".",
      versions: new Map([
        ["zod", "1.0.0"],
        ["hono", "1.0.0"],
      ]),
    },
    {
      dir: "clients/web",
      versions: new Map([
        ["zod", "2.0.0"],
        ["hono", "2.0.0"],
      ]),
    },
  ];
  assert.deepEqual(
    findSkew(new Set(["zod", "hono"]), installs).map((s) => s.name),
    ["hono", "zod"],
  );
});

test("partitionSkew: the allowlist is by name, not by version pair", () => {
  // So an ordinary patch float within a tolerated package does not churn the
  // allowlist, while any *unlisted* package that starts skewing still fails.
  const skewed = [
    {
      name: "react",
      holders: [
        { dir: ".", version: "19.2.7" },
        { dir: "clients/web", version: "19.2.8" },
      ],
    },
    {
      name: "zod",
      holders: [
        { dir: ".", version: "4.3.6" },
        { dir: "clients/web", version: "4.4.3" },
      ],
    },
  ];
  const tolerated = new Map([["react", "shallow interfaces"]]);
  const { failures, ignored } = partitionSkew(skewed, tolerated);
  assert.deepEqual(
    failures.map((s) => s.name),
    ["zod"],
  );
  assert.deepEqual(
    ignored.map((s) => s.name),
    ["react"],
  );
});

test("partitionSkew: deny by default — nothing tolerated fails everything", () => {
  const skewed = [{ name: "zod", holders: [{ dir: ".", version: "1.0.0" }] }];
  assert.equal(partitionSkew(skewed, new Map()).failures.length, 1);
});

test("partitionSkew: the allowlist tolerates skew only within a major (Copilot, #1962)", () => {
  // Each rationale establishes that a patch/minor difference is benign; that is
  // not evidence a React 18-vs-19 split is, so a listed package still fails
  // across a major boundary.
  const tolerated = new Map([["react", "shallow interfaces"]]);
  const withinMajor = [
    {
      name: "react",
      holders: [
        { dir: ".", version: "19.2.7" },
        { dir: "clients/web", version: "19.2.8" },
      ],
    },
  ];
  const acrossMajor = [
    {
      name: "react",
      holders: [
        { dir: ".", version: "18.3.1" },
        { dir: "clients/web", version: "19.2.8" },
      ],
    },
  ];
  assert.equal(partitionSkew(withinMajor, tolerated).failures.length, 0);
  assert.equal(partitionSkew(withinMajor, tolerated).ignored.length, 1);
  assert.equal(partitionSkew(acrossMajor, tolerated).failures.length, 1);
  assert.equal(partitionSkew(acrossMajor, tolerated).ignored.length, 0);
});

test("partitionSkew: an unparseable version can't be proven same-major, so it fails", () => {
  const tolerated = new Map([["react", "shallow interfaces"]]);
  const skewed = [
    {
      name: "react",
      holders: [
        { dir: ".", version: "19.2.7" },
        { dir: "clients/web", version: "next" },
      ],
    },
  ];
  assert.equal(partitionSkew(skewed, tolerated).failures.length, 1);
});

test("majorOf: prerelease and build metadata are irrelevant", () => {
  const cases = [
    ["4.4.3", "4"],
    ["2.0.0-beta.5", "2"],
    ["19.2.8", "19"],
    ["1.10.3+build.7", "1"],
  ];
  for (const [input, expected] of cases)
    assert.equal(majorOf(input), expected, input);
  for (const bad of ["next", "", undefined, null, "v4.4.3"])
    assert.equal(majorOf(bad), null, JSON.stringify(bad));
});

test("isSharedSourceFile: individually-named shared files are included (Copilot, #1962)", () => {
  // `vitest.shared.mts` is root-owned, imported by every client's vitest
  // config, and already treated as shared by `verify:typecheck-coverage`. It
  // imports only Node built-ins today, which is why omitting it would go
  // unnoticed until a third-party import appeared there and skewed.
  assert.equal(isSharedSourceFile("vitest.shared.mts"), true);
  // Still anchored: a same-named file nested elsewhere is not the shared one.
  assert.equal(isSharedSourceFile("clients/web/vitest.shared.mts"), false);
});
