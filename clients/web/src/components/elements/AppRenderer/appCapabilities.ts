import type { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";

/**
 * The app capabilities exactly as the view sent them, per bridge.
 *
 * `AppBridge.getAppCapabilities()` cannot be used for `elicitation` (#1854):
 * ext-apps 1.7.5 parses the view's `ui/initialize` params through
 * `McpUiAppCapabilitiesSchema`, a plain Zod object, so any key that schema does
 * not declare is **stripped before the bridge stores it**. `elicitation` is
 * exactly such a key — it is what ext-apps#733 adds — so an app that correctly
 * advertises it looks, through the bridge's own accessor, like an app that did
 * not. That silently turns every negotiated elicitation into a native-UI
 * fallback, which is indistinguishable from "the feature is off".
 *
 * So the raw frame is observed on the way in and recorded here. A WeakMap keeps
 * this per-bridge (never global) and lets the entry die with the bridge.
 *
 * Delete this module when ext-apps ships #733: `getAppCapabilities()` will
 * carry `elicitation` itself, and {@link appAdvertisesElicitation} already
 * prefers that value.
 */
const rawAppCapabilities = new WeakMap<AppBridge, Record<string, unknown>>();

/**
 * The only part of a transport this needs: the inbound-message callback.
 *
 * Structural, and generic over the message type, on purpose. ext-apps'
 * `PostMessageTransport` implements the SDK *v1* `Transport` — a different
 * nominal type from the v2 client's, though runtime-identical — so naming
 * either would force a cast at the call site. Generic rather than
 * `(message: unknown)` because a handler typed for a narrower message is not
 * assignable to one typed for `unknown` (contravariance), which would put the
 * cast back; `rest` is `never[]` for the same reason, accepting any trailing
 * parameter list without claiming to know it. The message is only ever read
 * through {@link recordAdvertisedCapabilities}, which narrows from `unknown`.
 */
export interface MessageObservable<TMessage = unknown> {
  onmessage?: (message: TMessage, ...rest: never[]) => void;
}

/**
 * Record `params.appCapabilities` if `message` is a `ui/initialize` frame.
 * Narrows from `unknown` rather than asserting a shape: the frame is whatever
 * the sandboxed view posted.
 */
function recordAdvertisedCapabilities(
  bridge: AppBridge,
  message: unknown,
): void {
  if (typeof message !== "object" || message === null) return;
  const frame = message as { method?: unknown; params?: unknown };
  if (frame.method !== "ui/initialize") return;
  if (typeof frame.params !== "object" || frame.params === null) return;
  const advertised = (frame.params as { appCapabilities?: unknown })
    .appCapabilities;
  if (typeof advertised === "object" && advertised !== null) {
    rawAppCapabilities.set(bridge, advertised as Record<string, unknown>);
  }
}

/**
 * Wrap a connected bridge's transport so the view's `ui/initialize` params are
 * recorded before the bridge parses them.
 *
 * Call AFTER `bridge.connect(transport)` — `connect` installs the handler this
 * wraps. That ordering is safe: the view cannot send `ui/initialize` until the
 * host has pushed its HTML into the sandbox, which happens later still.
 */
export function observeAppCapabilities<TMessage>(
  bridge: AppBridge,
  transport: MessageObservable<TMessage>,
): void {
  const inner = transport.onmessage?.bind(transport);
  transport.onmessage = (message: TMessage, ...rest: never[]) => {
    recordAdvertisedCapabilities(bridge, message);
    inner?.(message, ...rest);
  };
}

/**
 * Whether the app running on this bridge advertised the `elicitation`
 * capability. Prefers the bridge's own accessor (correct once ext-apps#733
 * ships) and falls back to the observed raw frame.
 */
export function appAdvertisesElicitation(bridge: AppBridge): boolean {
  const parsed = bridge.getAppCapabilities() as
    | Record<string, unknown>
    | undefined;
  if (parsed?.elicitation) return true;
  return Boolean(rawAppCapabilities.get(bridge)?.elicitation);
}
