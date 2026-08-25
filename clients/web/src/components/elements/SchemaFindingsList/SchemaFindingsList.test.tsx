import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/react";
import type { Tool } from "@modelcontextprotocol/client";
import { lintToolSchemas } from "@inspector/core/json/schemaLint.js";
import { renderWithMantine } from "../../../test/renderWithMantine";
import { SchemaFindingsList } from "./SchemaFindingsList";

function findingsFor(tool: Partial<Tool>) {
  return lintToolSchemas({ name: "info", ...tool } as Tool);
}

describe("SchemaFindingsList", () => {
  it("renders nothing when there are no findings", () => {
    renderWithMantine(<SchemaFindingsList findings={[]} />);
    expect(screen.queryByTestId("schema-findings")).not.toBeInTheDocument();
  });

  it("shows the path, severity, issue and fix for an error finding", () => {
    renderWithMantine(
      <SchemaFindingsList
        findings={findingsFor({
          outputSchema: { type: "object", properties: { data: true } },
        } as Partial<Tool>)}
      />,
    );
    expect(screen.getByText("Schema portability (1)")).toBeInTheDocument();
    expect(screen.getByText("error")).toBeInTheDocument();
    expect(
      screen.getByText("outputSchema.properties.data"),
    ).toBeInTheDocument();
    expect(screen.getByText(/Bare `true`/)).toBeInTheDocument();
    expect(screen.getByText(/^Fix: /)).toBeInTheDocument();
  });

  it("labels a warning finding as such", () => {
    renderWithMantine(
      <SchemaFindingsList
        findings={findingsFor({
          inputSchema: {
            type: "object",
            properties: { a: { type: ["null", "boolean"] } },
          },
        } as Partial<Tool>)}
      />,
    );
    expect(screen.getByText("warning")).toBeInTheDocument();
    expect(screen.queryByText("error")).not.toBeInTheDocument();
  });

  it("renders one block per finding", () => {
    renderWithMantine(
      <SchemaFindingsList
        findings={findingsFor({
          inputSchema: { type: "object", properties: { a: true, b: true } },
        } as Partial<Tool>)}
      />,
    );
    expect(screen.getByText("Schema portability (2)")).toBeInTheDocument();
    expect(screen.getAllByText("error")).toHaveLength(2);
  });
});
