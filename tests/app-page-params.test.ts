import { describe, expect, it } from "vite-plus/test";
import {
  resolveAppPageBranchParams,
  resolveAppPageSegmentParamScopeKeys,
  resolveAppPageSegmentParams,
} from "../packages/vinext/src/server/app-page-params.js";

describe("app page params helpers", () => {
  it("passes only params that apply to each layout", () => {
    // Ported from Next.js: test/e2e/app-dir/layout-params/layout-params.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/layout-params/layout-params.test.ts
    const routeSegments = ["base", "[param1]", "[param2]"];
    const matchedParams = { param1: "something", param2: "another" };

    expect(resolveAppPageSegmentParams(routeSegments, 0, matchedParams)).toEqual({});
    expect(resolveAppPageSegmentParams(routeSegments, 1, matchedParams)).toEqual({});
    expect(resolveAppPageSegmentParams(routeSegments, 2, matchedParams)).toEqual({
      param1: "something",
    });
    expect(resolveAppPageSegmentParams(routeSegments, 3, matchedParams)).toEqual({
      param1: "something",
      param2: "another",
    });
  });

  it("scopes catch-all params to the catch-all layout", () => {
    // Ported from Next.js: test/e2e/app-dir/layout-params/layout-params.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/layout-params/layout-params.test.ts
    const routeSegments = ["catchall", "[...params]"];
    const matchedParams = { params: ["something", "another"] };

    expect(resolveAppPageSegmentParams(routeSegments, 1, matchedParams)).toEqual({});
    expect(resolveAppPageSegmentParams(routeSegments, 2, matchedParams)).toEqual({
      params: ["something", "another"],
    });
  });

  it("omits empty optional catch-all params from layouts", () => {
    // Ported from Next.js: test/e2e/app-dir/layout-params/layout-params.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/layout-params/layout-params.test.ts
    const routeSegments = ["optional-catchall", "[[...params]]"];

    expect(resolveAppPageSegmentParams(routeSegments, 1, { params: [] })).toEqual({});
    expect(resolveAppPageSegmentParams(routeSegments, 2, { params: [] })).toEqual({});
    expect(
      resolveAppPageSegmentParams(routeSegments, 2, { params: ["something", "another"] }),
    ).toEqual({
      params: ["something", "another"],
    });
  });

  it("keeps optional catch-all names in structural layout param scope", () => {
    const routeSegments = ["docs", "[[...slug]]"];

    expect(resolveAppPageSegmentParams(routeSegments, 2, { slug: [] })).toEqual({});
    expect(resolveAppPageSegmentParamScopeKeys(routeSegments, 2)).toEqual(["slug"]);
  });

  it("preserves ancestor params while scoping parallel branch params", () => {
    expect(
      resolveAppPageBranchParams(
        ["photos", "[photo]", "[comment]"],
        2,
        { locale: "en", photo: "42", comment: "7" },
        ["photos", "[photo]"],
      ),
    ).toEqual({ locale: "en", photo: "42" });
  });

  it("uses canonical segment parsing for branch-local param names", () => {
    expect(resolveAppPageBranchParams(["[invalid.name]"], 0, { "invalid.name": "outer" })).toEqual({
      "invalid.name": "outer",
    });
  });
});
