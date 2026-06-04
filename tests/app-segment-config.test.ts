import { describe, expect, it } from "vitest";
import {
  isEdgeRuntime,
  resolveAppPageFetchCacheMode,
  resolveAppPageSegmentConfig,
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
      fetchCache: "force-no-store",
      revalidateSeconds: 0,
    });
  });

  it("derives fetchCache from static-only dynamic modes", () => {
    expect(
      resolveAppPageSegmentConfig({
        layouts: [{ dynamic: "error" }],
        page: {},
      }),
    ).toEqual({
      dynamicConfig: "error",
      dynamicParamsConfig: false,
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
      dynamicParamsConfig: false,
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
      dynamicParamsConfig: false,
      revalidateSeconds: null,
    });
  });

  it("defaults dynamicParams to false for static-only dynamic modes", () => {
    expect(
      resolveAppPageSegmentConfig({
        layouts: [{ dynamic: "error" }],
        page: {},
      }),
    ).toEqual({
      dynamicConfig: "error",
      dynamicParamsConfig: false,
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
      dynamicParamsConfig: false,
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

describe("isEdgeRuntime", () => {
  it("matches Next.js' edge-runtime values", () => {
    expect(isEdgeRuntime("edge")).toBe(true);
    expect(isEdgeRuntime("experimental-edge")).toBe(true);
    expect(isEdgeRuntime("nodejs")).toBe(false);
    expect(isEdgeRuntime(undefined)).toBe(false);
  });
});
