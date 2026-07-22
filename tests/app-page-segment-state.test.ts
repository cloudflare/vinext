import { describe, expect, it } from "vite-plus/test";
import {
  resolveAppPageLeafSegmentStateKey,
  resolveAppPageRouteStateKey,
  resolveAppPageSegmentStateKey,
} from "../packages/vinext/src/server/app-page-segment-state.js";

describe("app page segment state keys", () => {
  // Mirrors Next.js createRouterCacheKey(..., true): the React state key is
  // the active segment identity without search params, so search-only changes
  // do not reset templates or boundaries.
  it("resolves dynamic params into segment state keys without search params", () => {
    expect(
      resolveAppPageSegmentStateKey(["dashboard", "[team]", "settings"], 1, {
        team: "alpha",
      }),
    ).toBe("team|alpha|d");
  });

  it("skips route groups when selecting the state key below a tree position", () => {
    expect(
      resolveAppPageSegmentStateKey(["(marketing)", "blog", "[slug]"], 0, {
        slug: "launch",
      }),
    ).toBe("blog");
    expect(
      resolveAppPageSegmentStateKey(["(marketing)", "blog", "[slug]"], 1, {
        slug: "launch",
      }),
    ).toBe("blog");
    expect(
      resolveAppPageSegmentStateKey(["(marketing)", "blog", "[slug]"], 2, {
        slug: "launch",
      }),
    ).toBe("slug|launch|d");
  });

  it("keeps the leaf segment helper scoped to the active local segment", () => {
    expect(
      resolveAppPageLeafSegmentStateKey(["(marketing)", "blog", "[slug]"], {
        slug: "launch",
      }),
    ).toBe("slug|launch|d");
    expect(resolveAppPageLeafSegmentStateKey(["(marketing)"], {})).toBe("");
  });

  it("uses the full visible segment-state path for route-wide reset keys", () => {
    expect(
      resolveAppPageRouteStateKey(["(marketing)", "blog", "[slug]"], {
        slug: "launch",
      }),
    ).toBe(JSON.stringify(["blog", "slug|launch|d"]));

    expect(
      resolveAppPageRouteStateKey(["posts", "[id]"], {
        id: "123",
      }),
    ).not.toBe(
      resolveAppPageRouteStateKey(["photos", "[id]"], {
        id: "123",
      }),
    );

    expect(resolveAppPageRouteStateKey(["account", "settings"], {})).not.toBe(
      resolveAppPageRouteStateKey(["admin", "settings"], {}),
    );
  });

  it("keeps catch-all segment keys canonical", () => {
    expect(
      resolveAppPageSegmentStateKey(["docs", "[...parts]"], 1, {
        parts: ["guides", "routing"],
      }),
    ).toBe("parts|guides/routing|c");
    expect(
      resolveAppPageSegmentStateKey(["docs", "[[...parts]]"], 1, {
        parts: [],
      }),
    ).toBe("parts||oc");
  });
});
