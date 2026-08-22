import { Group, Text, Tooltip } from "@mantine/core";
import { TbAlertTriangle, TbDeviceDesktop, TbLock } from "react-icons/tb";
import {
  secretStorageCaveat,
  secretStorageLabel,
  secretStorageTone,
  type SecretStorageInfo,
} from "@inspector/core/auth/secret-storage-info.js";

/**
 * Height of the footer band. Matches `InspectorView`'s `FOOTER_HEIGHT`
 * deliberately: these are the app's only permanent status strips, and a
 * modal footer standing a few pixels taller than the one behind it would
 * read as a different kind of thing.
 */
export const SECRET_STORAGE_FOOTER_HEIGHT = 32;

export interface SecretStorageFooterProps {
  /**
   * The active store, from `GET /api/config`. Renders nothing when
   * undefined — a backend that didn't report one leaves the question
   * genuinely open, and an invented answer directly beneath a secret field
   * is worse than silence.
   */
  info?: SecretStorageInfo;
}

// A thin band, same height as the app footer. Mantine's compound Modal has no
// `Modal.Footer`, so it renders as the last child of `Modal.Content`, after the
// `Modal.Body`, and its theme variant pins it with `position: sticky` — the
// mirror of Mantine's own sticky header, because `Modal.Content` scrolls
// header, body and footer as one. `nowrap` keeps it to one line at any modal
// width; the truncating detail text on the right absorbs a narrow modal.
const FooterBand = Group.withProps({
  variant: "stickyModalFooter",
  h: SECRET_STORAGE_FOOTER_HEIGHT,
  px: "md",
  gap: 6,
  align: "center",
  wrap: "nowrap",
  w: "100%",
});

const FooterLabel = Text.withProps({
  size: "xs",
  fw: 500,
  variant: "nowrap",
});

// The detail — a path, or the caveat sentence — is the part allowed to lose
// characters, since the label before it carries the answer.
//
// `lineClamp` rather than `truncate`, and the difference is load-bearing.
// `Modal.Content` sizes its scroll container to its children's **max-content**
// width, and `truncate` sets `white-space: nowrap`, whose max-content is the
// entire sentence — so the band grew the container to 770px inside a 620px
// modal and the *form above it* got clipped at the right edge (measured).
// Clamped text still wraps internally, so its max-content is merely its
// longest word, and the container stays the modal's width; the clamp then
// keeps it to the one line this 32px band has room for. `miw: 0` + `flex: 1`
// let it shrink to the leftover space rather than to its content.
const FooterDetail = Text.withProps({
  size: "xs",
  lineClamp: 1,
  miw: 0,
  flex: 1,
});

// `multiline` + a fixed width so the sentence wraps instead of forming a
// tooltip wider than the modal it explains. Only the `label` is dynamic.
const CaveatTooltip = Tooltip.withProps({
  multiline: true,
  w: 320,
  position: "top",
  withArrow: true,
});

const ICON_SIZE = 14;

/**
 * The permanent "here is where your secrets go" strip at the bottom of the
 * Client Settings and Server Settings modals (#1950).
 *
 * Those two dialogs are the only places the Inspector accepts a secret —
 * an OAuth client secret, an enterprise IdP client secret, a stdio `env:`
 * value — so they are where the answer belongs. The alternatives were
 * considered and rejected: a startup banner is seen once, by whoever
 * started the process, possibly hours before anyone types anything; a
 * toast is seen once and then gone; a dismissible banner is, by design,
 * the thing a user makes disappear before doing the work it describes.
 * This is always present, is not dismissible, and has no empty state
 * beyond "the backend didn't say".
 *
 * When the store is lossy or unencrypted the caveat is rendered *inline*
 * rather than left to the tooltip. That is the whole point of the
 * "plaintext gets a loud warning" decision: a warning you have to hover to
 * discover is not one. The tooltip carries the full sentence for the case
 * where a narrow modal truncates it, and — for the quiet stores — the file
 * path.
 *
 * Deliberately read-only for now. Choosing the store from here is the
 * obvious follow-up, but the gap this closes is that users could not find
 * out *at all*, and closing that does not require a control.
 */
export function SecretStorageFooter({ info }: SecretStorageFooterProps) {
  if (!info) return null;

  const caveat = secretStorageCaveat(info);
  const warn = secretStorageTone(info) === "warn";
  const color = warn
    ? "var(--inspector-warning-text)"
    : "var(--inspector-text-secondary)";
  // The caveat wins the visible slot when there is one; otherwise the path,
  // which only the (quiet) encrypted-file case has.
  const detail = caveat ?? info.path;
  const Icon = warn
    ? TbAlertTriangle
    : info.kind === "keyring"
      ? TbDeviceDesktop
      : TbLock;

  const band = (
    <FooterBand
      data-testid="secret-storage-footer"
      data-tone={warn ? "warn" : "neutral"}
    >
      {/* A react-icons glyph, not a Mantine factory component — outside the
          `.withProps()` rule, and it takes `color` as a prop rather than a
          style. */}
      <Icon size={ICON_SIZE} color={color} aria-hidden />
      <FooterLabel c={color}>Secrets: {secretStorageLabel(info)}</FooterLabel>
      {detail && <FooterDetail c={color}>{detail}</FooterDetail>}
    </FooterBand>
  );

  // Tooltip content: the caveat plus the path when both exist (the unencrypted
  // file case), since the visible slot can only show one of them.
  const tip = [caveat, info.path].filter(Boolean).join(" ");
  if (!tip) return band;

  return <CaveatTooltip label={tip}>{band}</CaveatTooltip>;
}
