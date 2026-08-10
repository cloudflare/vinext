import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { toLinkPrefetchRoute } from "../packages/vinext/src/entries/app-browser-entry.js";
import type { AppRoute } from "../packages/vinext/src/routing/app-router.js";
import { resolveAppPrefetchSharedCacheKey } from "../packages/vinext/src/shims/internal/app-route-prefetch-policy.js";

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
  it("tracks page params independently from layout params", () => {
    const layoutPath = writeSource(
      "layout.tsx",
      `export default async function Layout({ children, params }) {
        const { category, itemId } = await params;
        return <div>{category}:{itemId}{children}</div>;
      }`,
    );
    const pagePath = writeSource(
      "page.tsx",
      `export default async function Page({ params }) {
        const { category } = await params;
        return <div>{category}</div>;
      }`,
    );

    const route = toLinkPrefetchRoute(
      createRoute({ layouts: [layoutPath], loadingPath: "/tmp/loading.tsx", pagePath }),
    );
    expect(route.loadingShellVaryParamNames).toEqual(["category", "itemId"]);
    expect(route.prefetchVaryParamNames).toEqual(["category"]);
  });

  it("separates generateMetadata access from a static page body", () => {
    const pagePath = writeSource(
      "page.tsx",
      `export async function generateMetadata({ params }) {
        const { itemId } = await params;
        return { title: itemId };
      }
      export function generateStaticParams() { return []; }
      export default function Page() { return <div>static</div>; }`,
    );

    const route = toLinkPrefetchRoute(createRoute({ loadingPath: "/tmp/loading.tsx", pagePath }));
    expect(route.canPrefetchStaticRoute).toBe(true);
    expect(route.loadingShellVaryParamNames).toEqual(["itemId"]);
    expect(route.prefetchVaryParamNames).toBeUndefined();
  });

  it("tracks only params accessed before connection for runtime prefetches", () => {
    const pagePath = writeSource(
      "page.tsx",
      `import { connection } from "next/server";
      export const unstable_instant = { prefetch: "runtime", samples: [] };
      export default async function Page({ params }) {
        const { category } = await params;
        await connection();
        const { itemId } = await params;
        return <div>{category}:{itemId}</div>;
      }`,
    );

    const route = toLinkPrefetchRoute(createRoute({ pagePath }));
    expect(route.canPrefetchRuntimeShell).toBe(true);
    expect(route.runtimePrefetchVaryParamNames).toEqual(["category"]);
  });

  it("does not treat static searchParams text as query access", () => {
    const pagePath = writeSource(
      "page.tsx",
      `export default function Page() { return <div>searchParams are not accessed</div>; }`,
    );
    const route = toLinkPrefetchRoute(
      createRoute({ isDynamic: false, pagePath, params: [], patternParts: ["static"] }),
    );
    expect(route.prefetchVarySearchParams).toBeUndefined();
  });

  it("tracks searchParams and optional catch-all reflection", () => {
    const pagePath = writeSource(
      "page.tsx",
      `export default async function Page({ params, searchParams }) {
        const resolved = await params;
        const copied = { ...resolved };
        const query = await searchParams;
        return <div>{copied.slug}:{query.q}</div>;
      }`,
    );
    const route = toLinkPrefetchRoute(
      createRoute({ pagePath, params: ["slug"], patternParts: [":slug*"] }),
    );
    expect(route.prefetchVaryParamNames).toEqual(["slug"]);
    expect(route.prefetchVarySearchParams).toBe(true);
  });

  it("keys concrete prefetches only by observed params and search", () => {
    const originalWindow = globalThis.window;
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
    } finally {
      if (originalWindow === undefined) delete (globalThis as any).window;
      else (globalThis as any).window = originalWindow;
    }
  });
});
