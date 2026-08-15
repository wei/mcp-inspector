import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { InspectorClient } from "@inspector/core/mcp/inspectorClient.js";
import { MessageLogState } from "@inspector/core/mcp/state/index.js";
import { createTransportNode } from "@inspector/core/mcp/node/transport.js";

/**
 * Per-item list salvage against a real connection (#1909).
 *
 * The reported server was PHP, whose empty `annotations` object reaches the
 * wire as `[]` rather than `{}` — one non-conforming entry, and the SDK
 * rejected the whole `resources/templates/list` result, so every template
 * vanished behind "Couldn't load resources".
 *
 * A hand-rolled JSON-RPC server is used rather than a composable test server
 * because the SDK's own server cannot emit these shapes: they are exactly what
 * its types forbid. The transport, the SDK client, and the salvage path are all
 * real.
 */

interface ListPage {
  items: unknown[];
  nextCursor?: string;
}

function jsonRpcResult(id: unknown, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

/**
 * Minimal streamable-HTTP MCP server that answers `initialize` and the list
 * methods it was configured with, returning entries verbatim (malformed ones
 * included).
 */
function startMalformedServer(initialPages: {
  resourceTemplates?: ListPage[];
  tools?: ListPage[];
}): Promise<{
  url: string;
  stop: () => Promise<void>;
  calls: string[];
  /** Swap what the server serves next, to model a server that got fixed. */
  setPages: (next: {
    resourceTemplates?: ListPage[];
    tools?: ListPage[];
  }) => void;
}> {
  const calls: string[] = [];
  let pages = initialPages;

  const pageFor = (key: "resourceTemplates" | "tools", cursor?: string) => {
    const configured = pages[key] ?? [];
    const index = cursor === undefined ? 0 : Number(cursor);
    return configured[index] ?? { items: [] };
  };

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString();
    // The SDK also issues bodyless requests (the SSE GET, the session DELETE on
    // teardown). Answer them without pretending they're JSON-RPC.
    if (raw.length === 0) {
      res.writeHead(405).end();
      return;
    }
    const body = JSON.parse(raw) as {
      id?: unknown;
      method: string;
      params?: { cursor?: string };
    };
    calls.push(body.method);

    // Notifications carry no id and get an empty 202.
    if (body.id === undefined) {
      res.writeHead(202).end();
      return;
    }

    const send = (result: unknown) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(jsonRpcResult(body.id, result)));
    };

    if (body.method === "initialize") {
      send({
        protocolVersion: "2025-06-18",
        capabilities: { resources: {}, tools: {} },
        serverInfo: { name: "malformed-list-server", version: "1.0.0" },
      });
      return;
    }
    if (body.method === "resources/templates/list") {
      const page = pageFor("resourceTemplates", body.params?.cursor);
      send({
        resourceTemplates: page.items,
        ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor }),
      });
      return;
    }
    if (body.method === "tools/list") {
      const page = pageFor("tools", body.params?.cursor);
      send({
        tools: page.items,
        ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor }),
      });
      return;
    }
    send({});
  };

  const server: Server = createServer((req, res) => {
    void handler(req, res);
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      /* v8 ignore next -- listen() on a fresh server always yields an AddressInfo */
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}/mcp`,
        calls,
        setPages: (next) => {
          pages = next;
        },
        stop: () =>
          new Promise((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

const VALID_TEMPLATE = {
  name: "full_annotations",
  uriTemplate: "annotated://full/{id}",
  annotations: { audience: ["user"], priority: 0.8 },
};
// The #1909 shape: `[]` where the spec says object.
const PHP_EMPTY_ANNOTATIONS = {
  name: "array_annotations",
  uriTemplate: "annotated://array/{id}",
  annotations: [],
};
const EMPTY_OBJECT_ANNOTATIONS = {
  name: "empty_annotations",
  uriTemplate: "annotated://empty/{id}",
  annotations: {},
};

describe("InspectorClient list salvage (#1909)", () => {
  let client: InspectorClient | null = null;
  let stopServer: (() => Promise<void>) | null = null;

  async function connectTo(url: string) {
    client = new InspectorClient(
      { type: "streamable-http", url },
      { environment: { transport: createTransportNode } },
    );
    await client.connect();
    return client;
  }

  beforeEach(() => {
    client = null;
    stopServer = null;
  });

  afterEach(async () => {
    try {
      await client?.disconnect();
    } catch {
      // Teardown only — the assertions already ran.
    }
    client = null;
    await stopServer?.();
    stopServer = null;
  });

  it("keeps the valid templates and reports the malformed one", async () => {
    const server = await startMalformedServer({
      resourceTemplates: [
        {
          items: [
            EMPTY_OBJECT_ANNOTATIONS,
            PHP_EMPTY_ANNOTATIONS,
            VALID_TEMPLATE,
          ],
        },
      ],
    });
    stopServer = server.stop;
    const connected = await connectTo(server.url);

    const { resourceTemplates } = await connected.listAllResourceTemplates();

    // Before the fix this threw, and the panel showed zero templates.
    expect(resourceTemplates.map((t) => t.name)).toEqual([
      "empty_annotations",
      "full_annotations",
    ]);
    expect(connected.getMalformedListItems()).toEqual([
      {
        method: "resources/templates/list",
        index: 1,
        label: "array_annotations",
        reason: expect.stringMatching(/^annotations: /),
      },
    ]);
  });

  it("accepts an empty annotations object without salvaging at all", async () => {
    // `{}` is legal — every Annotations field is optional — so this must take
    // the strict path and report nothing dropped.
    const server = await startMalformedServer({
      resourceTemplates: [{ items: [EMPTY_OBJECT_ANNOTATIONS] }],
    });
    stopServer = server.stop;
    const connected = await connectTo(server.url);

    const { resourceTemplates } = await connected.listAllResourceTemplates();
    expect(resourceTemplates).toHaveLength(1);
    expect(connected.getMalformedListItems()).toEqual([]);
  });

  it("emits malformedListItemsChange so the UI can warn", async () => {
    const server = await startMalformedServer({
      resourceTemplates: [{ items: [PHP_EMPTY_ANNOTATIONS, VALID_TEMPLATE] }],
    });
    stopServer = server.stop;
    const connected = await connectTo(server.url);

    const seen: unknown[] = [];
    connected.addEventListener("malformedListItemsChange", (event) => {
      seen.push(event.detail);
    });
    await connected.listAllResourceTemplates();

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject([{ label: "array_annotations" }]);
  });

  it("marks the Protocol entry rejected even though the list rendered", async () => {
    const server = await startMalformedServer({
      resourceTemplates: [{ items: [PHP_EMPTY_ANNOTATIONS, VALID_TEMPLATE] }],
    });
    stopServer = server.stop;
    const connected = await connectTo(server.url);
    const log = new MessageLogState(connected);

    await connected.listAllResourceTemplates();

    const rejected = log
      .getMessages()
      .filter((entry) => entry.clientError !== undefined);
    expect(rejected.length).toBeGreaterThan(0);
    expect(rejected.at(-1)?.clientError).toContain("Dropped 1 malformed entry");
    log.destroy();
  });

  it("salvages across pages, indexing against the aggregate", async () => {
    const server = await startMalformedServer({
      tools: [
        {
          items: [{ name: "ok_one", inputSchema: { type: "object" } }],
          nextCursor: "1",
        },
        { items: [{ name: "broken", inputSchema: "not-a-schema" }] },
      ],
    });
    stopServer = server.stop;
    const connected = await connectTo(server.url);

    const { tools } = await connected.listAllTools();
    expect(tools.map((t) => t.name)).toEqual(["ok_one"]);
    expect(connected.getMalformedListItems()).toMatchObject([
      { method: "tools/list", index: 1, label: "broken" },
    ]);
  });

  it("clears a previous report once the server answers cleanly", async () => {
    const server = await startMalformedServer({
      resourceTemplates: [{ items: [PHP_EMPTY_ANNOTATIONS, VALID_TEMPLATE] }],
    });
    stopServer = server.stop;
    const connected = await connectTo(server.url);

    await connected.listAllResourceTemplates();
    expect(connected.getMalformedListItems()).toHaveLength(1);

    // The server is fixed; the next refresh must clear the stale report rather
    // than leaving a warning about entries that are no longer wrong.
    server.setPages({ resourceTemplates: [{ items: [VALID_TEMPLATE] }] });
    await connected.listAllResourceTemplates({ cacheMode: "bypass" });
    expect(connected.getMalformedListItems()).toEqual([]);
  });

  it("rethrows when the rejection is not about any single entry", async () => {
    // Every entry validates; the result is bad for another reason (a cursor of
    // the wrong type). There is no per-item story, so the original error must
    // survive rather than being swallowed into a partial list.
    const server = await startMalformedServer({
      resourceTemplates: [
        { items: [VALID_TEMPLATE], nextCursor: 42 as unknown as string },
      ],
    });
    stopServer = server.stop;
    const connected = await connectTo(server.url);

    await expect(connected.listAllResourceTemplates()).rejects.toThrow();
    expect(connected.getMalformedListItems()).toEqual([]);
  });
});
