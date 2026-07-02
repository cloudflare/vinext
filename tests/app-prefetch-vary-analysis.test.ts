import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { toLinkPrefetchRoute } from "../packages/vinext/src/entries/app-browser-entry.js";
import type { AppRoute } from "../packages/vinext/src/routing/app-router.js";

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
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop()!, { force: true, recursive: true });
  }
});

describe("App Router prefetch vary analysis", () => {
  it("does not treat JSX text as a searchParams access", () => {
    const pagePath = writeSource(
      "page.tsx",
      `export default function Page() {
        return <div>Static target content - no searchParams access</div>;
      }`,
    );

    const route = toLinkPrefetchRoute(
      createRoute({ pagePath, params: [], patternParts: ["static"] }),
    );

    expect(route.prefetchVarySearchParams).toBeUndefined();
  });

  it("marks routes that await searchParams as varying by query", () => {
    const pagePath = writeSource(
      "page.tsx",
      `export default async function Page({ searchParams }: { searchParams: Promise<{ foo?: string }> }) {
        const { foo } = await searchParams;
        return <div>{foo}</div>;
      }`,
    );

    const route = toLinkPrefetchRoute(
      createRoute({ pagePath, params: [], patternParts: ["target"] }),
    );

    expect(route.prefetchVarySearchParams).toBe(true);
  });

  it("marks helper searchParams reads as varying by query", () => {
    const pagePath = writeSource(
      "page.tsx",
      `export default function Page({ searchParams }: { searchParams: Promise<{ foo?: string }> }) {
        return <div>{readQuery(searchParams)}</div>;
      }

      async function readQuery(input: Promise<{ foo?: string }>) {
        return (await input).foo;
      }`,
    );

    const route = toLinkPrefetchRoute(
      createRoute({ pagePath, params: [], patternParts: ["target"] }),
    );

    expect(route.prefetchVarySearchParams).toBe(true);
  });

  it("marks prop-renamed searchParams reads as varying by query", () => {
    const pagePath = writeSource(
      "page.tsx",
      `export default async function Page({ searchParams: query }: { searchParams: Promise<{ foo?: string }> }) {
        const resolved = await query;
        return <div>{resolved.foo}</div>;
      }`,
    );

    const route = toLinkPrefetchRoute(
      createRoute({ pagePath, params: [], patternParts: ["target"] }),
    );

    expect(route.prefetchVarySearchParams).toBe(true);
  });

  it("tracks params read from an object props argument", () => {
    const pagePath = writeSource(
      "page.tsx",
      `export default async function Page(props: { params: Promise<{ category: string; itemId: string }> }) {
        const { itemId } = await props.params;
        return <div>{itemId}</div>;
      }`,
    );

    const route = toLinkPrefetchRoute(createRoute({ pagePath }));

    expect(route.prefetchVaryParamNames).toEqual(["itemId"]);
  });

  it("marks helper-passed object props params as varying by all known params", () => {
    const pagePath = writeSource(
      "page.tsx",
      `export default function Page(props: { params: Promise<{ category: string; itemId: string }> }) {
        return <div>{readItem(props.params)}</div>;
      }

      async function readItem(input: Promise<{ category: string; itemId: string }>) {
        return (await input).itemId;
      }`,
    );

    const route = toLinkPrefetchRoute(createRoute({ pagePath }));

    expect(route.prefetchVaryParamNames).toEqual(["category", "itemId"]);
  });

  it("marks object props searchParams reads as varying by query", () => {
    const pagePath = writeSource(
      "page.tsx",
      `export default async function Page(props: { searchParams: Promise<{ foo?: string }> }) {
        const query = await props.searchParams;
        return <div>{query.foo}</div>;
      }`,
    );

    const route = toLinkPrefetchRoute(
      createRoute({ pagePath, params: [], patternParts: ["target"] }),
    );

    expect(route.prefetchVarySearchParams).toBe(true);
  });

  it("tracks object props params and searchParams promise aliases", () => {
    const pagePath = writeSource(
      "page.tsx",
      `export default async function Page(props: {
        params: Promise<{ category: string; itemId: string }>;
        searchParams: Promise<{ foo?: string }>;
      }) {
        const routeParams = props.params;
        const queryPromise = props.searchParams;
        const { itemId } = await routeParams;
        const query = await queryPromise;
        return <div>{itemId}:{query.foo}</div>;
      }`,
    );

    const route = toLinkPrefetchRoute(createRoute({ pagePath }));

    expect(route.prefetchVaryParamNames).toEqual(["itemId"]);
    expect(route.prefetchVarySearchParams).toBe(true);
  });

  it("tracks params read from awaited member expressions", () => {
    const pagePath = writeSource(
      "page.tsx",
      `export default async function Page({ params }: { params: Promise<{ category: string; itemId: string }> }) {
        const itemId = (await params).itemId;
        return <div>{itemId}</div>;
      }`,
    );

    const route = toLinkPrefetchRoute(createRoute({ pagePath }));

    expect(route.prefetchVaryParamNames).toEqual(["itemId"]);
  });

  it("tracks params destructured from awaited aliases", () => {
    const pagePath = writeSource(
      "page.tsx",
      `export default async function Page({ params }: { params: Promise<{ category: string; itemId: string }> }) {
        const resolved = await params;
        const { itemId } = resolved;
        return <div>{itemId}</div>;
      }`,
    );

    const route = toLinkPrefetchRoute(createRoute({ pagePath }));

    expect(route.prefetchVaryParamNames).toEqual(["itemId"]);
  });

  it("marks Object.assign param and searchParam copies as varying", () => {
    const pagePath = writeSource(
      "page.tsx",
      `export default async function Page({
        params,
        searchParams,
      }: {
        params: Promise<{ category: string; itemId: string }>;
        searchParams: Promise<{ foo?: string }>;
      }) {
        const paramCopy = Object.assign({}, await params);
        const queryCopy = Object.assign({}, await searchParams);
        return <div>{paramCopy.itemId}:{queryCopy.foo}</div>;
      }`,
    );

    const route = toLinkPrefetchRoute(createRoute({ pagePath }));

    expect(route.prefetchVaryParamNames).toEqual(["category", "itemId"]);
    expect(route.prefetchVarySearchParams).toBe(true);
  });

  it("does not treat client module param reads as server segment variation", () => {
    const layoutPath = writeSource(
      "layout.tsx",
      `"use client";

      import { use } from "react";

      export default function Layout({ params, children }: { params: Promise<{ category: string }>; children: React.ReactNode }) {
        const { category } = use(params);
        return <section data-category={category}>{children}</section>;
      }`,
    );
    const pagePath = writeSource(
      "page.tsx",
      `"use client";

      import { use } from "react";

      export default function Page({ params, searchParams }: { params: Promise<{ itemId: string }>; searchParams: Promise<Record<string, string>> }) {
        const { itemId } = use(params);
        const query = use(searchParams);
        return <div>{itemId}:{query.q}</div>;
      }`,
    );

    const route = toLinkPrefetchRoute(createRoute({ layouts: [layoutPath], pagePath }));

    expect(route.loadingShellVaryParamNames).toBeUndefined();
    expect(route.prefetchVaryParamNames).toBeUndefined();
    expect(route.prefetchVarySearchParams).toBeUndefined();
  });

  it("tracks only params accessed before connection for runtime-prefetch sharing", () => {
    const layoutPath = writeSource(
      "layout.tsx",
      `export default async function Layout({ children, params }: { children: React.ReactNode; params: Promise<{ category: string; itemId: string }> }) {
        const { category } = await params;
        return <section data-category={category}>{children}</section>;
      }`,
    );
    const pagePath = writeSource(
      "page.tsx",
      `import { connection } from "next/server";

      export default async function Page({ params }: { params: Promise<{ category: string; itemId: string }> }) {
        const { category } = await params;
        await connection();
        const { itemId } = await params;
        return <div>{category}:{itemId}</div>;
      }`,
    );

    const route = toLinkPrefetchRoute(
      createRoute({
        layouts: [layoutPath],
        loadingPath: writeSource(
          "loading.tsx",
          "export default function Loading() { return null; }",
        ),
        pagePath,
      }),
    );

    expect(route.loadingShellVaryParamNames).toEqual(["category"]);
    expect(route.prefetchVaryParamNames).toEqual(["category"]);
  });

  it("marks static-param pages that call connection as requiring fresh navigation", () => {
    const pagePath = writeSource(
      "page.tsx",
      `import { connection } from "next/server";

      export function generateStaticParams() {
        return [{ category: "books" }];
      }

      export default async function Page({ params }: { params: Promise<{ category: string }> }) {
        await connection();
        const { category } = await params;
        return <div>{category}</div>;
      }`,
    );

    const route = toLinkPrefetchRoute(
      createRoute({
        loadingPath: writeSource(
          "loading.tsx",
          "export default function Loading() { return null; }",
        ),
        pagePath,
        params: ["category"],
        patternParts: ["items", ":category"],
      }),
    );

    expect(route.canPrefetchStaticRoute).toBe(true);
    expect(route.requiresDynamicNavigationRequest).toBe(true);
  });

  it("does not truncate static analysis on local connection helpers", () => {
    const pagePath = writeSource(
      "page.tsx",
      `function connection() {
        return Promise.resolve();
      }

      export function generateStaticParams() {
        return [{ category: "books" }];
      }

      export default async function Page({ params }: { params: Promise<{ category: string; itemId: string }> }) {
        await connection();
        const { itemId } = await params;
        return <div>{itemId}</div>;
      }`,
    );

    const route = toLinkPrefetchRoute(createRoute({ pagePath }));

    expect(route.prefetchVaryParamNames).toEqual(["itemId"]);
    expect(route.requiresDynamicNavigationRequest).toBeUndefined();
  });

  it("does not truncate static analysis on non-Next connection imports", () => {
    const pagePath = writeSource(
      "page.tsx",
      `import { connection } from "./db";

      export function generateStaticParams() {
        return [{ category: "books" }];
      }

      export default async function Page({ params }: { params: Promise<{ category: string; itemId: string }> }) {
        await connection();
        const { itemId } = await params;
        return <div>{itemId}</div>;
      }`,
    );

    const route = toLinkPrefetchRoute(createRoute({ pagePath }));

    expect(route.prefetchVaryParamNames).toEqual(["itemId"]);
    expect(route.requiresDynamicNavigationRequest).toBeUndefined();
  });

  it("uses aliased next/server.js connection imports as the static analysis cutoff", () => {
    const pagePath = writeSource(
      "page.tsx",
      `import { connection as waitForRequest } from "next/server.js";

      export function generateStaticParams() {
        return [{ category: "books" }];
      }

      export default async function Page({ params }: { params: Promise<{ category: string; itemId: string }> }) {
        const { category } = await params;
        await waitForRequest();
        const { itemId } = await params;
        return <div>{category}:{itemId}</div>;
      }`,
    );

    const route = toLinkPrefetchRoute(createRoute({ pagePath }));

    expect(route.prefetchVaryParamNames).toEqual(["category"]);
    expect(route.requiresDynamicNavigationRequest).toBe(true);
  });

  it("does not truncate static analysis on connection substrings", () => {
    const pagePath = writeSource(
      "page.tsx",
      `function myConnection() {
        return "not next/server connection";
      }

      export default async function Page({ params }: { params: Promise<{ category: string; itemId: string }> }) {
        myConnection();
        const { itemId } = await params;
        return <div>{itemId}</div>;
      }`,
    );

    const route = toLinkPrefetchRoute(createRoute({ pagePath }));

    expect(route.prefetchVaryParamNames).toEqual(["itemId"]);
  });

  it("does not truncate static analysis on connection text", () => {
    const pagePath = writeSource(
      "page.tsx",
      `export default async function Page({ params }: { params: Promise<{ category: string; itemId: string }> }) {
        const docs = "Call connection() to opt into dynamic rendering";
        const { itemId } = await params;
        return <div>{docs}<code>connection()</code>{itemId}</div>;
      }`,
    );

    const route = toLinkPrefetchRoute(createRoute({ pagePath }));

    expect(route.prefetchVaryParamNames).toEqual(["itemId"]);
  });

  it("marks computed param reads as varying by all known params", () => {
    const pagePath = writeSource(
      "page.tsx",
      `export default async function Page({ params }: { params: Promise<{ category: string; itemId: string }> }) {
        const key = "category";
        const resolved = await params;
        return <div>{resolved[key]}</div>;
      }`,
    );

    const route = toLinkPrefetchRoute(createRoute({ pagePath }));

    expect(route.prefetchVaryParamNames).toEqual(["category", "itemId"]);
  });

  it("marks helper param reads as varying by all known params", () => {
    const pagePath = writeSource(
      "page.tsx",
      `export default async function Page({ params }: { params: Promise<{ category: string; itemId: string }> }) {
        return <div>{readItem(await params)}</div>;
      }

      function readItem(input: { category: string; itemId: string }) {
        return input.itemId;
      }`,
    );

    const route = toLinkPrefetchRoute(createRoute({ pagePath }));

    expect(route.prefetchVaryParamNames).toEqual(["category", "itemId"]);
  });

  it("tracks prop-renamed param reads", () => {
    const pagePath = writeSource(
      "page.tsx",
      `export default async function Page({ params: routeParams }: { params: Promise<{ category: string; itemId: string }> }) {
        const resolved = await routeParams;
        return <div>{resolved.itemId}</div>;
      }`,
    );

    const route = toLinkPrefetchRoute(createRoute({ pagePath }));

    expect(route.prefetchVaryParamNames).toEqual(["itemId"]);
  });

  it("extracts runtime-prefetch loading fallback metadata", () => {
    const pagePath = writeSource(
      "page.tsx",
      `import { Suspense } from "react";
      import { connection } from "next/server";

      export const unstable_instant = { prefetch: "runtime", samples: [] };

      export default async function Page({ params }: { params: Promise<{ category: string; itemId: string }> }) {
        const { category } = await params;
        return <section>
          <div>{category}</div>
          <Suspense fallback={<div>Loading page...</div>}>
            <StaticContent />
          </Suspense>
          <Suspense fallback={<div data-loading="true">Loading item details...</div>}>
            <DynamicContent />
          </Suspense>
        </section>;
      }

      async function StaticContent() {
        return <div>Static</div>;
      }

      async function DynamicContent() {
        await connection();
        return <div>Dynamic</div>;
      }`,
    );

    const route = toLinkPrefetchRoute(createRoute({ pagePath }));

    expect(route.runtimePrefetchLoadingFallback).toEqual({
      attributes: { "data-loading": "true" },
      tagName: "div",
      text: "Loading item details...",
    });
  });

  it("decodes runtime-prefetch fallback entities without double-decoding", () => {
    const pagePath = writeSource(
      "page.tsx",
      `import { Suspense } from "react";

      export const prefetch = "allow-runtime";

      export default function Page() {
        return <Suspense fallback={<div data-loading="true" data-label="&amp;lt;">Loading &amp;lt;item&amp;gt;</div>}>
          <DynamicContent />
        </Suspense>;
      }`,
    );

    const route = toLinkPrefetchRoute(createRoute({ pagePath }));

    expect(route.runtimePrefetchLoadingFallback).toEqual({
      attributes: { "data-label": "&lt;", "data-loading": "true" },
      tagName: "div",
      text: "Loading &lt;item&gt;",
    });
  });

  it("recognizes optional catch-all direct, enumeration, and in-operator param accesses", () => {
    const directRoute = toLinkPrefetchRoute(
      createRoute({
        pagePath: writeSource(
          "direct.tsx",
          `export default async function Page({ params }: { params: Promise<{ slug?: string[] }> }) {
            const { slug } = await params;
            return <div>{slug?.join("/")}</div>;
          }`,
        ),
        params: ["slug"],
        pattern: "/:slug*",
        patternParts: [":slug*"],
      }),
    );
    const enumerationRoute = toLinkPrefetchRoute(
      createRoute({
        pagePath: writeSource(
          "enumeration.tsx",
          `export default async function Page({ params }: { params: Promise<{ slug?: string[] }> }) {
            const resolved = await params;
            const copy = { ...resolved };
            return <div>{copy.slug?.join("/")}</div>;
          }`,
        ),
        params: ["slug"],
        pattern: "/:slug*",
        patternParts: [":slug*"],
      }),
    );
    const inOperatorRoute = toLinkPrefetchRoute(
      createRoute({
        pagePath: writeSource(
          "in-operator.tsx",
          `export default async function Page({ params }: { params: Promise<{ slug?: string[] }> }) {
            const resolved = await params;
            const hasSlug = "slug" in resolved;
            return <div>{String(hasSlug)}</div>;
          }`,
        ),
        params: ["slug"],
        pattern: "/:slug*",
        patternParts: [":slug*"],
      }),
    );

    expect(directRoute.prefetchVaryParamNames).toEqual(["slug"]);
    expect(enumerationRoute.prefetchVaryParamNames).toEqual(["slug"]);
    expect(inOperatorRoute.prefetchVaryParamNames).toEqual(["slug"]);
  });
});
