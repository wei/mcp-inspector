// Shared resolver for spawning a package's CLI cross-platform (#1939).
//
// On Windows, `npx`/`npm` are `.cmd` shims, not executables — a shell-free
// `execFileSync`/`spawnSync` cannot start one (Node refuses `.cmd`/`.bat`
// spawns without `shell: true` since the CVE-2024-27980 hardening) and throws
// `ENOENT`. GitHub CI runs Linux, so the gate stayed green there while being
// unrunnable for any Windows contributor. Instead of shelling through `npx`,
// resolve the JS entry behind the package's bin and run it with
// `process.execPath`: cross-platform, shell-free (no quoting hazards), faster
// (no npx resolution), and pinned to the locally installed package exactly as
// `npx --no-install` was.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

/**
 * Absolute path of the JS entry behind a package's bin (e.g. typescript's
 * `tsc`, vite's `vite`), resolved from `fromDir` up the node_modules tree —
 * the same walk `npx --no-install` does, minus the `.cmd` shim a shell-free
 * spawn can't start on Windows. Resolves `<pkg>/package.json` and reads its
 * `bin` field (what npx itself does) rather than resolving the bin path
 * directly, because an `exports` map blocks deep resolution — Vite 8 doesn't
 * export `./bin/vite.js`, so `require.resolve("vite/bin/vite.js")` throws
 * `ERR_PACKAGE_PATH_NOT_EXPORTED` (`./package.json` is always exported).
 *
 * Throws if the package isn't installed from `fromDir` or declares no such
 * bin — the caller decides whether that's a hard "cannot measure" error or a
 * fallback.
 */
export function resolveNodeBin(pkg, binName, fromDir) {
  const pkgPath = createRequire(path.join(fromDir, "package.json")).resolve(
    `${pkg}/package.json`,
  );
  const bin = JSON.parse(readFileSync(pkgPath, "utf8")).bin;
  // A string-form `bin` names a single command (the package's own name).
  const rel = typeof bin === "string" ? bin : bin?.[binName];
  if (typeof rel !== "string")
    throw new Error(`${pkg} declares no "${binName}" bin in its package.json`);
  return path.join(path.dirname(pkgPath), rel);
}
