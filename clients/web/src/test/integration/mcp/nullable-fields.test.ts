import { describe, it, expect, afterEach } from "vitest";
import { InspectorClient } from "@inspector/core/mcp/inspectorClient.js";
import { createTransportNode } from "@inspector/core/mcp/node/transport.js";
import { normalizeNullableUnion } from "@inspector/core/json/nullableUnion.js";
import { toFormSchema } from "../../../utils/jsonUtils";
import {
  createTestServerHttp,
  type TestServerHttp,
  createTestServerInfo,
  createNullableFieldsTool,
} from "@modelcontextprotocol/inspector-test-server";

/**
 * Live coverage of the `record_shipment` preset behind
 * `test-servers/configs/nullable-fields-http.json` — the documented manual
 * reproduction for #1928.
 *
 * The unit tests on both form builders construct the `anyOf` shape by hand,
 * which verifies the *renderers* but assumes the premise: that Zod's
 * `.nullish()` actually emits `anyOf: [<branch>, { type: "null" }]` with the
 * `enum` on the branch. That premise is the whole reason the fix exists, and
 * nothing else pins it — a Zod change in how it compiles a nullish enum, or a
 * typo in the preset registry, would leave every unit test green while the
 * showcase server quietly stopped reproducing the bug.
 *
 * So this asserts the wire shape end to end, then runs it through the same
 * collapse the forms use.
 */
describe("nullable argument schemas over the wire (#1928)", () => {
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

  async function connectToPreset(): Promise<InspectorClient> {
    const started = createTestServerHttp({
      serverInfo: createTestServerInfo("nullable-fields-test", "1.0.0"),
      tools: [createNullableFieldsTool()],
    });
    await started.start();
    server = started;

    const connected = new InspectorClient(
      { type: "streamable-http", url: started.url },
      { environment: { transport: createTransportNode } },
    );
    await connected.connect();
    client = connected;
    return connected;
  }

  it("emits an anyOf-with-null for every nullish argument, enum on the branch", async () => {
    const connected = await connectToPreset();
    const { tools } = await connected.listAllTools();

    const tool = tools.find((entry) => entry.name === "record_shipment");
    expect(tool).toBeDefined();

    const schema = toFormSchema(tool?.inputSchema);
    const properties = schema?.properties ?? {};
    expect(Object.keys(properties).sort()).toEqual([
      "direction",
      "express",
      "quantity",
      "reference",
    ]);

    // The premise of the whole fix: no top-level `type`, and the `enum` sits on
    // the surviving branch rather than beside it.
    const direction = properties.direction;
    expect(direction?.type).toBeUndefined();
    expect(direction?.enum).toBeUndefined();
    expect(direction?.anyOf).toHaveLength(2);
    expect(direction?.anyOf).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "null" })]),
    );
  });

  it("collapses each argument to the type its widget dispatches on", async () => {
    const connected = await connectToPreset();
    const { tools } = await connected.listAllTools();
    const schema = toFormSchema(
      tools.find((entry) => entry.name === "record_shipment")?.inputSchema,
    );
    const properties = schema?.properties ?? {};

    const collapsed = Object.fromEntries(
      Object.entries(properties).map(([name, propertySchema]) => [
        name,
        normalizeNullableUnion(propertySchema),
      ]),
    );

    expect(collapsed.direction?.type).toBe("string");
    expect(collapsed.direction?.enum).toEqual(["envio", "recebimento"]);
    expect(collapsed.reference?.type).toBe("string");
    expect(collapsed.quantity?.type).toBe("integer");
    expect(collapsed.express?.type).toBe("boolean");

    for (const propertySchema of Object.values(collapsed)) {
      expect(propertySchema?.nullable).toBe(true);
      expect(propertySchema?.anyOf).toBeUndefined();
    }
  });
});
