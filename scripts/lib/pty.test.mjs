import { strict as assert } from "node:assert";
import test from "node:test";

import {
  ptyCommand,
  probeScriptVersion,
  resolvePtyWrapper,
  scriptFlavorFor,
  shellQuote,
} from "./pty.mjs";

// The flavors are not interchangeable: BSD `script` takes argv after the
// typescript file, util-linux takes ONE shell string before it, and busybox
// takes that string without `-e`. Getting it wrong is not a subtle failure —
// `script` refuses to start, and the smoke reports it as a TUI crash.
test("scriptFlavorFor prefers the version probe over the platform", () => {
  assert.equal(
    scriptFlavorFor({
      platform: "linux",
      versionOutput: "script from util-linux 2.39.3",
    }),
    "util-linux",
  );
  assert.equal(
    scriptFlavorFor({
      platform: "linux",
      versionOutput: "BusyBox v1.36.1 (2024-01-01) multi-call binary.",
    }),
    "busybox",
  );
  // Alpine is the reason the probe exists at all: "linux" does not imply
  // util-linux, and busybox's `script` rejects `-e`.
  assert.notEqual(
    scriptFlavorFor({ platform: "linux", versionOutput: "BusyBox v1.36.1" }),
    "util-linux",
  );
});

test("scriptFlavorFor falls back to the platform when the probe says nothing", () => {
  // BSD `script` has no --version, so failing the probe is itself the signal.
  assert.equal(scriptFlavorFor({ platform: "darwin" }), "bsd");
  assert.equal(scriptFlavorFor({ platform: "freebsd" }), "bsd");
  // An unidentifiable `script` on linux is overwhelmingly util-linux. Guess it:
  // a wrong guess fails loudly with `script`'s own usage error in the captured
  // output, whereas skipping is the silence this issue exists to stop.
  assert.equal(scriptFlavorFor({ platform: "linux" }), "util-linux");
});

test("scriptFlavorFor returns null where there is no script(1)", () => {
  assert.equal(scriptFlavorFor({ platform: "win32" }), null);
  assert.equal(
    scriptFlavorFor({ platform: "win32", versionOutput: "not a thing" }),
    null,
  );
});

test("ptyCommand builds the BSD argv form", () => {
  assert.deepEqual(
    ptyCommand({
      command: "/bin/node",
      args: ["app.js", "--x"],
      flavor: "bsd",
    }),
    {
      command: "script",
      args: ["-q", "/dev/null", "/bin/node", "app.js", "--x"],
    },
  );
});

test("ptyCommand builds the util-linux shell-string form with -e", () => {
  // -e is what makes `script` exit with the child's status instead of its own.
  assert.deepEqual(
    ptyCommand({
      command: "/bin/node",
      args: ["app.js"],
      flavor: "util-linux",
    }),
    {
      command: "script",
      args: ["-qec", "'/bin/node' 'app.js'", "/dev/null"],
    },
  );
});

test("ptyCommand omits -e for busybox, which has no such flag", () => {
  const { args } = ptyCommand({
    command: "node",
    args: ["app.js"],
    flavor: "busybox",
  });
  assert.equal(args[0], "-qc");
  assert.deepEqual(args, ["-qc", "'node' 'app.js'", "/dev/null"]);
});

test("ptyCommand quotes arguments for the shell-string flavors", () => {
  // The smoke passes an mkdtemp path; a space in it would otherwise split into
  // two arguments inside the shell `script -c` runs.
  const { args } = ptyCommand({
    command: "/usr/local/my node/bin/node",
    args: ["/tmp/a dir/catalog.json", "it's-fine"],
    flavor: "util-linux",
  });
  assert.equal(
    args[1],
    `'/usr/local/my node/bin/node' '/tmp/a dir/catalog.json' 'it'\\''s-fine'`,
  );
});

test("shellQuote survives an embedded single quote", () => {
  assert.equal(shellQuote("it's"), `'it'\\''s'`);
  assert.equal(shellQuote("plain"), "'plain'");
});

test("probeScriptVersion combines both streams and never throws", () => {
  assert.equal(
    probeScriptVersion(() => ({ stdout: "out ", stderr: "err" })),
    "out err",
  );
  // BSD `script --version` errors; spawnSync can also return a bare object.
  assert.equal(
    probeScriptVersion(() => {
      throw new Error("ENOENT");
    }),
    "",
  );
  assert.equal(
    probeScriptVersion(() => ({})),
    "",
  );
});

test("resolvePtyWrapper wraps with the resolved flavor, or reports none", () => {
  const wrapper = resolvePtyWrapper({
    platform: "linux",
    probe: () => "script from util-linux 2.39.3",
  });
  assert.equal(wrapper.flavor, "util-linux");
  assert.deepEqual(wrapper.wrap({ command: "node", args: ["a.js"] }), {
    command: "script",
    args: ["-qec", "'node' 'a.js'", "/dev/null"],
  });
  // `args` is optional at the call site.
  assert.deepEqual(wrapper.wrap({ command: "node" }).args[1], "'node'");

  assert.equal(resolvePtyWrapper({ platform: "win32", probe: () => "" }), null);
});

test("resolvePtyWrapper resolves on this machine unless it is Windows", () => {
  // Not a tautology: it runs the real probe, so a `script` that has vanished
  // from PATH, or a platform nobody has tried, surfaces here rather than as an
  // opaque smoke failure.
  const wrapper = resolvePtyWrapper();
  if (process.platform === "win32") {
    assert.equal(wrapper, null);
  } else {
    assert.ok(wrapper, `no PTY wrapper resolved on ${process.platform}`);
    assert.equal(wrapper.wrap({ command: "node" }).command, "script");
  }
});
