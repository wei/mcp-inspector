// Table-driven tests for the pure helpers of the dep-lockstep guard (#1896).
// One case per rule the guard encodes — the comment names the rule, so a future
// change that relaxes one is visible as a deleted assertion rather than a quiet
// behavior shift. Run via `npm run test:scripts` (node:test; the root has no
// vitest harness).
//
// The candidate derivation itself lives in `lib/tsc-program.mjs` (shared with
// `verify:typecheck-coverage` since #1965) and is covered by
// `lib/tsc-program.test.mjs`; what stays here is the lockfile comparison and the
// client-enrollment rule this guard owns.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clientProjects,
  findSkew,
  hasReadableLockShape,
  majorOf,
  partitionSkew,
  topLevelLockVersions,
} from "./verify-dep-lockstep.mjs";

test("clientProjects: a `typecheck` script's projects win over references", () => {
  // Both enrollment paths exist (cli/tui/launcher declare `typecheck`,
  // `clients/web` is a `tsc -b` solution) and this guard must measure the same
  // programs as `verify:typecheck-coverage`, which prefers the script.
  assert.deepEqual(
    clientProjects(
      {
        typecheck: "tsc --noEmit -p tsconfig.json && tsc -p tsconfig.test.json",
      },
      ["./ignored.json"],
    ),
    ["tsconfig.json", "tsconfig.test.json"],
  );
});

test("clientProjects: a reference client is measured through its references", () => {
  assert.deepEqual(
    clientProjects({ build: "tsc -b && vite build" }, ["./a.json"]),
    ["./a.json"],
  );
  // Neither path available — the caller reports it rather than measuring nothing.
  assert.deepEqual(clientProjects({ build: "vite build" }, []), []);
});

test("clientProjects: a NEUTERED project still contributes its program (#1965)", () => {
  // `--noCheck` stops that pass type-checking, which is the sibling guard's
  // complaint; the program still resolves its imports, and dropping it here
  // would shrink what THIS guard measures on the strength of that other defect.
  assert.deepEqual(
    clientProjects(
      {
        typecheck:
          "tsc -p tsconfig.json --noCheck && tsc -p tsconfig.test.json",
      },
      [],
    ).sort(),
    ["tsconfig.json", "tsconfig.test.json"],
  );
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
    { lockfileVersion: 3, packages: null },
    { lockfileVersion: 3, packages: [] }, // an array has no `""` key
    { lockfileVersion: 3, packages: {} }, // no root entry
    {
      lockfileVersion: 3,
      packages: { "node_modules/zod": { version: "4.4.3" } },
    },
    { lockfileVersion: 1, dependencies: { zod: { version: "4.4.3" } } },
    // A declared v1 carrying a `packages` table: the version is checked, not
    // inferred from the key's presence, so this is rejected rather than
    // half-trusted into an empty (fail-open) version map.
    { lockfileVersion: 1, packages: { "": {} } },
    { packages: { "": {} } }, // no declared version at all
    { lockfileVersion: "3", packages: { "": {} } }, // not a number
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
