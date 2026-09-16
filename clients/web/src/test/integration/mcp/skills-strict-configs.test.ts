import { describe, it, expect, afterEach } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { InspectorClient } from "@inspector/core/mcp/inspectorClient.js";
import { createTransportNode } from "@inspector/core/mcp/node/transport.js";
import { eraToVersionNegotiation } from "@inspector/core/mcp/types.js";
import {
  createTestServerHttp,
  type TestServerHttp,
  loadConfig,
  resolveConfig,
} from "@modelcontextprotocol/inspector-test-server";

/**
 * Live coverage of the two checked-in strict Skills configs (#2373) — the
 * documented manual reproduction of a server that enforces the client's half
 * of SEP-2133 negotiation.
 *
 * `inspectorClient-skills.test.ts` exercises the fixture behavior by passing
 * `skillsRequireClientExtension` straight to `createTestServerHttp`, so it
 * never touches the JSON-to-`ServerConfig` mapping. A misspelled key in either
 * file, or a `resolveConfig` that stopped threading the flag, would leave the
 * manual fixtures quietly permissive while that suite stayed green. These
 * tests **resolve the checked-in files** and assert the refusal they exist
 * for, so that class fails here instead.
 */
const configsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../../../test-servers/configs",
);

const CONFIGS = [
  { file: "skills-strict-legacy-http.json", era: "legacy" as const },
  { file: "skills-strict-modern-http.json", era: "modern" as const },
];

describe("strict Skills showcase configs (#2373)", () => {
  let client: InspectorClient | null = null;
  let server: TestServerHttp | null = null;

  afterEach(async () => {
    if (client) {
      try {
        await client.disconnect();
      } catch {
        // ignore
      }
      client = null;
    }
    if (server) {
      try {
        await server.stop();
      } catch {
        // ignore
      }
      server = null;
    }
  });

  for (const { file, era } of CONFIGS) {
    describe(file, () => {
      const configPath = path.join(configsDir, file);

      it("resolves with the strict flag, skills, and its era intact", () => {
        const resolved = resolveConfig(loadConfig(configPath));
        expect(resolved.skills).toBe(true);
        expect(resolved.skillsRequireClientExtension).toBe(true);
        // One file per era is the documented contract: a legacy client
        // reaching a modern server is served statelessly and cannot be
        // checked, so the legacy file must not turn the modern leg on.
        expect(resolved.modern !== undefined).toBe(era === "modern");
      });

      it("refuses skills/list to a client that did not declare the extension", async () => {
        // The harness picks the port rather than the config's fixed one, so
        // this cannot collide with a showcase server someone runs by hand.
        const resolved = resolveConfig(loadConfig(configPath));
        const started = createTestServerHttp({ ...resolved, port: undefined });
        await started.start();
        server = started;

        const connected = new InspectorClient(
          { type: "streamable-http", url: started.url },
          {
            environment: { transport: createTransportNode },
            versionNegotiation: eraToVersionNegotiation(era),
            advertisedExtensions: { "io.modelcontextprotocol/skills": false },
          },
        );
        await connected.connect();
        client = connected;
        expect(connected.getProtocolEra()).toBe(era);

        await expect(connected.listSkills()).rejects.toMatchObject({
          code: era === "modern" ? -32021 : -32601,
        });
      });
    });
  }
});
