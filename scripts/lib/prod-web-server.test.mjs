/**
 * Unit tests for the prod-web-server helper's catalog-isolation contract (#1977).
 *
 * The smokes themselves cannot guard this: they exercise startup and then exit
 * the process immediately after teardown, so a regression that reintroduced the
 * shared catalog — or that stopped cleaning up — would still leave every smoke
 * green. These lock down the three properties that make isolation real: each run
 * gets its own catalog, an inherited `MCP_CATALOG_PATH` cannot win, and the temp
 * dir is removable on stop.
 *
 * `startProdWebServer` itself is not unit-tested — it spawns a real launcher, so
 * its contract is the smokes' job. What is tested here is exactly the part that
 * decides *which catalog the server sees*, which is pure.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { buildWebServerEnv, createTempCatalog } from "./prod-web-server.mjs";
import { removeSafe } from "./child-cleanup.mjs";

const BASE = {
  host: "127.0.0.1",
  port: "6299",
  token: "test-token",
  catalogPath: "/tmp/example/catalog.json",
};

test("createTempCatalog: mints a unique dir per call", () => {
  const a = createTempCatalog();
  const b = createTempCatalog();
  try {
    assert.notEqual(a.dir, b.dir, "two runs must not share a catalog dir");
    assert.equal(dirname(a.path), a.dir);
    assert.ok(existsSync(a.dir));
    assert.ok(existsSync(b.dir));
  } finally {
    removeSafe(a.dir);
    removeSafe(b.dir);
  }
});

test("createTempCatalog: does not create the catalog file itself", () => {
  // The backend seeds an empty catalog on first use; pre-creating the file would
  // hand it a zero-byte file to parse instead of the clean first-run state.
  const { dir, path } = createTempCatalog();
  try {
    assert.equal(existsSync(path), false);
  } finally {
    removeSafe(dir);
  }
});

test("createTempCatalog: its dir is removable by removeSafe", () => {
  const { dir, path } = createTempCatalog();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "{}");
  assert.equal(removeSafe(dir), true);
  assert.equal(existsSync(dir), false);
});

test("buildWebServerEnv: points the server at the given catalog", () => {
  const env = buildWebServerEnv({ ...BASE, baseEnv: {} });
  assert.equal(env.MCP_CATALOG_PATH, BASE.catalogPath);
});

test("buildWebServerEnv: overrides an inherited MCP_CATALOG_PATH", () => {
  // The regression this guards: assigning before the spread would let a
  // developer's exported MCP_CATALOG_PATH win, putting the smoke back on a
  // real catalog while every test still passed.
  const env = buildWebServerEnv({
    ...BASE,
    baseEnv: { MCP_CATALOG_PATH: "/home/dev/.mcp-inspector/mcp.json" },
  });
  assert.equal(env.MCP_CATALOG_PATH, BASE.catalogPath);
});

test("buildWebServerEnv: passes through unrelated inherited vars", () => {
  const env = buildWebServerEnv({ ...BASE, baseEnv: { PATH: "/usr/bin" } });
  assert.equal(env.PATH, "/usr/bin");
});

test("buildWebServerEnv: sets host, port, token, and disables auto-open", () => {
  const env = buildWebServerEnv({ ...BASE, baseEnv: {} });
  assert.equal(env.HOST, BASE.host);
  assert.equal(env.CLIENT_PORT, BASE.port);
  assert.equal(env.MCP_INSPECTOR_API_TOKEN, BASE.token);
  assert.equal(env.MCP_AUTO_OPEN_ENABLED, "false");
});

test("buildWebServerEnv: an inherited auto-open setting cannot re-enable it", () => {
  const env = buildWebServerEnv({
    ...BASE,
    baseEnv: { MCP_AUTO_OPEN_ENABLED: "true" },
  });
  assert.equal(env.MCP_AUTO_OPEN_ENABLED, "false");
});
