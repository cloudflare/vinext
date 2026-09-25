import { describe, expect, it } from "vite-plus/test";
import {
  cacheabilityManifestRouteState,
  cacheabilityManifestRouteKey,
  cacheabilityRequestIdentity,
  cacheabilityRoutePathname,
  findCacheabilityManifestRoute,
  parseCacheabilityManifest,
  type CacheabilityManifestRoute,
} from "../packages/vinext/src/server/cacheability-manifest.js";

const route: CacheabilityManifestRoute = {
  kind: "app-page",
  pattern: "/products/:id",
  state: "static-candidate",
};
const key = cacheabilityManifestRouteKey(route.kind, route.pattern);

describe("cacheability manifest", () => {
  it("accepts only the expected build and route-pattern key", () => {
    const raw = JSON.stringify({ buildId: "build-a", routes: { [key]: route }, version: 1 });
    const manifest = parseCacheabilityManifest(raw, "build-a");
    expect(manifest).not.toBeNull();
    expect(findCacheabilityManifestRoute(manifest!, "app-page", "/products/:id")).toEqual(route);
    expect(findCacheabilityManifestRoute(manifest!, "app-page", "/other/:id")).toBeNull();
    expect(parseCacheabilityManifest(raw, "build-b")).toBeNull();
  });

  it("keeps App and Pages routes with the same pattern isolated", () => {
    const pagesRoute: CacheabilityManifestRoute = { ...route, kind: "pages-page" };
    const pagesKey = cacheabilityManifestRouteKey(pagesRoute.kind, pagesRoute.pattern);
    const manifest = parseCacheabilityManifest(
      JSON.stringify({
        buildId: "build-a",
        routes: { [key]: route, [pagesKey]: pagesRoute },
        version: 1,
      }),
      "build-a",
    );
    expect(findCacheabilityManifestRoute(manifest!, "pages-page", "/products/:id")).toEqual(
      pagesRoute,
    );
  });

  it("accepts an exact App Route Handler identity", () => {
    const appRoute: CacheabilityManifestRoute = {
      ...route,
      kind: "app-route",
    };
    const appRouteKey = cacheabilityManifestRouteKey(appRoute.kind, appRoute.pattern);
    const manifest = parseCacheabilityManifest(
      JSON.stringify({ buildId: "build-a", routes: { [appRouteKey]: appRoute }, version: 1 }),
      "build-a",
    );
    expect(findCacheabilityManifestRoute(manifest!, "app-route", appRoute.pattern)).toEqual(
      appRoute,
    );
  });

  it("rejects malformed routes instead of partially trusting a manifest", () => {
    expect(
      parseCacheabilityManifest(
        JSON.stringify({
          buildId: "build-a",
          routes: { [key]: { ...route, pattern: "/different" } },
          version: 1,
        }),
        "build-a",
      ),
    ).toBeNull();
  });

  it("authorizes only exact concrete static paths for a dynamic pattern", () => {
    const mixedRoute: CacheabilityManifestRoute = {
      ...route,
      pathPrefix: "/products/",
      runtimePaths: ["dynamic"],
      state: "runtime-check",
      staticPaths: { html: ["static"] },
    };
    const manifest = parseCacheabilityManifest(
      JSON.stringify({ buildId: "build-a", routes: { [key]: mixedRoute }, version: 1 }),
      "build-a",
    );
    const parsed = findCacheabilityManifestRoute(manifest!, route.kind, route.pattern)!;
    expect(cacheabilityManifestRouteState(parsed, "/products/static", "html")).toBe(
      "static-candidate",
    );
    expect(cacheabilityManifestRouteState(parsed, "/products/static", "rsc-full")).toBe(
      "runtime-check",
    );
    expect(cacheabilityManifestRouteState(parsed, "/products/dynamic?preview=1", "html")).toBe(
      "runtime-check",
    );
    expect(cacheabilityManifestRouteState(parsed, "/products/unlisted")).toBeNull();

    for (const staticPaths of [[], ["z", "a"], ["a", "a"]]) {
      expect(
        parseCacheabilityManifest(
          JSON.stringify({
            buildId: "build-a",
            routes: {
              [key]: {
                ...route,
                pathPrefix: "/products/",
                state: "runtime-check",
                staticPaths: { html: staticPaths },
              },
            },
            version: 1,
          }),
          "build-a",
        ),
      ).toBeNull();
    }
    for (const malformedRoute of [
      {
        ...mixedRoute,
        runtimePaths: ["static"],
      },
      {
        ...mixedRoute,
        pathPrefix: "/products?scope=wrong",
      },
      {
        ...mixedRoute,
        runtimePaths: ["../outside"],
      },
    ]) {
      expect(
        parseCacheabilityManifest(
          JSON.stringify({
            buildId: "build-a",
            routes: { [key]: malformedRoute },
            version: 1,
          }),
          "build-a",
        ),
      ).toBeNull();
    }

    const allStaticRoute: CacheabilityManifestRoute = {
      ...mixedRoute,
      allowUnknown: true,
      runtimePaths: undefined,
      unknownState: "static-candidate",
    };
    expect(cacheabilityManifestRouteState(allStaticRoute, "/products/unlisted", "html")).toBe(
      "static-candidate",
    );
    expect(cacheabilityManifestRouteState(allStaticRoute, "/products/static", "rsc-full")).toBe(
      "runtime-check",
    );
    expect(
      parseCacheabilityManifest(
        JSON.stringify({
          buildId: "build-a",
          routes: { [key]: { ...allStaticRoute, allowUnknown: undefined } },
          version: 1,
        }),
        "build-a",
      ),
    ).toBeNull();
  });

  it("certifies one path under each representation of its static render", () => {
    const promotedRoute: CacheabilityManifestRoute = {
      ...route,
      pathPrefix: "/products/",
      runtimePaths: ["dynamic"],
      state: "runtime-check",
      staticPaths: { html: ["static"], "rsc-full": ["static"], "rsc-loading-shell": ["static"] },
    };
    const manifest = parseCacheabilityManifest(
      JSON.stringify({ buildId: "build-a", routes: { [key]: promotedRoute }, version: 1 }),
      "build-a",
    );
    expect(manifest).not.toBeNull();
    const parsed = findCacheabilityManifestRoute(manifest!, route.kind, route.pattern)!;
    for (const representation of ["html", "rsc-full", "rsc-loading-shell"] as const) {
      expect(cacheabilityManifestRouteState(parsed, "/products/static", representation)).toBe(
        "static-candidate",
      );
    }

    // A path is still listed once per list, and never both runtime-checked and static.
    for (const malformedRoute of [
      { ...promotedRoute, staticPaths: { html: ["static"], "rsc-full": ["dynamic"] } },
      { ...promotedRoute, staticPaths: { html: ["static"], "rsc-full": ["static", "static"] } },
    ]) {
      expect(
        parseCacheabilityManifest(
          JSON.stringify({ buildId: "build-a", routes: { [key]: malformedRoute }, version: 1 }),
          "build-a",
        ),
      ).toBeNull();
    }
  });

  it("maps Pages data and HTML requests to one concrete route pathname", () => {
    expect(cacheabilityRoutePathname("/docs/products/one?currency=gbp", "html")).toBe(
      "/docs/products/one",
    );
    expect(
      cacheabilityRoutePathname(
        "/docs/_next/data/build-a/products/one.json?currency=gbp",
        "pages-data",
      ),
    ).toBe("/docs/products/one");
    expect(cacheabilityRoutePathname("/_next/data/build-a/index.json", "pages-data")).toBe("/");
    expect(cacheabilityRoutePathname("/docs/products/one?_rsc", "rsc-full")).toBe(
      "/docs/products/one",
    );
    expect(cacheabilityRoutePathname("/docs/products/one.rsc", "rsc-full")).toBe(
      "/docs/products/one",
    );
  });

  it("supports a representation-specific proof for a literal route", () => {
    const literal: CacheabilityManifestRoute = {
      kind: "app-page",
      pattern: "/about",
      state: "runtime-check",
      staticRepresentation: "html",
    };
    const literalKey = cacheabilityManifestRouteKey(literal.kind, literal.pattern);
    const manifest = parseCacheabilityManifest(
      JSON.stringify({ buildId: "build-a", routes: { [literalKey]: literal }, version: 1 }),
      "build-a",
    );
    expect(manifest).not.toBeNull();
    expect(cacheabilityManifestRouteState(literal, "/about", "html")).toBe("static-candidate");
    expect(cacheabilityManifestRouteState(literal, "/about", "rsc-full")).toBe("runtime-check");

    expect(
      parseCacheabilityManifest(
        JSON.stringify({
          buildId: "build-a",
          routes: {
            [key]: { ...route, state: "runtime-check", staticRepresentation: "html" },
          },
          version: 1,
        }),
        "build-a",
      ),
    ).toBeNull();
  });

  it("authorizes only the runtime representation certified for a whole pattern", () => {
    const shellRoute: CacheabilityManifestRoute = {
      kind: "app-page",
      pattern: "/posts/:slug",
      runtimeRepresentation: "rsc-loading-shell",
      state: "runtime-check",
    };
    const shellKey = cacheabilityManifestRouteKey(shellRoute.kind, shellRoute.pattern);
    expect(
      parseCacheabilityManifest(
        JSON.stringify({ buildId: "build-a", routes: { [shellKey]: shellRoute }, version: 1 }),
        "build-a",
      ),
    ).not.toBeNull();
    expect(cacheabilityManifestRouteState(shellRoute, "/posts/one", "rsc-loading-shell")).toBe(
      "runtime-check",
    );
    expect(cacheabilityManifestRouteState(shellRoute, "/posts/one", "rsc-full")).toBeNull();
    expect(cacheabilityManifestRouteState(shellRoute, "/posts/one", "html")).toBeNull();
  });

  it("authorizes a runtime representation only at its listed paths", () => {
    const mixedRoute: CacheabilityManifestRoute = {
      kind: "app-page",
      pathPrefix: "/posts/",
      pattern: "/posts/:slug",
      runtimeRepresentationPaths: { "rsc-loading-shell": ["two"] },
      state: "runtime-check",
      staticPaths: { html: ["one"], "rsc-full": ["one"], "rsc-loading-shell": ["one"] },
    };
    const mixedKey = cacheabilityManifestRouteKey(mixedRoute.kind, mixedRoute.pattern);
    const parse = (value: CacheabilityManifestRoute) =>
      parseCacheabilityManifest(
        JSON.stringify({ buildId: "build-a", routes: { [mixedKey]: value }, version: 1 }),
        "build-a",
      );
    expect(parse(mixedRoute)?.routes[mixedKey]).toEqual(mixedRoute);
    expect(cacheabilityManifestRouteState(mixedRoute, "/posts/two", "rsc-loading-shell")).toBe(
      "runtime-check",
    );
    expect(cacheabilityManifestRouteState(mixedRoute, "/posts/two", "rsc-full")).toBeNull();
    expect(cacheabilityManifestRouteState(mixedRoute, "/posts/two", "html")).toBeNull();
    expect(cacheabilityManifestRouteState(mixedRoute, "/posts/one", "rsc-loading-shell")).toBe(
      "static-candidate",
    );
    expect(
      cacheabilityManifestRouteState(mixedRoute, "/posts/three", "rsc-loading-shell"),
    ).toBeNull();
    // A path is never both representation-only and runtime-checked or static.
    expect(parse({ ...mixedRoute, runtimePaths: ["two"] })).toBeNull();
    expect(
      parse({ ...mixedRoute, runtimeRepresentationPaths: { "rsc-loading-shell": ["one"] } }),
    ).toBeNull();
    expect(
      parse({
        kind: "app-page",
        pattern: "/posts/:slug",
        runtimeRepresentation: "rsc-loading-shell",
        runtimeRepresentationPaths: { "rsc-loading-shell": ["/posts/two"] },
        state: "runtime-check",
      }),
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
    expect(
      cacheabilityRequestIdentity(new Request("https://example.com/api/products/one")),
    ).toEqual({ representation: "app-route", requestKey: "/api/products/one" });
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
