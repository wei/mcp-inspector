import { describe, it, expect } from "vitest";
import type { SecretStorageInfo } from "@inspector/core/auth/secret-storage-info.js";
import { renderWithMantine, screen } from "../../../test/renderWithMantine";
import { SecretStorageFooter } from "./SecretStorageFooter";

const keyring: SecretStorageInfo = {
  kind: "keyring",
  reason: "default",
  durable: true,
};
const encryptedFile: SecretStorageInfo = {
  kind: "file",
  reason: "fallback",
  durable: true,
  plaintext: false,
  path: "/home/node/.mcp-inspector/secrets.json",
};
const plaintextFile: SecretStorageInfo = { ...encryptedFile, plaintext: true };
const memory: SecretStorageInfo = {
  kind: "memory",
  reason: "fallback",
  durable: false,
};

describe("SecretStorageFooter", () => {
  it("names the keychain with no caveat and no warning tone", () => {
    renderWithMantine(<SecretStorageFooter info={keyring} />);
    // Asserted on the band's full text rather than with `getByText`: the
    // "Secrets:" prefix is its own `<span>`, and testing-library matches a
    // string against an element's *direct* text nodes only, so the label now
    // reads as two fragments even though it renders as one line.
    const band = screen.getByTestId("secret-storage-footer");
    expect(band).toHaveTextContent("Secrets: OS keychain");
    expect(band).toHaveAttribute("data-tone", "neutral");
  });

  it("shows the path for an encrypted file, quietly", () => {
    // Nothing is wrong here, so the band must not shout — the path is the
    // useful part and the tone stays neutral.
    renderWithMantine(<SecretStorageFooter info={encryptedFile} />);
    const band = screen.getByTestId("secret-storage-footer");
    expect(band).toHaveTextContent("Secrets: File (encrypted)");
    expect(
      screen.getByText("/home/node/.mcp-inspector/secrets.json"),
    ).toBeInTheDocument();
    expect(band).toHaveAttribute("data-tone", "neutral");
  });

  it("renders the plaintext caveat inline, not only on hover", () => {
    // This is the "loud banner" decision made concrete: a warning you have
    // to hover to discover is not a warning. The caveat takes the visible
    // slot, displacing the path (which stays in the tooltip).
    renderWithMantine(<SecretStorageFooter info={plaintextFile} />);
    const band = screen.getByTestId("secret-storage-footer");
    expect(band).toHaveTextContent("Secrets: File (unencrypted)");
    expect(
      screen.getByText(/Set MCP_INSPECTOR_SECRET_KEY to encrypt them/),
    ).toBeInTheDocument();
    expect(band).toHaveAttribute("data-tone", "warn");
  });

  it("warns that an in-memory store loses secrets on exit", () => {
    renderWithMantine(<SecretStorageFooter info={memory} />);
    const band = screen.getByTestId("secret-storage-footer");
    expect(band).toHaveTextContent("Secrets: Memory (this session only):");
    expect(screen.getByText(/lost on exit/)).toBeInTheDocument();
    expect(band).toHaveAttribute("data-tone", "warn");
  });

  it("renders nothing when the backend didn't report a store", () => {
    // A guessed answer under a secret field is worse than no answer, so the
    // unknown case is silence rather than a default.
    renderWithMantine(<SecretStorageFooter info={undefined} />);
    expect(screen.queryByTestId("secret-storage-footer")).toBeNull();
  });
});
