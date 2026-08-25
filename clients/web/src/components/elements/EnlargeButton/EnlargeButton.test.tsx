import { describe, it, expect, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { renderWithMantine, screen } from "../../../test/renderWithMantine";
import { EnlargeButton } from "./EnlargeButton";

describe("EnlargeButton", () => {
  it('renders with the "Enlarge" accessible name', () => {
    renderWithMantine(<EnlargeButton onClick={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Enlarge" })).toBeInTheDocument();
  });

  it("stays in the keyboard tab order", () => {
    renderWithMantine(<EnlargeButton onClick={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Enlarge" })).not.toHaveAttribute(
      "tabindex",
      "-1",
    );
  });

  it("invokes onClick when clicked", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    renderWithMantine(<EnlargeButton onClick={onClick} />);
    await user.click(screen.getByRole("button", { name: "Enlarge" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("allows the accessible name to be overridden", () => {
    renderWithMantine(
      <EnlargeButton onClick={vi.fn()} ariaLabel="Enlarge Query" />,
    );
    expect(
      screen.getByRole("button", { name: "Enlarge Query" }),
    ).toBeInTheDocument();
  });

  it("is inert when the field it belongs to is disabled", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    renderWithMantine(<EnlargeButton onClick={onClick} disabled />);
    const button = screen.getByRole("button", { name: "Enlarge" });
    expect(button).toBeDisabled();
    await user.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });
});
