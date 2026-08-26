import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithMantine } from "../../../test/renderWithMantine";
import { ReAuthBannerBar } from "./ReAuthBannerBar";

describe("ReAuthBannerBar", () => {
  it("floats the banner centered above the page", () => {
    renderWithMantine(
      <ReAuthBannerBar data-testid="bar">contents</ReAuthBannerBar>,
    );
    const bar = screen.getByTestId("bar");
    expect(bar).toHaveTextContent("contents");
    expect(bar.style.transform).toBe("translate(-50%, -50%)");
    expect(bar.style.zIndex).toBe("200");
  });
});
