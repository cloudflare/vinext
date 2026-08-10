import { describe, expect, it } from "vite-plus/test";
import {
  alignBfcacheSegmentIdentitiesForResume,
  type BfcacheSegmentIdentityMap,
} from "../packages/vinext/src/server/app-bfcache-identity.js";

describe("fallback-shell BFCache replay identity", () => {
  it("maps a concrete page id to the fallback identity for the same route graph", () => {
    const fallback: BfcacheSegmentIdentityMap = {
      "page:/blog/[slug]": JSON.stringify([
        "page",
        "page:/blog/:slug",
        "root-boundary:/blog",
        '["blog","slug|%5Bslug%5D|d"]',
      ]),
    };
    const current: BfcacheSegmentIdentityMap = {
      "page:/blog/hello": JSON.stringify([
        "page",
        "page:/blog/:slug",
        "root-boundary:/blog",
        '["blog","slug|hello|d"]',
      ]),
    };

    expect(alignBfcacheSegmentIdentitiesForResume(current, fallback)).toEqual({
      "page:/blog/hello": fallback["page:/blog/[slug]"],
    });
  });

  it("keeps unmatched concrete identities unchanged", () => {
    const identity = JSON.stringify(["layout", "layout:/other", null, '["other"]']);
    expect(alignBfcacheSegmentIdentitiesForResume({ "layout:/other": identity }, {})).toEqual({
      "layout:/other": identity,
    });
  });
});
