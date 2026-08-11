// End-to-end tests for the dep-lockstep guard's executable path (Copilot,
// #1962). The sibling tests cover the pure helpers; nothing exercised `main()`,
// so a regression in source enumeration, install discovery, lockfile loading,
// the sibling-guard vouch, or the nonzero exit on real skew would have left the
// whole suite green.
//
// Each case builds a throwaway repo — the guard derives its root from its own
// file location, so the script is copied into the fixture rather than pointed
// at one — `git add`s it (the enumeration is `git ls-files`, which reads the
// index), and runs the guard as a subprocess to assert the exit status and
// message. Run via `npm run test:scripts`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(scriptsDir, "..");

/** The real typescript install, symlinked into each fixture so the guard resolves it. */
const typescriptDir = path.dirname(
  createRequire(path.join(repoRoot, "clients", "web", "package.json")).resolve(
    "typescript/package.json",
  ),
);

/** A lockfileVersion 3 lockfile, including the `""` root entry npm always writes. */
const lock = (deps) => ({
  lockfileVersion: 3,
  packages: {
    "": { name: "fixture" },
    ...Object.fromEntries(
      Object.entries(deps).map(([name, version]) => [
        `node_modules/${name}`,
        { version },
      ]),
    ),
  },
});

/**
 * Build a fixture repo: shared sources importing `zod` and `express`, a root
 * install and one client install, and the guard itself. `rootDeps`/`webDeps`
 * decide whether the two installs agree.
 */
function makeFixture({ rootDeps, webDeps, scripts, rawWebLock }) {
  // realpath matters: on macOS `tmpdir()` is `/var/...`, a symlink to
  // `/private/var/...`. The guard only runs `main()` when `import.meta.url`
  // (always the resolved path) matches `process.argv[1]`, so launching it via
  // the unresolved path would load the module and silently do nothing —
  // exiting 0 with no output, which every assertion here would misread.
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "dep-lockstep-")));
  const write = (rel, contents) => {
    mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
    writeFileSync(
      path.join(dir, rel),
      typeof contents === "string"
        ? contents
        : JSON.stringify(contents, null, 2),
    );
  };

  write("package.json", {
    name: "fixture",
    scripts: scripts ?? {
      validate: "npm run verify:format-coverage && npm run verify:dep-lockstep",
      "verify:format-coverage": "node scripts/verify-format-coverage.mjs",
      "verify:dep-lockstep": "node scripts/verify-dep-lockstep.mjs",
    },
  });
  write("core/client.ts", 'import { z } from "zod";\nexport const s = z;\n');
  write(
    "test-servers/src/server.ts",
    'import express from "express";\nexport const app = express;\n',
  );
  write(
    "vitest.shared.mts",
    'import path from "node:path";\nexport default path;\n',
  );
  write("package-lock.json", lock(rootDeps));
  write("clients/web/package.json", { name: "web" });
  write("clients/web/package-lock.json", rawWebLock ?? lock(webDeps));

  // The guard resolves its repo root from its own location, so it has to live
  // inside the fixture; `lib/npm-scripts.mjs` comes along as its import.
  mkdirSync(path.join(dir, "scripts", "lib"), { recursive: true });
  for (const rel of [
    "verify-dep-lockstep.mjs",
    path.join("lib", "npm-scripts.mjs"),
  ])
    cpSync(path.join(scriptsDir, rel), path.join(dir, "scripts", rel));

  mkdirSync(path.join(dir, "node_modules"), { recursive: true });
  symlinkSync(
    typescriptDir,
    path.join(dir, "node_modules", "typescript"),
    "dir",
  );

  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  return dir;
}

function runGuard(dir) {
  const r = spawnSync(
    process.execPath,
    [path.join(dir, "scripts", "verify-dep-lockstep.mjs")],
    { cwd: dir, encoding: "utf8" },
  );
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

/** Run `fn` against a fresh fixture, always cleaning the temp dir up. */
function withFixture(options, fn) {
  const dir = makeFixture(options);
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const ALIGNED = { zod: "4.4.3", express: "5.2.1" };

test("main: exits 0 when every install agrees", () => {
  withFixture({ rootDeps: ALIGNED, webDeps: ALIGNED }, (dir) => {
    const { status, out } = runGuard(dir);
    assert.equal(status, 0, out);
    assert.match(out, /verify:dep-lockstep — OK/);
    // Both shared trees and the named shared file contributed their imports.
    assert.match(out, /2 install-crossing dependencies/);
  });
});

test("main: exits 1 and names the skewed package and every holder", () => {
  withFixture(
    { rootDeps: { ...ALIGNED, zod: "4.3.6" }, webDeps: ALIGNED },
    (dir) => {
      const { status, out } = runGuard(dir);
      assert.equal(status, 1, out);
      assert.match(out, /\bzod\b/);
      assert.match(out, /4\.3\.6\s+\(\.\)/);
      assert.match(out, /4\.4\.3\s+\(clients\/web\)/);
      // `express` agrees, so it must not be reported.
      assert.doesNotMatch(out, /^\s+express$/m);
    },
  );
});

test("main: a package imported only by test-servers/src is still checked", () => {
  // Guards the enumeration of the *second* shared tree: if only `core/` were
  // scanned, this skew would pass.
  withFixture(
    { rootDeps: { ...ALIGNED, express: "5.0.0" }, webDeps: ALIGNED },
    (dir) => {
      const { status, out } = runGuard(dir);
      assert.equal(status, 1, out);
      assert.match(out, /\bexpress\b/);
    },
  );
});

test("main: exits 1 when a configured shared source matches no file", () => {
  withFixture({ rootDeps: ALIGNED, webDeps: ALIGNED }, (dir) => {
    // Drop `core/` from the index — the other sources keep the file count
    // nonzero, which is exactly what the old aggregate check missed.
    execFileSync("git", ["rm", "-r", "-q", "--cached", "core"], { cwd: dir });
    const { status, out } = runGuard(dir);
    assert.equal(status, 1, out);
    assert.match(out, /matched no tracked file/);
    assert.match(out, /^\s+core$/m);
  });
});

test("main: exits 1 on a lockfile it cannot read, rather than failing open (Copilot, #1962)", () => {
  // A v1 lockfile has `dependencies` and no `packages` table. Treating it as an
  // install that simply holds nothing would leave the *root's* zod unopposed
  // and the skew below reported as aligned — the gate failing open.
  withFixture(
    {
      rootDeps: { ...ALIGNED, zod: "4.3.6" },
      webDeps: ALIGNED,
      rawWebLock: {
        lockfileVersion: 1,
        dependencies: { zod: { version: "4.4.3" } },
      },
    },
    (dir) => {
      const { status, out } = runGuard(dir);
      assert.equal(status, 1, out);
      assert.match(out, /not in a readable format/);
      assert.match(out, /clients\/web\/package-lock\.json/);
    },
  );
});

test("main: exits 1 on a lockfile with a `packages` table but no root entry", () => {
  // The shape check is not just "has a packages key" — a table without the
  // `""` root npm always writes is not a lockfile this guard can trust.
  withFixture(
    {
      rootDeps: ALIGNED,
      webDeps: ALIGNED,
      rawWebLock: {
        lockfileVersion: 3,
        packages: { "node_modules/zod": { version: "4.4.3" } },
      },
    },
    (dir) => {
      const { status, out } = runGuard(dir);
      assert.equal(status, 1, out);
      assert.match(out, /not in a readable format/);
    },
  );
});

test("main: exits 1 when the root validate no longer runs the sibling guard", () => {
  withFixture(
    {
      rootDeps: ALIGNED,
      webDeps: ALIGNED,
      // `verify:format-coverage` dropped from the chain: the vouch must fail
      // even though the dependency versions themselves are fine.
      scripts: {
        validate: "npm run verify:dep-lockstep",
        "verify:dep-lockstep": "node scripts/verify-dep-lockstep.mjs",
      },
    },
    (dir) => {
      const { status, out } = runGuard(dir);
      assert.equal(status, 1, out);
      assert.match(out, /no longer runs `verify:format-coverage`/);
    },
  );
});
