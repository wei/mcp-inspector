import { Code, Group, Stack, Text } from "@mantine/core";
import {
  describeSchemaPath,
  type SchemaFinding,
} from "@inspector/core/json/schemaLint.js";

// Section wrapper: heading + one block per finding.
const FindingsSection = Stack.withProps({
  gap: "xs",
});

const FindingsTitle = Text.withProps({
  size: "sm",
  fw: 600,
});

const FindingsNote = Text.withProps({
  size: "xs",
  c: "var(--inspector-text-secondary)",
});

// One finding: severity badge + path on the first row, then issue and fix.
const FindingBlock = Stack.withProps({
  gap: 2,
});

const FindingHeadRow = Group.withProps({
  gap: "xs",
  wrap: "nowrap",
  align: "center",
});

const FindingText = Text.withProps({
  size: "xs",
  c: "var(--inspector-text-secondary)",
});

/**
 * Severity label.
 *
 * Deliberately coloured text rather than a filled `Badge`: a filled `yellow`
 * badge puts white on `yellow-7`, which at this size is 3.92:1 and fails the
 * story's a11y check, and neither `autoContrast` (yellow-7 sits below
 * Mantine's default luminance threshold, so it stays white) nor
 * `variant="light"` (3.34:1) fixes it. The `--inspector-*` severity tokens are
 * the pairings this app already uses against its own surfaces, in both colour
 * schemes.
 */
const SeverityLabel = Text.withProps({
  size: "xs",
  fw: 700,
  tt: "uppercase",
});

/**
 * Severity → text-colour token. `error` is a construct a shipping MCP client
 * refuses outright; `warning` is one handled unevenly.
 */
function severityColor(severity: SchemaFinding["severity"]): string {
  return severity === "error"
    ? "var(--inspector-danger-text)"
    : "var(--inspector-warning-text)";
}

export interface SchemaFindingsListProps {
  /** Findings for one tool, in walk order. Renders nothing when empty. */
  findings: readonly SchemaFinding[];
}

/**
 * Tool-schema portability findings for one tool (#1005).
 *
 * The same verdict the CLI's `--strict` report and the TUI's detail pane show
 * — all three read `core/json/schemaLint`, so they cannot disagree about
 * whether a schema is portable, only about how much room they have to say so.
 */
export function SchemaFindingsList({ findings }: SchemaFindingsListProps) {
  if (findings.length === 0) return null;

  return (
    <FindingsSection data-testid="schema-findings">
      <FindingsTitle>Schema portability ({findings.length})</FindingsTitle>
      {findings.map((finding, index) => (
        <FindingBlock
          key={`${finding.schema}-${finding.path}-${finding.rule}-${index}`}
        >
          <FindingHeadRow>
            <SeverityLabel c={severityColor(finding.severity)}>
              {finding.severity}
            </SeverityLabel>
            <Code>{describeSchemaPath(finding.schema, finding.path)}</Code>
          </FindingHeadRow>
          <FindingText>{finding.issue}</FindingText>
          <FindingText>Fix: {finding.suggestion}</FindingText>
        </FindingBlock>
      ))}
      <FindingsNote>
        These constructs are legal JSON Schema but are refused or mishandled by
        some MCP clients, so a tool can work here and fail there.
      </FindingsNote>
    </FindingsSection>
  );
}
