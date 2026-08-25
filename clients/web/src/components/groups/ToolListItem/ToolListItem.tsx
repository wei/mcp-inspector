import {
  Group,
  Image,
  Stack,
  Text,
  ThemeIcon,
  Tooltip,
  UnstyledButton,
} from "@mantine/core";
import { useMemo } from "react";
import { RiErrorWarningLine } from "react-icons/ri";
import type { Tool } from "@modelcontextprotocol/client";
import { lintToolSchemas } from "@inspector/core/json/schemaLint.js";
import { resolveDisplayLabel } from "../../../utils/toolUtils";

export interface ToolListItemProps {
  tool: Tool;
  selected: boolean;
  onClick: () => void;
}

const ItemLabel = Text.withProps({
  fw: 500,
  truncate: true,
});

const ItemSubLabel = Text.withProps({
  size: "xs",
  c: "dimmed",
  truncate: true,
});

const ItemBody = Stack.withProps({
  gap: 2,
  flex: 1,
  miw: 0,
});

const Row = Group.withProps({
  gap: "sm",
  wrap: "nowrap",
  align: "flex-start",
});

const ToolIcon = Image.withProps({
  w: 20,
  h: 20,
  fit: "contain",
});

const ListItemButton = UnstyledButton.withProps({
  w: "100%",
  p: "sm",
  variant: "listItem",
});

// Schema-portability flag (#1005). Sits in the row rather than only in the
// detail panel so a problem tool is visible without clicking each one — the
// findings are rare enough that a marked row means something.
const SchemaFlagIcon = ThemeIcon.withProps({
  size: "xs",
  variant: "transparent",
  role: "img",
});

export function ToolListItem({ tool, selected, onClick }: ToolListItemProps) {
  const { name, title, icons } = tool;
  const iconSrc = icons?.[0]?.src;
  const findings = useMemo(() => lintToolSchemas(tool), [tool]);
  const hasError = findings.some((f) => f.severity === "error");

  return (
    <ListItemButton
      bg={selected ? "var(--mantine-primary-color-light)" : undefined}
      onClick={onClick}
    >
      <Row>
        {iconSrc && <ToolIcon src={iconSrc} alt="" />}
        <ItemBody>
          <ItemLabel>{resolveDisplayLabel(name, title)}</ItemLabel>
          {title && <ItemSubLabel>{name}</ItemSubLabel>}
        </ItemBody>
        {findings.length > 0 && (
          <Tooltip
            label={`${findings.length} schema portability finding${findings.length === 1 ? "" : "s"} — select the tool for detail`}
            withArrow
          >
            <SchemaFlagIcon
              color={hasError ? "red" : "yellow"}
              aria-label={
                hasError
                  ? "Schema portability errors"
                  : "Schema portability warnings"
              }
            >
              <RiErrorWarningLine />
            </SchemaFlagIcon>
          </Tooltip>
        )}
      </Row>
    </ListItemButton>
  );
}
