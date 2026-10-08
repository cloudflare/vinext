import {
  headers,
  draftMode,
  getDraftModeCookieHeader,
} from "../packages/vinext/src/shims/headers.js";
import { describe, expect, it, vi } from "vite-plus/test";
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
import { createWorkerCacheabilityAdmissionContext } from "../packages/vinext/src/server/cacheability-request.js";
import {
  CACHEABILITY_REQUEST_STATE,
  type RouteCacheabilityState,
} from "../packages/vinext/src/shims/cacheability-classification.js";

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
  it("enumerates cached text metadata routes for build prerendering", async () => {
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
    ]);
  });

  it("publishes collected cache tags and cache life for prerender seeding", async () => {
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

  it("rejects excluded dynamic metadata images before reading ISR", async () => {
    let cacheReads = 0;
    const response = await handleMetadataRouteRequest({
      cleanPathname: "/drafts/private/twitter-image",
      isrRouteKey: (pathname) => pathname,
      async isrGet() {
        cacheReads++;
        throw new Error("excluded metadata routes must not read cached content");
      },
      makeThenableParams,
      metadataRoutes: [
        {
          type: "twitter-image",
          isDynamic: true,
          filePath: "/tmp/app/drafts/[slug]/twitter-image.tsx",
          routePrefix: "/drafts/[slug]",
          routeSegments: ["drafts", "[slug]"],
          servedUrl: "/drafts/[slug]/twitter-image",
          patternParts: ["drafts", ":slug", "twitter-image"],
          contentType: "image/png",
          module: {
            dynamicParams: false,
            generateStaticParams: () => [{ slug: "public" }],
            default: () => new Response("private image"),
          },
        },
      ],
    });

    expect(response?.status).toBe(404);
    expect(cacheReads).toBe(0);
  });

  it("keeps double-encoded metadata params distinct from generated params", async () => {
    const response = await handleMetadataRouteRequest({
      cleanPathname: "/drafts/public%20post/twitter-image",
      makeThenableParams,
      metadataRoutes: [
        {
          type: "twitter-image",
          isDynamic: true,
          filePath: "/tmp/app/drafts/[slug]/twitter-image.tsx",
          routePrefix: "/drafts/[slug]",
          routeSegments: ["drafts", "[slug]"],
          servedUrl: "/drafts/[slug]/twitter-image",
          patternParts: ["drafts", ":slug", "twitter-image"],
          contentType: "image/png",
          module: {
            dynamicParams: false,
            generateStaticParams: () => [{ slug: "public post" }],
            default: () => new Response("encoded alias"),
          },
        },
      ],
      routePathname: "/drafts/public%2520post/twitter-image",
    });

    expect(response?.status).toBe(404);
  });

  it.each([
    ["public%20post", "public%2520post"],
    ["public%2Fpost", "public%252Fpost"],
  ])("uses one decoded param identity for %s", async (generatedSlug, requestSlug) => {
    const response = await handleMetadataRouteRequest({
      cleanPathname: `/drafts/${generatedSlug}/twitter-image`,
      makeThenableParams,
      metadataRoutes: [
        {
          type: "twitter-image",
          isDynamic: true,
          filePath: "/tmp/app/drafts/[slug]/twitter-image.tsx",
          routePrefix: "/drafts/[slug]",
          routeSegments: ["drafts", "[slug]"],
          servedUrl: "/drafts/[slug]/twitter-image",
          patternParts: ["drafts", ":slug", "twitter-image"],
          contentType: "image/png",
          module: {
            dynamicParams: false,
            generateStaticParams: () => [{ slug: generatedSlug }],
            default: async ({ params }: { params: Promise<{ slug: string }> }) =>
              new Response((await params).slug),
          },
        },
      ],
      routePathname: `/drafts/${requestSlug}/twitter-image`,
    });

    expect(response?.status).toBe(200);
    await expect(response?.text()).resolves.toBe(generatedSlug);
  });

  it.each([
    ["undefined", undefined, 200],
    ["null", null, 200],
    ["false", false, 200],
    ["empty array", [], 200],
    ["omitted", Symbol("omitted"), 404],
  ])("handles %s optional catch-all static params", async (_label, value, status) => {
    const staticParams =
      typeof value === "symbol" ? [{}] : [{ path: value as undefined | null | false | never[] }];
    const response = await handleMetadataRouteRequest({
      cleanPathname: "/docs/twitter-image",
      makeThenableParams,
      metadataRoutes: [
        {
          type: "twitter-image",
          isDynamic: true,
          filePath: "/tmp/app/docs/[[...path]]/twitter-image.tsx",
          routePrefix: "/docs/[[...path]]",
          routeSegments: ["docs", "[[...path]]"],
          servedUrl: "/docs/[[...path]]/twitter-image",
          patternParts: ["docs", ":path*", "twitter-image"],
          contentType: "image/png",
          module: {
            dynamicParams: false,
            generateStaticParams: () => staticParams,
            default: () => new Response("empty optional"),
          },
        },
      ],
    });

    expect(response?.status).toBe(status);
  });

  it.each([
    ["incomplete", () => [{ slug: "public" }]],
    ["non-array", () => null],
  ])("rejects %s metadata static params", async (_label, generateStaticParams) => {
    let cacheReads = 0;
    const response = await handleMetadataRouteRequest({
      cleanPathname: "/teams/private/public/opengraph-image",
      async isrGet() {
        cacheReads++;
        return null;
      },
      isrRouteKey: (pathname) => pathname,
      makeThenableParams,
      metadataRoutes: [
        {
          type: "opengraph-image",
          isDynamic: true,
          filePath: "/tmp/app/teams/[team]/[slug]/opengraph-image.tsx",
          routePrefix: "/teams/[team]/[slug]",
          routeSegments: ["teams", "[team]", "[slug]"],
          servedUrl: "/teams/[team]/[slug]/opengraph-image",
          patternParts: ["teams", ":team", ":slug", "opengraph-image"],
          contentType: "image/png",
          module: {
            dynamicParams: false,
            generateStaticParams,
            default: () => new Response("private team"),
          },
        },
      ],
    });

    expect(response?.status).toBe(404);
    expect(cacheReads).toBe(0);
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
    it(`stores static metadata independently of browser Cache-Control: ${cacheControl}`, async () => {
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
      expect(outerWrites).toBe(1);
    });
  }

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
      _setRequestScopedCacheLife({ revalidate: 60, expire: 300, stale: 30 });
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

  it.each([
    [307, true],
    [404, true],
    [400, false],
    [500, false],
  ] as const)(
    "handles metadata regeneration status %s consistently with static admission",
    async (status, cacheable) => {
      let metadataCalls = 0;
      let regenerate: (() => Promise<void>) | undefined;
      const writes: unknown[] = [];
      const defaultExport = markUseCache(async () => {
        metadataCalls++;
        return new Response("replacement", { status });
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
      expect(writes).toHaveLength(cacheable ? 1 : 0);
    },
  );

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

  it("uses framework cache control for a raw metadata Response without authored policy", async () => {
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
    expect(response?.headers.get("cache-control")).toBe(
      "s-maxage=31536000, stale-while-revalidate",
    );
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

describe("metadata route cacheability registration", () => {
  it("applies development metadata defaults to immutable Response headers", async () => {
    await withEnvVar("NODE_ENV", "development", async () => {
      const { response } = await handleWithAdmission("/event/london/42/opengraph-image", [
        dynamicImageRoute(() => Response.redirect("https://example.com/image.png", 307)),
      ]);
      expect(response?.status).toBe(307);
      expect(response?.headers.get("Location")).toBe("https://example.com/image.png");
      expect(response?.headers.get("Cache-Control")).toBe("no-cache, no-store");
      expect(response?.body).toBeNull();
    });
  });

  async function handleWithAdmission(
    cleanPathname: string,
    metadataRoutes: MetadataRuntimeRoute[],
    options: Partial<Parameters<typeof handleMetadataRouteRequest>[0]> = {},
  ): Promise<{ response: Response | null; state: RouteCacheabilityState }> {
    const context = createWorkerCacheabilityAdmissionContext(
      { waitUntil() {} },
      new Request(`https://example.com${cleanPathname}`),
      null,
      "build-a",
      true,
    );
    const response = await runWithRequestContext(
      createRequestContext({
        executionContext: context,
        headersContext: { headers: new Headers({ "x-visitor": "alice" }), cookies: new Map() },
      }),
      () =>
        handleMetadataRouteRequest({
          cleanPathname,
          makeThenableParams,
          metadataRoutes,
          ...options,
        }),
    );
    return {
      response,
      state: Reflect.get(context, CACHEABILITY_REQUEST_STATE) as RouteCacheabilityState,
    };
  }

  function dynamicImageRoute(response: () => Response): MetadataRuntimeRoute {
    return {
      type: "opengraph-image",
      isDynamic: true,
      filePath: "/tmp/app/event/[city]/[eventId]/opengraph-image.tsx",
      routePrefix: "/event/[city]/[eventId]",
      routeSegments: ["event", "[city]", "[eventId]"],
      servedUrl: "/event/[city]/[eventId]/opengraph-image",
      patternParts: ["event", ":city", ":eventId", "opengraph-image"],
      contentType: "image/png",
      module: { default: response },
    };
  }

  it.each([
    [undefined, "private, max-age=300"],
    ["public, max-age=1", "private, max-age=300"],
    ["public, max-age=1", undefined],
  ])(
    "captures metadata stream policy from %s to %s after EOF",
    async (initialPolicy, finalPolicy) => {
      const write = vi.fn();
      const route = dynamicImageRoute(() => {
        const response = new Response(
          new ReadableStream(
            {
              pull(controller) {
                if (finalPolicy) response.headers.set("Cache-Control", finalPolicy);
                else response.headers.delete("Cache-Control");
                controller.enqueue(new TextEncoder().encode("image"));
                controller.close();
              },
            },
            { highWaterMark: 0 },
          ),
          { headers: initialPolicy ? { "Cache-Control": initialPolicy } : {} },
        );
        return response;
      });
      route.module!.revalidate = 2;
      const { response, state } = await handleWithAdmission(
        "/event/london/42/opengraph-image",
        [route],
        { isrSet: write, isrRouteKey: (path) => path },
      );
      if (finalPolicy) expect(response?.headers.get("Cache-Control")).toBe(finalPolicy);
      else expect(response?.headers.get("Cache-Control")).toContain("s-maxage=2");
      expect(write).toHaveBeenCalledOnce();
      expect(write.mock.calls[0][1].headers["cache-control"]).toBe(finalPolicy);
      expect(state.explicitResponseCachePolicy === true).toBe(finalPolicy !== undefined);
    },
  );

  it.each([
    [307, true],
    [404, true],
    [400, false],
    [500, false],
  ] as const)(
    "classifies metadata status %s consistently for framework and edge storage",
    async (status, cacheable) => {
      const write = vi.fn();
      const { response, state } = await handleWithAdmission(
        "/event/london/42/opengraph-image",
        [
          dynamicImageRoute(
            () =>
              new Response("not an image", {
                status,
                headers: { "Cache-Control": "public, max-age=300" },
              }),
          ),
        ],
        { isrSet: write, isrRouteKey: (path) => path },
      );
      expect(response?.status).toBe(status);
      expect(response?.headers.get("Cache-Control")).toBe("public, max-age=300");
      expect(state.outcome?.cacheable).toBe(cacheable);
      expect(write).toHaveBeenCalledTimes(cacheable ? 1 : 0);
    },
  );

  it.each(["auto", "force-static"])(
    "observes late metadata request reads in %s mode",
    async (dynamic) => {
      const route = dynamicImageRoute(
        () =>
          new Response(
            new ReadableStream({
              async pull(controller) {
                const visitor = (await headers()).get("x-visitor") ?? "anonymous";
                controller.enqueue(new TextEncoder().encode(visitor));
                controller.close();
              },
            }),
            { headers: { "Cache-Control": "private, max-age=300" } },
          ),
      );
      route.module!.dynamic = dynamic;
      const writes = vi.fn();
      const { response, state } = await runWithRequestContext(
        createRequestContext({
          headersContext: { headers: new Headers({ "x-visitor": "alice" }), cookies: new Map() },
        }),
        () =>
          handleWithAdmission("/event/london/42/opengraph-image", [route], {
            isrGet: async () => null,
            isrSet: writes,
            isrRouteKey: (path) => path,
          }),
      );
      expect(state.outcome?.cacheable).toBe(dynamic === "force-static");
      expect(writes).toHaveBeenCalledTimes(dynamic === "force-static" ? 1 : 0);
      await expect(response?.text()).resolves.toBe(
        dynamic === "force-static" ? "anonymous" : "alice",
      );
    },
  );

  it("does not read or write metadata ISR in draft mode", async () => {
    const read = vi.fn(async () => null);
    const write = vi.fn();
    const response = await runWithRequestContext(
      createRequestContext({
        headersContext: { headers: new Headers(), cookies: new Map(), draftModeEnabled: true },
      }),
      () =>
        handleMetadataRouteRequest({
          cleanPathname: "/event/london/42/opengraph-image",
          makeThenableParams,
          metadataRoutes: [
            dynamicImageRoute(
              () => new Response("draft", { headers: { "Cache-Control": "public, max-age=300" } }),
            ),
          ],
          isrGet: read,
          isrSet: write,
          isrRouteKey: (path) => path,
        }),
    );
    await expect(response?.text()).resolves.toBe("draft");
    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("preserves cookie-derived draft mode under force-static metadata", async () => {
    const read = vi.fn(async () => null);
    const write = vi.fn();
    const route = dynamicImageRoute(() => new Response("draft"));
    route.module!.dynamic = "force-static";
    const response = await runWithRequestContext(
      createRequestContext({
        headersContext: {
          headers: new Headers(),
          get cookies() {
            return new Map([["__prerender_bypass", "secret"]]);
          },
          draftModeSecret: "secret",
        },
      }),
      () =>
        handleMetadataRouteRequest({
          cleanPathname: "/event/london/42/opengraph-image",
          makeThenableParams,
          metadataRoutes: [route],
          isrGet: read,
          isrSet: write,
          isrRouteKey: (path) => path,
        }),
    );
    await expect(response?.text()).resolves.toBe("draft");
    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it.each(["before", "body"])(
    "preserves a draft disable cookie set %s metadata rendering",
    async (when) => {
      const read = vi.fn(async () => null);
      const write = vi.fn();
      await runWithRequestContext(
        createRequestContext({
          headersContext: {
            headers: new Headers(),
            cookies: new Map(),
            draftModeEnabled: true,
            draftModeSecret: "secret",
          },
        }),
        async () => {
          if (when === "before") (await draftMode()).disable();
          const response = await handleMetadataRouteRequest({
            cleanPathname: "/event/london/42/opengraph-image",
            makeThenableParams,
            metadataRoutes: [
              dynamicImageRoute(
                () =>
                  new Response(
                    new ReadableStream({
                      async pull(controller) {
                        if (when === "body") (await draftMode()).disable();
                        controller.enqueue(new TextEncoder().encode("disabled"));
                        controller.close();
                      },
                    }),
                  ),
              ),
            ],
            isrGet: read,
            isrSet: write,
            isrRouteKey: (path) => path,
          });
          await expect(response?.text()).resolves.toBe("disabled");
          expect(getDraftModeCookieHeader()).toContain("__prerender_bypass=");
        },
      );
      expect(read).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
    },
  );

  it("does not write metadata ISR after a handler enables draft mode", async () => {
    const write = vi.fn();
    const route = dynamicImageRoute(
      () =>
        new Response(
          new ReadableStream({
            async pull(controller) {
              (await draftMode()).enable();
              controller.enqueue(new TextEncoder().encode("draft"));
              controller.close();
            },
          }),
          { headers: { "Cache-Control": "no-store" } },
        ),
    );
    const response = await runWithRequestContext(
      createRequestContext({
        headersContext: {
          headers: new Headers(),
          cookies: new Map(),
          draftModeEnabled: false,
          draftModeSecret: "secret",
        },
      }),
      () =>
        handleMetadataRouteRequest({
          cleanPathname: "/event/london/42/opengraph-image",
          makeThenableParams,
          metadataRoutes: [route],
          isrGet: async () => null,
          isrSet: write,
          isrRouteKey: (path) => path,
        }),
    );
    await expect(response?.text()).resolves.toBe("draft");
    expect(write).not.toHaveBeenCalled();
  });

  it.each([0, 1, 60])(
    "caps metadata cacheLife %s by the route's revalidate",
    async (revalidate) => {
      const write = vi.fn();
      const route = dynamicImageRoute(() => {
        _setRequestScopedCacheLife({ revalidate, expire: 300 });
        return new Response("image", { headers: { "Cache-Control": "public, max-age=3600" } });
      });
      route.module!.revalidate = 2;
      const { response, state } = await handleWithAdmission(
        "/event/london/42/opengraph-image",
        [route],
        {
          isrGet: async () => null,
          isrSet: write,
          isrRouteKey: (path) => path,
        },
      );
      expect(state.outcome?.cacheable).toBe(revalidate > 0);
      if (revalidate > 0) {
        expect(write.mock.calls[0]?.[2].cacheControl).toEqual({
          revalidate: Math.min(2, revalidate),
          expire: 300,
        });
        expect(state.outcome?.cacheControl).toContain(`s-maxage=${Math.min(2, revalidate)}`);
        expect(state.outcome?.tags).toContain("_N_T_/event/london/42/opengraph-image");
      } else expect(write).not.toHaveBeenCalled();
      await response?.body?.cancel();
    },
  );

  it("registers the route pattern rather than the concrete path", async () => {
    const { state } = await handleWithAdmission("/event/london/42/opengraph-image", [
      dynamicImageRoute(() => new Response("png")),
    ]);

    expect(state.route).toEqual({
      kind: "app-route",
      pattern: "/event/:city/:eventId/opengraph-image",
    });
  });

  it("registers generated sitemaps under their base route", async () => {
    const { state } = await handleWithAdmission("/products/sitemap/0.xml", [
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
          default: async () => [],
        },
      },
    ]);

    expect(state.route).toEqual({ kind: "app-route", pattern: "/products/sitemap.xml" });
  });

  it("does not register a request that matches no metadata route", async () => {
    const { response, state } = await handleWithAdmission("/event/london/42/twitter-image", [
      dynamicImageRoute(() => new Response("png")),
    ]);

    expect(response).toBeNull();
    expect(state.route).toBeUndefined();
  });

  it.each(["public, max-age=31536000", "no-store", "private, max-age=300"])(
    "records authored %s independently of shared admission",
    async (policy) => {
      const { response, state } = await handleWithAdmission("/event/london/42/opengraph-image", [
        dynamicImageRoute(() => new Response("png", { headers: { "Cache-Control": policy } })),
      ]);

      expect(response?.headers.get("cache-control")).toBe(policy);
      expect(state.explicitResponseCachePolicy).toBe(true);
    },
  );

  it("does not record the framework default as an explicit policy", async () => {
    const { state } = await handleWithAdmission("/event/london/42/opengraph-image", [
      dynamicImageRoute(() => new Response("png")),
    ]);

    expect(state.route?.kind).toBe("app-route");
    expect(state.explicitResponseCachePolicy).toBeUndefined();
  });

  it("does not record serialized or static metadata as an explicit policy", async () => {
    const robots = await handleWithAdmission("/robots.txt", [
      {
        type: "robots",
        isDynamic: true,
        filePath: "/tmp/app/robots.ts",
        routePrefix: "",
        routeSegments: [],
        servedUrl: "/robots.txt",
        contentType: "text/plain",
        module: { default: () => ({ rules: { userAgent: "*", allow: "/" } }) },
      },
    ]);
    const favicon = await handleWithAdmission("/favicon.ico", [
      {
        type: "favicon",
        isDynamic: false,
        filePath: "/tmp/app/favicon.ico",
        routePrefix: "",
        routeSegments: [],
        servedUrl: "/favicon.ico",
        contentType: "image/x-icon",
        fileDataBase64: btoa("icon"),
      },
    ]);

    expect(robots.state.route).toEqual({ kind: "app-route", pattern: "/robots.txt" });
    expect(robots.state.explicitResponseCachePolicy).toBeUndefined();
    expect(favicon.state.route).toEqual({ kind: "app-route", pattern: "/favicon.ico" });
    expect(favicon.state.explicitResponseCachePolicy).toBeUndefined();
  });

  it("does not record a replayed use-cache entry as an explicit policy", async () => {
    const { response, state } = await handleWithAdmission(
      "/robots.txt",
      [
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
              throw new Error("cached metadata must not execute at runtime");
            }),
          },
        },
      ],
      {
        isrRouteKey: (pathname) => pathname,
        async isrGet() {
          return {
            isStale: false,
            value: {
              lastModified: 1,
              value: {
                kind: "APP_ROUTE",
                body: new TextEncoder().encode("User-Agent: *\n").buffer,
                headers: {
                  "content-type": "text/plain",
                  "x-vinext-metadata-route-cache": "1",
                },
                status: 200,
              },
            },
          };
        },
      },
    );

    expect(await response?.text()).toBe("User-Agent: *\n");
    expect(state.route).toEqual({ kind: "app-route", pattern: "/robots.txt" });
    expect(state.explicitResponseCachePolicy).toBeUndefined();
  });
});
