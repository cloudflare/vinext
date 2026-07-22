import { describe, expect, it } from "vite-plus/test";
import {
  createAppRscStateFingerprint,
  type AppRscStateFingerprintInput,
} from "../packages/vinext/src/server/app-rsc-state-fingerprint.js";
import { ReadonlyURLSearchParams } from "../packages/vinext/src/shims/readonly-url-search-params.js";

function createState(pathname: string, search = ""): AppRscStateFingerprintInput {
  return {
    layoutIds: ["layout:/", "layout:/docs"],
    navigationSnapshot: {
      params: {},
      pathname,
      searchParams: new ReadonlyURLSearchParams(new URLSearchParams(search)),
    },
    rootLayoutTreePath: "layout:/",
    routeId: "page:/docs/[slug]",
    slotBindings: [],
  };
}

describe("createAppRscStateFingerprint", () => {
  it("is stable for the same visible router state", () => {
    expect(createAppRscStateFingerprint(createState("/docs/a", "tab=one"))).toBe(
      createAppRscStateFingerprint(createState("/docs/a", "tab=one")),
    );
  });

  it("varies with the visible pathname and search params", () => {
    const original = createAppRscStateFingerprint(createState("/docs/a", "tab=one"));
    expect(createAppRscStateFingerprint(createState("/docs/b", "tab=one"))).not.toBe(original);
    expect(createAppRscStateFingerprint(createState("/docs/a", "tab=two"))).not.toBe(original);
  });

  it("stays fixed-size for large valid router states", () => {
    const state = createState(`/${"nested/".repeat(500)}page`, `q=${"value".repeat(500)}`);
    state.layoutIds = Array.from({ length: 500 }, (_, index) => `layout:${index}`);

    expect(createAppRscStateFingerprint(state)).toMatch(/^[0-9a-f]{16}$/);
  });
});
