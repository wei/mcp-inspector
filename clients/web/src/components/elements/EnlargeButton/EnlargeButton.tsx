import { ActionIcon, Tooltip } from "@mantine/core";
import { ImEnlarge2 } from "react-icons/im";

export interface EnlargeButtonProps {
  /** Swap the single-line input this sits in for a multiline text area. */
  onClick: () => void;
  /**
   * Overrides the accessible name (aria-label), which defaults to the tooltip
   * text ("Enlarge"). Pass a per-field name (e.g. including the field's label)
   * when several inputs in one form each carry a button, so assistive tech can
   * tell them apart; the visible tooltip stays the plain verb.
   */
  ariaLabel?: string;
}

const EnlargeActionIcon = ActionIcon.withProps({
  variant: "subtle",
  color: "gray",
  size: "sm",
});

/**
 * The enlarge affordance shown to the left of a text input's ClearButton
 * (#2042). Clicking it replaces the single-line input with a multiline text
 * area, so a value containing newlines can be typed — a plain `<input>` swallows
 * Enter, which left string arguments effectively single-line.
 *
 * Deliberately not a toggle: shrinking back would have to decide what to do with
 * the newlines already typed, and either answer (silently discard them, or keep
 * a value the field can no longer display) is worse than staying enlarged.
 *
 * Unlike ClearButton it stays in the keyboard tab order. Clearing a field has a
 * keyboard equivalent (select-all, delete), so #1487 could take that button out
 * of the tab order without cost; entering multiline mode has none, so removing
 * this one would put the feature out of reach of keyboard users entirely.
 */
export function EnlargeButton({ onClick, ariaLabel }: EnlargeButtonProps) {
  return (
    <Tooltip label="Enlarge">
      <EnlargeActionIcon aria-label={ariaLabel ?? "Enlarge"} onClick={onClick}>
        <ImEnlarge2 size={12} />
      </EnlargeActionIcon>
    </Tooltip>
  );
}
