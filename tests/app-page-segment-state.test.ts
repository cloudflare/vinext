import { describe, expect, it } from "vite-plus/test";
import {
  resolveAppPageLeafSegmentStateKey,
  resolveAppPagePatternStateKey,
  resolveAppPageRouteStateKey,
  resolveAppPageSegmentStateKey,
  resolveAppPageTemplateStateKey,
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

  it("canonicalizes interception pattern params with their full target path", () => {
    expect(
      resolveAppPagePatternStateKey([":lang", "photo", ":id"], {
        lang: "en",
        id: "42",
      }),
    ).toBe(JSON.stringify(["lang|en|d", "photo", "id|42|d"]));
    expect(
      resolveAppPagePatternStateKey(["docs", ":parts+"], {
        parts: ["guides", "routing"],
      }),
    ).toBe(JSON.stringify(["docs", "parts|guides/routing|c"]));
    expect(resolveAppPagePatternStateKey(["docs", ":parts*"], {})).toBe(
      JSON.stringify(["docs", "parts||oc"]),
    );
  });

  it("uses the owning dynamic segment for leaf templates", () => {
    expect(resolveAppPageTemplateStateKey(["docs", "[slug]"], 1, { slug: "launch" })).toBe(
      JSON.stringify(["docs", "slug|launch|d"]),
    );
    expect(resolveAppPageTemplateStateKey(["docs", "[slug]"], 2, { slug: "launch" })).toBe(
      JSON.stringify(["docs", "slug|launch|d"]),
    );
  });

  it("includes dynamic ancestors in non-leaf template state", () => {
    expect(resolveAppPageTemplateStateKey(["[tenant]", "settings"], 1, { tenant: "a" })).toBe(
      JSON.stringify(["tenant|a|d", "settings"]),
    );
    expect(resolveAppPageTemplateStateKey(["[tenant]", "settings"], 1, { tenant: "b" })).toBe(
      JSON.stringify(["tenant|b|d", "settings"]),
    );
    expect(
      resolveAppPageTemplateStateKey(["[tenant]", "(group)", "settings"], 1, {
        tenant: "a",
      }),
    ).toBe(JSON.stringify(["tenant|a|d", "(group)"]));
    expect(resolveAppPageTemplateStateKey(["(stable)", "[id]"], 0, { id: "a" })).toBe(
      JSON.stringify(["(stable)"]),
    );
  });
});
