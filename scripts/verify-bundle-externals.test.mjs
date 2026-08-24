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
  evaluateClient,
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
  const banner = (p) => `// ${p}\nvar x = 1;\n`;

  test("flags a package inlined as its own chunk", () => {
    // The exact shape #2067 shipped: a dynamically import()ed CommonJS package
    // emitted as `undici-HXPKCIY3.js` beside index.js.
    const { violations } = findInlinedExternals({
      externals: ["undici"],
      files: [
        {
          name: "index.js",
          source: banner("../../core/mcp/node/transport.ts"),
        },
        {
          name: "undici-HXPKCIY3.js",
          source: banner("../../node_modules/undici/lib/core/symbols.js"),
        },
      ],
    });
    assert.equal(violations.length, 1);
    assert.equal(violations[0].pkg, "undici");
    assert.match(violations[0].reason, /undici-HXPKCIY3\.js/);
  });

  test("flags a package inlined straight into the entry, with no chunk", () => {
    // A *statically* imported package is folded into index.js and emits no
    // chunk at all, so a chunk-name check would miss it entirely. The banner is
    // what gives it away.
    const { violations } = findInlinedExternals({
      externals: ["pino"],
      files: [
        {
          name: "index.js",
          source:
            banner("../../core/mcp/index.ts") +
            banner("../../node_modules/pino/pino.js"),
        },
      ],
    });
    assert.equal(violations.length, 1);
    assert.equal(violations[0].pkg, "pino");
    assert.match(violations[0].reason, /index\.js/);
  });

  test("passes a genuinely external package", () => {
    const { noBanners, violations } = findInlinedExternals({
      externals: ["undici", "pino"],
      files: [
        {
          name: "index.js",
          source:
            banner("../../core/mcp/node/proxyFetch.ts") +
            'await import("undici");\nimport "pino";\n',
        },
      ],
    });
    assert.equal(noBanners, false);
    assert.deepEqual(violations, []);
  });

  test("does not mistake a same-prefix package for the external", () => {
    // `undici-types` is a @types transitive and is legitimately inlined; the
    // trailing slash in the needle is what keeps it from reading as `undici`.
    const { violations } = findInlinedExternals({
      externals: ["undici"],
      files: [
        {
          name: "index.js",
          source: banner("../../node_modules/undici-types/index.js"),
        },
      ],
    });
    assert.deepEqual(violations, []);
  });

  test("matches a scoped package on its full name", () => {
    const { violations } = findInlinedExternals({
      externals: ["@napi-rs/keyring"],
      files: [
        {
          name: "index.js",
          source: banner("../../node_modules/@napi-rs/keyring/index.js"),
        },
      ],
    });
    assert.equal(violations.length, 1);
    assert.equal(violations[0].pkg, "@napi-rs/keyring");
  });

  test("reports noBanners rather than a clean pass when banners are absent", () => {
    // The guard reads esbuild's `// <path>` module banners, so minified output
    // would make every bundle look clean. That must fail loudly instead —
    // otherwise enabling `minify` silently retires the check.
    const { noBanners, violations } = findInlinedExternals({
      externals: ["undici"],
      files: [{ name: "index.js", source: "var a=1;var b=2;" }],
    });
    assert.equal(noBanners, true);
    assert.deepEqual(violations, []);
  });
});

describe("evaluateClient", () => {
  const banner = (p) => `// ${p}\nvar x = 1;\n`;
  const clean = [
    { name: "index.js", source: banner("../../core/mcp/index.ts") },
  ];

  test("fails closed when no externals could be parsed", () => {
    // A tsup refactor — `external: EXTERNALS`, or a line break after the colon —
    // makes parseExternals return nothing. Checking zero packages and reporting
    // success would silently disable the guard on a change that looks harmless.
    const failures = evaluateClient({
      name: "web",
      build: "clients/web/build",
      externals: [],
      files: clean,
    });
    assert.equal(failures.length, 1);
    assert.match(failures[0], /no `external` entries could be parsed/);
  });

  test("fails when the bundle carries no module banners", () => {
    const failures = evaluateClient({
      name: "cli",
      build: "clients/cli/build",
      externals: ["undici"],
      files: [{ name: "index.js", source: "var a=1;" }],
    });
    assert.equal(failures.length, 1);
    assert.match(failures[0], /no esbuild module banners/);
  });

  test("reports one failure per inlined package", () => {
    const failures = evaluateClient({
      name: "tui",
      build: "clients/tui/build",
      externals: ["undici", "pino"],
      files: [
        {
          name: "index.js",
          source:
            banner("../../node_modules/undici/index.js") +
            banner("../../node_modules/pino/pino.js"),
        },
      ],
    });
    assert.equal(failures.length, 2);
    assert.match(
      failures[0],
      /tui: "undici" is declared external but was inlined/,
    );
  });

  test("passes a clean bundle", () => {
    assert.deepEqual(
      evaluateClient({
        name: "web",
        build: "clients/web/build",
        externals: ["undici"],
        files: clean,
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
