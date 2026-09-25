import { describe, expect, it } from "vite-plus/test";
import {
  collectAppPageStaticGenerationRuntimes,
  collectAppPageStaticParamsWalkSegments,
  hasAppPageAnyGenerateStaticParams,
  hasAppPageGenerateStaticParamsAtLastDynamicSegment,
  isAppPageInterceptAttached,
  isAppPageStaticEligible,
  isEdgeRuntime,
  lastDynamicSegmentHasGenerateStaticParams,
  resolveAppPageDynamicConfig,
  resolveAppPageFetchCacheMode,
  resolveAppPageInterceptSegmentConfig,
  resolveAppPageInterceptTree,
  resolveAppPageSegmentConfig,
  resolveAppPageStaticGenerationRuntime,
  resolveAppRouteHandlerFetchCacheMode,
} from "../packages/vinext/src/server/app-segment-config.js";

describe("resolveAppPageSegmentConfig", () => {
  it("resolves the dynamic mode shared by build-time discovery and rendering", () => {
    // Next.js applies these values while walking the component tree, where the
    // nested-most main-chain config wins and force-dynamic remains sticky.
    // https://github.com/vercel/next.js/blob/canary/packages/next/src/server/app-render/create-component-tree.tsx
    expect(
      resolveAppPageDynamicConfig({
        layouts: [{ dynamic: "force-static" }],
        page: { dynamic: "auto" },
      }),
    ).toBe("auto");
    expect(
      resolveAppPageDynamicConfig({
        page: { dynamic: "auto" },
        parallelSegments: [{ dynamic: "force-static" }, { dynamic: "force-dynamic" }],
      }),
    ).toBe("force-dynamic");
  });

  it("returns defaults when no segment config is present", () => {
    expect(resolveAppPageSegmentConfig({})).toEqual({
      revalidateSeconds: null,
    });
  });

  it("merges route segment config from layouts and the page", () => {
    expect(
      resolveAppPageSegmentConfig({
        layouts: [
          { revalidate: 120, dynamicParams: false, fetchCache: "default-cache" },
          { dynamic: "error", revalidate: 60 },
        ],
        page: { dynamic: "force-static", revalidate: 300 },
      }),
    ).toEqual({
      dynamicConfig: "force-static",
      dynamicParamsConfig: false,
      fetchCache: "default-cache",
      revalidateSeconds: 60,
    });
  });

  it("treats force-dynamic from any effective segment as revalidate zero", () => {
    expect(
      resolveAppPageSegmentConfig({
        layouts: [{ revalidate: 60 }],
        page: { dynamic: "force-dynamic" },
      }),
    ).toEqual({
      dynamicConfig: "force-dynamic",
      revalidateSeconds: 0,
    });
  });

  it("keeps ancestor force-dynamic sticky across child dynamic overrides", () => {
    // Next.js create-component-tree.tsx sets workStore.forceDynamic and never
    // clears it when a deeper segment selects auto/error/force-static.
    for (const childDynamic of ["auto", "error", "force-static"] as const) {
      expect(
        resolveAppPageSegmentConfig({
          layouts: [{ dynamic: "force-dynamic" }],
          page: { dynamic: childDynamic },
        }),
      ).toEqual({
        dynamicConfig: "force-dynamic",
        revalidateSeconds: 0,
      });
    }
  });

  it("derives fetchCache from static-only dynamic modes", () => {
    expect(
      resolveAppPageSegmentConfig({
        layouts: [{ dynamic: "error" }],
        page: {},
      }),
    ).toEqual({
      dynamicConfig: "error",
      fetchCache: "only-cache",
      revalidateSeconds: null,
    });
  });

  it("lets explicit fetchCache override the dynamic mode default", () => {
    expect(
      resolveAppPageSegmentConfig({
        layouts: [{ dynamic: "error" }],
        page: { fetchCache: "default-cache" },
      }),
    ).toEqual({
      dynamicConfig: "error",
      fetchCache: "default-cache",
      revalidateSeconds: null,
    });
  });

  it("resolves fetchCache force modes with route-level precedence", () => {
    expect(
      resolveAppPageSegmentConfig({
        layouts: [{ fetchCache: "only-cache" }],
        page: { fetchCache: "force-cache" },
      }).fetchCache,
    ).toBe("force-cache");

    expect(
      resolveAppPageSegmentConfig({
        layouts: [{ fetchCache: "force-no-store" }],
        page: { fetchCache: "only-no-store" },
      }).fetchCache,
    ).toBe("force-no-store");
  });

  it("rejects incompatible cross-segment fetchCache modes", () => {
    expect(() =>
      resolveAppPageSegmentConfig({
        layouts: [{ fetchCache: "only-cache" }],
        page: { fetchCache: "only-no-store" },
      }),
    ).toThrow(/incompatible fetchCache/);

    expect(() =>
      resolveAppPageSegmentConfig({
        layouts: [{ fetchCache: "force-cache" }],
        page: { fetchCache: "force-no-store" },
      }),
    ).toThrow(/incompatible fetchCache/);

    expect(() =>
      resolveAppPageSegmentConfig({
        layouts: [{ fetchCache: "default-no-store" }],
        page: { fetchCache: "auto" },
      }),
    ).toThrow(/incompatible fetchCache/);
  });

  it("ignores unknown dynamic values", () => {
    expect(
      resolveAppPageSegmentConfig({
        layouts: [{ dynamic: "sometimes" }],
        page: { dynamic: "force-static" },
      }),
    ).toEqual({
      dynamicConfig: "force-static",
      revalidateSeconds: null,
    });
  });

  it("keeps implicit dynamicParams separate from static render modes", () => {
    expect(
      resolveAppPageSegmentConfig({
        layouts: [{ dynamic: "error" }],
        page: {},
      }),
    ).toEqual({
      dynamicConfig: "error",
      fetchCache: "only-cache",
      revalidateSeconds: null,
    });

    expect(
      resolveAppPageSegmentConfig({
        layouts: [{ dynamic: "force-static" }],
        page: {},
      }),
    ).toEqual({
      dynamicConfig: "force-static",
      revalidateSeconds: null,
    });
  });

  it("lets explicit dynamicParams override static-only dynamic defaults", () => {
    expect(
      resolveAppPageSegmentConfig({
        layouts: [{ dynamic: "error" }],
        page: { dynamicParams: true },
      }),
    ).toEqual({
      dynamicConfig: "error",
      dynamicParamsConfig: true,
      fetchCache: "only-cache",
      revalidateSeconds: null,
    });
  });

  it("uses the child route runtime when segment runtimes differ", () => {
    expect(
      resolveAppPageSegmentConfig({
        layouts: [{ runtime: "edge" }],
        page: { runtime: "nodejs" },
      }).runtime,
    ).toBe("nodejs");
  });

  it("ignores unknown runtime values", () => {
    expect(
      resolveAppPageSegmentConfig({
        layouts: [{ runtime: "bun" }],
        page: {},
      }),
    ).toEqual({
      revalidateSeconds: null,
    });
  });

  it("keeps explicit dynamicParams false sticky across child segments", () => {
    expect(
      resolveAppPageSegmentConfig({
        layouts: [{ dynamicParams: false }],
        page: { dynamicParams: true },
      }),
    ).toEqual({
      dynamicParamsConfig: false,
      revalidateSeconds: null,
    });
  });

  it("allows an ungenerated dynamic child below an ancestor dynamicParams=false segment", () => {
    expect(
      resolveAppPageSegmentConfig({
        layouts: [{ dynamicParams: false, generateStaticParams() {} }, {}],
        layoutTreePositions: [1, 2],
        page: {},
        routeSegments: ["[locale]", "no-gsp", "stories", "[slug]"],
      }).dynamicParamsConfig,
    ).toBeUndefined();
  });

  it("enforces ancestor dynamicParams=false when the dynamic child generates params", () => {
    expect(
      resolveAppPageSegmentConfig({
        layouts: [{ dynamicParams: false, generateStaticParams() {} }, {}],
        layoutTreePositions: [1, 2],
        page: { generateStaticParams() {} },
        routeSegments: ["[locale]", "gsp", "stories", "[slug]"],
      }).dynamicParamsConfig,
    ).toBe(false);
  });

  it("ignores route groups when assigning layout config to a dynamic segment", () => {
    expect(
      resolveAppPageSegmentConfig({
        layouts: [{}, { dynamicParams: false, generateStaticParams: () => [{ region: "SE" }] }],
        layoutTreePositions: [0, 2],
        page: { dynamic: "force-dynamic" },
        routeSegments: ["[region]", "(default)", "static-prefetch"],
      }),
    ).toEqual({
      dynamicConfig: "force-dynamic",
      dynamicParamsConfig: false,
      revalidateSeconds: 0,
    });
  });

  it("resolves revalidate = false as Infinity (cache indefinitely)", () => {
    expect(
      resolveAppPageSegmentConfig({
        page: { revalidate: false },
      }),
    ).toEqual({
      revalidateSeconds: Infinity,
    });
  });

  it("resolves shortest-wins: finite revalidate beats false (Infinity)", () => {
    expect(
      resolveAppPageSegmentConfig({
        layouts: [{ revalidate: 60 }],
        page: { revalidate: false },
      }).revalidateSeconds,
    ).toBe(60);
  });

  it("resolves shortest-wins: false (Infinity) loses to any finite value", () => {
    expect(
      resolveAppPageSegmentConfig({
        layouts: [{ revalidate: false }],
        page: { revalidate: 60 },
      }).revalidateSeconds,
    ).toBe(60);
  });

  it("reads unstable_dynamicStaleTime only from page modules", () => {
    // Ported from Next.js: test/e2e/app-dir/segment-cache/staleness/segment-cache-per-page-dynamic-stale-time.test.ts
    // See also: packages/next/src/server/app-render/app-render.tsx#getDynamicStaleTime
    expect(
      resolveAppPageSegmentConfig({
        layouts: [{ unstable_dynamicStaleTime: 5 }],
        page: { unstable_dynamicStaleTime: 60 },
      }),
    ).toEqual({
      dynamicStaleTimeSeconds: 60,
      revalidateSeconds: null,
    });
  });

  it("uses the shortest unstable_dynamicStaleTime across active page slots", () => {
    // Ported from Next.js: test/e2e/app-dir/segment-cache/staleness/segment-cache-per-page-dynamic-stale-time.test.ts
    expect(
      resolveAppPageSegmentConfig({
        page: { unstable_dynamicStaleTime: 60 },
        parallelPages: [
          { unstable_dynamicStaleTime: 15 },
          { unstable_dynamicStaleTime: 30 },
          { unstable_dynamicStaleTime: "not-a-number" },
        ],
      }),
    ).toEqual({
      dynamicStaleTimeSeconds: 15,
      revalidateSeconds: null,
    });
  });

  it("includes active parallel route segments in effective route config", () => {
    // Ported from Next.js: packages/next/src/build/segment-config/app/app-segments.ts
    // collectAppPageSegments() breadth-first traverses every parallel route before reduceAppConfig().
    expect(
      resolveAppPageSegmentConfig({
        layouts: [{ revalidate: 300 }],
        page: { dynamic: "auto", runtime: "nodejs" },
        parallelSegments: [
          { fetchCache: "only-cache", revalidate: 60, runtime: "edge" },
          { dynamic: "force-dynamic", revalidate: 120 },
        ],
      }),
    ).toEqual({
      dynamicConfig: "force-dynamic",
      fetchCache: "only-cache",
      revalidateSeconds: 0,
      runtime: "nodejs",
    });
  });

  it("keeps dynamicParams=false active when a parallel layout generates the leaf param", () => {
    expect(
      resolveAppPageSegmentConfig({
        layouts: [{ dynamicParams: false, generateStaticParams: () => [{ locale: "en" }] }],
        layoutTreePositions: [1],
        parallelBranches: [
          {
            configLayouts: [{ generateStaticParams: () => [{ slug: "static-123" }] }],
            configLayoutTreePositions: [2],
            routeSegments: ["stories", "[slug]"],
          },
        ],
        routeSegments: ["[locale]", "gsp", "stories", "[slug]"],
      }).dynamicParamsConfig,
    ).toBe(false);
  });

  it("ignores parallel generateStaticParams owned by a parent dynamic segment", () => {
    expect(
      resolveAppPageSegmentConfig({
        layouts: [{ dynamicParams: false, generateStaticParams: () => [{ locale: "en" }] }],
        layoutTreePositions: [1],
        parallelBranches: [
          {
            configLayouts: [{ generateStaticParams: () => [{ locale: "en" }] }],
            configLayoutTreePositions: [1],
            routeSegments: ["[locale]", "no-gsp", "stories", "[slug]"],
          },
        ],
        routeSegments: ["[locale]", "no-gsp", "stories", "[slug]"],
      }).dynamicParamsConfig,
    ).toBeUndefined();
  });

  it("ignores parallel dynamicParams=false owned by a parent dynamic segment", () => {
    expect(
      resolveAppPageSegmentConfig({
        parallelBranches: [
          {
            configLayouts: [{ dynamicParams: false }],
            configLayoutTreePositions: [1],
            routeSegments: ["[locale]", "no-gsp", "stories", "[slug]"],
          },
        ],
        routeSegments: ["[locale]", "no-gsp", "stories", "[slug]"],
      }).dynamicParamsConfig,
    ).toBeUndefined();
  });

  it("enforces parallel dynamicParams=false owned by the leaf dynamic segment", () => {
    expect(
      resolveAppPageSegmentConfig({
        parallelBranches: [
          {
            configLayouts: [{ dynamicParams: false }],
            configLayoutTreePositions: [2],
            routeSegments: ["stories", "[slug]"],
          },
        ],
        routeSegments: ["[locale]", "no-gsp", "stories", "[slug]"],
      }).dynamicParamsConfig,
    ).toBe(false);
  });

  it("uses slot-only route config values", () => {
    // Next.js collectAppPageSegments() includes parallel route layouts/pages
    // before reduceAppConfig() selects the route-level config.
    expect(
      resolveAppPageSegmentConfig({
        parallelSegments: [
          {
            dynamic: "error",
            dynamicParams: false,
            fetchCache: "default-cache",
            runtime: "edge",
          },
        ],
      }),
    ).toEqual({
      dynamicConfig: "error",
      dynamicParamsConfig: false,
      fetchCache: "default-cache",
      revalidateSeconds: null,
      runtime: "edge",
    });
  });

  it("does not invent last-wins ordering for ambiguous parallel branch configs", () => {
    expect(
      resolveAppPageSegmentConfig({
        page: { dynamic: "error", runtime: "nodejs" },
        parallelSegments: [{ dynamic: "force-static", runtime: "edge" }],
      }),
    ).toEqual({
      dynamicConfig: "error",
      fetchCache: "only-cache",
      revalidateSeconds: null,
      runtime: "nodejs",
    });

    expect(
      resolveAppPageSegmentConfig({
        page: { fetchCache: "default-cache" },
        parallelSegments: [{ fetchCache: "default-no-store" }],
      }).fetchCache,
    ).toBe("default-cache");
  });

  it("rejects fetchCache conflicts from active parallel route segments", () => {
    expect(() =>
      resolveAppPageSegmentConfig({
        page: { fetchCache: "only-cache" },
        parallelSegments: [{ fetchCache: "only-no-store" }],
      }),
    ).toThrow(/incompatible fetchCache/);
  });

  it("lets force fetchCache modes override opposing only modes", () => {
    expect(
      resolveAppPageSegmentConfig({
        layouts: [{ fetchCache: "only-cache" }],
        page: { fetchCache: "force-no-store" },
      }).fetchCache,
    ).toBe("force-no-store");
    expect(
      resolveAppPageSegmentConfig({
        page: { fetchCache: "only-no-store" },
        parallelSegments: [{ fetchCache: "force-cache" }],
      }).fetchCache,
    ).toBe("force-cache");
  });

  it("resolves just the fetchCache mode for route-specific render scopes", () => {
    expect(
      resolveAppPageFetchCacheMode({
        layouts: [{ fetchCache: "only-cache" }],
        page: {},
      }),
    ).toBe("only-cache");

    expect(
      resolveAppPageFetchCacheMode({
        layouts: [{ revalidate: 60 }],
        page: {},
      }),
    ).toBeNull();
  });

  it("captures the runtime export and lets child segments override parents", () => {
    expect(
      resolveAppPageSegmentConfig({
        layouts: [{ runtime: "nodejs" }],
        page: { runtime: "edge" },
      }).runtime,
    ).toBe("edge");

    expect(
      resolveAppPageSegmentConfig({
        layouts: [{ runtime: "edge" }],
        page: {},
      }).runtime,
    ).toBe("edge");

    expect(resolveAppPageSegmentConfig({ page: {} }).runtime).toBeUndefined();
  });
});

describe("resolveAppRouteHandlerFetchCacheMode", () => {
  it("returns the handler module's fetchCache export when valid", () => {
    expect(resolveAppRouteHandlerFetchCacheMode({ fetchCache: "force-cache" })).toBe("force-cache");
    expect(resolveAppRouteHandlerFetchCacheMode({ fetchCache: "default-no-store" })).toBe(
      "default-no-store",
    );
  });

  it("returns null for missing or invalid fetchCache values", () => {
    expect(resolveAppRouteHandlerFetchCacheMode({})).toBeNull();
    expect(resolveAppRouteHandlerFetchCacheMode({ fetchCache: "bogus" })).toBeNull();
    expect(resolveAppRouteHandlerFetchCacheMode({ fetchCache: 42 })).toBeNull();
  });
});

describe("isEdgeRuntime", () => {
  it("matches Next.js' edge-runtime values", () => {
    expect(isEdgeRuntime("edge")).toBe(true);
    expect(isEdgeRuntime("experimental-edge")).toBe(true);
    expect(isEdgeRuntime("nodejs")).toBe(false);
    expect(isEdgeRuntime(undefined)).toBe(false);
  });
});

describe("resolveAppPageStaticGenerationRuntime", () => {
  // Next.js reads runtime from the page and its parent layouts, the page
  // winning, then the nearest layout.
  // https://github.com/vercel/next.js/blob/v16.2.6/packages/next/src/build/get-static-info-including-layouts.ts
  it("lets the page win, then the nearest layout", () => {
    expect(resolveAppPageStaticGenerationRuntime(["nodejs", "edge", undefined])).toBe("edge");
    expect(resolveAppPageStaticGenerationRuntime(["edge", undefined, "nodejs"])).toBe("nodejs");
    expect(resolveAppPageStaticGenerationRuntime(["edge", "bogus"])).toBe("edge");
    expect(resolveAppPageStaticGenerationRuntime([undefined, undefined])).toBeUndefined();
  });
});

describe("collectAppPageStaticGenerationRuntimes", () => {
  const resolve = (options: Parameters<typeof collectAppPageStaticGenerationRuntimes>[0]) =>
    resolveAppPageStaticGenerationRuntime(collectAppPageStaticGenerationRuntimes(options));

  it("reads the page and its layouts", () => {
    expect(
      resolve({
        layouts: [{ runtime: "edge" }, {}],
        layoutTreePositions: [0, 1],
        page: {},
        routeSegments: ["blog"],
      }),
    ).toBe("edge");
    expect(
      resolve({
        layouts: [{ runtime: "edge" }, {}],
        layoutTreePositions: [0, 1],
        page: { runtime: "nodejs" },
        routeSegments: ["blog"],
      }),
    ).toBe("nodejs");
  });

  it("merges a slot page's runtime into a route with its own page", () => {
    // app/page.tsx and app/@panel/page.tsx exporting runtime = "edge": Next.js
    // merges every parallel branch, so / is edge.
    expect(
      resolve({
        childrenSlot: { ownerTreePath: "/", state: "active" },
        layouts: [{}],
        layoutTreePositions: [0],
        page: {},
        parallelBranches: [
          { name: "panel", ownerTreePosition: 0, page: { runtime: "edge" }, routeSegments: [] },
        ],
        routeSegments: [],
      }),
    ).toBe("edge");
  });

  it("merges a slot's default module runtime", () => {
    // app/@panel/default.tsx exports runtime = "edge".
    expect(
      resolve({
        layouts: [{}],
        layoutTreePositions: [0],
        page: {},
        parallelBranches: [
          { isDefault: true, name: "panel", ownerTreePosition: 0, page: { runtime: "edge" } },
        ],
        routeSegments: [],
      }),
    ).toBe("edge");
  });

  it("reads the slot page of a route that only a slot page materializes", () => {
    // app/@feed/foo/page.tsx with no app/foo/page.tsx: children renders the
    // root default, and the slot page supplies the runtime.
    expect(
      resolve({
        childrenSlot: { ownerTreePath: "/", state: "default" },
        layouts: [{ runtime: "nodejs" }],
        layoutTreePositions: [0],
        page: {},
        parallelBranches: [
          {
            configLayouts: [{ runtime: "nodejs" }],
            configLayoutTreePositions: [1],
            layout: {},
            name: "feed",
            ownerTreePosition: 0,
            page: { runtime: "edge" },
            routeSegments: ["foo"],
          },
        ],
        routeSegments: ["foo"],
      }),
    ).toBe("edge");
  });

  it("makes the route edge when any sibling slot page is edge", () => {
    // app/@alpha/page.tsx (Node) and app/@zeta/page.tsx (edge) with no
    // app/page.tsx: / is edge even though @alpha sorts first.
    expect(
      resolve({
        childrenSlot: { ownerTreePath: "/", state: "default" },
        layouts: [{}],
        layoutTreePositions: [0],
        page: null,
        parallelBranches: [
          { name: "alpha", ownerTreePosition: 0, page: {}, routeSegments: [] },
          { name: "zeta", ownerTreePosition: 0, page: { runtime: "edge" }, routeSegments: [] },
        ],
        routeSegments: [],
      }),
    ).toBe("edge");
  });

  it("lets a branch's runtime win over an enclosing layout's", () => {
    // app/layout.tsx sets runtime = "edge" and app/@alpha/page.tsx sets
    // "nodejs": the merged branch value is set, so the root layout doesn't
    // override it.
    expect(
      resolve({
        childrenSlot: { ownerTreePath: "/", state: "default" },
        layouts: [{ runtime: "edge" }],
        layoutTreePositions: [0],
        page: null,
        parallelBranches: [
          { name: "alpha", ownerTreePosition: 0, page: { runtime: "nodejs" }, routeSegments: [] },
          { name: "zeta", ownerTreePosition: 0, page: {}, routeSegments: [] },
        ],
        routeSegments: [],
      }),
    ).toBe("nodejs");
  });

  it("reads the main-branch layouts of a page-less route", () => {
    // app/layout.tsx sets runtime = "edge", app/dashboard/layout.tsx sets
    // "nodejs", app/dashboard/@panel/default.tsx makes /dashboard a route, and
    // app/@feed/dashboard/page.tsx matches it. The dashboard layout is in the
    // children branch, whose value the root layout doesn't override.
    expect(
      resolve({
        layouts: [{ runtime: "edge" }, { runtime: "nodejs" }],
        layoutTreePositions: [0, 1],
        page: null,
        parallelBranches: [
          {
            layout: {},
            name: "feed",
            ownerTreePosition: 0,
            page: {},
            routeSegments: ["dashboard"],
          },
          { isDefault: true, name: "panel", ownerTreePosition: 1, page: {} },
        ],
        routeSegments: ["dashboard"],
      }),
    ).toBe("nodejs");
  });

  it("stops the main branch at the folder whose default children renders", () => {
    // app/dashboard/layout.tsx sets runtime = "edge", app/dashboard/settings/
    // layout.tsx sets "nodejs", and app/dashboard/@feed/settings/page.tsx
    // materializes /dashboard/settings. Children renders the dashboard default,
    // so the settings layout isn't in the tree.
    expect(
      resolve({
        childrenSlot: { ownerTreePath: "/dashboard", state: "default" },
        layouts: [{}, { runtime: "edge" }, { runtime: "nodejs" }],
        layoutTreePositions: [0, 1, 2],
        page: {},
        parallelBranches: [
          { name: "feed", ownerTreePosition: 1, page: {}, routeSegments: ["settings"] },
        ],
        routeSegments: ["dashboard", "settings"],
      }),
    ).toBe("edge");
  });
});

describe("hasAppPageGenerateStaticParamsAtLastDynamicSegment", () => {
  const generateStaticParams = () => [];

  it("counts generateStaticParams on the page below the last dynamic segment", () => {
    // app/[slug]/page.tsx
    expect(
      hasAppPageGenerateStaticParamsAtLastDynamicSegment({
        layouts: [{}],
        layoutTreePositions: [0],
        page: { generateStaticParams },
        routeSegments: ["[slug]"],
      }),
    ).toBe(true);
    // app/[locale]/about/page.tsx
    expect(
      hasAppPageGenerateStaticParamsAtLastDynamicSegment({
        layouts: [{}],
        layoutTreePositions: [0],
        page: { generateStaticParams },
        routeSegments: ["[locale]", "about"],
      }),
    ).toBe(true);
  });

  it("counts the last dynamic segment's layout and deeper layouts", () => {
    // app/[slug]/layout.tsx exports it, app/[slug]/details/page.tsx does not.
    expect(
      hasAppPageGenerateStaticParamsAtLastDynamicSegment({
        layouts: [{}, { generateStaticParams }],
        layoutTreePositions: [0, 1],
        page: {},
        routeSegments: ["[slug]", "details"],
      }),
    ).toBe(true);
    // app/[slug]/(group)/layout.tsx
    expect(
      hasAppPageGenerateStaticParamsAtLastDynamicSegment({
        layouts: [{}, { generateStaticParams }],
        layoutTreePositions: [0, 2],
        page: {},
        routeSegments: ["[slug]", "(group)"],
      }),
    ).toBe(true);
  });

  it("does not count generateStaticParams above the last dynamic segment", () => {
    // app/[a]/layout.tsx exports it; app/[a]/[b]/page.tsx does not (Next.js: ƒ).
    expect(
      hasAppPageGenerateStaticParamsAtLastDynamicSegment({
        layouts: [{}, { generateStaticParams }],
        layoutTreePositions: [0, 1],
        page: {},
        routeSegments: ["[a]", "[b]"],
      }),
    ).toBe(false);
    // The root layout's generateStaticParams sits above every dynamic segment.
    expect(
      hasAppPageGenerateStaticParamsAtLastDynamicSegment({
        layouts: [{ generateStaticParams }],
        layoutTreePositions: [0],
        page: {},
        routeSegments: ["[slug]"],
      }),
    ).toBe(false);
  });

  it("does not use a sibling page's generateStaticParams", () => {
    // app/[slug]/page.tsx exports it, but /[slug]/details has its own page.
    expect(
      hasAppPageGenerateStaticParamsAtLastDynamicSegment({
        layouts: [{}],
        layoutTreePositions: [0],
        page: {},
        routeSegments: ["[slug]", "details"],
      }),
    ).toBe(false);
  });

  it("counts parallel slot pages, and visits a layout-less slot folder that repeats the main tree once", () => {
    // app/[id]/page.tsx has no generateStaticParams, app/@modal/[id]/page.tsx does.
    expect(
      hasAppPageGenerateStaticParamsAtLastDynamicSegment({
        layouts: [{}],
        layoutTreePositions: [0],
        page: {},
        parallelBranches: [{ page: { generateStaticParams }, routeSegments: ["[id]"] }],
        routeSegments: ["[id]"],
      }),
    ).toBe(true);
    // app/[id]/page.tsx exports it. The slot's layout-less [id] folder is the
    // same segment to Next.js, so it does not clear the flag again.
    expect(
      hasAppPageGenerateStaticParamsAtLastDynamicSegment({
        layouts: [{}],
        layoutTreePositions: [0],
        page: { generateStaticParams },
        parallelBranches: [{ page: {}, routeSegments: ["[id]"] }],
        routeSegments: ["[id]"],
      }),
    ).toBe(true);
  });

  // Next.js's default build (Turbopack) puts `children` first at each level,
  // so the main-tree segment is visited before a slot segment at the same
  // depth.
  // https://github.com/vercel/next.js/blob/v16.2.7/crates/next-core/src/app_structure.rs#L1504-L1511
  it("visits the main tree before a matched slot at the same depth", () => {
    // app/[id]/page.tsx exports it; app/@modal/[id]/layout.tsx does not. The
    // slot's [id] is a separate segment, visited after the main page.
    expect(
      hasAppPageGenerateStaticParamsAtLastDynamicSegment({
        layouts: [{}],
        layoutTreePositions: [0],
        page: { generateStaticParams },
        parallelBranches: [
          {
            configLayouts: [{}],
            configLayoutTreePositions: [1],
            name: "modal",
            ownerTreePosition: 0,
            page: {},
            routeSegments: ["[id]"],
          },
        ],
        routeSegments: ["[id]"],
      }),
    ).toBe(false);
  });

  it("orders slot folder names by UTF-8 bytes", () => {
    // @豈 (U+F900) sorts before @𐀀 (U+10000) by UTF-8 bytes, but after it by
    // UTF-16 code units.
    const segments = collectAppPageStaticParamsWalkSegments({
      layouts: [{}],
      layoutTreePositions: [0],
      page: {},
      parallelBranches: [
        { name: "\u{10000}", ownerTreePosition: 0, page: {}, routeSegments: [] },
        { name: "\u{F900}", ownerTreePosition: 0, page: {}, routeSegments: [] },
      ],
      routeSegments: [],
    });
    expect(
      segments
        .filter((segment) => segment.treePath.length === 1 && segment.treePath[0] > 0)
        .map((segment) => segment.identity[0]),
    ).toEqual(["@\u{F900}", "@\u{10000}"]);
  });

  it("orders slots by folder name, whether they matched a page or render default", () => {
    const segments = collectAppPageStaticParamsWalkSegments({
      layouts: [{}],
      layoutTreePositions: [0],
      page: {},
      parallelBranches: [
        { name: "zeta", ownerTreePosition: 0, page: {}, routeSegments: [] },
        { isDefault: true, name: "alpha", ownerTreePosition: 0, page: {} },
      ],
      routeSegments: [],
    });
    expect(segments.map((segment) => [segment.identity[0], segment.treePath])).toEqual([
      ["", []],
      ["__DEFAULT__", [1]],
      ["@zeta", [2]],
      ["__PAGE__", [2, 0]],
      ["__PAGE__", [0]],
    ]);
  });

  it("places a slot under the folder that owns it, not by its segment count", () => {
    // app/(main)/[id]/page.tsx exports it; the root slot app/@panel/[id]/page.tsx
    // does not. The slot's [id] sits one level above the main page.
    expect(
      hasAppPageGenerateStaticParamsAtLastDynamicSegment({
        layouts: [{}],
        layoutTreePositions: [0],
        page: { generateStaticParams },
        parallelBranches: [
          { name: "panel", ownerTreePosition: 0, page: {}, routeSegments: ["[id]"] },
        ],
        routeSegments: ["(main)", "[id]"],
      }),
    ).toBe(true);
  });

  it("reads only the default module of a slot that renders its default", () => {
    // A default slot is a single `__DEFAULT__` segment; the slot's own layout
    // is not part of the loader tree.
    expect(
      hasAppPageGenerateStaticParamsAtLastDynamicSegment({
        layouts: [{}],
        layoutTreePositions: [0],
        page: {},
        parallelBranches: [
          {
            isDefault: true,
            layout: { generateStaticParams },
            name: "modal",
            ownerTreePosition: 0,
            page: {},
            routeSegments: [],
          },
        ],
        routeSegments: ["[id]"],
      }),
    ).toBe(false);
  });

  it("places the children default of a route that only a slot page materializes under its owner", () => {
    // app/default.tsx exports it; app/@feed/[id]/page.tsx does not. Next.js's
    // loader tree puts `__DEFAULT__` directly under the root, so the slot's
    // deeper [id] is visited last and clears the flag.
    expect(
      hasAppPageGenerateStaticParamsAtLastDynamicSegment({
        childrenSlot: { ownerTreePath: "/", state: "default" },
        layouts: [{}],
        layoutTreePositions: [0],
        page: { generateStaticParams },
        parallelBranches: [
          { name: "feed", ownerTreePosition: 0, page: {}, routeSegments: ["[id]"] },
        ],
        routeSegments: ["[id]"],
      }),
    ).toBe(false);
  });

  it("reads a route-group layout of a slot page that has no URL segments", () => {
    // app/[id]/@details/(variant)/layout.tsx exports it, below the [id]
    // segment it follows.
    expect(
      hasAppPageGenerateStaticParamsAtLastDynamicSegment({
        layouts: [{}],
        layoutTreePositions: [0],
        page: {},
        parallelBranches: [
          {
            configLayouts: [{ generateStaticParams }],
            configLayoutTreePositions: [1],
            name: "details",
            ownerTreePosition: 1,
            page: {},
            routeSegments: [],
          },
        ],
        routeSegments: ["[id]"],
      }),
    ).toBe(true);
  });

  it("walks segments breadth-first in loader tree order", () => {
    expect(
      lastDynamicSegmentHasGenerateStaticParams([
        {
          dynamic: false,
          generateStaticParams: true,
          identity: ["__PAGE__", "page"],
          treePath: [1, 0],
        },
        {
          dynamic: true,
          generateStaticParams: false,
          identity: ["[slug]", undefined],
          treePath: [1],
        },
        {
          dynamic: true,
          generateStaticParams: false,
          identity: ["[id]", "slot"],
          treePath: [0, 0],
        },
      ]),
    ).toBe(true);
    expect(lastDynamicSegmentHasGenerateStaticParams([])).toBe(false);
  });
});

describe("isAppPageStaticEligible", () => {
  const base = {
    hasGenerateStaticParams: false,
    isDynamicRoute: false,
    isStaticGenerationEdgeRuntime: false,
    revalidateSeconds: null,
  };

  it("treats routes without dynamic segments as static", () => {
    expect(isAppPageStaticEligible(base)).toBe(true);
    expect(isAppPageStaticEligible({ ...base, revalidateSeconds: 60 })).toBe(true);
  });

  it("treats dynamic-segment routes as SSG only with generateStaticParams at the last dynamic segment", () => {
    expect(isAppPageStaticEligible({ ...base, isDynamicRoute: true })).toBe(false);
    // revalidate never makes a dynamic route static in Next.js.
    expect(isAppPageStaticEligible({ ...base, isDynamicRoute: true, revalidateSeconds: 60 })).toBe(
      false,
    );
    expect(
      isAppPageStaticEligible({ ...base, hasGenerateStaticParams: true, isDynamicRoute: true }),
    ).toBe(true);
  });

  it("treats force-static and dynamic = error as static", () => {
    expect(
      isAppPageStaticEligible({ ...base, dynamicConfig: "force-static", isDynamicRoute: true }),
    ).toBe(true);
    expect(isAppPageStaticEligible({ ...base, dynamicConfig: "error", isDynamicRoute: true })).toBe(
      true,
    );
  });

  it("excludes force-dynamic, revalidate = 0 and the edge runtime", () => {
    expect(isAppPageStaticEligible({ ...base, dynamicConfig: "force-dynamic" })).toBe(false);
    expect(isAppPageStaticEligible({ ...base, revalidateSeconds: 0 })).toBe(false);
    for (const config of [
      {},
      { revalidateSeconds: 60 },
      { hasGenerateStaticParams: true, isDynamicRoute: true },
      { dynamicConfig: "force-static" },
    ]) {
      expect(
        isAppPageStaticEligible({ ...base, ...config, isStaticGenerationEdgeRuntime: true }),
      ).toBe(false);
    }
  });
});

describe("resolveAppPageInterceptTree", () => {
  // app/layout.tsx, app/feed/layout.tsx, app/feed/page.tsx and
  // app/feed/@modal/default.tsx.
  const layouts = [{}, {}];
  const layoutTreePositions = [0, 1];
  const routeSegments = ["feed"];
  const modalDefault = {
    isDefault: true,
    layout: null,
    name: "modal",
    ownerTreePosition: 1,
    page: {},
  };

  function classify(
    interceptPage: Record<string, unknown>,
    options: {
      isDynamicRoute?: boolean;
      interceptOwnerDefault?: Record<string, unknown>;
      siblingBranches?: Parameters<typeof resolveAppPageInterceptTree>[0]["parallelBranches"];
      sourcePage?: Record<string, unknown>;
      slotIndex?: number;
    } = {},
  ) {
    // app/feed/@modal/(.)photos/[id]/page.tsx, or app/feed/(.)photos/[id]/
    // page.tsx for a sibling-page intercept. Like the generated entry, both
    // Next.js's tree and the one vinext renders must be static.
    return [false, true].every((keepActiveSiblings) => {
      const tree = resolveAppPageInterceptTree({
        childrenSlot: { ownerTreePath: "/feed", state: "active" },
        interceptBranchSegments: ["(.)photos", "[id]"],
        interceptLayouts: [],
        interceptLayoutSegments: [],
        interceptOwnerDefault: options.interceptOwnerDefault,
        interceptPage,
        keepActiveSiblings,
        layouts,
        layoutTreePositions,
        page: options.sourcePage ?? {},
        parallelBranches: [modalDefault, ...(options.siblingBranches ?? [])],
        routeSegments,
        isSiblingPageIntercept: options.slotIndex === -1,
        slotIndex: options.slotIndex ?? 0,
      });
      const config = resolveAppPageSegmentConfig(tree);
      return isAppPageStaticEligible({
        dynamicConfig: config.dynamicConfig,
        hasGenerateStaticParams: hasAppPageGenerateStaticParamsAtLastDynamicSegment(tree),
        isDynamicRoute: options.isDynamicRoute ?? false,
        isStaticGenerationEdgeRuntime: isEdgeRuntime(
          resolveAppPageStaticGenerationRuntime(collectAppPageStaticGenerationRuntimes(tree)) as
            | string
            | undefined,
        ),
        revalidateSeconds: config.revalidateSeconds,
      });
    });
  }

  it("puts the intercepting branch in place of the intercepted slot's", () => {
    const interceptPage = { dynamic: "force-dynamic" };
    const tree = resolveAppPageInterceptTree({
      interceptBranchSegments: ["(.)photos", "[id]"],
      interceptLayouts: [{ revalidate: 60 }],
      interceptLayoutSegments: [["(.)photos"]],
      interceptPage,
      layouts,
      layoutTreePositions,
      page: {},
      parallelBranches: [modalDefault],
      routeSegments,
      isSiblingPageIntercept: false,
      slotIndex: 0,
    });
    expect(tree.parallelBranches).toEqual([
      {
        configLayouts: [{ revalidate: 60 }],
        configLayoutTreePositions: [1],
        isDefault: false,
        layout: null,
        name: "modal",
        ownerTreePosition: 1,
        page: interceptPage,
        routeSegments: ["(.)photos", "[id]"],
      },
    ]);
  });

  it("keeps the slot's layouts above the intercept marker in its branch", () => {
    // app/layout.tsx, app/gallery/page.tsx, app/@modal/default.tsx,
    // app/@modal/gallery/layout.tsx (force-dynamic), app/@modal/gallery/
    // (.)photo/layout.tsx and app/@modal/gallery/(.)photo/page.tsx. Next.js's
    // intercepting route tree holds the @modal/gallery folder, and its layout,
    // above the (.)photo branch.
    const galleryLayout = { dynamic: "force-dynamic" };
    const photoLayout = {};
    const interceptPage = {};
    const source = {
      childrenSlot: { ownerTreePath: "/gallery", state: "active" },
      interceptBranchSegments: ["gallery", "(.)photo"],
      interceptLayouts: [galleryLayout, photoLayout],
      interceptLayoutSegments: [["gallery"], ["gallery", "(.)photo"]],
      interceptPage,
      isSiblingPageIntercept: false,
      layouts: [{}],
      layoutTreePositions: [0],
      page: {},
      parallelBranches: [{ ...modalDefault, ownerTreePosition: 0 }],
      routeSegments: ["gallery"],
      slotIndex: 0,
    } as const;

    for (const keepActiveSiblings of [false, true]) {
      const tree = resolveAppPageInterceptTree({ ...source, keepActiveSiblings });
      expect(tree.parallelBranches?.[0]).toEqual({
        configLayouts: [galleryLayout, photoLayout],
        configLayoutTreePositions: [1, 2],
        isDefault: false,
        layout: null,
        name: "modal",
        ownerTreePosition: 0,
        page: interceptPage,
        routeSegments: ["gallery", "(.)photo"],
      });
      expect(collectAppPageStaticParamsWalkSegments(tree)).toContainEqual({
        dynamic: false,
        generateStaticParams: false,
        identity: ["gallery", galleryLayout],
        treePath: [1, 0],
      });
      expect(resolveAppPageSegmentConfig(tree).dynamicConfig).toBe("force-dynamic");
    }
  });

  it("puts a sibling-page intercept in place of the source's page", () => {
    const interceptLayout = {};
    const interceptPage = {};
    const tree = resolveAppPageInterceptTree({
      childrenSlot: { ownerTreePath: "/feed", state: "active" },
      interceptBranchSegments: ["(.)photos", "[id]"],
      interceptLayouts: [interceptLayout],
      interceptLayoutSegments: [["(.)photos"]],
      interceptPage,
      layouts,
      layoutTreePositions,
      page: { dynamic: "force-static" },
      parallelBranches: [modalDefault],
      routeSegments,
      isSiblingPageIntercept: true,
      slotIndex: -1,
    });
    expect(tree).toEqual({
      childrenSlot: null,
      layoutTreePositions: [0, 1, 2],
      layouts: [{}, {}, interceptLayout],
      page: interceptPage,
      parallelBranches: [
        {
          configLayouts: [],
          configLayoutTreePositions: [],
          isDefault: true,
          layout: null,
          name: "modal",
          ownerTreePosition: 1,
          page: modalDefault.page,
          routeSegments: [],
        },
      ],
      routeSegments: ["feed", "(.)photos", "[id]"],
    });
  });

  it("replaces active sibling slots at or above the intercept with their defaults", () => {
    // For the source app/feed/nested/page.tsx, app/@global/feed/nested/page.tsx
    // and app/feed/@sidebar/nested/page.tsx sit on the intercepting branch's
    // path; app/feed/nested/@aside/page.tsx sits inside app/feed's children,
    // which Next.js replaces with app/feed's default.
    const globalDefault = { revalidate: 30 };
    const sidebarDefault = { runtime: "edge" };
    const aside = {
      default: {},
      isDefault: false,
      layout: {},
      name: "aside",
      ownerTreePosition: 2,
      page: { runtime: "nodejs" },
      routeSegments: [],
    };
    const tree = resolveAppPageInterceptTree({
      interceptBranchSegments: ["(.)photos", "[id]"],
      interceptPage: {},
      isSiblingPageIntercept: false,
      layouts: [{}, {}, {}],
      layoutTreePositions: [0, 1, 2],
      page: {},
      parallelBranches: [
        {
          configLayouts: [{}],
          configLayoutTreePositions: [1],
          default: globalDefault,
          isDefault: false,
          layout: { dynamic: "force-dynamic" },
          name: "global",
          ownerTreePosition: 0,
          page: {},
          routeSegments: ["feed", "nested"],
        },
        { ...modalDefault, default: modalDefault.page },
        {
          default: sidebarDefault,
          isDefault: false,
          layout: null,
          name: "sidebar",
          ownerTreePosition: 1,
          page: { runtime: "nodejs" },
          routeSegments: ["nested"],
        },
        aside,
      ],
      routeSegments: ["feed", "nested"],
      slotIndex: 1,
    });
    const leaf = {
      configLayouts: [],
      configLayoutTreePositions: [],
      isDefault: true,
      layout: null,
    };
    expect(tree.parallelBranches).toEqual([
      { ...leaf, name: "global", ownerTreePosition: 0, page: globalDefault, routeSegments: [] },
      expect.objectContaining({ isDefault: false, name: "modal" }),
      { ...leaf, name: "sidebar", ownerTreePosition: 1, page: sidebarDefault, routeSegments: [] },
      null,
    ]);
  });

  it("replaces a slot intercept's children with the owner's default, but renders the source", () => {
    // app/feed/nested/layout.tsx, app/feed/nested/page.tsx and
    // app/feed/nested/@aside/page.tsx sit below app/feed, whose children
    // Next.js replaces with app/feed/default.tsx as a __DEFAULT__ leaf.
    const feedDefault = { revalidate: 30 };
    const sourcePage = { dynamic: "force-static" };
    const nestedLayout = { dynamic: "force-static" };
    const aside = {
      default: {},
      isDefault: false,
      layout: null,
      name: "aside",
      ownerTreePosition: 2,
      page: {},
      routeSegments: [],
    };
    const source = {
      childrenSlot: { ownerTreePath: "/feed/nested", state: "active" },
      interceptBranchSegments: ["(.)photos", "[id]"],
      interceptOwnerDefault: feedDefault,
      interceptPage: {},
      isSiblingPageIntercept: false,
      layouts: [layouts[0], layouts[1], nestedLayout],
      layoutTreePositions: [0, 1, 2],
      page: sourcePage,
      parallelBranches: [modalDefault, aside],
      routeSegments: ["feed", "nested"],
      slotIndex: 0,
    } as const;
    const intercept = expect.objectContaining({ isDefault: false, name: "modal" });

    const nextTree = resolveAppPageInterceptTree(source);
    expect(nextTree).toEqual({
      childrenSlot: { ownerTreePath: "/feed", state: "default" },
      layoutTreePositions: [0, 1],
      layouts: [layouts[0], layouts[1]],
      page: feedDefault,
      parallelBranches: [intercept, null],
      routeSegments: ["feed"],
    });
    expect(collectAppPageStaticParamsWalkSegments(nextTree)).toContainEqual({
      dynamic: false,
      generateStaticParams: false,
      identity: ["__DEFAULT__", feedDefault],
      treePath: [0, 0],
    });

    const renderedTree = resolveAppPageInterceptTree({ ...source, keepActiveSiblings: true });
    expect(renderedTree).toEqual({
      childrenSlot: source.childrenSlot,
      layoutTreePositions: source.layoutTreePositions,
      layouts: source.layouts,
      page: sourcePage,
      parallelBranches: [intercept, aside],
      routeSegments: source.routeSegments,
    });
  });

  it("drops a force-static source page from a slot intercept's tree", () => {
    // app/feed/page.tsx sets dynamic = "force-static"; the intercepting
    // app/feed/@modal/(.)photos/[id]/page.tsx has no generateStaticParams,
    // and app/feed has no default.tsx, so its children are default-null.
    const sourcePage = { dynamic: "force-static" };
    expect(classify({}, { isDynamicRoute: true, sourcePage })).toBe(false);
    // A force-static app/feed/default.tsx takes the source page's place.
    expect(
      classify(
        {},
        { interceptOwnerDefault: { dynamic: "force-static" }, isDynamicRoute: true, sourcePage },
      ),
    ).toBe(true);
  });

  it("classifies a slot intercept with an active sibling's edge default as edge", () => {
    // app/feed/@sidebar/page.tsx is Node; app/feed/@sidebar/default.tsx is edge.
    const sidebar = {
      default: { runtime: "edge" },
      isDefault: false,
      layout: null,
      name: "sidebar",
      ownerTreePosition: 1,
      page: { runtime: "nodejs" },
      routeSegments: [],
    };
    expect(classify({}, { siblingBranches: [sidebar] })).toBe(false);
    expect(classify({}, { siblingBranches: [{ ...sidebar, default: {} }] })).toBe(true);
  });

  it("keeps a slot intercept's rendered force-dynamic sibling page dynamic", () => {
    // app/feed/@sidebar/page.tsx is force-dynamic and still renders beside
    // the intercept; app/feed/@sidebar/default.tsx is static.
    const sidebar = {
      default: {},
      isDefault: false,
      layout: null,
      name: "sidebar",
      ownerTreePosition: 1,
      page: { dynamic: "force-dynamic" },
      routeSegments: [],
    };
    expect(classify({}, { siblingBranches: [sidebar] })).toBe(false);
    expect(classify({}, { siblingBranches: [sidebar], slotIndex: -1 })).toBe(false);
  });

  it("keeps an active sibling slot's page when resolving the tree vinext renders", () => {
    const sidebar = {
      default: {},
      isDefault: false,
      layout: null,
      name: "sidebar",
      ownerTreePosition: 1,
      page: { dynamic: "force-dynamic" },
      routeSegments: [],
    };
    const tree = resolveAppPageInterceptTree({
      interceptBranchSegments: ["(.)photos", "[id]"],
      interceptPage: {},
      isSiblingPageIntercept: false,
      keepActiveSiblings: true,
      layouts,
      layoutTreePositions,
      page: {},
      parallelBranches: [modalDefault, sidebar],
      routeSegments,
      slotIndex: 0,
    });
    expect(tree.parallelBranches?.[1]).toBe(sidebar);
  });

  it("drops an active sibling slot's config from a sibling-page intercept's tree", () => {
    // app/feed/@sidebar/page.tsx sets dynamic = "force-static"; the
    // intercepting app/feed/(.)photos/[id]/page.tsx has no generateStaticParams.
    const sidebar = {
      default: {},
      isDefault: false,
      layout: null,
      name: "sidebar",
      ownerTreePosition: 1,
      page: { dynamic: "force-static" },
      routeSegments: [],
    };
    expect(classify({}, { isDynamicRoute: true, siblingBranches: [sidebar], slotIndex: -1 })).toBe(
      false,
    );
  });

  it("keeps the source's tree when the source route lacks the intercepted slot", () => {
    // A route-group variant of app/feed matched as the source has no @modal,
    // so the intercepting page doesn't render and the dynamic source page does.
    const sourcePage = { dynamic: "force-dynamic" };
    const tree = resolveAppPageInterceptTree({
      interceptBranchSegments: ["(.)photos", "[id]"],
      interceptPage: {},
      isSiblingPageIntercept: false,
      layouts,
      layoutTreePositions,
      page: sourcePage,
      parallelBranches: [],
      routeSegments,
      slotIndex: -1,
    });
    expect(tree.page).toBe(sourcePage);
    expect(tree.routeSegments).toEqual(routeSegments);
    expect(resolveAppPageSegmentConfig(tree).dynamicConfig).toBe("force-dynamic");
  });

  it("attaches a slot intercept only to a source that has the slot", () => {
    const source = { layouts, layoutTreePositions, page: {}, routeSegments };
    expect(
      isAppPageInterceptAttached({
        ...source,
        isSiblingPageIntercept: false,
        parallelBranches: [modalDefault],
        slotIndex: 0,
      }),
    ).toBe(true);
    expect(
      isAppPageInterceptAttached({
        ...source,
        isSiblingPageIntercept: false,
        parallelBranches: [],
        slotIndex: -1,
      }),
    ).toBe(false);
    // A sibling-page intercept replaces the source's page, whatever its slots.
    expect(
      isAppPageInterceptAttached({
        ...source,
        isSiblingPageIntercept: true,
        parallelBranches: [],
        slotIndex: -1,
      }),
    ).toBe(true);
  });

  it("keeps a static intercepting branch static", () => {
    expect(classify({})).toBe(true);
  });

  it("makes the tree dynamic when the intercepting page is force-dynamic", () => {
    expect(classify({ dynamic: "force-dynamic" })).toBe(false);
  });

  it("makes the tree dynamic when the intercepting page sets revalidate = 0", () => {
    expect(classify({ revalidate: 0 })).toBe(false);
  });

  it("disables static generation when the intercepting page is edge", () => {
    expect(classify({ runtime: "edge" })).toBe(false);
  });

  it("needs generateStaticParams on the intercepting branch of a dynamic intercepted route", () => {
    expect(classify({}, { isDynamicRoute: true })).toBe(false);
    expect(classify({ generateStaticParams: () => [] }, { isDynamicRoute: true })).toBe(true);
  });

  it("drops a force-static source page from a sibling-page intercept's tree", () => {
    // app/feed/page.tsx sets dynamic = "force-static"; the intercepting
    // app/feed/(.)photos/[id]/page.tsx has no generateStaticParams.
    expect(
      classify(
        {},
        {
          isDynamicRoute: true,
          slotIndex: -1,
          sourcePage: { dynamic: "force-static" },
        },
      ),
    ).toBe(false);
  });

  it("drops a source page's generateStaticParams from a sibling-page intercept's tree", () => {
    // app/u/[user]/page.tsx exports generateStaticParams; the intercepting
    // app/u/[user]/(.)settings/page.tsx doesn't, so [user] has none left.
    const tree = resolveAppPageInterceptTree({
      childrenSlot: { ownerTreePath: "/u/[user]", state: "active" },
      interceptBranchSegments: ["(.)settings"],
      interceptPage: {},
      layouts: [{}],
      layoutTreePositions: [0],
      page: { generateStaticParams: () => [] },
      parallelBranches: [],
      routeSegments: ["u", "[user]"],
      isSiblingPageIntercept: true,
      slotIndex: -1,
    });
    expect(hasAppPageGenerateStaticParamsAtLastDynamicSegment(tree)).toBe(false);
  });

  it("counts a marker-prefixed intercepting folder as a dynamic segment", () => {
    // app/[user]/layout.tsx exports generateStaticParams; the intercepting
    // app/[user]/feed/@modal/(.)[photo]/page.tsx, or the sibling-page
    // app/[user]/feed/(..)(..)[photo]/page.tsx, doesn't, so [photo] has none.
    const source = {
      childrenSlot: { ownerTreePath: "/[user]/feed", state: "active" },
      interceptPage: {},
      layouts: [{}, { generateStaticParams: () => [] }],
      layoutTreePositions: [0, 1],
      page: {},
      routeSegments: ["[user]", "feed"],
    } as const;
    const slotTree = resolveAppPageInterceptTree({
      ...source,
      interceptBranchSegments: ["(.)[photo]"],
      isSiblingPageIntercept: false,
      parallelBranches: [{ ...modalDefault, ownerTreePosition: 2 }],
      slotIndex: 0,
    });
    const siblingTree = resolveAppPageInterceptTree({
      ...source,
      interceptBranchSegments: ["(..)(..)[photo]"],
      isSiblingPageIntercept: true,
      parallelBranches: [],
      slotIndex: -1,
    });
    expect(hasAppPageGenerateStaticParamsAtLastDynamicSegment(slotTree)).toBe(false);
    expect(hasAppPageGenerateStaticParamsAtLastDynamicSegment(siblingTree)).toBe(false);
  });
});

describe("hasAppPageAnyGenerateStaticParams", () => {
  const generator = () => [];

  it("reads a generator from any segment, not only at or below the last dynamic one", () => {
    // app/[lang]/layout.tsx exports generateStaticParams; app/[lang]/[slug]
    // has none.
    const route = {
      layouts: [{}, { generateStaticParams: generator }],
      layoutTreePositions: [0, 1],
      page: {},
      routeSegments: ["[lang]", "[slug]"],
    };
    expect(hasAppPageAnyGenerateStaticParams(route)).toBe(true);
    expect(hasAppPageGenerateStaticParamsAtLastDynamicSegment(route)).toBe(false);
    expect(hasAppPageAnyGenerateStaticParams({ ...route, layouts: [{}, {}] })).toBe(false);
  });

  // app/layout.tsx, app/feed/layout.tsx, app/feed/page.tsx,
  // app/feed/@modal/default.tsx, app/feed/@modal/gallery/layout.tsx,
  // app/feed/@modal/gallery/(.)photo/page.tsx and app/feed/@sidebar/page.tsx.
  function resolveInterceptTree(
    modules: {
      galleryLayout?: object;
      interceptPage?: object;
      rootLayout?: object;
      sidebarPage?: object;
      sourcePage?: object;
    },
    keepActiveSiblings = false,
  ) {
    return resolveAppPageInterceptTree({
      childrenSlot: { ownerTreePath: "/feed", state: "active" },
      interceptBranchSegments: ["gallery", "(.)photo"],
      interceptLayouts: [modules.galleryLayout ?? {}],
      interceptLayoutSegments: [["gallery"]],
      interceptPage: modules.interceptPage ?? {},
      isSiblingPageIntercept: false,
      keepActiveSiblings,
      layouts: [modules.rootLayout ?? {}, {}],
      layoutTreePositions: [0, 1],
      page: modules.sourcePage ?? {},
      parallelBranches: [
        { isDefault: true, layout: null, name: "modal", ownerTreePosition: 1, page: {} },
        {
          default: {},
          isDefault: false,
          layout: null,
          name: "sidebar",
          ownerTreePosition: 1,
          page: modules.sidebarPage ?? {},
          routeSegments: [],
        },
      ],
      routeSegments: ["feed"],
      slotIndex: 0,
    });
  }

  it.each([
    ["a shared ancestor layout", { rootLayout: { generateStaticParams: generator } }],
    ["the intercepting page", { interceptPage: { generateStaticParams: generator } }],
    [
      "a slot layout above the intercept marker",
      { galleryLayout: { generateStaticParams: generator } },
    ],
  ])("reads a generator from %s of an intercepting route's tree", (_name, modules) => {
    expect(hasAppPageAnyGenerateStaticParams(resolveInterceptTree(modules))).toBe(true);
    expect(hasAppPageAnyGenerateStaticParams(resolveInterceptTree({}))).toBe(false);
  });

  it.each([
    ["the source page the intercept's children default replaces", "sourcePage"],
    ["an active sibling page Next.js's tree has the default of", "sidebarPage"],
  ])("does not read a generator from %s", (_name, module) => {
    const modules = { [module]: { generateStaticParams: generator } };
    expect(hasAppPageAnyGenerateStaticParams(resolveInterceptTree(modules))).toBe(false);
    // vinext still renders it, but the intercepting route's tree doesn't.
    expect(hasAppPageAnyGenerateStaticParams(resolveInterceptTree(modules, true))).toBe(true);
  });
});

describe("resolveAppPageInterceptSegmentConfig", () => {
  // app/layout.tsx, app/feed/layout.tsx, app/feed/page.tsx, the intercepting
  // app/feed/@modal/(.)photos/[id]/page.tsx, and app/feed/@sidebar, whose
  // page vinext renders beside the intercept where Next.js renders its default.
  const modalDefault = {
    isDefault: true,
    layout: null,
    name: "modal",
    ownerTreePosition: 1,
    page: {},
  };

  function resolve(
    interceptPage: Record<string, unknown>,
    sidebar: { default?: Record<string, unknown>; page: Record<string, unknown> },
    options: { isSiblingPageIntercept?: boolean; page?: Record<string, unknown> } = {},
  ) {
    const [interceptTree, renderedTree] = [false, true].map((keepActiveSiblings) =>
      resolveAppPageInterceptTree({
        interceptBranchSegments: ["(.)photos", "[id]"],
        interceptPage,
        isSiblingPageIntercept: options.isSiblingPageIntercept ?? false,
        keepActiveSiblings,
        layouts: [{}, {}],
        layoutTreePositions: [0, 1],
        page: options.page ?? {},
        parallelBranches: [
          modalDefault,
          {
            default: sidebar.default ?? {},
            isDefault: false,
            layout: null,
            name: "sidebar",
            ownerTreePosition: 1,
            page: sidebar.page,
            routeSegments: [],
          },
        ],
        routeSegments: ["feed"],
        slotIndex: options.isSiblingPageIntercept ? -1 : 0,
      }),
    );
    return resolveAppPageInterceptSegmentConfig(interceptTree, renderedTree);
  }

  it("takes the shorter revalidate of an active sibling page", () => {
    // app/feed/@sidebar/page.tsx sets revalidate = 10 beside an intercepting
    // page at 30.
    expect(resolve({ revalidate: 30 }, { page: { revalidate: 10 } }).revalidateSeconds).toBe(10);
    expect(
      resolve({ revalidate: 30 }, { page: { revalidate: 10 } }, { isSiblingPageIntercept: true })
        .revalidateSeconds,
    ).toBe(10);
    // A longer active sibling revalidate leaves the intercepting page's.
    expect(resolve({ revalidate: 30 }, { page: { revalidate: 60 } }).revalidateSeconds).toBe(30);
  });

  it("keeps the shorter revalidate of the default Next.js renders instead", () => {
    // app/feed/@sidebar/default.tsx sets revalidate = 5.
    expect(
      resolve({ revalidate: 30 }, { default: { revalidate: 5 }, page: {} }).revalidateSeconds,
    ).toBe(5);
  });

  it("makes the render force-dynamic for a force-dynamic active sibling page", () => {
    expect(resolve({ dynamic: "force-static" }, { page: { dynamic: "force-dynamic" } })).toEqual(
      expect.objectContaining({ dynamicConfig: "force-dynamic", revalidateSeconds: 0 }),
    );
  });

  it("keeps the intercepting branch's dynamic mode over an active sibling's", () => {
    expect(resolve({ dynamic: "force-static" }, { page: { dynamic: "error" } }).dynamicConfig).toBe(
      "force-static",
    );
    // With none of its own, the active sibling's applies.
    expect(resolve({}, { page: { dynamic: "force-static" } }).dynamicConfig).toBe("force-static");
  });

  it("takes an active sibling page's route-wide fetchCache mode", () => {
    expect(
      resolve({ fetchCache: "default-cache" }, { page: { fetchCache: "force-no-store" } })
        .fetchCache,
    ).toBe("force-no-store");
    expect(resolve({}, { page: { fetchCache: "default-no-store" } }).fetchCache).toBe(
      "default-no-store",
    );
    expect(() =>
      resolve({ fetchCache: "force-cache" }, { page: { fetchCache: "force-no-store" } }),
    ).toThrow(/incompatible fetchCache values/);
  });

  it("never reduces a slot's default together with the active page it replaces", () => {
    // app/feed/@sidebar/default.tsx and app/feed/@sidebar/page.tsx never
    // render together, so conflicting fetchCache modes don't throw. The
    // no-store mode wins between the two trees.
    expect(
      resolve(
        {},
        { default: { fetchCache: "force-cache" }, page: { fetchCache: "force-no-store" } },
      ).fetchCache,
    ).toBe("force-no-store");
    expect(
      resolve(
        {},
        { default: { fetchCache: "only-no-store" }, page: { fetchCache: "only-cache" } },
        { isSiblingPageIntercept: true },
      ).fetchCache,
    ).toBe("only-no-store");
    // A force mode of either tree overrides an only mode of the other.
    expect(
      resolve({}, { default: { fetchCache: "only-no-store" }, page: { fetchCache: "force-cache" } })
        .fetchCache,
    ).toBe("force-cache");
  });

  it("applies the dynamic = error fetchCache default to the merged dynamic mode only", () => {
    // app/feed/page.tsx sets dynamic = "error", which only vinext's tree
    // renders beside the force-static intercepting page, whose mode wins.
    const merged = resolve(
      { dynamic: "force-static" },
      { page: {} },
      { page: { dynamic: "error" } },
    );
    expect(merged.dynamicConfig).toBe("force-static");
    expect(merged).not.toHaveProperty("fetchCache");
    // With none of its own, app/feed/page.tsx's dynamic = "error" applies.
    expect(resolve({}, { page: {} }, { page: { dynamic: "error" } }).fetchCache).toBe("only-cache");
  });

  it("takes the shortest unstable_dynamicStaleTime of the pages either tree renders", () => {
    const staleTime = (...args: Parameters<typeof resolve>) =>
      resolve(...args).dynamicStaleTimeSeconds;
    // The intercepting page, in the modal slot or in place of app/feed/page.tsx.
    expect(staleTime({ unstable_dynamicStaleTime: 30 }, { page: {} })).toBe(30);
    expect(
      staleTime({ unstable_dynamicStaleTime: 30 }, { page: {} }, { isSiblingPageIntercept: true }),
    ).toBe(30);
    // An active sibling page, or the default Next.js renders in its place.
    expect(
      staleTime({ unstable_dynamicStaleTime: 30 }, { page: { unstable_dynamicStaleTime: 10 } }),
    ).toBe(10);
    expect(
      staleTime(
        { unstable_dynamicStaleTime: 30 },
        { default: { unstable_dynamicStaleTime: 5 }, page: {} },
        { isSiblingPageIntercept: true },
      ),
    ).toBe(5);
    expect(staleTime({}, { page: {} })).toBeUndefined();
  });
});
