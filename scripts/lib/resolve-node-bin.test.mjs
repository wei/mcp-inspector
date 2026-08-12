// Tests for `resolve-node-bin.mjs` (#1939) — the shared resolver that replaces
// shelling through `npx`, which is a `.cmd` shim on Windows that a shell-free
// `execFileSync`/`spawnSync` cannot start (ENOENT). Resolution is exercised
// against the packages the callers actually spawn (typescript, vite, prettier),
// installed by the repo's own `npm install`, so the contract is pinned against
// the real `bin`/`exports` shapes rather than fixtures that can drift.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
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

test("resolves a string-form bin (prettier), ignoring the binName", () => {
  const entry = resolveNodeBin("prettier", "prettier", repoRoot);
  assert.ok(existsSync(entry), `resolved entry does not exist: ${entry}`);
  assert.match(entry.split(path.sep).join("/"), /\/prettier\//);
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
