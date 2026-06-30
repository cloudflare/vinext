import { describe, expect, it } from "vitest";
import {
  isEdgeRuntime,
  resolveAppPageFetchCacheMode,
  resolveAppPageSegmentConfig,
  resolveAppRouteHandlerFetchCacheMode,
} from "../packages/vinext/src/server/app-segment-config.js";

describe("resolveAppPageSegmentConfig", () => {
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
