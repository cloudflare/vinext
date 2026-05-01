import { describe, expect, it } from "vite-plus/test";
import {
  fillRoutePatternSegments,
  matchRoutePattern,
  routePattern,
  routePatternParts,
} from "../packages/vinext/src/routing/route-pattern.js";

describe("route pattern helpers", () => {
  it("normalizes app route segments into vinext pattern parts", () => {
    expect(routePatternParts("/docs/[section]/[[...slug]]/icon")).toEqual([
      "docs",
      ":section",
      ":slug*",
      "icon",
    ]);
    expect(routePattern("/shop/[...slug]/opengraph-image")).toBe("/shop/:slug+/opengraph-image");
    expect(routePattern("/")).toBe("");
  });

  it("fills dynamic route segments from params and rejects incomplete paths", () => {
    expect(
      fillRoutePatternSegments("/docs/[section]/[[...slug]]/icon", {
        section: "api",
      }),
    ).toBe("/docs/api/icon");
    expect(
      fillRoutePatternSegments("/docs/[section]/[[...slug]]/icon", {
        section: "api",
        slug: ["routing", "metadata"],
      }),
    ).toBe("/docs/api/routing/metadata/icon");
    expect(fillRoutePatternSegments("/docs/[...slug]/icon", {})).toBeNull();
    expect(fillRoutePatternSegments("/docs/[section]/icon", { section: ["a", "b"] })).toBeNull();
  });

  it("matches dynamic pattern parts with catch-all segments before suffixes", () => {
    expect(
      matchRoutePattern(
        ["metadata-multi-catchall", "a", "b", "icon"],
        ["metadata-multi-catchall", ":slug+", "icon"],
      ),
    ).toEqual({ slug: ["a", "b"] });
    expect(matchRoutePattern(["shop"], ["shop", ":slug*"])).toEqual({});
    expect(
      matchRoutePattern(
        ["metadata-multi-catchall", "icon"],
        ["metadata-multi-catchall", ":slug+", "icon"],
      ),
    ).toBeNull();
  });

  it("treats literal route segments ending in pattern markers as literals", () => {
    expect(matchRoutePattern(["docs+", "icon"], ["docs+", "icon"])).toEqual({});
    expect(matchRoutePattern(["docs", "icon"], ["docs+", "icon"])).toBeNull();
  });
});
