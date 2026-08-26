import { describe, expect, it } from "vite-plus/test";
import {
  cacheabilityManifestRouteKey,
  cacheabilityRequestIdentity,
  findCacheabilityManifestRoute,
  parseCacheabilityManifest,
  type CacheabilityManifestRoute,
} from "../packages/vinext/src/server/cacheability-manifest.js";

const route: CacheabilityManifestRoute = {
  kind: "app-page",
  pattern: "/products/:id",
  representation: "html",
  requestKey: "/products/one?currency=gbp",
  state: "static-candidate",
  status: 200,
};
const key = cacheabilityManifestRouteKey(
  route.kind,
  route.pattern,
  route.representation,
  route.requestKey,
);

describe("cacheability manifest", () => {
  it("accepts only the expected build and exact route key", () => {
    const raw = JSON.stringify({ buildId: "build-a", routes: { [key]: route }, version: 1 });
    const manifest = parseCacheabilityManifest(raw, "build-a");
    expect(manifest).not.toBeNull();
    expect(
      findCacheabilityManifestRoute(manifest!, "app-page", "/products/:id", {
        representation: "html",
        requestKey: "/products/one?currency=gbp",
      }),
    ).toEqual(route);
    expect(
      findCacheabilityManifestRoute(manifest!, "app-page", "/products/:id", {
        representation: "html",
        requestKey: "/products/two?currency=gbp",
      }),
    ).toBeNull();
    expect(parseCacheabilityManifest(raw, "build-b")).toBeNull();
  });

  it("keeps App and Pages routes with the same pattern isolated", () => {
    const pagesRoute: CacheabilityManifestRoute = { ...route, kind: "pages-page" };
    const pagesKey = cacheabilityManifestRouteKey(
      pagesRoute.kind,
      pagesRoute.pattern,
      pagesRoute.representation,
      pagesRoute.requestKey,
    );
    const manifest = parseCacheabilityManifest(
      JSON.stringify({
        buildId: "build-a",
        routes: { [key]: route, [pagesKey]: pagesRoute },
        version: 1,
      }),
      "build-a",
    );
    expect(
      findCacheabilityManifestRoute(manifest!, "pages-page", "/products/:id", {
        representation: "html",
        requestKey: "/products/one?currency=gbp",
      }),
    ).toEqual(pagesRoute);
  });

  it("rejects malformed routes instead of partially trusting a manifest", () => {
    expect(
      parseCacheabilityManifest(
        JSON.stringify({
          buildId: "build-a",
          routes: { [key]: { ...route, requestKey: "/different" } },
          version: 1,
        }),
        "build-a",
      ),
    ).toBeNull();
  });

  it("keeps HTML query variants and RSC representations distinct", () => {
    expect(
      cacheabilityRequestIdentity(
        new Request("https://example.com/products/one?currency=gbp", {
          headers: { Accept: "text/html" },
        }),
      ),
    ).toEqual({ representation: "html", requestKey: "/products/one?currency=gbp" });
    expect(
      cacheabilityRequestIdentity(
        new Request("https://example.com/docs/_next/data/build-a/products/one.json?currency=gbp", {
          headers: { Accept: "application/json" },
        }),
      ),
    ).toEqual({
      representation: "pages-data",
      requestKey: "/docs/_next/data/build-a/products/one.json?currency=gbp",
    });
    expect(
      cacheabilityRequestIdentity(
        new Request("https://example.com/products/one?_rsc", {
          headers: { Accept: "text/x-component", RSC: "1" },
        }),
      ),
    ).toEqual({ representation: "rsc-full", requestKey: "/products/one?_rsc" });
  });

  it("fails closed for contextual RSC and action requests", () => {
    expect(
      cacheabilityRequestIdentity(
        new Request("https://example.com/products/one?_rsc", {
          headers: { "Next-Router-State-Tree": "opaque", RSC: "1" },
        }),
      ),
    ).toBeNull();
    expect(
      cacheabilityRequestIdentity(
        new Request("https://example.com/products/one", {
          method: "POST",
          headers: { "Next-Action": "action-id" },
        }),
      ),
    ).toBeNull();
  });
});
