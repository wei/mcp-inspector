/**
 * Table-driven tests for the pure parsers of `verify-bundle-externals.mjs`.
 *
 * One case per rule the guard encodes. The guard itself reads real build output,
 * which no unit test can produce cheaply — so what is pinned here is the
 * *decision* logic: which entries count as externals, and which emitted shapes
 * count as "inlined anyway".
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  BUNDLED_CLIENTS,
  parseExternals,
  findInlinedExternals,
} from "./verify-bundle-externals.mjs";

describe("parseExternals", () => {
  test("collects bare string entries", () => {
    assert.deepEqual(
      parseExternals(`export default { external: ["undici", "pino"] }`),
      ["undici", "pino"],
    );
  });

  test("ignores package names that appear only inside comments", () => {
    // The real configs document each entry at length, and #2067's entry names
    // `undici` in its own prose — a comment-blind scan would double-count it and,
    // worse, invent entries for packages merely discussed.
    const src = `export default { external: [
      // "ghost" is explained here but is NOT an entry.
      /* neither is "phantom" */
      "undici",
    ] }`;
    assert.deepEqual(parseExternals(src), ["undici"]);
  });

  test("handles single quotes and nested arrays", () => {
    assert.deepEqual(
      parseExternals(
        `export default { external: ['a', 'b'], noExternal: ["c"] }`,
      ),
      ["a", "b"],
    );
  });

  test("returns an empty list when there is no external array", () => {
    assert.deepEqual(parseExternals(`export default { entry: ["x.ts"] }`), []);
  });
});

describe("findInlinedExternals", () => {
  test("flags an emitted chunk named after the package", () => {
    // The exact shape #2067 shipped: `undici-HXPKCIY3.js` beside index.js.
    const v = findInlinedExternals({
      externals: ["undici"],
      buildFiles: ["index.js", "undici-HXPKCIY3.js"],
      entrySource: "",
    });
    assert.equal(v.length, 1);
    assert.equal(v[0].pkg, "undici");
    assert.match(v[0].reason, /undici-HXPKCIY3\.js/);
  });

  test("flags a rewritten relative specifier in the entry", () => {
    // Belt to the chunk-name brace: if esbuild ever names the chunk differently,
    // the rewritten import in the entry still gives the inlining away.
    const v = findInlinedExternals({
      externals: ["undici"],
      buildFiles: ["index.js"],
      entrySource: 'await import("./undici-ABC123.js")',
    });
    assert.equal(v.length, 1);
    assert.match(v[0].reason, /rewritten relative chunk/);
  });

  test("matches a scoped package on its last segment", () => {
    const v = findInlinedExternals({
      externals: ["@napi-rs/keyring"],
      buildFiles: ["index.js", "keyring-QQ11.js"],
      entrySource: "",
    });
    assert.equal(v.length, 1);
    assert.equal(v[0].pkg, "@napi-rs/keyring");
  });

  test("passes a genuinely external package", () => {
    assert.deepEqual(
      findInlinedExternals({
        externals: ["undici", "pino"],
        buildFiles: ["index.js"],
        entrySource: 'await import("undici"); import "pino";',
      }),
      [],
    );
  });

  test("does not mistake an unrelated chunk for the package", () => {
    // `undici-types` is a @types transitive; a substring match would flag it.
    assert.deepEqual(
      findInlinedExternals({
        externals: ["undici"],
        buildFiles: ["index.js", "undici-types-AA22.js"],
        entrySource: "",
      }),
      [],
    );
  });
});

describe("BUNDLED_CLIENTS", () => {
  test("covers every tsup-bundled client", () => {
    // `clients/launcher` is plain tsc and emits no bundle, so it is deliberately
    // absent. If a fourth bundled client appears, it must be enrolled here.
    assert.deepEqual(BUNDLED_CLIENTS.map((c) => c.name).sort(), [
      "cli",
      "tui",
      "web",
    ]);
  });
});
