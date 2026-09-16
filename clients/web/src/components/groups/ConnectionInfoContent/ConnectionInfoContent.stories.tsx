import type {
  ClientCapabilities,
  InitializeResult,
} from "@modelcontextprotocol/client";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import {
  ConnectionInfoContent,
  SERVER_INFO_NOT_REPORTED_LABEL,
} from "./ConnectionInfoContent";

const fullResult: InitializeResult = {
  protocolVersion: "2025-03-26",
  serverInfo: { name: "Everything Server", version: "2.1.0" },
  capabilities: {
    tools: { listChanged: true },
    resources: { subscribe: true, listChanged: true },
    prompts: { listChanged: true },
    logging: {},
    completions: {},
  },
  instructions:
    "This server provides access to the project management system. Use the list_projects tool first to discover available projects before querying tasks. Rate limiting applies: max 60 requests per minute.",
};

const fullClientCaps: ClientCapabilities = {
  roots: { listChanged: true },
  sampling: {},
  elicitation: {},
  experimental: {},
};

const meta: Meta<typeof ConnectionInfoContent> = {
  title: "Groups/ConnectionInfoContent",
  component: ConnectionInfoContent,
};

export default meta;
type Story = StoryObj<typeof ConnectionInfoContent>;

export const FullCapabilities: Story = {
  args: {
    initializeResult: fullResult,
    clientCapabilities: fullClientCaps,
    transport: "stdio",
  },
};

// The snapshot clock, read once when the stories load. The rows start from it
// and then tick against the wall clock, so the fixture has to be "now" — a
// fixed historical date would read as months ago a second after mounting.
const STORY_NOW = Date.now();

/**
 * The Connection Activity section, in the #2187 shape: the notification
 * stream has been open the whole session and delivered nothing, `tools/list`
 * has been outstanding for a minute, and nothing has been answered since
 * `initialize`. The same facts a request timeout's message reports, shown
 * while the request is still in flight (#2318).
 */
export const WithConnectionActivity: Story = {
  args: {
    initializeResult: fullResult,
    clientCapabilities: fullClientCaps,
    transport: "streamable-http",
    diagnostics: {
      capturedAt: STORY_NOW,
      outstandingRequests: [
        { id: 2, method: "tools/list", sentAt: STORY_NOW - 60_000 },
        { id: 3, method: "ping", sentAt: STORY_NOW - 12_000 },
      ],
      lastResponse: { method: "initialize", receivedAt: STORY_NOW - 61_000 },
      notificationStream: {
        url: "http://127.0.0.1:9779/mcp",
        openedAt: STORY_NOW - 252_000,
        eventCount: 0,
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Connection Activity")).toBeInTheDocument();
    // Ticking: the rows may have advanced a second or two since the fixture
    // was stamped, so match the shape rather than the exact second.
    await expect(
      canvas.getByText(/^tools\/list — sent 1m0\ds ago$/),
    ).toBeInTheDocument();
    await expect(
      canvas.getByText(/^GET \/mcp — open for 4m1\ds, 0 events delivered$/),
    ).toBeInTheDocument();
  },
};

export const ModernEra: Story = {
  args: {
    initializeResult: {
      protocolVersion: "2026-07-28",
      serverInfo: { name: "Modern Server", version: "2.0.0" },
      capabilities: {
        tools: { listChanged: true },
        resources: { subscribe: true },
        // The Server Extensions row reads the negotiated server capabilities
        // (era-transparent), not discoverResult — carry it here too so the
        // modern story demonstrates the extension. (#1740)
        extensions: {
          "io.modelcontextprotocol/tasks": {},
        },
      },
    },
    clientCapabilities: fullClientCaps,
    transport: "streamable-http",
    protocolEra: "modern",
    discoverResult: {
      supportedVersions: ["2026-07-28", "2025-11-25"],
      serverInfo: { name: "Modern Server", version: "2.0.0" },
      capabilities: {
        tools: { listChanged: true },
        resources: { subscribe: true },
        extensions: {
          "io.modelcontextprotocol/tasks": {},
        },
      },
    },
  },
  // SEP-2663 moved task support to the extension map, so the Tasks capability
  // row must read it there on a modern connection — otherwise a tasks-capable
  // server shows ✗ while listing the extension below (#1887).
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const tasksRow = canvas.getByText("Tasks");
    await expect(tasksRow.previousElementSibling).toHaveTextContent("✓");
  },
};

// A modern server that omitted the optional `_meta` serverInfo stamp (#1772).
// `initializeResult.serverInfo` here is App's client-side catalog fallback, and
// `serverInfoReported: false` tells the modal not to present it as server-sent —
// Name and Version read "— (not reported by server)".
export const ServerInfoNotReported: Story = {
  args: {
    initializeResult: {
      protocolVersion: "2026-07-28",
      // The catalog name App synthesizes; must NOT surface as the reported name.
      serverInfo: { name: "my-catalog-name", version: "" },
      capabilities: { tools: { listChanged: true } },
    },
    serverInfoReported: false,
    clientCapabilities: { roots: { listChanged: true } },
    transport: "streamable-http",
    protocolEra: "modern",
    // A real modern connection that skipped the `_meta` serverInfo stamp still
    // has a discover result — with `supportedVersions` + capabilities, just no
    // `serverInfo`. Including it makes the story accurate and shows the Discovery
    // section doesn't leak a name either.
    discoverResult: {
      supportedVersions: ["2026-07-28", "2025-11-25"],
      capabilities: { tools: { listChanged: true } },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByText("my-catalog-name")).not.toBeInTheDocument();
    await expect(
      canvas.getAllByText(SERVER_INFO_NOT_REPORTED_LABEL),
    ).toHaveLength(2);
  },
};

export const MinimalCapabilities: Story = {
  args: {
    initializeResult: {
      protocolVersion: "2025-03-26",
      serverInfo: { name: "Simple Server", version: "1.0.0" },
      capabilities: {
        tools: { listChanged: false },
      },
    },
    clientCapabilities: {
      roots: { listChanged: true },
    },
    transport: "streamable-http",
  },
};

export const WithInstructions: Story = {
  args: {
    initializeResult: fullResult,
    clientCapabilities: {
      roots: { listChanged: true },
      sampling: {},
    },
    transport: "stdio",
  },
};

export const WithOAuth: Story = {
  args: {
    initializeResult: {
      protocolVersion: "2025-03-26",
      serverInfo: { name: "Authenticated Server", version: "3.0.0" },
      capabilities: {
        tools: { listChanged: true },
        resources: { subscribe: true },
      },
    },
    clientCapabilities: {
      roots: { listChanged: true },
    },
    transport: "streamable-http",
    oauth: {
      protocol: "standard",
      authorized: true,
      authUrl: "https://auth.example.com/oauth2/authorize",
      scopes: ["read", "write", "admin"],
      accessToken: "eyJhbGciOiJSUzI1NiIs...truncated",
    },
  },
};

// An authorization server that also returned an `id_token` (#2019). Shown for
// inspection only — decoding it is display-only, and it is never used as a
// credential.
export const WithOAuthIdToken: Story = {
  args: {
    initializeResult: {
      protocolVersion: "2025-03-26",
      serverInfo: { name: "OIDC-fronted Server", version: "3.0.0" },
      capabilities: { tools: { listChanged: true } },
    },
    clientCapabilities: { roots: { listChanged: true } },
    transport: "streamable-http",
    oauth: {
      protocol: "standard",
      authorized: true,
      authUrl: "https://auth.example.com/oauth2/authorize",
      scopes: ["openid", "email", "read"],
      accessToken: "opaque-access-token",
      // header {"alg":"none"} / payload {"sub":"user-42","email":"a@b.test"}
      idToken:
        "eyJhbGciOiJub25lIn0.eyJzdWIiOiJ1c2VyLTQyIiwiZW1haWwiOiJhQGIudGVzdCJ9.",
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("ID Token")).toBeInTheDocument();
    // Only the ID token is a JWT here, so exactly one decode toggle is offered.
    await userEvent.click(
      canvas.getByRole("button", { name: "Decode JWT for ID Token" }),
    );
    await expect(canvas.getByText(/"sub": "user-42"/)).toBeInTheDocument();
  },
};
