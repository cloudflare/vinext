import { describe, expect, it } from "vite-plus/test";
import {
  getPrewarmableAppPaths,
  getPrewarmableConcretePaths,
  hasNonCacheablePrewarmHeaders,
  type PrerenderManifest,
} from "../packages/vinext/src/server/prerender-manifest.js";

describe("getPrewarmableAppPaths", () => {
  it("rejects HTML Accept variance but accepts the canonical RSC Vary contract", () => {
    expect(
      hasNonCacheablePrewarmHeaders({
        Vary: "RSC, Accept, Cookie, Authorization, Host",
      }),
    ).toBe(true);
    expect(
      hasNonCacheablePrewarmHeaders(
        {
          Vary: "RSC, Accept, Cookie, Authorization, Host",
        },
        { allowRscAcceptVary: true },
      ),
    ).toBe(false);
  });

  it("excludes App and Pages HTML that varies on Accept from prewarm eligibility", () => {
    const manifest: PrerenderManifest = {
      routes: [
        {
          route: "/app-vary-accept",
          status: "rendered",
          router: "app",
          revalidate: false,
          fallback: false,
          headers: { Vary: "Accept" },
        },
        {
          route: "/pages-vary-accept",
          status: "rendered",
          router: "pages",
          revalidate: false,
          fallback: false,
          headers: { Vary: "Accept" },
        },
        {
          route: "/app-safe",
          status: "rendered",
          router: "app",
          revalidate: false,
          fallback: false,
        },
        {
          route: "/pages-safe",
          status: "rendered",
          router: "pages",
          revalidate: false,
          fallback: false,
        },
      ],
    };

    expect(getPrewarmableAppPaths(manifest)).toEqual(["/app-safe"]);
    expect(getPrewarmableConcretePaths(manifest)).toEqual(["/app-safe", "/pages-safe"]);
  });

  it("admits adapter-owned Vary fields only when persisted in the manifest", () => {
    const route = {
      route: "/scheme-aware",
      status: "rendered",
      router: "app",
      revalidate: false,
      headers: { Vary: "X-Forwarded-Proto" },
    } as const;

    expect(getPrewarmableAppPaths({ routes: [route] })).toEqual([]);
    expect(
      getPrewarmableAppPaths({
        controlledResponseVaryHeaders: ["X-Forwarded-Proto"],
        routes: [route],
      }),
    ).toEqual(["/scheme-aware"]);
  });

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
        {
          route: "/vary-all",
          status: "rendered",
          router: "app",
          revalidate: 60,
          fallback: false,
          headers: { Vary: "Accept-Encoding, *" },
        },
        {
          route: "/sets-cookie",
          status: "rendered",
          router: "app",
          revalidate: 60,
          fallback: false,
          hasSetCookie: true,
        },
        {
          route: "/vary-user-agent",
          status: "rendered",
          router: "app",
          revalidate: 60,
          fallback: false,
          headers: { Vary: "RSC, User-Agent" },
        },
        {
          route: "/probe-rejected",
          status: "rendered",
          router: "app",
          revalidate: 60,
          fallback: false,
          prewarmable: false,
        },
      ],
    };

    expect(getPrewarmableAppPaths(manifest)).toEqual([]);
  });
});
