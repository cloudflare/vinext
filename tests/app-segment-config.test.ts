import { describe, expect, it } from "vitest";
import {
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
});
