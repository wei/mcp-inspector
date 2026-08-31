/**
 * Vitest/Vite resolve aliases shared between clients/web and node clients
 * (cli, tui). Pass each client's directory so bare-module pins resolve against
 * that client's node_modules.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

export function vitestSharedPaths(clientDir: string) {
  const dirname = path.resolve(clientDir);
  const repoRoot = path.resolve(dirname, "../..");

  const sharedAliases = {
    "@inspector/core": path.resolve(repoRoot, "core"),
    "@modelcontextprotocol/inspector-test-server": path.resolve(
      repoRoot,
      "test-servers/build/index.js",
    ),
  };

  const sharedDedupe = [
    "react",
    "react-dom",
    "@modelcontextprotocol/client",
    "@modelcontextprotocol/core",
  ];

  const nodeModulesAliases = [
    {
      find: /^react$/,
      replacement: path.resolve(dirname, "node_modules/react"),
    },
    {
      find: /^react\/jsx-runtime$/,
      replacement: path.resolve(dirname, "node_modules/react/jsx-runtime.js"),
    },
    {
      find: /^react\/jsx-dev-runtime$/,
      replacement: path.resolve(
        dirname,
        "node_modules/react/jsx-dev-runtime.js",
      ),
    },
    {
      find: /^react-dom$/,
      replacement: path.resolve(dirname, "node_modules/react-dom"),
    },
    {
      find: /^react-dom\/client$/,
      replacement: path.resolve(dirname, "node_modules/react-dom/client.js"),
    },
    // Everything below is **root-owned** and resolves from the repo root,
    // unlike the `react` / `react-dom` pins above. What they have in common is
    // that no client declares them, so the root install is the only place a
    // client's resolution chain is guaranteed to find one — not that they are
    // all root `dependencies`: `express` is test-only and sits in the root
    // `devDependencies`. Nor is this the complete root runtime set; a package
    // that resolves unambiguously without help (`ajv`, `commander`, `open`,
    // `undici`, `zod`) needs no pin and has none.
    //
    // `express` and `yaml` are reached only through `test-servers/src` —
    // express by the http/oauth servers, yaml by `load-config.ts` — which is
    // root-owned code with no manifest of its own.
    //
    // Pointing these at `<client>/node_modules` is what broke when the MCP
    // packages moved to the root (#1970): express was never declared by a client
    // at all, it arrived in `clients/cli` as a peer of `express-rate-limit`
    // under `@modelcontextprotocol/server-legacy`, so removing that manifest
    // entry took express with it and every cli test that spawns a test server
    // failed to resolve it.
    {
      find: /^express$/,
      replacement: path.resolve(repoRoot, "node_modules/express"),
    },
    {
      find: /^yaml$/,
      replacement: path.resolve(repoRoot, "node_modules/yaml"),
    },
    // Same reasoning, one layer in: `proper-lockfile` is reached only through
    // `core/` (the secrets file's cross-process lock, #2082), which is the
    // other root-owned tree with no manifest of its own. Resolution finds the
    // root copy on its own today — nothing declares it in a client — and this
    // pin is what keeps that from depending on nothing ever arriving as some
    // client's transitive dependency, which would otherwise give a test two
    // copies of a module whose whole job is a single registry of held locks.
    {
      find: /^proper-lockfile$/,
      replacement: path.resolve(repoRoot, "node_modules/proper-lockfile"),
    },
    // The rest of `core/`'s runtime dependencies, consolidated into the root
    // manifest by #2195. Each of these used to be declared by the clients that
    // reached it and was pinned to `<client>/node_modules` accordingly; once
    // the declarations went away those paths stopped existing, so the pin has
    // to follow the package to the root. Left un-repointed they would resolve
    // to a directory that is not there — or, worse, to a transitive copy some
    // unrelated dependency happened to drag in, which is the duplicate this
    // whole pin list exists to prevent.
    {
      find: /^pino$/,
      replacement: path.resolve(repoRoot, "node_modules/pino"),
    },
    {
      find: /^pino\/browser\.js$/,
      replacement: path.resolve(repoRoot, "node_modules/pino/browser.js"),
    },
    {
      find: /^hono$/,
      replacement: path.resolve(repoRoot, "node_modules/hono/dist/index.js"),
    },
    {
      find: /^hono\/streaming$/,
      replacement: path.resolve(
        repoRoot,
        "node_modules/hono/dist/helper/streaming/index.js",
      ),
    },
    {
      find: /^@hono\/node-server$/,
      replacement: path.resolve(repoRoot, "node_modules/@hono/node-server"),
    },
    {
      find: /^atomically$/,
      replacement: path.resolve(repoRoot, "node_modules/atomically"),
    },
    {
      find: /^chokidar$/,
      replacement: path.resolve(repoRoot, "node_modules/chokidar"),
    },
    {
      find: /^@napi-rs\/keyring$/,
      replacement: path.resolve(repoRoot, "node_modules/@napi-rs/keyring"),
    },
  ];

  const projectResolve = {
    alias: [
      ...Object.entries(sharedAliases).map(([find, replacement]) => ({
        find,
        replacement,
      })),
      ...nodeModulesAliases,
    ],
    dedupe: sharedDedupe,
  };

  return {
    repoRoot,
    sharedAliases,
    sharedDedupe,
    nodeModulesAliases,
    projectResolve,
  };
}

/** Convenience for importers that only have import.meta.url. */
export function vitestSharedPathsFromMetaUrl(metaUrl: string) {
  const clientDir = path.dirname(fileURLToPath(metaUrl));
  return vitestSharedPaths(clientDir);
}
