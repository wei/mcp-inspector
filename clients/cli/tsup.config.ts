import { defineConfig } from "tsup";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(dirname, "../..");

export default defineConfig({
  entry: {
    index: "src/index.ts",
  },
  format: ["esm"],
  outDir: "build",
  clean: true,
  // No source maps in the published bundle — they roughly double the on-disk
  // size and aren't needed at runtime (debug via `npm run dev` on the source).
  sourcemap: false,
  target: "node22",
  platform: "node",
  // Bundle core source; leave npm deps external.
  noExternal: [/^@inspector\/core/],
  external: [
    "@napi-rs/keyring",
    // Root-declared (see the repo's dependency-placement rule) and CJS, which
    // is the combination that bites: tsup externalizes what the *client's*
    // package.json declares, so a root-only dependency is bundled unless named
    // here — and inlining a CJS module into an ESM bundle leaves esbuild's
    // `Dynamic require of "path" is not supported` shim, which throws at
    // import time and takes the whole binary down before it parses a flag.
    "proper-lockfile",
    "@modelcontextprotocol/client",
    "@modelcontextprotocol/core",
    "commander",
    "pino",
  ],
  esbuildOptions(options) {
    options.alias = {
      "@inspector/core": path.join(repoRoot, "core"),
    };
  },
});
