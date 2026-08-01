import { describe, expect, it } from "vite-plus/test";
import {
  getPrewarmableAppPaths,
  type PrerenderManifest,
} from "../packages/vinext/src/server/prerender-manifest.js";

describe("getPrewarmableAppPaths", () => {
  it("selects only exact cacheable App paths proven by the final prerender", () => {
    const manifest: PrerenderManifest = {
      routes: [
        {
          route: "/static",
          status: "rendered",
          router: "app",
          revalidate: false,
          fallback: false,
        },
        {
          route: "/posts/:slug",
          path: "/posts/first",
          status: "rendered",
          router: "app",
          revalidate: 60,
          fallback: false,
        },
        {
          route: "/posts/:slug",
          path: "/posts/second",
          status: "rendered",
          router: "app",
          revalidate: 60,
          fallback: false,
        },
        {
          route: "/static",
          status: "rendered",
          router: "app",
          revalidate: false,
          fallback: false,
        },
      ],
    };

    expect(getPrewarmableAppPaths(manifest)).toEqual(["/static", "/posts/first", "/posts/second"]);
  });

  it("rejects dynamic patterns, fallback shells, errors, and non-cacheable results", () => {
    const manifest: PrerenderManifest = {
      routes: [
        {
          route: "/dynamic/:slug",
          status: "rendered",
          router: "app",
          revalidate: false,
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
        {
          route: "/failed",
          status: "error",
          router: "app",
          revalidate: false,
          fallback: false,
        },
        {
          route: "/500",
          status: "rendered",
          router: "app",
          revalidate: false,
          fallback: false,
        },
        {
          route: "/pages-route",
          status: "rendered",
          router: "pages",
          revalidate: false,
          fallback: false,
        },
        {
          route: "/revalidate-zero",
          status: "rendered",
          router: "app",
          revalidate: 0,
          fallback: false,
        },
        {
          route: "/unknown-lifetime",
          status: "rendered",
          router: "app",
          fallback: false,
        },
        {
          route: "/private",
          status: "rendered",
          router: "app",
          revalidate: false,
          fallback: false,
          headers: { "Cache-Control": "public, private, max-age=60" },
        },
        {
          route: "/no-store",
          status: "rendered",
          router: "app",
          revalidate: false,
          fallback: false,
          headers: { "CDN-Cache-Control": "no-store" },
        },
        {
          route: "/no-cache",
          status: "rendered",
          router: "app",
          revalidate: false,
          fallback: false,
          headers: { "Cloudflare-CDN-Cache-Control": "no-cache" },
        },
      ],
    };

    expect(getPrewarmableAppPaths(manifest)).toEqual([]);
  });
});
