import { describe, it, expect } from "vitest";
import type { InspectorServerSettings } from "@inspector/core/mcp/types.js";
import { buildHeaderSettingsPatch } from "./serverSettingsPatch";

const EMPTY: InspectorServerSettings = {
  headers: [],
  env: [],
  metadata: [],
  connectionTimeout: 0,
  requestTimeout: 0,
  taskTtl: 60000,
  autoRefreshOnListChanged: false,
  paginatedLists: false,
  maxFetchRequests: 1000,
  roots: [],
};

// A server carrying settings the modal never shows — the fields an edit must
// preserve and a clone must not copy.
const POPULATED: InspectorServerSettings = {
  ...EMPTY,
  headers: [{ key: "X-Old", value: "1" }],
  metadata: [{ key: "trace", value: "abc" }],
  connectionTimeout: 5000,
  oauthClientId: "cid",
  oauthClientSecret: "shhh",
  roots: [{ uri: "file:///project", name: "Project" }],
};

const NEW_HEADERS = [{ key: "Cookie", value: "branch=x" }];

describe("buildHeaderSettingsPatch", () => {
  it("sends nothing when there are no headers on either side", () => {
    expect(
      buildHeaderSettingsPatch("add", undefined, [], EMPTY),
    ).toBeUndefined();
    expect(buildHeaderSettingsPatch("edit", EMPTY, [], EMPTY)).toBeUndefined();
  });

  it("carries the target's other settings forward on an edit", () => {
    const patch = buildHeaderSettingsPatch(
      "edit",
      POPULATED,
      NEW_HEADERS,
      EMPTY,
    );
    expect(patch).toEqual({ ...POPULATED, headers: NEW_HEADERS });
    // The node is replaced wholesale, so the fields the modal doesn't show
    // have to travel with it.
    expect(patch?.metadata).toEqual([{ key: "trace", value: "abc" }]);
    expect(patch?.oauthClientSecret).toBe("shhh");
    expect(patch?.connectionTimeout).toBe(5000);
  });

  it("still sends on an edit that clears the last header", () => {
    expect(buildHeaderSettingsPatch("edit", POPULATED, [], EMPTY)).toEqual({
      ...POPULATED,
      headers: [],
    });
  });

  it("does not copy the source server's settings on a clone", () => {
    // The regression this guards: `configModalTarget` in clone mode is the
    // SOURCE entry, so spreading it put that server's OAuth client secret on a
    // brand-new one.
    const patch = buildHeaderSettingsPatch(
      "clone",
      POPULATED,
      NEW_HEADERS,
      EMPTY,
    );
    expect(patch).toEqual({ ...EMPTY, headers: NEW_HEADERS });
    expect(patch?.oauthClientSecret).toBeUndefined();
    expect(patch?.oauthClientId).toBeUndefined();
    expect(patch?.metadata).toEqual([]);
    expect(patch?.roots).toEqual([]);
    expect(patch?.connectionTimeout).toBe(0);
  });

  it("builds from the empty shape on an add", () => {
    expect(
      buildHeaderSettingsPatch("add", undefined, NEW_HEADERS, EMPTY),
    ).toEqual({ ...EMPTY, headers: NEW_HEADERS });
  });

  it("ignores a stale target on a clone with no headers", () => {
    // A clone of a server that HAS headers, submitted with none: nothing about
    // the new entry needs a settings node.
    expect(
      buildHeaderSettingsPatch("clone", POPULATED, [], EMPTY),
    ).toBeUndefined();
  });
});
