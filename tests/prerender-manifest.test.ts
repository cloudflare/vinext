import { describe, expect, it } from "vite-plus/test";
import {
  getPrewarmableAppPaths,
  type PrerenderManifest,
} from "../packages/vinext/src/server/prerender-manifest.js";
import { VINEXT_RSC_VARY_HEADER } from "../packages/vinext/src/server/headers.js";

describe("getPrewarmableAppPaths", () => {
  it("selects exact App paths using the completed ISR lifetime and safe Vary fields", () => {
    const manifest: PrerenderManifest = {
      routes: [
        {
          route: "/static",
          status: "rendered",
          router: "app",
          revalidate: false,
          fallback: false,
          rscVary: VINEXT_RSC_VARY_HEADER,
          rscPrewarmable: true,
        },
        {
          route: "/posts/:slug",
          path: "/posts/first",
          status: "rendered",
          router: "app",
          revalidate: 60,
          fallback: false,
          rscVary: VINEXT_RSC_VARY_HEADER,
          rscPrewarmable: true,
        },
        {
          route: "/custom-policy",
          status: "rendered",
          router: "app",
          revalidate: 30,
          fallback: false,
          rscVary: VINEXT_RSC_VARY_HEADER,
          rscPrewarmable: true,
          headers: { "cache-control": "private" },
        },
        {
          route: "/custom-vary",
          status: "rendered",
          router: "app",
          revalidate: 30,
          fallback: false,
          rscVary: `${VINEXT_RSC_VARY_HEADER}, User-Agent`,
          rscPrewarmable: true,
        },
        {
          route: "/static",
          status: "rendered",
          router: "app",
          revalidate: false,
          fallback: false,
          rscVary: VINEXT_RSC_VARY_HEADER,
          rscPrewarmable: true,
        },
      ],
    };

    expect(getPrewarmableAppPaths(manifest)).toEqual(["/static", "/posts/first", "/custom-policy"]);
  });

  it("excludes unresolved, partial, failed, Pages, and non-cacheable results", () => {
    const manifest: PrerenderManifest = {
      routes: [
        {
          route: "/dynamic/:slug",
          status: "rendered",
          router: "app",
          revalidate: 60,
          fallback: false,
        },
        {
          route: "/fallback/:slug",
          path: "/fallback/[slug]",
          status: "rendered",
          router: "app",
          revalidate: 60,
          fallback: true,
        },
        { route: "/failed", status: "error", router: "app", revalidate: 60 },
        {
          route: "/pages",
          status: "rendered",
          router: "pages",
          revalidate: 60,
          fallback: false,
        },
        {
          route: "/zero",
          status: "rendered",
          router: "app",
          revalidate: 0,
          fallback: false,
        },
        {
          route: "/unknown",
          status: "rendered",
          router: "app",
          fallback: false,
        },
        {
          route: "/500",
          status: "rendered",
          router: "app",
          revalidate: false,
          fallback: false,
        },
      ],
    };

    expect(getPrewarmableAppPaths(manifest)).toEqual([]);
  });
});
