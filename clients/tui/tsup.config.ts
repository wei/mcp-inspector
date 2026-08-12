import { defineConfig, type Options } from "tsup";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(dirname, "../..");

/**
 * `ink-form` hardcodes a misspelled hint under an incomplete form — "you have
 * not competed yet" — with no prop to override it. It is upstream's string
 * (`ink-form/lib/SubmitButton.js`), last published in 2024, but it renders in
 * the Inspector's tool/prompt/resource test forms, so we correct it on the way
 * into the bundle. Reported upstream as lukasbach/ink-form#14; drop this patch
 * if a release ever carries the fix.
 *
 * This is only possible because `ink-form` is inlined (see `noExternal` below).
 */
export const INK_FORM_INCOMPLETE_HINT = {
  typo: "There are still required inputs you have not competed yet.",
  fixed: "There are still required inputs you have not completed yet.",
};

/**
 * Applies the correction above, throwing if the string is no longer there.
 *
 * Failing loudly is the point: a silent no-op would let an `ink-form` upgrade
 * (or a fixed upstream, or a reworded label) quietly retire this patch with
 * nobody noticing it had stopped applying — or, worse, leave a patch here for a
 * string that no longer exists. If this throws, check whether upstream fixed
 * the typo; if so, delete this patch rather than re-targeting it.
 */
export function fixInkFormIncompleteHint(source: string, file: string): string {
  if (!source.includes(INK_FORM_INCOMPLETE_HINT.typo)) {
    throw new Error(
      `${file} no longer contains the ink-form label this build patches ` +
        `(${JSON.stringify(INK_FORM_INCOMPLETE_HINT.typo)}). If upstream fixed ` +
        `the typo, remove fixInkFormIncompleteHint from tsup.config.ts.`,
    );
  }
  return source.replaceAll(
    INK_FORM_INCOMPLETE_HINT.typo,
    INK_FORM_INCOMPLETE_HINT.fixed,
  );
}

/**
 * Which module the patch above is applied to.
 *
 * Exported so the tests can check it against the *resolved* path of the real
 * `ink-form` module — a filter that stops matching is the one way this patch
 * can silently no-op, since `fixInkFormIncompleteHint` would then never run.
 */
export const INK_FORM_SUBMIT_BUTTON = /ink-form[\\/]lib[\\/]SubmitButton\.js$/;

// The plugin type is derived from tsup rather than imported from `esbuild`:
// `esbuild` is tsup's transitive dependency, not a declared one of this client,
// so a direct import typechecks only while npm happens to hoist it.
type EsbuildPlugin = NonNullable<Options["esbuildPlugins"]>[number];

export const inkFormLabelPatch: EsbuildPlugin = {
  name: "ink-form-label-patch",
  setup(build) {
    build.onLoad(
      { filter: INK_FORM_SUBMIT_BUTTON },
      async ({ path: file }) => ({
        contents: fixInkFormIncompleteHint(await readFile(file, "utf8"), file),
        loader: "js",
      }),
    );
  },
};

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
  esbuildPlugins: [inkFormLabelPatch],
  esbuildOptions(options) {
    options.alias = {
      "@inspector/core": path.join(repoRoot, "core"),
    };
    options.jsx = "automatic";
  },
});
