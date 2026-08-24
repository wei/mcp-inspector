/**
 * App-origin server: the dedicated origin an MCP App gets when its UI resource
 * declares `_meta.ui.domain` (#2056).
 *
 * ## Why a third listener exists
 *
 * By default the Inspector renders an App by handing its HTML to the sandbox
 * proxy as `srcdoc`, in an iframe sandboxed **without** `allow-same-origin`.
 * That is the isolation model #1565 chose, and it is the right default — but it
 * gives the app document an *opaque* origin, so every request it makes carries
 * `Origin: null`. An app whose backend allowlists origins (CORS, an OAuth
 * callback, an API-key allowlist) therefore cannot work, which is exactly what
 * `_meta.ui.domain` exists to solve: the spec lets a server ask its host for a
 * stable, dedicated origin.
 *
 * `domain` is explicitly **host-dependent** — "the format and validation rules
 * for this field are determined by each host" — and the Inspector owns no
 * domain infrastructure. What it *can* provide is a real, stable HTTP origin on
 * loopback. So a UI resource that declares any non-empty `domain` opts into
 * being served from this listener instead of `srcdoc`, and its requests carry a
 * real `Origin: http://<host>:<port>`.
 *
 * ## One shared origin, not one per domain
 *
 * Every domain-declaring app is served from this single port, path-keyed by an
 * unguessable document id. That is a deliberate trade: it delivers the property
 * the spec field is *for* (a real, allowlistable origin) without minting a port
 * — or a DNS name — per app. The consequence is that this origin is **not** a
 * per-app isolation boundary: two apps served here share `localStorage`,
 * `sessionStorage`, and cookies for it. They remain isolated from the sandbox
 * proxy and from the Inspector itself, which are different origins.
 *
 * ## Why granting `allow-same-origin` here is not a regression
 *
 * The inner frame is sandboxed with `allow-same-origin` only on this path,
 * which is what makes the origin real rather than opaque. The #1565 rationale —
 * "the app cannot touch the proxy's DOM, so it cannot bypass its own CSP by
 * executing in the parent's realm" — still holds, because this listener is on
 * its own port and is therefore cross-origin to both the proxy and the app
 * page. Same-origin policy blocks the reach either way.
 *
 * The per-app CSP is additionally delivered as a real response **header** here,
 * which is stronger than the `<meta>` the `srcdoc` path must rely on: a header
 * applies to the document before any of its bytes are parsed and cannot be
 * displaced by anything in the app's own markup.
 */

import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import {
  canonicalUrlHost,
  isAllInterfacesHost,
} from "../../../core/node/hostUrl.ts";
import { DEFAULT_BIND_HOST } from "./resolve-bind-host.js";
import { frameAncestorsDirective } from "./sandbox-controller.js";

/**
 * The default app-origin listen port — **fixed**, for the same reason
 * `DEFAULT_SANDBOX_PORT` is: a port that changes per run can never be named in
 * a dev container's `forwardPorts`, a `docker run -p`, or an SSH tunnel. `6276`
 * sits next to the web (`6274`) and sandbox (`6275`) ports so the three forward
 * together.
 */
export const DEFAULT_APP_ORIGIN_PORT = 6276;

/** Documents kept at once. Oldest is evicted past this; see {@link publish}. */
const MAX_DOCUMENTS = 32;

/**
 * How long a published document stays fetchable. An iframe fetches its `src`
 * once, so this only has to outlive the gap between publishing and the frame
 * loading — but a generous window keeps a reload (React StrictMode, a devtools
 * "reload frame") working rather than blanking the app.
 */
const DOCUMENT_TTL_MS = 60 * 60 * 1000;

/**
 * The sandbox proxy's origin as a one-entry list for
 * {@link AppOriginControllerOptions.embedderOrigins}, or `undefined` when the
 * sandbox never bound (its controller degrades to a null URL). Passing
 * `undefined` is what makes the app-origin `frame-ancestors` fall back to
 * loopback rather than to `'none'`, which would block the frame outright.
 */
export function sandboxOriginList(
  sandboxUrl: string | null | undefined,
): string[] | undefined {
  if (!sandboxUrl) return undefined;
  try {
    return [new URL(sandboxUrl).origin];
  } catch {
    /* v8 ignore next -- the sandbox controller only ever emits a URL it built
       itself; an unparseable value would be a bug there, not input. */
    return undefined;
  }
}

export interface AppOriginControllerOptions {
  /** Port to bind (0 = dynamic). */
  port: number;
  /** Host to bind (default {@link DEFAULT_BIND_HOST}). */
  host?: string;
  /**
   * The origin(s) allowed to frame a published document — in practice the
   * sandbox proxy's own origin, since the proxy is what embeds the inner
   * iframe. Malformed entries are dropped and an empty result falls back to
   * loopback, exactly as the sandbox proxy's own `frame-ancestors` does.
   */
  embedderOrigins?: string[];
}

/** A document handed to {@link AppOriginController.publish}. */
export interface AppDocument {
  /** The fully-wrapped HTML the sandbox would otherwise have received. */
  html: string;
  /** The per-app CSP policy string, delivered as a response header. */
  csp?: string;
}

export interface AppOriginController {
  start(): Promise<{ port: number; url: string }>;
  close(): Promise<void>;
  /** The origin this listener serves on, or null when it never bound. */
  getOrigin(): string | null;
  /**
   * Store a document and return the absolute URL the sandbox proxy should load
   * it from, or `null` when this listener isn't running (the caller then falls
   * back to the default `srcdoc` path rather than failing the render).
   */
  publish(doc: AppDocument): { url: string } | null;
}

/**
 * A usable listen port from a raw env value, or `undefined` if it isn't a plain
 * integer in `0`–`65535`. Mirrors `sandbox-controller`'s parser: `^\d+$` rejects
 * `parseInt`'s partial parses (`6276abc`) and the bound keeps an out-of-range
 * value from reaching `server.listen`, which throws synchronously.
 */
function parseListenPort(raw: string | undefined): number | undefined {
  const v = raw?.trim();
  if (!v || !/^\d+$/.test(v)) return undefined;
  const n = parseInt(v, 10);
  return n <= 65535 ? n : undefined;
}

/**
 * Resolve the app-origin port from env: `MCP_APP_ORIGIN_PORT` →
 * {@link DEFAULT_APP_ORIGIN_PORT}. A set-but-invalid value is warned and falls
 * through rather than crashing the boot, matching `resolveSandboxPort`.
 */
export function resolveAppOriginPort(): number {
  const parsed = parseListenPort(process.env.MCP_APP_ORIGIN_PORT);
  if (parsed === undefined && process.env.MCP_APP_ORIGIN_PORT?.trim()) {
    console.warn(
      `Ignoring invalid MCP_APP_ORIGIN_PORT="${process.env.MCP_APP_ORIGIN_PORT}" (need an integer 0–65535); falling back.`,
    );
  }
  return parsed ?? DEFAULT_APP_ORIGIN_PORT;
}

/** The path a published document is served at, given its id. */
const DOC_PATH_PREFIX = "/app-document/";

/** `/app-document/<id>` → `<id>`, or null for any other request target. */
export function parseDocumentId(url: string | undefined): string | null {
  if (!url || !url.startsWith(DOC_PATH_PREFIX)) return null;
  // Drop a query string: an app's own URL may carry one and it is not part of
  // the id. Anything with a further path segment is not a document target.
  const id = url.slice(DOC_PATH_PREFIX.length).split(/[?#]/)[0];
  return /^[0-9a-f]{32}$/.test(id ?? "") ? (id ?? null) : null;
}

interface StoredDocument extends AppDocument {
  expiresAt: number;
}

export function createAppOriginController(
  options: AppOriginControllerOptions,
): AppOriginController {
  // Same defaulting rationale as the sandbox controller: never the *name*
  // `localhost`, which resolves to a single address family and would put this
  // listener on a different family than the web server (#1951).
  const { port, host = DEFAULT_BIND_HOST, embedderOrigins } = options;
  let server: Server | null = null;
  let origin: string | null = null;

  // Insertion-ordered, so the first key is the oldest entry.
  const documents = new Map<string, StoredDocument>();

  const FRAME_ANCESTORS = frameAncestorsDirective(embedderOrigins);

  /** Drop everything past its TTL. Cheap: the map is bounded by MAX_DOCUMENTS. */
  function evictExpired(now: number): void {
    for (const [id, doc] of documents) {
      if (doc.expiresAt <= now) documents.delete(id);
    }
  }

  return {
    async start(): Promise<{ port: number; url: string }> {
      if (server && origin) {
        return { port: parseInt(new URL(origin).port, 10), url: origin };
      }
      return new Promise((resolve) => {
        let settled = false;
        const settle = (value: { port: number; url: string }) => {
          /* v8 ignore next -- defensive double-settle guard: `error` and
             `listening` are mutually exclusive for a TCP listen. */
          if (settled) return;
          settled = true;
          resolve(value);
        };

        server = createServer((req, res) => {
          const id = req.method === "GET" ? parseDocumentId(req.url) : null;
          const doc = id ? documents.get(id) : undefined;
          if (!doc || doc.expiresAt <= Date.now()) {
            if (id) documents.delete(id);
            res.writeHead(404, { "Content-Type": "text/plain" });
            res.end("Not Found");
            return;
          }
          res.writeHead(200, {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store, no-cache, must-revalidate",
            Pragma: "no-cache",
            // `nosniff` matters more here than on a page we authored: these
            // bytes are server-supplied and untrusted.
            "X-Content-Type-Options": "nosniff",
            // The per-app policy as a real header. It is the same policy baked
            // into the document's <meta>; delivering both is deliberate —
            // multiple policies intersect, and two copies of one policy
            // intersect to itself, so this can only ever be at least as strict.
            "Content-Security-Policy": doc.csp
              ? `${doc.csp}; ${FRAME_ANCESTORS}`
              : FRAME_ANCESTORS,
          });
          res.end(doc.html);
        });

        // Same fallback as the sandbox controller: a fixed default port can
        // collide (a second Inspector), and losing the listener would take
        // dedicated-origin rendering down. Retry once on an OS-assigned port,
        // loudly — whoever pinned the port to forward it needs to know.
        let retriedDynamic = false;
        server.on("error", (err: NodeJS.ErrnoException) => {
          if (err.code === "EADDRINUSE") {
            if (!retriedDynamic && port !== 0) {
              retriedDynamic = true;
              console.warn(
                `App origin: port ${port} in use; falling back to an OS-assigned port. ` +
                  `Apps declaring _meta.ui.domain will still render, but the origin ` +
                  `they are served from is no longer predictable — set ` +
                  `MCP_APP_ORIGIN_PORT to a free one if your app's backend ` +
                  `allowlists it.`,
              );
              server!.listen(0, host);
              return;
            }
            console.error(
              `App origin: port ${port || "dynamic"} in use. Apps declaring _meta.ui.domain will fall back to an opaque origin.`,
            );
          } else {
            console.error("App origin server error:", err);
          }
          // Degrade rather than reject: `publish` then returns null and the
          // renderer keeps working on the default srcdoc path.
          server = null;
          settle({ port: 0, url: "" });
        });

        server.listen(port, host, () => {
          const addr = server!.address();
          const actualPort =
            typeof addr === "object" && addr !== null && "port" in addr
              ? addr.port
              : /* v8 ignore next -- unreachable for a TCP listen; `address()`
                   returns AddressInfo. */
                (addr as unknown as number);
          // A wildcard bind isn't reachable as `http://0.0.0.0:PORT`, but it
          // does serve loopback — advertise `localhost` there, and otherwise
          // the same canonical host the origin allow-list emits.
          const canonicalHost = canonicalUrlHost(host);
          const urlHost = isAllInterfacesHost(canonicalHost)
            ? "localhost"
            : canonicalHost;
          origin = `http://${urlHost}:${actualPort}`;
          settle({ port: actualPort, url: origin });
        });
      });
    },

    async close(): Promise<void> {
      documents.clear();
      if (!server) return;
      return new Promise((resolve) => {
        server!.close(() => {
          server = null;
          origin = null;
          resolve();
        });
      });
    },

    getOrigin(): string | null {
      return origin;
    },

    publish(doc: AppDocument): { url: string } | null {
      if (!origin) return null;
      const now = Date.now();
      evictExpired(now);
      // Bound the map even if nothing has expired: drop the oldest entry. An
      // evicted document's frame has long since loaded, and the alternative is
      // an unbounded store fed by every app the user opens in a session.
      while (documents.size >= MAX_DOCUMENTS) {
        const oldest = documents.keys().next();
        /* v8 ignore next -- `size >= MAX_DOCUMENTS` guarantees a first key. */
        if (oldest.done) break;
        documents.delete(oldest.value);
      }
      const id = randomBytes(16).toString("hex");
      documents.set(id, { ...doc, expiresAt: now + DOCUMENT_TTL_MS });
      return { url: `${origin}${DOC_PATH_PREFIX}${id}` };
    },
  };
}
