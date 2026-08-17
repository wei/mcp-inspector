import type { Tool } from "@modelcontextprotocol/client";

/**
 * Returns the display label for an MCP entity that follows the BaseMetadata
 * shape (Tool, Prompt, Resource): the optional `title` if provided, else the
 * machine `name`. Centralized so list items, detail panels, and screens stay
 * consistent.
 */
export function resolveDisplayLabel(name: string, title?: string): string {
  return title ?? name;
}

/**
 * True when the tool's input schema declares at least one property — used by
 * App-flow callers to decide whether to render a form or auto-launch. Kept in
 * one place so the definition of "has fields" stays consistent if it ever
 * grows to consider `additionalProperties`, `anyOf`, etc.
 */
export function hasInputFields(tool: Tool): boolean {
  return Object.keys(tool.inputSchema.properties ?? {}).length > 0;
}

/**
 * A tool's stable per-row identity in the Tools sidebar.
 *
 * A server may return the same tool name more than once, so the name alone
 * identifies neither a React child nor a selection: colliding keys let a
 * filtered-out row survive reconciliation (#1957), and a name-keyed selection
 * highlights both copies at once while the detail panel can only ever resolve
 * the first (#2001). The tool's position in the *unfiltered* list disambiguates
 * duplicates and stays stable while the search narrows, since it is captured
 * before filtering.
 *
 * This is a UI identity only — the wire identity is still `tool.name`, which is
 * what a `tools/call` must send.
 */
export function toolRowKey(name: string, sourceIndex: number): string {
  return `${sourceIndex}:${name}`;
}

/**
 * Resolves the tool a {@link toolRowKey} refers to, or `undefined` when the key
 * names no row in the current list (e.g. the list changed under a stale
 * selection). Compares computed keys rather than parsing the key, so the two
 * stay in lockstep if the format ever changes.
 */
export function findToolByRowKey(
  tools: Tool[],
  key: string | undefined,
): Tool | undefined {
  if (key === undefined) return undefined;
  return tools.find((tool, index) => toolRowKey(tool.name, index) === key);
}
