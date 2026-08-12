import { defineConfig } from "tsup";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(dirname, "../..");

export default defineConfig({
  entry: ["index.ts"],
  format: ["esm"],
  outDir: "build",
  clean: true,
  // No source maps in the published bundle — they roughly double the on-disk
  // size and aren't needed at runtime (debug via `npm run dev` on the source).
  sourcemap: false,
  target: "node22",
  platform: "node",
  // Every package here renders React components, so it MUST share the one
  // React instance the bundle imports. Bundling them is what guarantees that:
  // an inlined package's `import "react"` is emitted into build/index.js and so
  // resolves from *this* directory, exactly like the bundle's own — no consumer
  // install layout can point it somewhere else (#1952). Left external, npm is
  // free to hoist them next to a *different* React: `ink-form` and
  // `ink-scroll-view` declare a loose `react` peer (">=18"), so a consumer
  // project holding React 18 satisfies it and gets them hoisted to its own root
  // while the Inspector's React 19 nests under it — two React copies, and the
  // first hook they call reads a null dispatcher ("Cannot read properties of
  // null (reading 'useState')") the moment a tool test form or a scroll view
  // mounts. `__tests__/tsupConfig.test.ts` guards this list.
  noExternal: [/^@inspector\/core/, "ink-form", "ink-scroll-view"],
  external: [
    // `react` is deliberately external — it is the single instance everything
    // above resolves to, from this build directory.
    "react",
    // `ink` stays external too: it cannot be bundled (its CJS `signal-exit@3`
    // dependency fails ESM interop with "Dynamic require of \"assert\""), and
    // it does not need to be — its `react` peer is ">=19", which keeps npm
    // from hoisting it next to a React the Inspector could not also use.
    "ink",
    "open",
    "commander",
    "pino",
    "@modelcontextprotocol/client",
    "@modelcontextprotocol/core",
    "@napi-rs/keyring",
  ],
  esbuildOptions(options) {
    options.alias = {
      "@inspector/core": path.join(repoRoot, "core"),
    };
    options.jsx = "automatic";
  },
});
