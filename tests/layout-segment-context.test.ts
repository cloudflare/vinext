import { describe, expect, it } from "vite-plus/test";
import { mergeLayoutSegmentMap } from "../packages/vinext/src/shims/layout-segment-context.js";

describe("layout segment context", () => {
  it("preserves omitted named-slot segments while replacing explicit keys", () => {
    const previous = {
      children: [],
      auth: ["login"],
      nav: ["login"],
    };

    expect(
      mergeLayoutSegmentMap(previous, {
        children: [],
        auth: ["reset"],
      }),
    ).toEqual({
      children: [],
      auth: ["reset"],
      nav: ["login"],
    });
  });
});
