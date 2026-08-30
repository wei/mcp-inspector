import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import { defineConfig, globalIgnores } from "eslint/config";

// Root-level lint gate for first-party code that no client's own `eslint .`
// (each scoped to its own directory) reaches: the shared `core/` package
// (#1689) and the root-owned "shared" surface — `test-servers/src/**`, the
// root `vitest.shared.mts`, and this config file itself (#1767). `core/` is
// isomorphic TypeScript (browser-side OAuth + Node backends + shared runtime);
// the shared surface is Node-only tooling/tests.
//
// ⚠️ There is no React plugin here, and "neither surface has JSX" is NOT a
// sufficient reason for that — `core/react/` is a directory of React hooks,
// which the hook rules judge whether or not any JSX is present. So the whole
// `eslint-plugin-react-hooks` set, `set-state-in-effect` included, has never
// looked at them: it is a devDependency of `clients/web` only, and Node
// resolution walks up rather than down, so the root cannot even load it.
// That is why the prop-into-effect re-sync #1955 fixed sat here unreported
// while the identical shape is an error over in `clients/web/src`. Closing the
// gap means adding the plugin at the root and taking what it then reports —
// measured during #1955 as 15 findings, every one of them in a hook that issue
// did not convert (the two settings-draft hooks and the three async fetch
// hooks) and none in the 16 it did. Tracked on its own rather than folded in.
//
// Type-aware linting for the two blocks below. `no-floating-promises` needs
// type information, which `tseslint.configs.recommended` (the non-type-aware
// set) does not provide — so each block adds a parser project (#1959).
//
// `tsconfig.lint.json` exists for this and nothing else: the root has no
// tsconfig of its own (`core/` is typechecked through `clients/web`'s
// `tsc -b`, `test-servers/src` through `clients/cli`'s test project), and a
// parser project must literally *contain* every file it is asked to lint.
const typeAware = {
  languageOptions: {
    parserOptions: {
      project: ["./tsconfig.lint.json"],
      tsconfigRootDir: import.meta.dirname,
    },
  },
  rules: {
    // The class this catches is invisible at review time: the call reads like
    // an awaited one minus four characters, and the unhandled rejection it
    // produces surfaces in a different test, in a different file, as a stack
    // pointing at SDK internals — which is how #1947 came to fail the whole
    // `npm run local:gate` chain from two un-held `callTool` promises.
    "@typescript-eslint/no-floating-promises": "error",
  },
};

const sharedRules = {
  // An `_`-prefix is the explicit "intentionally unused" marker —
  // interface-conformance params in fakes, destructuring-rest omissions,
  // and reserved-for-later args. Honor it rather than deleting signal.
  "@typescript-eslint/no-unused-vars": [
    "error",
    {
      argsIgnorePattern: "^_",
      varsIgnorePattern: "^_",
      caughtErrorsIgnorePattern: "^_",
    },
  ],
};

export default defineConfig([
  globalIgnores([
    "core/**/build/**",
    "core/**/dist/**",
    "test-servers/build/**",
  ]),
  {
    files: ["core/**/*.{ts,tsx}"],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
    rules: sharedRules,
  },
  {
    files: [
      "test-servers/src/**/*.{ts,tsx,mts,cts}",
      "vitest.shared.mts",
      "eslint.config.js",
    ],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.node,
      },
    },
    rules: sharedRules,
  },
  {
    // Type-aware pass over the same surface, minus `eslint.config.js` — it is
    // JavaScript, so no tsconfig contains it and asking the parser for a
    // project would fail it outright rather than lint it.
    files: [
      "core/**/*.{ts,tsx}",
      "test-servers/src/**/*.{ts,tsx,mts,cts}",
      "vitest.shared.mts",
    ],
    ...typeAware,
  },
]);
