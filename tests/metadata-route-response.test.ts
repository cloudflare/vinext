import { describe, expect, it, beforeAll, afterAll } from "vite-plus/test";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createBuilder } from "vite";
import vinext from "../packages/vinext/src/index.js";
import { runPrerender } from "../packages/vinext/src/build/run-prerender.js";
import {
  getPrerenderableMetadataRoutePaths,
  handleMetadataRouteRequest,
} from "../packages/vinext/src/server/metadata-route-response.js";
import type { MetadataFileRoute } from "../packages/vinext/src/server/metadata-routes.js";
import { withEnvVar } from "./env-test-helpers.js";
import { addCollectedRequestTags } from "../packages/vinext/src/shims/fetch-cache.js";
import { _setRequestScopedCacheLife } from "../packages/vinext/src/shims/cache-request-state.js";
import {
  createRequestContext,
  runWithRequestContext,
} from "../packages/vinext/src/shims/unified-request-context.js";
import { registerCachedFunction } from "../packages/vinext/src/shims/cache-runtime.js";
import type { IsrWritePolicy } from "../packages/vinext/src/server/isr-cache.js";
import { createIsolatedFixture } from "./helpers.js";

type MetadataRuntimeRoute = MetadataFileRoute & {
  fileDataBase64?: string;
};

function makeThenableParams(params: Record<string, string | string[]>): unknown {
  return Object.assign(Promise.resolve(params), params);
}

function markUseCache<T extends (...args: never[]) => unknown>(fn: T): T {
  Reflect.set(fn, Symbol.for("vinext.useCacheFunction"), true);
  return fn;
}

describe("handleMetadataRouteRequest", () => {
  it("enumerates prerenderable metadata route paths", async () => {
    // Ported from Next.js:
    // test/e2e/app-dir/use-cache-metadata-route-handler/use-cache-metadata-route-handler.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/use-cache-metadata-route-handler/use-cache-metadata-route-handler.test.ts
    const routes = [
      {
        type: "sitemap",
        isDynamic: true,
        filePath: "/tmp/app/sitemap.ts",
        routePrefix: "",
        routeSegments: [],
        servedUrl: "/sitemap.xml",
        contentType: "application/xml",
        module: { default: markUseCache(async () => []) },
      },
      {
        type: "sitemap",
        isDynamic: true,
        filePath: "/tmp/app/products/sitemap.ts",
        routePrefix: "/products",
        routeSegments: ["products"],
        servedUrl: "/products/sitemap.xml",
        contentType: "application/xml",
        module: {
          generateSitemaps: async () => [{ id: 0 }, { id: "one" }],
          default: markUseCache(async () => []),
        },
      },
      {
        type: "robots",
        isDynamic: true,
        filePath: "/tmp/app/robots.ts",
        routePrefix: "",
        routeSegments: [],
        servedUrl: "/robots.txt",
        contentType: "text/plain",
        module: { default: markUseCache(async () => ({})) },
      },
      {
        type: "manifest",
        isDynamic: true,
        filePath: "/tmp/app/manifest.ts",
        routePrefix: "",
        routeSegments: [],
        servedUrl: "/manifest.webmanifest",
        contentType: "application/manifest+json",
        module: { default: markUseCache(async () => ({})) },
      },
      {
        type: "icon",
        isDynamic: true,
        filePath: "/tmp/app/icon.tsx",
        routePrefix: "",
        routeSegments: [],
        servedUrl: "/icon",
        contentType: "image/png",
        module: { default: async () => new Response("icon") },
      },
    ] satisfies MetadataFileRoute[];

    await expect(getPrerenderableMetadataRoutePaths(routes)).resolves.toEqual([
      { path: "/sitemap.xml", routePattern: "/sitemap.xml", routeSegments: [] },
      {
        path: "/products/sitemap/0.xml",
        routePattern: "/products/sitemap.xml",
        routeSegments: ["products"],
      },
      {
        path: "/products/sitemap/one.xml",
        routePattern: "/products/sitemap.xml",
        routeSegments: ["products"],
      },
      { path: "/robots.txt", routePattern: "/robots.txt", routeSegments: [] },
      {
        path: "/manifest.webmanifest",
        routePattern: "/manifest.webmanifest",
        routeSegments: [],
      },
      { path: "/icon", routePattern: "/icon", routeSegments: [] },
    ]);
  });

  it("enumerates generated image metadata ids for prerendering", async () => {
    const routes = [
      {
        type: "icon",
        isDynamic: true,
        filePath: "/tmp/app/icon.tsx",
        routePrefix: "",
        routeSegments: [],
        servedUrl: "/icon",
        contentType: "image/png",
        module: {
          generateImageMetadata: async () => [{ id: "small" }, { id: "large" }],
          default: async () => new Response("icon"),
        },
      },
      {
        type: "opengraph-image",
        isDynamic: true,
        filePath: "/tmp/app/opengraph-image.tsx",
        routePrefix: "",
        routeSegments: [],
        servedUrl: "/opengraph-image",
        contentType: "image/png",
        module: {
          generateImageMetadata: async () => [{ id: "default" }],
          default: async () => new Response("og"),
        },
      },
    ] satisfies MetadataFileRoute[];

    await expect(getPrerenderableMetadataRoutePaths(routes)).resolves.toEqual([
      { path: "/icon/small", routePattern: "/icon", routeSegments: [] },
      { path: "/icon/large", routePattern: "/icon", routeSegments: [] },
      { path: "/opengraph-image/default", routePattern: "/opengraph-image", routeSegments: [] },
    ]);
  });

  it("skips invalid generated image metadata ids when enumerating prerender paths", async () => {
    const routes = [
      {
        type: "icon",
        isDynamic: true,
        filePath: "/tmp/app/icon.tsx",
        routePrefix: "",
        routeSegments: [],
        servedUrl: "/icon",
        contentType: "image/png",
        module: {
          generateImageMetadata: async () => [
            { id: "valid" },
            { id: "bad/id" },
            { id: "" },
            { id: "bad id" },
            { id: "bad:id" },
            { id: "also-valid" },
            { id: "unicode-\u4e2d\u6587" },
          ],
          default: async () => new Response("icon"),
        },
      },
    ] satisfies MetadataFileRoute[];

    await expect(getPrerenderableMetadataRoutePaths(routes)).resolves.toEqual([
      { path: "/icon/valid", routePattern: "/icon", routeSegments: [] },
      { path: "/icon/also-valid", routePattern: "/icon", routeSegments: [] },
    ]);
  });

  it("throws when generateImageMetadata returns an entry without id", async () => {
    const routes = [
      {
        type: "icon",
        isDynamic: true,
        filePath: "/tmp/app/icon.tsx",
        routePrefix: "",
        routeSegments: [],
        servedUrl: "/icon",
        contentType: "image/png",
        module: {
          generateImageMetadata: async () => [{}],
          default: async () => new Response("icon"),
        },
      },
    ] satisfies MetadataFileRoute[];

    await expect(getPrerenderableMetadataRoutePaths(routes)).rejects.toThrow(
      "id property is required for every item returned from generateImageMetadata",
    );
  });

  it("skips metadata image routes with dynamic segments when enumerating prerender paths", async () => {
    const routes = [
      {
        type: "opengraph-image",
        isDynamic: true,
        filePath: "/tmp/app/blog/[slug]/opengraph-image.tsx",
        routePrefix: "/blog/[slug]",
        routeSegments: ["blog", "[slug]"],
        servedUrl: "/blog/[slug]/opengraph-image",
        contentType: "image/png",
        module: {
          generateImageMetadata: async () => [{ id: "default" }],
          default: async () => new Response("og"),
        },
      },
    ] satisfies MetadataFileRoute[];

    await expect(getPrerenderableMetadataRoutePaths(routes)).resolves.toEqual([]);
  });

  it("skips metadata image routes whose generateImageMetadata returns a non-array", async () => {
    const routes = [
      {
        type: "icon",
        isDynamic: true,
        filePath: "/tmp/app/icon.tsx",
        routePrefix: "",
        routeSegments: [],
        servedUrl: "/icon",
        contentType: "image/png",
        module: {
          generateImageMetadata: async () => null,
          default: async () => new Response("icon"),
        },
      },
    ] satisfies MetadataFileRoute[];

    await expect(getPrerenderableMetadataRoutePaths(routes)).resolves.toEqual([]);
  });

  it("returns no paths for metadata image routes with empty generateImageMetadata", async () => {
    const routes = [
      {
        type: "icon",
        isDynamic: true,
        filePath: "/tmp/app/icon.tsx",
        routePrefix: "",
        routeSegments: [],
        servedUrl: "/icon",
        contentType: "image/png",
        module: {
          generateImageMetadata: async () => [],
          default: async () => new Response("icon"),
        },
      },
    ] satisfies MetadataFileRoute[];

    await expect(getPrerenderableMetadataRoutePaths(routes)).resolves.toEqual([]);
  });

  it("preserves valid special characters in generated image metadata ids", async () => {
    const routes = [
      {
        type: "icon",
        isDynamic: true,
        filePath: "/tmp/app/icon.tsx",
        routePrefix: "",
        routeSegments: [],
        servedUrl: "/icon",
        contentType: "image/png",
        module: {
          generateImageMetadata: async () => [{ id: "my.id" }, { id: "my_id" }, { id: "my-id" }],
          default: async () => new Response("icon"),
        },
      },
    ] satisfies MetadataFileRoute[];

    await expect(getPrerenderableMetadataRoutePaths(routes)).resolves.toEqual([
      { path: "/icon/my.id", routePattern: "/icon", routeSegments: [] },
      { path: "/icon/my_id", routePattern: "/icon", routeSegments: [] },
      { path: "/icon/my-id", routePattern: "/icon", routeSegments: [] },
    ]);
  });

  it("skips metadata image routes without a default export", async () => {
    const routes = [
      {
        type: "icon",
        isDynamic: true,
        filePath: "/tmp/app/icon.tsx",
        routePrefix: "",
        routeSegments: [],
        servedUrl: "/icon",
        contentType: "image/png",
        module: {
          generateImageMetadata: async () => [{ id: "small" }],
        },
      },
    ] satisfies MetadataFileRoute[];

    await expect(getPrerenderableMetadataRoutePaths(routes)).resolves.toEqual([]);
  });

  it("enumerates numeric generated image metadata ids", async () => {
    const routes = [
      {
        type: "icon",
        isDynamic: true,
        filePath: "/tmp/app/icon.tsx",
        routePrefix: "",
        routeSegments: [],
        servedUrl: "/icon",
        contentType: "image/png",
        module: {
          generateImageMetadata: async () => [{ id: 0 }, { id: 1 }],
          default: async () => new Response("icon"),
        },
      },
    ] satisfies MetadataFileRoute[];

    await expect(getPrerenderableMetadataRoutePaths(routes)).resolves.toEqual([
      { path: "/icon/0", routePattern: "/icon", routeSegments: [] },
      { path: "/icon/1", routePattern: "/icon", routeSegments: [] },
    ]);
  });

  it("enumerates generated image metadata ids for all image route types", async () => {
    const routes = [
      {
        type: "apple-icon",
        isDynamic: true,
        filePath: "/tmp/app/apple-icon.tsx",
        routePrefix: "",
        routeSegments: [],
        servedUrl: "/apple-icon",
        contentType: "image/png",
        module: {
          generateImageMetadata: async () => [{ id: "touch" }],
          default: async () => new Response("apple-icon"),
        },
      },
      {
        type: "twitter-image",
        isDynamic: true,
        filePath: "/tmp/app/twitter-image.tsx",
        routePrefix: "",
        routeSegments: [],
        servedUrl: "/twitter-image",
        contentType: "image/png",
        module: {
          generateImageMetadata: async () => [{ id: "card" }],
          default: async () => new Response("twitter-image"),
        },
      },
    ] satisfies MetadataFileRoute[];

    await expect(getPrerenderableMetadataRoutePaths(routes)).resolves.toEqual([
      { path: "/apple-icon/touch", routePattern: "/apple-icon", routeSegments: [] },
      { path: "/twitter-image/card", routePattern: "/twitter-image", routeSegments: [] },
    ]);
  });

  it("skips metadata routes with dynamic = 'force-dynamic' when enumerating prerender paths", async () => {
    const routes = [
      {
        type: "robots",
        isDynamic: true,
        filePath: "/tmp/app/robots.ts",
        routePrefix: "",
        routeSegments: [],
        servedUrl: "/robots.txt",
        contentType: "text/plain",
        module: {
          dynamic: "force-dynamic",
          default: async () => {
            throw new Error(
              "force-dynamic metadata route must not execute during prerender enumeration",
            );
          },
        },
      },
    ] satisfies MetadataFileRoute[];

    await expect(getPrerenderableMetadataRoutePaths(routes)).resolves.toEqual([]);
  });

  it("skips metadata routes with revalidate = 0 when enumerating prerender paths", async () => {
    const routes = [
      {
        type: "icon",
        isDynamic: true,
        filePath: "/tmp/app/icon.tsx",
        routePrefix: "",
        routeSegments: [],
        servedUrl: "/icon",
        contentType: "image/png",
        module: {
          revalidate: 0,
          default: async () => {
            throw new Error(
              "revalidate=0 metadata route must not execute during prerender enumeration",
            );
          },
        },
      },
    ] satisfies MetadataFileRoute[];

    await expect(getPrerenderableMetadataRoutePaths(routes)).resolves.toEqual([]);
  });

  it("publishes collected cache tags for prerender seeding", async () => {
    const response = await withEnvVar("VINEXT_PRERENDER", "1", () =>
      runWithRequestContext(createRequestContext(), () =>
        handleMetadataRouteRequest({
          cleanPathname: "/robots.txt",
          makeThenableParams,
          metadataRoutes: [
            {
              type: "robots",
              isDynamic: true,
              filePath: "/tmp/app/robots.ts",
              routePrefix: "",
              routeSegments: [],
              servedUrl: "/robots.txt",
              contentType: "text/plain",
              module: {
                default: markUseCache(async () => {
                  addCollectedRequestTags(["metadata-user-tag"]);
                  _setRequestScopedCacheLife({ revalidate: 60, expire: 300, stale: 30 });
                  return { rules: { userAgent: "*" } };
                }),
              },
            },
          ],
        }),
      ),
    );

    expect(response?.headers.get("x-next-cache-tags")).toBe("metadata-user-tag");
    expect(response?.headers.get("x-vinext-prerender-cache-life")).toBe(
      '{"revalidate":60,"expire":300,"stale":30}',
    );
  });

  it("still enumerates metadata routes with a positive revalidate for prerendering", async () => {
    const routes = [
      {
        type: "robots",
        isDynamic: true,
        filePath: "/tmp/app/robots.ts",
        routePrefix: "",
        routeSegments: [],
        servedUrl: "/robots.txt",
        contentType: "text/plain",
        module: {
          revalidate: 60,
          default: async () => ({ rules: { userAgent: "*" } }),
        },
      },
    ] satisfies MetadataFileRoute[];

    await expect(getPrerenderableMetadataRoutePaths(routes)).resolves.toEqual([
      { path: "/robots.txt", routePattern: "/robots.txt", routeSegments: [] },
    ]);
  });

  it("applies exported revalidate interval to metadata prerender cache life header", async () => {
    const response = await withEnvVar("VINEXT_PRERENDER", "1", () =>
      runWithRequestContext(createRequestContext(), () =>
        handleMetadataRouteRequest({
          cleanPathname: "/robots.txt",
          makeThenableParams,
          metadataRoutes: [
            {
              type: "robots",
              isDynamic: true,
              filePath: "/tmp/app/robots.ts",
              routePrefix: "",
              routeSegments: [],
              servedUrl: "/robots.txt",
              contentType: "text/plain",
              module: {
                revalidate: 60,
                default: async () => ({ rules: { userAgent: "*" } }),
              },
            },
          ],
        }),
      ),
    );

    expect(response?.headers.get("x-vinext-prerender-cache-life")).toBe(
      JSON.stringify({ revalidate: 60 }),
    );
  });

  it("applies exported revalidate interval to metadata runtime cache write policy", async () => {
    const writes: IsrWritePolicy[] = [];
    const response = await handleMetadataRouteRequest({
      cleanPathname: "/robots.txt",
      isrRouteKey: (pathname) => pathname,
      async isrGet() {
        return null;
      },
      async isrSet(_key, _value, policy) {
        writes.push(policy);
      },
      makeThenableParams,
      metadataRoutes: [
        {
          type: "robots",
          isDynamic: true,
          filePath: "/tmp/app/robots.ts",
          routePrefix: "",
          routeSegments: [],
          servedUrl: "/robots.txt",
          contentType: "text/plain",
          module: {
            revalidate: 60,
            default: async () => ({ rules: { userAgent: "*" } }),
          },
        },
      ],
    });

    expect(response?.status).toBe(200);
    expect(writes).toHaveLength(1);
    expect(writes[0].cacheControl.revalidate).toBe(60);
  });

  it("preserves revalidate=false for runtime metadata cache writes", async () => {
    const writes: IsrWritePolicy[] = [];
    const response = await handleMetadataRouteRequest({
      cleanPathname: "/robots.txt",
      isrRouteKey: (pathname) => pathname,
      async isrGet() {
        return null;
      },
      async isrSet(_key, _value, policy) {
        writes.push(policy);
      },
      makeThenableParams,
      metadataRoutes: [
        {
          type: "robots",
          isDynamic: true,
          filePath: "/tmp/app/robots.ts",
          routePrefix: "",
          routeSegments: [],
          servedUrl: "/robots.txt",
          contentType: "text/plain",
          module: {
            revalidate: false,
            default: async () => ({ rules: { userAgent: "*" } }),
          },
        },
      ],
    });

    expect(response?.status).toBe(200);
    expect(writes).toHaveLength(1);
    expect(writes[0].cacheControl.revalidate).toBe(false);
  });

  it("lets internal cacheLife win over exported revalidate=false", async () => {
    const writes: IsrWritePolicy[] = [];
    const response = await runWithRequestContext(createRequestContext(), () =>
      handleMetadataRouteRequest({
        cleanPathname: "/robots.txt",
        isrRouteKey: (pathname) => pathname,
        async isrGet() {
          return null;
        },
        async isrSet(_key, _value, policy) {
          writes.push(policy);
        },
        makeThenableParams,
        metadataRoutes: [
          {
            type: "robots",
            isDynamic: true,
            filePath: "/tmp/app/robots.ts",
            routePrefix: "",
            routeSegments: [],
            servedUrl: "/robots.txt",
            contentType: "text/plain",
            module: {
              revalidate: false,
              default: async () => {
                _setRequestScopedCacheLife({ revalidate: 60 });
                return { rules: { userAgent: "*" } };
              },
            },
          },
        ],
      }),
    );

    expect(response?.status).toBe(200);
    expect(writes).toHaveLength(1);
    expect(writes[0].cacheControl.revalidate).toBe(60);
  });

  it("falls back to the default cache life when no revalidate is exported", async () => {
    const writes: IsrWritePolicy[] = [];
    const response = await handleMetadataRouteRequest({
      cleanPathname: "/robots.txt",
      isrRouteKey: (pathname) => pathname,
      async isrGet() {
        return null;
      },
      async isrSet(_key, _value, policy) {
        writes.push(policy);
      },
      makeThenableParams,
      metadataRoutes: [
        {
          type: "robots",
          isDynamic: true,
          filePath: "/tmp/app/robots.ts",
          routePrefix: "",
          routeSegments: [],
          servedUrl: "/robots.txt",
          contentType: "text/plain",
          module: {
            default: async () => ({ rules: { userAgent: "*" } }),
          },
        },
      ],
    });

    expect(response?.status).toBe(200);
    expect(writes).toHaveLength(1);
    expect(writes[0].cacheControl.revalidate).toBe(900);
  });

  it("applies cache life declared inside metadata route default export to runtime cache write policy", async () => {
    const writes: IsrWritePolicy[] = [];
    const response = await runWithRequestContext(createRequestContext(), () =>
      handleMetadataRouteRequest({
        cleanPathname: "/robots.txt",
        isrRouteKey: (pathname) => pathname,
        async isrGet() {
          return null;
        },
        async isrSet(_key, _value, policy) {
          writes.push(policy);
        },
        makeThenableParams,
        metadataRoutes: [
          {
            type: "robots",
            isDynamic: true,
            filePath: "/tmp/app/robots.ts",
            routePrefix: "",
            routeSegments: [],
            servedUrl: "/robots.txt",
            contentType: "text/plain",
            module: {
              default: async () => {
                _setRequestScopedCacheLife({ revalidate: 60, expire: 300, stale: 30 });
                return { rules: { userAgent: "*" } };
              },
            },
          },
        ],
      }),
    );

    expect(response?.status).toBe(200);
    expect(writes).toHaveLength(1);
    expect(writes[0].cacheControl).toEqual({
      revalidate: 60,
      expire: 300,
      stale: 30,
    });
  });

  it("does not replay an unrelated cached App Route response as metadata", async () => {
    const response = await handleMetadataRouteRequest({
      cleanPathname: "/api/cached",
      isrRouteKey: (pathname) => pathname,
      async isrGet() {
        throw new Error("unrelated paths must not query the metadata cache");
      },
      makeThenableParams,
      metadataRoutes: [
        {
          type: "robots",
          isDynamic: true,
          filePath: "/tmp/app/robots.ts",
          routePrefix: "",
          routeSegments: [],
          servedUrl: "/robots.txt",
          contentType: "text/plain",
          module: { default: async () => ({ rules: { userAgent: "*" } }) },
        },
      ],
    });

    expect(response).toBeNull();
  });

  it("replays a matched cached response without invoking the metadata function", async () => {
    const response = await handleMetadataRouteRequest({
      cleanPathname: "/robots.txt",
      isrRouteKey: (pathname) => pathname,
      async isrGet(key) {
        expect(key).toBe("/robots.txt");
        return {
          isStale: false,
          value: {
            lastModified: 1,
            value: {
              kind: "APP_ROUTE",
              body: new TextEncoder().encode("User-Agent: *\nAllow: /buildtime\n").buffer,
              headers: {
                "content-type": "text/plain",
                "x-next-cache-tags": "private-tag",
                "x-vinext-metadata-route-cache": "1",
              },
              status: 200,
            },
          },
        };
      },
      makeThenableParams,
      metadataRoutes: [
        {
          type: "robots",
          isDynamic: true,
          filePath: "/tmp/app/robots.ts",
          routePrefix: "",
          routeSegments: [],
          servedUrl: "/robots.txt",
          contentType: "text/plain",
          module: {
            default: async () => {
              throw new Error("cached metadata must not execute at runtime");
            },
          },
        },
      ],
    });

    expect(await response?.text()).toContain("/buildtime");
    expect(response?.headers.get("x-next-cache-tags")).toBeNull();
    expect(response?.headers.has("x-vinext-metadata-route-cache")).toBe(false);
  });

  it("does not add an outer metadata cache around shared use-cache functions in development", async () => {
    let metadataCalls = 0;
    let outerReads = 0;
    let outerWrites = 0;
    const responses = await withEnvVar("NODE_ENV", "development", async () => {
      const defaultExport = registerCachedFunction(async () => {
        metadataCalls++;
        return { rules: { userAgent: "*", allow: `/runtime-${metadataCalls}` } };
      }, "test:metadata-dev-bypass");
      const route = {
        type: "robots",
        isDynamic: true,
        filePath: "/tmp/app/robots.ts",
        routePrefix: "",
        routeSegments: [],
        servedUrl: "/robots.txt",
        contentType: "text/plain",
        module: { default: defaultExport },
      } satisfies MetadataFileRoute;
      const request = () =>
        runWithRequestContext(createRequestContext(), () =>
          handleMetadataRouteRequest({
            cleanPathname: "/robots.txt",
            async isrGet() {
              outerReads++;
              return null;
            },
            isrRouteKey: (pathname) => pathname,
            async isrSet() {
              outerWrites++;
            },
            makeThenableParams,
            metadataRoutes: [route],
            scheduleBackgroundRegeneration() {
              throw new Error("development metadata must not schedule ISR regeneration");
            },
          }),
        );
      return [await request(), await request()];
    });

    expect(metadataCalls).toBe(2);
    expect(outerReads).toBe(0);
    expect(outerWrites).toBe(0);
    expect(await responses[0]?.text()).toContain("/runtime-1");
    expect(await responses[1]?.text()).toContain("/runtime-2");
  });

  for (const cacheControl of ["no-store", "no-cache"]) {
    it(`does not admit runtime metadata responses with Cache-Control: ${cacheControl}`, async () => {
      let outerWrites = 0;
      const response = await handleMetadataRouteRequest({
        cleanPathname: "/icon",
        async isrGet() {
          return null;
        },
        isrRouteKey: (pathname) => pathname,
        async isrSet() {
          outerWrites++;
        },
        makeThenableParams,
        metadataRoutes: [
          {
            type: "icon",
            isDynamic: true,
            filePath: "/tmp/app/icon.tsx",
            routePrefix: "",
            routeSegments: [],
            servedUrl: "/icon",
            contentType: "image/png",
            module: {
              default: markUseCache(
                async () =>
                  new Response("dynamic image", {
                    headers: { "cache-control": cacheControl, "content-type": "image/png" },
                  }),
              ),
            },
          },
        ],
      });

      expect(response?.headers.get("cache-control")).toBe(cacheControl);
      expect(await response?.text()).toBe("dynamic image");
      expect(outerWrites).toBe(0);
    });
  }

  it("treats metadata routes with dynamic = 'force-dynamic' as explicitly dynamic", async () => {
    let outerWrites = 0;
    const response = await handleMetadataRouteRequest({
      cleanPathname: "/robots.txt",
      async isrGet() {
        return null;
      },
      isrRouteKey: (pathname) => pathname,
      async isrSet() {
        outerWrites++;
      },
      makeThenableParams,
      metadataRoutes: [
        {
          type: "robots",
          isDynamic: true,
          filePath: "/tmp/app/robots.ts",
          routePrefix: "",
          routeSegments: [],
          servedUrl: "/robots.txt",
          contentType: "text/plain",
          module: {
            dynamic: "force-dynamic",
            default: markUseCache(async () => ({ rules: { userAgent: "*" } })),
          },
        },
      ],
    });

    expect(response?.status).toBe(200);
    expect(response?.headers.get("cache-control")).toBe(
      "private, no-cache, no-store, max-age=0, must-revalidate",
    );
    expect(outerWrites).toBe(0);
  });

  it("treats metadata routes with revalidate = 0 as explicitly dynamic", async () => {
    let outerWrites = 0;
    const response = await handleMetadataRouteRequest({
      cleanPathname: "/robots.txt",
      async isrGet() {
        return null;
      },
      isrRouteKey: (pathname) => pathname,
      async isrSet() {
        outerWrites++;
      },
      makeThenableParams,
      metadataRoutes: [
        {
          type: "robots",
          isDynamic: true,
          filePath: "/tmp/app/robots.ts",
          routePrefix: "",
          routeSegments: [],
          servedUrl: "/robots.txt",
          contentType: "text/plain",
          module: {
            revalidate: 0,
            default: markUseCache(async () => ({ rules: { userAgent: "*" } })),
          },
        },
      ],
    });

    expect(response?.status).toBe(200);
    expect(response?.headers.get("cache-control")).toBe(
      "private, no-cache, no-store, max-age=0, must-revalidate",
    );
    expect(outerWrites).toBe(0);
  });

  it("does not replay a colliding unmarked App Route cache entry", async () => {
    let metadataCalls = 0;
    const response = await handleMetadataRouteRequest({
      cleanPathname: "/robots.txt",
      isrRouteKey: (pathname) => pathname,
      async isrGet() {
        return {
          isStale: false,
          value: {
            lastModified: 1,
            value: {
              kind: "APP_ROUTE",
              body: new TextEncoder().encode("unrelated app route").buffer,
              headers: { "content-type": "text/plain" },
              status: 200,
            },
          },
        };
      },
      makeThenableParams,
      metadataRoutes: [
        {
          type: "robots",
          isDynamic: true,
          filePath: "/tmp/app/robots.ts",
          routePrefix: "",
          routeSegments: [],
          servedUrl: "/robots.txt",
          contentType: "text/plain",
          module: {
            default: async () => {
              metadataCalls++;
              return { rules: { userAgent: "*", allow: "/runtime" } };
            },
          },
        },
      ],
    });

    expect(metadataCalls).toBe(1);
    expect(await response?.text()).toContain("/runtime");
  });

  it("serves stale metadata while regenerating its value and invalidation tags", async () => {
    let metadataCalls = 0;
    let regenerate: (() => Promise<void>) | undefined;
    const writes: Array<{
      key: string;
      policy: { cacheControl?: unknown; tags?: string[] };
      value: { headers: Record<string, string | string[]>; body: ArrayBuffer };
    }> = [];
    const defaultExport = markUseCache(async () => {
      metadataCalls++;
      addCollectedRequestTags(["metadata-user-tag"]);
      return { rules: { userAgent: "*", allow: "/regenerated" } };
    });

    const response = await handleMetadataRouteRequest({
      cleanPathname: "/robots.txt",
      isrRouteKey: (pathname) => `metadata:${pathname}`,
      async isrGet() {
        return {
          isStale: true,
          value: {
            lastModified: 1,
            cacheControl: { revalidate: 60, expire: 300, stale: 30 },
            value: {
              kind: "APP_ROUTE",
              body: new TextEncoder().encode("User-Agent: *\nAllow: /stale\n").buffer,
              headers: {
                "content-type": "text/plain",
                "x-vinext-metadata-route-cache": "1",
              },
              status: 200,
            },
          },
        };
      },
      async isrSet(key, value, policy) {
        writes.push({ key, value, policy });
      },
      makeThenableParams,
      metadataRoutes: [
        {
          type: "robots",
          isDynamic: true,
          filePath: "/tmp/app/robots.ts",
          routePrefix: "",
          routeSegments: ["robots"],
          servedUrl: "/robots.txt",
          contentType: "text/plain",
          module: { default: defaultExport },
        },
      ],
      scheduleBackgroundRegeneration(_key, renderFn) {
        regenerate = renderFn;
      },
    });

    expect(metadataCalls).toBe(0);
    expect(await response?.text()).toContain("/stale");
    expect(regenerate).toBeTypeOf("function");

    await regenerate?.();
    expect(metadataCalls).toBe(1);
    expect(writes).toHaveLength(1);
    expect(writes[0].key).toBe("metadata:/robots.txt");
    expect(writes[0].policy.cacheControl).toEqual({
      revalidate: 60,
      expire: 300,
      stale: 30,
    });
    expect(writes[0].policy.tags).toEqual(
      expect.arrayContaining([
        "/robots.txt",
        "_N_T_/robots.txt",
        "_N_T_/layout",
        "_N_T_/robots/route",
        "metadata-user-tag",
      ]),
    );
    expect(writes[0].value.headers["x-vinext-metadata-route-cache"]).toBe("1");
    expect(new TextDecoder().decode(writes[0].value.body)).toContain("/regenerated");
  });

  it("preserves stale metadata when background regeneration returns a non-ok response", async () => {
    let metadataCalls = 0;
    let regenerate: (() => Promise<void>) | undefined;
    const writes: unknown[] = [];
    const defaultExport = markUseCache(async () => {
      metadataCalls++;
      return new Response("missing", { status: 404 });
    });

    const response = await handleMetadataRouteRequest({
      cleanPathname: "/icon",
      isrRouteKey: (pathname) => `metadata:${pathname}`,
      async isrGet() {
        return {
          isStale: true,
          value: {
            lastModified: 1,
            cacheControl: { revalidate: 60 },
            value: {
              kind: "APP_ROUTE",
              body: new TextEncoder().encode("stale icon").buffer,
              headers: {
                "content-type": "image/png",
                "x-vinext-metadata-route-cache": "1",
              },
              status: 200,
            },
          },
        };
      },
      async isrSet(...args) {
        writes.push(args);
      },
      makeThenableParams,
      metadataRoutes: [
        {
          type: "icon",
          isDynamic: true,
          filePath: "/tmp/app/icon.tsx",
          routePrefix: "",
          routeSegments: ["icon"],
          servedUrl: "/icon",
          contentType: "image/png",
          module: { default: defaultExport },
        },
      ],
      scheduleBackgroundRegeneration(_key, renderFn) {
        regenerate = renderFn;
      },
    });

    expect(metadataCalls).toBe(0);
    expect(response?.status).toBe(200);
    await expect(response?.text()).resolves.toBe("stale icon");
    expect(regenerate).toBeTypeOf("function");

    await regenerate?.();
    expect(metadataCalls).toBe(1);
    expect(writes).toHaveLength(0);
  });

  it("does not inspect generateSitemaps on non-sitemap metadata routes", async () => {
    let generateSitemapsReads = 0;
    const route = {
      type: "icon",
      isDynamic: true,
      filePath: "/tmp/app/icon.tsx",
      routePrefix: "",
      routeSegments: [],
      servedUrl: "/icon",
      contentType: "image/png",
      module: {
        get generateSitemaps() {
          generateSitemapsReads++;
          return () => [];
        },
        default: () => new Response("icon", { headers: { "Content-Type": "image/png" } }),
      },
    } satisfies MetadataFileRoute;

    const response = await handleMetadataRouteRequest({
      metadataRoutes: [route],
      cleanPathname: "/icon",
      makeThenableParams,
    });

    expect(response?.status).toBe(200);
    expect(generateSitemapsReads).toBe(0);
  });

  it("serves matched static metadata route file data", async () => {
    const route = {
      type: "icon",
      isDynamic: false,
      filePath: "/tmp/app/icon.png",
      routePrefix: "",
      routeSegments: [],
      servedUrl: "/icon.png",
      contentType: "image/png",
      fileDataBase64: btoa("icon-bytes"),
    } satisfies MetadataRuntimeRoute;

    const response = await handleMetadataRouteRequest({
      metadataRoutes: [route],
      cleanPathname: "/icon.png",
      makeThenableParams,
    });

    expect(response?.status).toBe(200);
    expect(response?.headers.get("content-type")).toBe("image/png");
    expect(response?.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
    expect(
      Array.from(new Uint8Array((await response?.arrayBuffer()) ?? new ArrayBuffer(0))),
    ).toEqual([105, 99, 111, 110, 45, 98, 121, 116, 101, 115]);
  });

  it("keeps static image metadata route cache control stable in development", async () => {
    await withEnvVar("NODE_ENV", "development", async () => {
      const route = {
        type: "apple-icon",
        isDynamic: false,
        filePath: "/tmp/app/apple-icon.png",
        routePrefix: "",
        routeSegments: [],
        servedUrl: "/apple-icon.png",
        contentType: "image/png",
        fileDataBase64: btoa("icon-bytes"),
      } satisfies MetadataRuntimeRoute;

      const response = await handleMetadataRouteRequest({
        metadataRoutes: [route],
        cleanPathname: "/apple-icon.png",
        makeThenableParams,
      });

      expect(response?.status).toBe(200);
      expect(response?.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
    });
  });

  it("caches metadata route module function lookups", async () => {
    let generateImageMetadataReads = 0;
    const route = {
      type: "icon",
      isDynamic: true,
      filePath: "/tmp/app/icon.tsx",
      routePrefix: "",
      routeSegments: [],
      servedUrl: "/icon",
      contentType: "image/png",
      module: {
        get generateImageMetadata() {
          generateImageMetadataReads++;
          return () => [{ id: "small" }];
        },
        default: () => new Response("icon"),
      },
    } satisfies MetadataFileRoute;

    const firstResponse = await handleMetadataRouteRequest({
      metadataRoutes: [route],
      cleanPathname: "/icon/small",
      makeThenableParams,
    });
    const secondResponse = await handleMetadataRouteRequest({
      metadataRoutes: [route],
      cleanPathname: "/icon/small",
      makeThenableParams,
    });

    expect(firstResponse?.status).toBe(200);
    expect(secondResponse?.status).toBe(200);
    expect(generateImageMetadataReads).toBe(1);
  });

  it("checks generateSitemaps once when skipping the generated sitemap base URL", async () => {
    let generateSitemapsReads = 0;
    const route = {
      type: "sitemap",
      isDynamic: true,
      filePath: "/tmp/app/products/sitemap.ts",
      routePrefix: "/products",
      routeSegments: ["products"],
      servedUrl: "/products/sitemap.xml",
      contentType: "application/xml",
      module: {
        get generateSitemaps() {
          generateSitemapsReads++;
          return () => [{ id: 0 }];
        },
        default: () => [{ url: "https://example.com/products/0" }],
      },
    } satisfies MetadataFileRoute;

    const response = await handleMetadataRouteRequest({
      metadataRoutes: [route],
      cleanPathname: "/products/sitemap.xml",
      makeThenableParams,
    });

    expect(response).toBeNull();
    expect(generateSitemapsReads).toBe(1);
  });

  it("passes generated sitemap id as a thenable URL string id", async () => {
    let receivedPromise = false;
    let receivedSyncId: string | undefined;
    let receivedPrimitiveId: string | undefined;
    const route = {
      type: "sitemap",
      isDynamic: true,
      filePath: "/tmp/app/products/sitemap.ts",
      routePrefix: "/products",
      routeSegments: ["products"],
      servedUrl: "/products/sitemap.xml",
      contentType: "application/xml",
      module: {
        generateSitemaps: () => [{ id: 0 }],
        default: async ({
          id,
        }: {
          id: Promise<string | undefined> & {
            toString(): string;
            [Symbol.toPrimitive](): string;
          };
        }) => {
          receivedPromise = id instanceof Promise;
          receivedSyncId = id.toString();
          receivedPrimitiveId = String(id);
          return [{ url: `https://example.com/products/${await id}` }];
        },
      },
    } satisfies MetadataFileRoute;

    const response = await handleMetadataRouteRequest({
      metadataRoutes: [route],
      cleanPathname: "/products/sitemap/0.xml",
      makeThenableParams,
    });

    expect(response?.status).toBe(200);
    expect(receivedPromise).toBe(true);
    expect(receivedSyncId).toBe("0");
    expect(receivedPrimitiveId).toBe("0");
    expect(response?.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
    expect(await response?.text()).toContain("https://example.com/products/0");
  });

  it("captures cache life declared inside a generated sitemap default export for runtime ISR", async () => {
    const writes: IsrWritePolicy[] = [];
    const route = {
      type: "sitemap",
      isDynamic: true,
      filePath: "/tmp/app/products/sitemap.ts",
      routePrefix: "/products",
      routeSegments: ["products"],
      servedUrl: "/products/sitemap.xml",
      contentType: "application/xml",
      module: {
        generateSitemaps: () => [{ id: 0 }],
        default: async ({
          id,
        }: {
          id: Promise<string | undefined> & {
            toString(): string;
            [Symbol.toPrimitive](): string;
          };
        }) => {
          _setRequestScopedCacheLife({ revalidate: 60, expire: 300, stale: 30 });
          return [{ url: `https://example.com/products/${await id}` }];
        },
      },
    } satisfies MetadataFileRoute;

    const response = await runWithRequestContext(createRequestContext(), () =>
      handleMetadataRouteRequest({
        metadataRoutes: [route],
        cleanPathname: "/products/sitemap/0.xml",
        isrRouteKey: (pathname) => pathname,
        async isrGet() {
          return null;
        },
        async isrSet(_key, _value, policy) {
          writes.push(policy);
        },
        makeThenableParams,
      }),
    );

    expect(response?.status).toBe(200);
    expect(await response?.text()).toContain("https://example.com/products/0");
    expect(writes).toHaveLength(1);
    expect(writes[0].cacheControl).toEqual({
      revalidate: 60,
      expire: 300,
      stale: 30,
    });
  });

  it("captures cache life declared inside a generated sitemap default export for prerender seeding", async () => {
    const response = await withEnvVar("VINEXT_PRERENDER", "1", () =>
      runWithRequestContext(createRequestContext(), () =>
        handleMetadataRouteRequest({
          cleanPathname: "/products/sitemap/0.xml",
          makeThenableParams,
          metadataRoutes: [
            {
              type: "sitemap",
              isDynamic: true,
              filePath: "/tmp/app/products/sitemap.ts",
              routePrefix: "/products",
              routeSegments: ["products"],
              servedUrl: "/products/sitemap.xml",
              contentType: "application/xml",
              module: {
                generateSitemaps: () => [{ id: 0 }],
                default: async ({
                  id,
                }: {
                  id: Promise<string | undefined> & {
                    toString(): string;
                    [Symbol.toPrimitive](): string;
                  };
                }) => {
                  _setRequestScopedCacheLife({ revalidate: 60, expire: 300, stale: 30 });
                  return [{ url: `https://example.com/products/${await id}` }];
                },
              },
            },
          ],
        }),
      ),
    );

    expect(response?.status).toBe(200);
    expect(response?.headers.get("x-vinext-prerender-cache-life")).toBe(
      '{"revalidate":60,"expire":300,"stale":30}',
    );
  });

  it("throws when matched static metadata route data is missing", async () => {
    const route = {
      type: "icon",
      isDynamic: false,
      filePath: "/tmp/app/icon.png",
      routePrefix: "",
      routeSegments: [],
      servedUrl: "/icon.png",
      contentType: "image/png",
    } satisfies MetadataFileRoute;

    await expect(
      handleMetadataRouteRequest({
        metadataRoutes: [route],
        cleanPathname: "/icon.png",
        makeThenableParams,
      }),
    ).rejects.toThrow("Static metadata route /icon.png is missing embedded file data");
  });

  it("throws when matched static metadata route data is corrupt", async () => {
    const route = {
      type: "icon",
      isDynamic: false,
      filePath: "/tmp/app/icon.png",
      routePrefix: "",
      routeSegments: [],
      servedUrl: "/icon.png",
      contentType: "image/png",
      fileDataBase64: "%%%",
    } satisfies MetadataRuntimeRoute;

    await expect(
      handleMetadataRouteRequest({
        metadataRoutes: [route],
        cleanPathname: "/icon.png",
        makeThenableParams,
      }),
    ).rejects.toThrow("Failed to decode embedded metadata route file data for /icon.png");
  });

  it("sets explicit cache control on generated metadata route responses", async () => {
    const route = {
      type: "robots",
      isDynamic: true,
      filePath: "/tmp/app/robots.ts",
      routePrefix: "",
      routeSegments: [],
      servedUrl: "/robots.txt",
      contentType: "text/plain",
      module: {
        default: () => ({ rules: { userAgent: "*" } }),
      },
    } satisfies MetadataFileRoute;

    const response = await handleMetadataRouteRequest({
      metadataRoutes: [route],
      cleanPathname: "/robots.txt",
      makeThenableParams,
    });

    expect(response?.status).toBe(200);
    expect(response?.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
  });

  it("throws the route contract error when robots returns an array", async () => {
    const route = {
      type: "robots",
      isDynamic: true,
      filePath: "/tmp/app/robots.ts",
      routePrefix: "",
      routeSegments: [],
      servedUrl: "/robots.txt",
      contentType: "text/plain",
      module: {
        default: () => [],
      },
    } satisfies MetadataFileRoute;

    await expect(
      handleMetadataRouteRequest({
        metadataRoutes: [route],
        cleanPathname: "/robots.txt",
        makeThenableParams,
      }),
    ).rejects.toThrow("Metadata robots routes must return an object.");
  });

  it("throws the route contract error when manifest returns an array", async () => {
    const route = {
      type: "manifest",
      isDynamic: true,
      filePath: "/tmp/app/manifest.ts",
      routePrefix: "",
      routeSegments: [],
      servedUrl: "/manifest.webmanifest",
      contentType: "application/manifest+json",
      module: {
        default: () => [],
      },
    } satisfies MetadataFileRoute;

    await expect(
      handleMetadataRouteRequest({
        metadataRoutes: [route],
        cleanPathname: "/manifest.webmanifest",
        makeThenableParams,
      }),
    ).rejects.toThrow("Metadata manifest routes must return an object.");
  });

  it("throws when generateSitemaps returns an entry without id", async () => {
    const route = {
      type: "sitemap",
      isDynamic: true,
      filePath: "/tmp/app/products/sitemap.ts",
      routePrefix: "/products",
      routeSegments: ["products"],
      servedUrl: "/products/sitemap.xml",
      contentType: "application/xml",
      module: {
        generateSitemaps: () => [{}],
        default: () => [{ url: "https://example.com/products/0" }],
      },
    } satisfies MetadataFileRoute;

    await expect(
      handleMetadataRouteRequest({
        metadataRoutes: [route],
        cleanPathname: "/products/sitemap/0.xml",
        makeThenableParams,
      }),
    ).rejects.toThrow("id property is required for every item returned from generateSitemaps");
  });

  it("serves dynamic generated image metadata routes by matched id", async () => {
    let receivedId: Promise<string | undefined> | null = null;
    let receivedSyncId: string | undefined;
    let receivedSlug: string | undefined;
    const route = {
      type: "opengraph-image",
      isDynamic: true,
      filePath: "/tmp/app/blog/[slug]/opengraph-image.tsx",
      routePrefix: "/blog/[slug]",
      routeSegments: ["blog", "[slug]"],
      servedUrl: "/blog/[slug]/opengraph-image",
      patternParts: ["blog", ":slug", "opengraph-image"],
      contentType: "image/png",
      module: {
        generateImageMetadata: async ({ params }: { params: Promise<{ slug: string }> }) => [
          { id: `${(await params).slug}-small` },
        ],
        default: async ({
          id,
          params,
        }: {
          id: Promise<string | undefined> & { toString(): string };
          params: Promise<{ slug: string }> & { slug?: string };
        }) => {
          receivedId = id;
          receivedSyncId = id.toString();
          receivedSlug = params.slug;
          return new Response(`image:${await id}`, {
            headers: { "Content-Type": "image/png" },
          });
        },
      },
    } satisfies MetadataFileRoute;

    const response = await handleMetadataRouteRequest({
      metadataRoutes: [route],
      cleanPathname: "/blog/post/opengraph-image/post-small",
      makeThenableParams,
    });

    expect(response?.status).toBe(200);
    expect(response?.headers.get("content-type")).toBe("image/png");
    expect(receivedId).toBeInstanceOf(Promise);
    expect(receivedSyncId).toBe("post-small");
    expect(receivedSlug).toBe("post");
    expect(await response?.text()).toBe("image:post-small");
  });

  it("sets metadata cache control on dynamic image route Response results", async () => {
    // Ported from Next.js: test/e2e/app-dir/metadata-dynamic-routes/index.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/metadata-dynamic-routes/index.test.ts
    const route = {
      type: "opengraph-image",
      isDynamic: true,
      filePath: "/tmp/app/opengraph-image.tsx",
      routePrefix: "",
      routeSegments: [],
      servedUrl: "/opengraph-image",
      contentType: "image/png",
      module: {
        default: () => new Response("image", { headers: { "Content-Type": "image/png" } }),
      },
    } satisfies MetadataFileRoute;

    const response = await handleMetadataRouteRequest({
      metadataRoutes: [route],
      cleanPathname: "/opengraph-image",
      makeThenableParams,
    });

    expect(response?.status).toBe(200);
    expect(response?.headers.get("content-type")).toBe("image/png");
    expect(response?.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
  });

  it("returns 404 for unknown or invalid generated image ids", async () => {
    const route = {
      type: "icon",
      isDynamic: true,
      filePath: "/tmp/app/icon.tsx",
      routePrefix: "",
      routeSegments: [],
      servedUrl: "/icon",
      contentType: "image/png",
      module: {
        generateImageMetadata: async () => [{ id: "small" }],
        default: () => new Response("icon"),
      },
    } satisfies MetadataFileRoute;

    const unknownResponse = await handleMetadataRouteRequest({
      metadataRoutes: [route],
      cleanPathname: "/icon/large",
      makeThenableParams,
    });
    const invalidResponse = await handleMetadataRouteRequest({
      metadataRoutes: [route],
      cleanPathname: "/icon/bad/id",
      makeThenableParams,
    });

    expect(unknownResponse?.status).toBe(404);
    expect(invalidResponse).toBeNull();
  });

  it("throws when dynamic image metadata routes return non-Response values", async () => {
    const route = {
      type: "opengraph-image",
      isDynamic: true,
      filePath: "/tmp/app/opengraph-image.tsx",
      routePrefix: "",
      routeSegments: [],
      servedUrl: "/opengraph-image",
      contentType: "image/png",
      module: {
        default: () => ({ broken: true }),
      },
    } satisfies MetadataFileRoute;

    await expect(
      handleMetadataRouteRequest({
        metadataRoutes: [route],
        cleanPathname: "/opengraph-image",
        makeThenableParams,
      }),
    ).rejects.toThrow(
      "Dynamic metadata opengraph-image route /opengraph-image must return a Response.",
    );
  });
});

const FIXTURE_DIR = path.resolve(import.meta.dirname, "./fixtures/og-image-optimization");
const PNG_MAGIC_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

type PrerenderManifestEntry = {
  route: string;
  status: string;
  reason?: string;
  router?: string;
};

describe("metadata route prerender integration (issue #2950)", () => {
  let root = "";
  let manifest: { routes: PrerenderManifestEntry[] };

  beforeAll(async () => {
    // Copy the fixture to a tmpdir so build output (dist/) doesn't pollute the
    // checked-in fixture. Reuse the fixture's own node_modules (it carries the
    // workspace vinext link + react).
    root = await createIsolatedFixture(
      FIXTURE_DIR,
      "vinext-og-prerender-",
      undefined,
      path.join(FIXTURE_DIR, "node_modules"),
    );

    const builder = await createBuilder({
      root,
      configFile: false,
      plugins: [vinext({ appDir: root })],
      logLevel: "silent",
    });
    await builder.buildApp();

    // Same prerender phase `vinext build --prerender-all` runs after building.
    await runPrerender({ root, concurrency: 1 });

    manifest = JSON.parse(
      fs.readFileSync(path.join(root, "dist", "server", "vinext-prerender.json"), "utf-8"),
    );
  }, 300000);

  afterAll(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('prerenders a static metadata image route without requiring "use cache"', () => {
    const entry = manifest.routes.find((r) => r.route === "/opengraph-image");
    expect(entry).toMatchObject({ status: "rendered", router: "metadata" });

    const artifactPath = path.join(
      root,
      "dist",
      "server",
      "prerendered-routes",
      "opengraph-image.route",
    );
    expect(fs.existsSync(artifactPath)).toBe(true);
    // The artifact must be the persisted metadata route body — a real PNG.
    const artifact = fs.readFileSync(artifactPath);
    expect(artifact.subarray(0, PNG_MAGIC_BYTES.length).equals(PNG_MAGIC_BYTES)).toBe(true);
  });

  it("serves a metadata image route dynamically at runtime", async () => {
    // The metadata route itself remains fully functional — it is only excluded
    // from the prerender phase. This pins the repro to candidate enumeration
    // (getPrerenderableMetadataRoutePaths) rather than a broken route.
    const built: { default?: unknown } = await import(
      `${pathToFileURL(path.join(root, "dist", "server", "index.js")).href}?t=${Date.now()}`
    );
    expect(typeof built.default).toBe("function");
    if (typeof built.default !== "function") return;

    const res = await built.default(new Request("http://localhost/opengraph-image"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("image/png");
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.subarray(0, PNG_MAGIC_BYTES.length).equals(PNG_MAGIC_BYTES)).toBe(true);
  });

  it("does not prerender a metadata route that uses request-time APIs", () => {
    // A dynamic metadata image route (headers()) must stay dynamic: either
    // absent from the manifest or recorded as skipped — never persisted as a
    // static artifact.
    const entry = manifest.routes.find((r) => r.route === "/dynamic/opengraph-image");
    expect(entry).toMatchObject({
      status: "skipped",
      reason: "dynamic",
    });
    if (entry?.status === "skipped") {
      expect(entry.reason).toBe("dynamic");
    }
    expect(
      fs.existsSync(
        path.join(root, "dist", "server", "prerendered-routes", "dynamic", "opengraph-image.route"),
      ),
    ).toBe(false);
  });
});
