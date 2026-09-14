/**
 * Public addresses for the MCP Apps listeners (#1862): the URL the browser is
 * told to load the sandbox proxy from, and the origin a `_meta.ui.domain` app
 * document is served from, when either differs from the address the process
 * binds.
 *
 * ## Why an override exists
 *
 * Both listeners advertise a URL built from their own bind — `http://localhost:
 * 6275/sandbox` under a wildcard bind. That is right whenever the browser shares
 * the process's view of the network (a desktop, a container published on the
 * same port numbers, an SSH tunnel), and wrong behind a reverse proxy or an
 * ingress, where the browser reaches the listener at a public hostname and
 * frequently over HTTPS. The port knobs (`MCP_SANDBOX_PORT`,
 * `MCP_APP_ORIGIN_PORT`) cannot express a scheme or a hostname, so:
 *
 * - `MCP_SANDBOX_FULL_ADDRESS` — the sandbox proxy URL, e.g.
 *   `https://inspector-sandbox.example.com/sandbox`. A bare origin gets
 *   `/sandbox` appended, since that is the only path the listener serves.
 * - `MCP_APP_ORIGIN_FULL_ADDRESS` — the app-origin listener's origin, e.g.
 *   `https://inspector-apps.example.com`. An origin only: documents are served
 *   at `<origin>/app-document/<id>`, so a path would name nothing.
 *
 * Neither changes what the process listens on; the operator routes the public
 * address to the listener.
 *
 * ## Why the values are validated rather than passed through
 *
 * The sandbox origin is an isolation boundary, not merely an address. The MCP
 * Apps spec requires host ≠ sandbox origin, and today that holds structurally —
 * the listener is on its own port of the same process, so it cannot be
 * misconfigured. An operator-supplied address makes it configurable, and the
 * most natural reverse-proxy layout (`https://inspector.example.com/sandbox`
 * routed to `:6275`) is exactly the one that collapses it. The proxy page's own
 * self-test and its #2056 `src` check both fail closed, but their symptom is a
 * blank frame and a console throw; refusing here names the cause at boot.
 *
 * So a value is **refused** — warned and ignored, falling back to the
 * bind-derived address, matching the warn-and-drop precedent `ALLOWED_ORIGINS`
 * and `MCP_SANDBOX_PORT` set — when it is not an absolute `http(s)` URL, carries
 * credentials, a query, a fragment, a wildcard, or a bracketed IPv6 literal (not
 * a valid CSP host-source, and the sandbox origin is emitted into published
 * documents' `frame-ancestors`), or when its origin equals an Inspector UI
 * origin (or, for the app origin, the sandbox's). A plain-`http` address under
 * an `https` UI is only **warned**: the browser blocks it as mixed content, but
 * `ALLOWED_ORIGINS` can legitimately list both schemes at once, so it is not
 * provably wrong.
 *
 * Not `DANGEROUSLY_`-prefixed: it widens no bind and disables no check, and the
 * configurations that would be dangerous are rejected rather than renamed.
 */

export const SANDBOX_FULL_ADDRESS_ENV = "MCP_SANDBOX_FULL_ADDRESS";
export const APP_ORIGIN_FULL_ADDRESS_ENV = "MCP_APP_ORIGIN_FULL_ADDRESS";

/** The only path the sandbox listener serves (see `sandbox-controller.ts`). */
const SANDBOX_PATH = "/sandbox";

/** A parsed address, or the reason it was refused. */
type Parsed = { url: URL } | { reason: string };

/**
 * Shape checks shared by both addresses. Returns the reason for the first
 * failure, so the warning names one concrete thing to fix.
 */
function parsePublicUrl(raw: string): Parsed {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { reason: "it is not an absolute URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { reason: "it needs an http:// or https:// scheme" };
  }
  if (url.username || url.password) {
    return { reason: "it must not carry credentials" };
  }
  // `new URL` accepts `*` in a hostname; it is never a reachable address.
  if (url.hostname.includes("*")) {
    return { reason: "it must not contain a wildcard" };
  }
  if (url.hostname.startsWith("[")) {
    return {
      reason:
        "a bracketed IPv6 literal is not a valid CSP host-source — use a hostname or an IPv4 address",
    };
  }
  if (url.search || url.hash) {
    return { reason: "it must not carry a query string or fragment" };
  }
  return { url };
}

/**
 * The value as it may appear in a log line. Never the raw string: the values
 * refused for carrying credentials or a query are exactly the ones likely to
 * hold a secret, and echoing them would leak what the check refused. Userinfo,
 * query and fragment are dropped; an unparseable value is not echoed at all.
 */
export function describeForLog(raw: string): string {
  try {
    const u = new URL(raw);
    return `"${u.protocol}${u.host ? `//${u.host}` : ""}${u.pathname}"`;
  } catch {
    return "(unparseable value, not echoed)";
  }
}

function warnIgnored(env: string, raw: string, reason: string): void {
  console.warn(
    `Ignoring ${env}=${describeForLog(raw)}: ${reason}. Advertising the bind-derived address instead.`,
  );
}

/**
 * Warn when a plain-`http` address will be loaded by an `https` UI. Not a
 * refusal — see the header comment.
 */
function warnMixedContent(
  env: string,
  url: URL,
  allowedOrigins: readonly string[],
): void {
  if (
    url.protocol === "http:" &&
    allowedOrigins.some((o) => o.startsWith("https:"))
  ) {
    console.warn(
      `${env} is plain http (${url.origin}) but ALLOWED_ORIGINS includes an https origin: ` +
        `a browser on the https UI blocks it as mixed content and MCP Apps will not render there.`,
    );
  }
}

/**
 * The public sandbox proxy URL from {@link SANDBOX_FULL_ADDRESS_ENV}, or
 * `undefined` when it is unset, blank, or refused (warned).
 *
 * @param allowedOrigins The resolved Inspector UI origins — the sandbox must
 *   not share an origin with any of them.
 */
export function resolveSandboxPublicUrl(
  raw: string | undefined,
  allowedOrigins: readonly string[],
): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  const parsed = parsePublicUrl(value);
  if ("reason" in parsed) {
    warnIgnored(SANDBOX_FULL_ADDRESS_ENV, value, parsed.reason);
    return undefined;
  }
  const { url } = parsed;
  // A bare origin names the listener, not the page; the page is `/sandbox`.
  if (url.pathname === "/") url.pathname = SANDBOX_PATH;
  if (allowedOrigins.includes(url.origin)) {
    warnIgnored(
      SANDBOX_FULL_ADDRESS_ENV,
      value,
      `its origin ${url.origin} is also an Inspector UI origin (ALLOWED_ORIGINS), and the MCP Apps ` +
        `sandbox must be on a different origin from its host — route it to its own hostname or port`,
    );
    return undefined;
  }
  warnMixedContent(SANDBOX_FULL_ADDRESS_ENV, url, allowedOrigins);
  return url.href;
}

/**
 * The public app-origin from {@link APP_ORIGIN_FULL_ADDRESS_ENV}, or
 * `undefined` when it is unset, blank, or refused (warned).
 *
 * @param allowedOrigins The resolved Inspector UI origins.
 * @param sandboxUrl The overridden sandbox URL, when there is one. This is the
 *   early, config-time check; a bind-derived sandbox origin is only known once
 *   that listener binds (possibly on a fallback port), so the authoritative
 *   comparison against it is made by the app-origin controller at start, which
 *   receives the real sandbox and Inspector origins as `embedderOrigins`.
 */
export function resolveAppOriginPublicOrigin(
  raw: string | undefined,
  allowedOrigins: readonly string[],
  sandboxUrl: string | undefined,
): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  const parsed = parsePublicUrl(value);
  if ("reason" in parsed) {
    warnIgnored(APP_ORIGIN_FULL_ADDRESS_ENV, value, parsed.reason);
    return undefined;
  }
  const { url } = parsed;
  if (url.pathname !== "/") {
    warnIgnored(
      APP_ORIGIN_FULL_ADDRESS_ENV,
      value,
      "it must be an origin only, with no path — app documents are served at <origin>/app-document/<id>",
    );
    return undefined;
  }
  // Same-origin with the host or the proxy is precisely what the dedicated
  // origin must never be: the inner frame is granted `allow-same-origin` on
  // this path, so sharing either origin hands the app that realm.
  const trusted = sandboxUrl
    ? [...allowedOrigins, new URL(sandboxUrl).origin]
    : allowedOrigins;
  if (trusted.includes(url.origin)) {
    warnIgnored(
      APP_ORIGIN_FULL_ADDRESS_ENV,
      value,
      `its origin ${url.origin} is also the Inspector UI's or the sandbox's, and a dedicated app ` +
        `origin must differ from both — route it to its own hostname or port`,
    );
    return undefined;
  }
  warnMixedContent(APP_ORIGIN_FULL_ADDRESS_ENV, url, allowedOrigins);
  return url.origin;
}
