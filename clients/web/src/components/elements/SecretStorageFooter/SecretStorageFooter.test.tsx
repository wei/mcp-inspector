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
    expect(screen.getByText("Secrets: OS keychain")).toBeInTheDocument();
    expect(screen.getByTestId("secret-storage-footer")).toHaveAttribute(
      "data-tone",
      "neutral",
    );
  });

  it("shows the path for an encrypted file, quietly", () => {
    // Nothing is wrong here, so the band must not shout — the path is the
    // useful part and the tone stays neutral.
    renderWithMantine(<SecretStorageFooter info={encryptedFile} />);
    expect(screen.getByText("Secrets: File (encrypted)")).toBeInTheDocument();
    expect(
      screen.getByText("/home/node/.mcp-inspector/secrets.json"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("secret-storage-footer")).toHaveAttribute(
      "data-tone",
      "neutral",
    );
  });

  it("renders the plaintext caveat inline, not only on hover", () => {
    // This is the "loud banner" decision made concrete: a warning you have
    // to hover to discover is not a warning. The caveat takes the visible
    // slot, displacing the path (which stays in the tooltip).
    renderWithMantine(<SecretStorageFooter info={plaintextFile} />);
    expect(screen.getByText("Secrets: File (unencrypted)")).toBeInTheDocument();
    expect(
      screen.getByText(/Set MCP_INSPECTOR_SECRET_KEY to encrypt them/),
    ).toBeInTheDocument();
    expect(screen.getByTestId("secret-storage-footer")).toHaveAttribute(
      "data-tone",
      "warn",
    );
  });

  it("warns that an in-memory store loses secrets on exit", () => {
    renderWithMantine(<SecretStorageFooter info={memory} />);
    expect(
      screen.getByText("Secrets: Memory (this session only)"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/lost when the Inspector exits/),
    ).toBeInTheDocument();
    expect(screen.getByTestId("secret-storage-footer")).toHaveAttribute(
      "data-tone",
      "warn",
    );
  });

  it("renders nothing when the backend didn't report a store", () => {
    // A guessed answer under a secret field is worse than no answer, so the
    // unknown case is silence rather than a default.
    renderWithMantine(<SecretStorageFooter info={undefined} />);
    expect(screen.queryByTestId("secret-storage-footer")).toBeNull();
  });
});
