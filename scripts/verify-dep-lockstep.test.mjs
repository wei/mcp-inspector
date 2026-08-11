// Table-driven tests for the pure helpers of the dep-lockstep guard (#1896).
// One case per rule the guard encodes — the comment names the rule, so a future
// change that relaxes one is visible as a deleted assertion rather than a quiet
// behavior shift. Run via `npm run test:scripts` (node:test; the root has no
// vitest harness).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  findSkew,
  importedPackageNames,
  packageNameOf,
  partitionSkew,
  topLevelLockVersions,
} from "./verify-dep-lockstep.mjs";

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

test("importedPackageNames: the three specifier forms that introduce types", () => {
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

test("importedPackageNames: prose after `from` is not an import", () => {
  // The scan over-approximates on purpose, but must not invent package names
  // out of comment text — a bogus name absent from every lockfile is inert,
  // yet a *plausible* one would silently widen the candidate set.
  const source = `
    // Resolved relative to the runner dir, not from "cwd omitted" by the caller.
    /** Reads the manifest from "file:" URLs. */
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
  for (const lock of [undefined, null, {}, { packages: {} }])
    assert.equal(topLevelLockVersions(lock).size, 0);
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
    { name: "react", holders: [] },
    { name: "zod", holders: [] },
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
  const skewed = [{ name: "zod", holders: [] }];
  assert.equal(partitionSkew(skewed, new Map()).failures.length, 1);
});
