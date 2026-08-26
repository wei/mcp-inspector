import { describe, expect, it } from "vitest";
import {
  formatProgressToastMessage,
  PROGRESS_TOAST_AUTOCLOSE_MS,
  progressToastId,
} from "./progressToasts";

describe("PROGRESS_TOAST_AUTOCLOSE_MS", () => {
  it("lingers a few seconds after the last tick", () => {
    expect(PROGRESS_TOAST_AUTOCLOSE_MS).toBe(5000);
  });
});

describe("progressToastId", () => {
  it("keys by the progress token", () => {
    expect(progressToastId("abc")).toBe("progress-abc");
    expect(progressToastId(7)).toBe("progress-7");
  });

  it("shares one id when the server sends no token", () => {
    expect(progressToastId(undefined)).toBe("progress-default");
  });
});

describe("formatProgressToastMessage", () => {
  it("renders the fraction and percentage when a total is present", () => {
    expect(formatProgressToastMessage({ progress: 1, total: 4 })).toBe(
      "1 / 4 (25%)",
    );
  });

  it("prefixes the server's message when present", () => {
    expect(
      formatProgressToastMessage({
        progress: 3,
        total: 4,
        message: "Indexing",
      }),
    ).toBe("Indexing — 3 / 4 (75%)");
  });

  it("omits the fraction when there is no total", () => {
    expect(formatProgressToastMessage({ progress: 9 })).toBe("9");
    expect(
      formatProgressToastMessage({ progress: 9, message: "Working" }),
    ).toBe("Working — 9");
  });

  it("omits the fraction when the total is zero (no divide-by-zero)", () => {
    expect(formatProgressToastMessage({ progress: 0, total: 0 })).toBe("0");
  });
});
