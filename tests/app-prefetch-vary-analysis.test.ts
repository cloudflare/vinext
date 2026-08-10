import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toLinkPrefetchRoute } from "../packages/vinext/src/entries/app-browser-entry.js";
import type { AppRoute } from "../packages/vinext/src/routing/app-router.js";
import {
  encodeAppPrefetchRuntimeTemplateVariantKey,
  learnAppPrefetchVaryMetadata,
  resolveAutoAppRoutePrefetch,
  resolveAppPrefetchSharedCacheKey,
} from "../packages/vinext/src/shims/internal/app-route-prefetch-policy.js";

// Ported from Next.js:
// test/e2e/app-dir/segment-cache/vary-params/vary-params.test.ts
// https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/segment-cache/vary-params/vary-params.test.ts

const tmpDirs: string[] = [];

function writeSource(name: string, source: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-prefetch-vary-"));
  tmpDirs.push(dir);
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, source);
  return filePath;
}

function createRoute(overrides: Partial<AppRoute> = {}): AppRoute {
  return {
    errorPath: null,
    forbiddenPath: null,
    forbiddenPaths: [],
    isDynamic: true,
    layoutErrorPaths: [],
    layouts: [],
    layoutTreePositions: [],
    loadingPath: null,
    notFoundPath: null,
    notFoundPaths: [],
    pagePath: null,
    parallelSlots: [],
    params: ["category", "itemId"],
    pattern: "/items/:category/:itemId",
    patternParts: ["items", ":category", ":itemId"],
    routePath: null,
    routeSegments: ["items", "[category]", "[itemId]"],
    siblingIntercepts: [],
    templates: [],
    unauthorizedPath: null,
    unauthorizedPaths: [],
    ...overrides,
  };
}

afterEach(() => {
  while (tmpDirs.length > 0) fs.rmSync(tmpDirs.pop()!, { force: true, recursive: true });
});

describe("App Router prefetch vary analysis", () => {
  it("skips source analysis when prefetch vary is disabled", () => {
    const readFileSync = vi.spyOn(fs, "readFileSync");
    try {
      const route = toLinkPrefetchRoute(createRoute({ pagePath: "/missing/page.tsx" }), {
        hasSiblingInterceptLoading: false,
        prefetchVaryEnabled: false,
      });
      expect(route.canPrefetchFullStaticRoute).toBeUndefined();
      expect(route.canPrefetchRuntimeShell).toBeUndefined();
      expect(route.canPrefetchStaticRoute).toBeUndefined();
      expect(readFileSync).not.toHaveBeenCalled();
    } finally {
      readFileSync.mockRestore();
    }
  });

  it("encodes runtime template variants without composite-key collisions", () => {
    expect(encodeAppPrefetchRuntimeTemplateVariantKey("a\0b", "c")).not.toBe(
      encodeAppPrefetchRuntimeTemplateVariantKey("a", "b\0c"),
    );
  });

  it("detects explicit runtime-prefetch capability without inferring dependencies", () => {
    const pagePath = writeSource(
      "page.tsx",
      `import { readCategory } from "./helper";
      export const unstable_instant = { prefetch: "runtime", samples: [] };
      export default async function Page({ params }) {
        const category = await readCategory(params);
        return <div>{category}</div>;
      }`,
    );
    const route = toLinkPrefetchRoute(createRoute({ pagePath }));
    expect(route.canPrefetchRuntimeShell).toBe(true);
    expect(route.prefetchVaryParamNames).toBeUndefined();
    expect(route.runtimePrefetchVaryParamNames).toBeUndefined();
  });

  it("detects generateStaticParams capability from the page or a layout", () => {
    const pagePath = writeSource(
      "page.tsx",
      `export function generateStaticParams() { return []; }
      export default function Page() { return <div>static</div>; }`,
    );
    const layoutPath = writeSource(
      "layout.tsx",
      `export async function generateStaticParams() { return []; }
      export default function Layout({ children }) { return children; }`,
    );
    expect(toLinkPrefetchRoute(createRoute({ pagePath })).canPrefetchStaticRoute).toBe(true);
    expect(toLinkPrefetchRoute(createRoute({ layouts: [layoutPath] })).canPrefetchStaticRoute).toBe(
      true,
    );
  });

  it("prefetches the loading shell for partially static dynamic routes", () => {
    const originalWindow = globalThis.window;
    (globalThis as any).window = {
      location: { href: "http://localhost/", origin: "http://localhost" },
      __VINEXT_PREFETCH_VARY_ENABLED__: true,
      __VINEXT_LINK_PREFETCH_ROUTES__: [
        {
          canPrefetchLoadingShell: true,
          canPrefetchStaticRoute: true,
          isDynamic: true,
          patternParts: ["items", ":category", ":itemId"],
        },
      ],
    };
    try {
      expect(resolveAutoAppRoutePrefetch("/items/books/one")).toMatchObject({
        cacheForNavigation: false,
        renderLoadingShell: true,
      });
    } finally {
      if (originalWindow === undefined) delete (globalThis as any).window;
      else (globalThis as any).window = originalWindow;
    }
  });

  it("keys concrete prefetches only by observed params and search", () => {
    const originalWindow = globalThis.window;
    const originalFlags = {
      cacheComponents: process.env.__NEXT_CACHE_COMPONENTS,
      optimisticRouting: process.env.__VINEXT_OPTIMISTIC_ROUTING,
      varyParams: process.env.__VINEXT_VARY_PARAMS,
    };
    process.env.__NEXT_CACHE_COMPONENTS = "true";
    process.env.__VINEXT_OPTIMISTIC_ROUTING = "true";
    process.env.__VINEXT_VARY_PARAMS = "true";
    (globalThis as any).window = {
      location: { href: "http://localhost/", origin: "http://localhost" },
      __VINEXT_LINK_PREFETCH_ROUTES__: [
        {
          canPrefetchLoadingShell: true,
          isDynamic: true,
          loadingShellVaryParamNames: ["category", "itemId"],
          patternParts: ["items", ":category", ":itemId"],
          prefetchVaryParamNames: ["category"],
          runtimePrefetchVaryParamNames: ["category"],
        },
      ],
    };
    try {
      expect(resolveAppPrefetchSharedCacheKey("/items/books/one", "navigation")).toBe(
        "items/:category/:itemId\0items/books/:itemId",
      );
      expect(resolveAppPrefetchSharedCacheKey("/items/books/two", "navigation")).toBe(
        "items/:category/:itemId\0items/books/:itemId",
      );
      expect(resolveAppPrefetchSharedCacheKey("/items/books/two", "loading-shell")).toBe(
        "items/:category/:itemId\0items/books/two",
      );

      const inheritedSlotRoute = toLinkPrefetchRoute(
        createRoute({
          params: ["teamID", "folder"],
          pattern: "/:teamID/sub/:folder",
          patternParts: [":teamID", "sub", ":folder"],
          routeSegments: ["[teamID]", "sub", "[folder]"],
          parallelSlots: [
            {
              id: "slot:slot:/:teamID",
              key: "slot@[teamID]/@slot",
              name: "slot",
              ownerDir: "/tmp/app/[teamID]/@slot",
              ownerTreePath: "/[teamID]",
              ownerTreePosition: 1,
              hasPage: true,
              pagePath: "/tmp/app/[teamID]/@slot/[...catchAll]/page.tsx",
              defaultPath: null,
              layoutPath: null,
              loadingPath: null,
              errorPath: null,
              interceptingRoutes: [],
              layoutIndex: 0,
              routeSegments: ["[...catchAll]"],
              slotPatternParts: [":teamID", ":catchAll+"],
              slotParamNames: ["teamID", "catchAll"],
            },
          ],
        }),
      );
      expect(inheritedSlotRoute.slotParamPatterns).toEqual([
        {
          paramNames: ["teamID", "catchAll"],
          patternParts: [":teamID", ":catchAll+"],
        },
      ]);
      inheritedSlotRoute.runtimePrefetchVaryParamNames = ["catchAll"];
      (globalThis as any).window.__VINEXT_LINK_PREFETCH_ROUTES__ = [inheritedSlotRoute];
      expect(resolveAppPrefetchSharedCacheKey("/acme/sub/docs", "runtime")).toBe(
        ":teamID/sub/:folder\0:teamID/sub/:folder\0" + "0:catchAll=sub/docs",
      );
      expect(resolveAppPrefetchSharedCacheKey("/acme/sub/api", "runtime")).toBe(
        ":teamID/sub/:folder\0:teamID/sub/:folder\0" + "0:catchAll=sub/api",
      );
    } finally {
      if (originalFlags.cacheComponents === undefined) delete process.env.__NEXT_CACHE_COMPONENTS;
      else process.env.__NEXT_CACHE_COMPONENTS = originalFlags.cacheComponents;
      if (originalFlags.optimisticRouting === undefined)
        delete process.env.__VINEXT_OPTIMISTIC_ROUTING;
      else process.env.__VINEXT_OPTIMISTIC_ROUTING = originalFlags.optimisticRouting;
      if (originalFlags.varyParams === undefined) delete process.env.__VINEXT_VARY_PARAMS;
      else process.env.__VINEXT_VARY_PARAMS = originalFlags.varyParams;
      if (originalWindow === undefined) delete (globalThis as any).window;
      else (globalThis as any).window = originalWindow;
    }
  });

  it("learns render-observed vary metadata on the matching route", () => {
    const originalWindow = globalThis.window;
    const originalFlags = {
      cacheComponents: process.env.__NEXT_CACHE_COMPONENTS,
      optimisticRouting: process.env.__VINEXT_OPTIMISTIC_ROUTING,
      varyParams: process.env.__VINEXT_VARY_PARAMS,
    };
    process.env.__NEXT_CACHE_COMPONENTS = "true";
    process.env.__VINEXT_OPTIMISTIC_ROUTING = "true";
    process.env.__VINEXT_VARY_PARAMS = "true";
    const route = createRoute();
    (globalThis as any).window = {
      location: {
        href: "http://localhost/items/books/one",
        origin: "http://localhost",
      },
      __VINEXT_LINK_PREFETCH_ROUTES__: [route],
    };
    try {
      learnAppPrefetchVaryMetadata("/items/books/one", {
        loadingParamNames: ["category", "itemId"],
        metadataParamNames: [],
        metadataSearchParams: true,
        pageDynamicSuspenseOrdinals: [],
        pageDynamicSuspenseOrdinalsByElementId: {},
        pageParamNames: ["category"],
        pageSearchParams: false,
      });
      expect(route).toMatchObject({
        loadingShellVaryParamNames: ["category", "itemId"],
        loadingShellVarySearchParams: true,
        prefetchVaryParamNames: ["category"],
        runtimePrefetchVaryParamNames: ["category"],
        runtimePrefetchVarySearchParams: true,
      });
      expect(resolveAppPrefetchSharedCacheKey("/items/books/one?q=1", "navigation")).toBe(
        resolveAppPrefetchSharedCacheKey("/items/books/one?q=2", "navigation"),
      );
      expect(resolveAppPrefetchSharedCacheKey("/items/books/one?q=1", "loading-shell")).not.toBe(
        resolveAppPrefetchSharedCacheKey("/items/books/one?q=2", "loading-shell"),
      );
    } finally {
      if (originalFlags.cacheComponents === undefined) delete process.env.__NEXT_CACHE_COMPONENTS;
      else process.env.__NEXT_CACHE_COMPONENTS = originalFlags.cacheComponents;
      if (originalFlags.optimisticRouting === undefined)
        delete process.env.__VINEXT_OPTIMISTIC_ROUTING;
      else process.env.__VINEXT_OPTIMISTIC_ROUTING = originalFlags.optimisticRouting;
      if (originalFlags.varyParams === undefined) delete process.env.__VINEXT_VARY_PARAMS;
      else process.env.__VINEXT_VARY_PARAMS = originalFlags.varyParams;
      if (originalWindow === undefined) delete (globalThis as any).window;
      else (globalThis as any).window = originalWindow;
    }
  });

  it.each([
    ["cacheComponents", "__NEXT_CACHE_COMPONENTS"],
    ["optimisticRouting", "__VINEXT_OPTIMISTIC_ROUTING"],
    ["varyParams", "__VINEXT_VARY_PARAMS"],
  ] as const)("keeps vary behavior off without %s", (_name, disabledFlag) => {
    const originalWindow = globalThis.window;
    const originalFlags = {
      __NEXT_CACHE_COMPONENTS: process.env.__NEXT_CACHE_COMPONENTS,
      __VINEXT_OPTIMISTIC_ROUTING: process.env.__VINEXT_OPTIMISTIC_ROUTING,
      __VINEXT_VARY_PARAMS: process.env.__VINEXT_VARY_PARAMS,
    };
    process.env.__NEXT_CACHE_COMPONENTS = "true";
    process.env.__VINEXT_OPTIMISTIC_ROUTING = "true";
    process.env.__VINEXT_VARY_PARAMS = "true";
    process.env[disabledFlag] = "false";
    const route = createRoute();
    (globalThis as any).window = {
      location: { href: "http://localhost/", origin: "http://localhost" },
      __VINEXT_LINK_PREFETCH_ROUTES__: [route],
    };
    try {
      learnAppPrefetchVaryMetadata("/items/books/one", {
        loadingParamNames: ["category"],
        metadataParamNames: [],
        metadataSearchParams: false,
        pageDynamicSuspenseOrdinals: [],
        pageDynamicSuspenseOrdinalsByElementId: {},
        pageParamNames: ["category"],
        pageSearchParams: false,
      });
      expect(resolveAppPrefetchSharedCacheKey("/items/books/one", "navigation")).toBeNull();
      expect(route).not.toHaveProperty("prefetchVaryParamNames");
    } finally {
      for (const [key, value] of Object.entries(originalFlags)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      if (originalWindow === undefined) delete (globalThis as any).window;
      else (globalThis as any).window = originalWindow;
    }
  });
});
