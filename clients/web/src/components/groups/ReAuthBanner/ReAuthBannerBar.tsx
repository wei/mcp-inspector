import { Paper } from "@mantine/core";

// The re-auth popup. A `Paper` so every static style is a prop; the stacking
// order goes through `styles.root` since Mantine has no `z` prop.
//
// Floats rather than spanning the top as a sticky full-bleed bar. The bar cost
// the whole view a band of vertical space for what is a notification about one
// server, and it sat directly above the monitoring sidebar that an OAuth
// failure now opens (#2108) — the two things a user needs at once here are this
// affordance and those requests, so it must not push them around. `fixed`, not
// `sticky`, so scrolling the server list leaves it put.
//
// Centered, and deliberately WITHOUT an overlay. Every corner is spoken for —
// the toast stack owns bottom-right (see `main.tsx`), the right edge is the
// monitoring sidebar whose toolbar this would cover, and top-left is the
// Servers header — so anchoring it anywhere hides something. Centering is the
// one placement that reads as addressed to the whole window rather than
// attached to the wrong panel.
//
// The missing overlay is the point, not an omission: this is a notification,
// not a decision that must be made now. An OAuth failure opens the monitoring
// sidebar (#2108), and blocking the page would force a choice between reading
// those requests and keeping the affordance — dismissing is not free, since
// "Authorize again" also clears the stale OAuth state, which a plain reconnect
// does not do. So it floats above the page and leaves it usable.
//
// `transform` goes through `styles.root` for the same reason `zIndex` does:
// Mantine exposes neither as a style prop.
export const ReAuthBannerBar = Paper.withProps({
  pos: "fixed",
  top: "50%",
  left: "50%",
  w: 420,
  bg: "var(--mantine-color-body)",
  shadow: "xl",
  radius: "md",
  styles: { root: { transform: "translate(-50%, -50%)", zIndex: 200 } },
});
