// Tests for `resolve-node-bin.mjs` (#1939) — the shared resolver that replaces
// shelling through `npx`, which is a `.cmd` shim on Windows that a shell-free
// `execFileSync`/`spawnSync` cannot start (ENOENT). Resolution is exercised
// against the packages the callers actually spawn (typescript, vite, prettier),
// installed by the repo's own `npm install`, so the contract is pinned against
// the real `bin`/`exports` shapes rather than fixtures that can drift.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveNodeBin } from "./resolve-node-bin.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

test("resolves typescript's tsc (object-form bin) to an existing JS entry", () => {
  const entry = resolveNodeBin("typescript", "tsc", repoRoot);
  assert.ok(path.isAbsolute(entry), entry);
  assert.ok(existsSync(entry), `resolved entry does not exist: ${entry}`);
  assert.match(entry.split(path.sep).join("/"), /\/typescript\/.*tsc/);
});

test("resolves from a client dir, walking node_modules up like `npx --no-install`", () => {
  const entry = resolveNodeBin(
    "typescript",
    "tsc",
    path.join(repoRoot, "clients", "cli"),
  );
  assert.ok(existsSync(entry), `resolved entry does not exist: ${entry}`);
});

test("resolves vite's bin despite Vite 8's exports map (no deep bin export)", () => {
  // `require.resolve("vite/bin/vite.js")` throws ERR_PACKAGE_PATH_NOT_EXPORTED
  // under Vite 8 — the reason the helper goes through `<pkg>/package.json`.
  const entry = resolveNodeBin(
    "vite",
    "vite",
    path.join(repoRoot, "clients", "web"),
  );
  assert.ok(existsSync(entry), `resolved entry does not exist: ${entry}`);
  assert.match(entry.split(path.sep).join("/"), /\/vite\/.*vite\.js$/);
});

test("resolves a string-form bin (prettier) under the package's own name", () => {
  const entry = resolveNodeBin("prettier", "prettier", repoRoot);
  assert.ok(existsSync(entry), `resolved entry does not exist: ${entry}`);
  assert.match(entry.split(path.sep).join("/"), /\/prettier\//);
});

test("rejects a mismatched binName against a string-form bin", () => {
  // npm's string shorthand declares ONE command, named after the package — so
  // a typo must fail rather than silently resolving prettier's executable.
  assert.throws(
    () => resolveNodeBin("prettier", "prettierd", repoRoot),
    /prettier declares no "prettierd" bin/,
  );
});

test("throws when the package is not installed from fromDir", () => {
  assert.throws(
    () => resolveNodeBin("definitely-not-installed-anywhere", "x", repoRoot),
    /definitely-not-installed-anywhere/,
  );
});

test("throws when the package declares no such bin", () => {
  // typescript's bin map has `tsc`/`tsserver`, not `vite`.
  assert.throws(
    () => resolveNodeBin("typescript", "vite", repoRoot),
    /typescript declares no "vite" bin/,
  );
});

// The remaining cases need a manifest shape the real installs don't have, so
// they run against a throwaway node_modules tree rather than a real package.
function fixtureDir(manifest, { createBinFile = false } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "resolve-node-bin-"));
  const pkgDir = path.join(dir, "node_modules", manifest.name);
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(
    path.join(pkgDir, "package.json"),
    JSON.stringify(manifest),
    "utf8",
  );
  if (createBinFile) {
    const rel =
      typeof manifest.bin === "string"
        ? manifest.bin
        : Object.values(manifest.bin)[0];
    const target = path.join(pkgDir, rel);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, "", "utf8");
  }
  // The consumer `package.json` `createRequire` is based at.
  writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "consumer" }),
    "utf8",
  );
  return dir;
}

test("throws when a declared bin's file is missing (partial install)", () => {
  // The silent case this helper exists to kill: `process.execPath <missing>`
  // spawns fine and exits 1 with empty stdout, which downstream reads as "no
  // diagnostic captured" and reports every tracked file as uncovered.
  const dir = fixtureDir({ name: "ghostpkg", bin: { ghost: "bin/ghost.js" } });
  try {
    assert.throws(
      () => resolveNodeBin("ghostpkg", "ghost", dir),
      /ghostpkg's "ghost" bin points at a missing file/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("accepts a scoped package's string-form bin under its unscoped name", () => {
  const dir = fixtureDir(
    { name: "@scope/tool", bin: "bin/tool.js" },
    { createBinFile: true },
  );
  try {
    const entry = resolveNodeBin("@scope/tool", "tool", dir);
    assert.ok(existsSync(entry), `resolved entry does not exist: ${entry}`);
    assert.throws(
      () => resolveNodeBin("@scope/tool", "scope-tool", dir),
      /declares no "scope-tool" bin/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
