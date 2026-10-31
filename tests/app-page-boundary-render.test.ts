import { describe, expect, it, vi } from "vite-plus/test";
import React from "react";
import ReactDOMServer from "react-dom/server";
import {
  renderAppPageErrorBoundary,
  renderAppPageHttpAccessFallback,
} from "../packages/vinext/src/server/app-page-boundary-render.js";
import type { AppElements } from "../packages/vinext/src/server/app-elements.js";
import type { AppPagePreparedRouteHead } from "../packages/vinext/src/server/app-page-head.js";
import type { MetadataFileRoute } from "../packages/vinext/src/server/metadata-routes.js";
import { VINEXT_RSC_VARY_HEADER } from "../packages/vinext/src/server/app-rsc-cache-busting.js";
import { applyFileBasedMetadata } from "../packages/vinext/src/server/file-based-metadata.js";

function createStreamFromMarkup(markup: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(markup));
      controller.close();
    },
  });
}

function renderElementToStream(element: React.ReactNode | AppElements): ReadableStream<Uint8Array> {
  if (element !== null && typeof element === "object" && !React.isValidElement(element)) {
    // Flat map payload — extract the route element and render it to HTML
    // (mirrors what the real SSR entry does after deserializing the Flight stream)
    const record = element as Record<string, unknown>;
    const routeId = record.__route;
    if (typeof routeId === "string" && React.isValidElement(record[routeId])) {
      return createStreamFromMarkup(
        ReactDOMServer.renderToStaticMarkup(record[routeId] as React.ReactNode),
      );
    }
    return createStreamFromMarkup(JSON.stringify(element));
  }
  return createStreamFromMarkup(ReactDOMServer.renderToStaticMarkup(element));
}

// Streams the route element through Fizz, so Suspense branches resolve late.
function renderElementToFizzStream(
  element: React.ReactNode | AppElements,
): ReadableStream<Uint8Array> {
  const record = element as Record<string, unknown>;
  const node = record[record.__route as string] as React.ReactNode;
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  void ReactDOMServer.renderToReadableStream(node).then((stream) => stream.pipeTo(writable));
  return readable;
}

const UNPREPARED_ROUTE_HEAD = {
  observeSearchParams: false,
  prepared: null,
  searchParams: new URLSearchParams(),
  streamMetadata: false,
};

function renderWirePayloadToStream(payload: unknown): ReadableStream<Uint8Array> {
  return createStreamFromMarkup(JSON.stringify(payload));
}

function createCommonOptions() {
  const clearRequestContext = vi.fn();
  const loadSsrHandler = vi.fn(async () => ({
    async handleSsr(rscStream: ReadableStream<Uint8Array>) {
      return rscStream;
    },
  }));

  return {
    applyFileBasedMetadata,
    buildFontLinkHeader(preloads: readonly { href: string; type: string }[] | null | undefined) {
      if (!preloads || preloads.length === 0) {
        return "";
      }
      return preloads.map((preload) => `<${preload.href}>; rel=preload`).join(", ");
    },
    clearRequestContext,
    createRscOnErrorHandler() {
      return () => null;
    },
    getFontLinks() {
      return ["/styles.css"];
    },
    getFontPreloads() {
      return [{ href: "/font.woff2", type: "font/woff2" }];
    },
    getFontStyles() {
      return [".font { font-family: Test; }"];
    },
    getNavigationContext() {
      return { pathname: "/posts/missing", searchParams: new URLSearchParams(), params: {} };
    },
    isRscRequest: false,
    loadSsrHandler,
    makeThenableParams<T>(params: T) {
      return params;
    },
    middlewareContext: {
      headers: null,
      status: null,
    },
    metadataRoutes: [],
    renderToReadableStream: renderElementToStream,
    request: new Request("https://example.com/posts/missing"),
    requestUrl: "https://example.com/posts/missing",
    resolveChildSegments() {
      return [];
    },
    rootLayouts: EMPTY_ROOT_LAYOUTS,
  };
}

function createMiddlewareContext() {
  const headers = new Headers();
  headers.set("x-middleware-security", "present");
  headers.append("set-cookie", "session=rotated; Path=/; HttpOnly");
  headers.set("vary", "x-auth-state");

  return {
    headers,
    status: 299,
  };
}

function RootLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: { slug?: string };
}) {
  return React.createElement("div", { "data-layout": "root", "data-slug": params.slug }, children);
}

function LeafLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: { slug?: string };
}) {
  return React.createElement(
    "section",
    { "data-layout": "leaf", "data-slug": params.slug },
    children,
  );
}

function NotFoundBoundary() {
  return React.createElement("p", { "data-boundary": "not-found" }, "Missing page");
}

function RouteErrorBoundary({ error }: { error: Error }) {
  return React.createElement("p", { "data-boundary": "route-error" }, `route:${error.message}`);
}

function GlobalErrorBoundary({ error }: { error: Error }) {
  return React.createElement("p", { "data-boundary": "global-error" }, `global:${error.message}`);
}

function GlobalErrorBoundaryWithStack({ error }: { error: Error }) {
  return React.createElement("p", { "data-boundary": "global-error" }, error.stack);
}

type TestModule = {
  default: React.ComponentType<any>;
  generateMetadata?: (props: any) => unknown;
  generateViewport?: (props: any) => unknown;
  metadata?: { description?: string; title?: string };
  viewport?: Record<string, unknown>;
};

const rootLayoutModule = {
  default: RootLayout,
  metadata: { description: "Root layout description" },
  viewport: { themeColor: "#111111" },
} satisfies TestModule;

const leafLayoutModule = {
  default: LeafLayout,
} satisfies TestModule;

const notFoundModule = {
  default: NotFoundBoundary,
} satisfies TestModule;

function RedirectingRootLayout(): React.ReactNode {
  const error = Object.assign(new Error("NEXT_REDIRECT"), {
    digest: "NEXT_REDIRECT;replace;/login;307;",
  });
  throw error;
}

const redirectingRootLayoutModule = {
  default: RedirectingRootLayout,
} satisfies TestModule;

function NotFoundThrowingRootLayout(): React.ReactNode {
  // Mimics notFound() re-thrown while the route-miss boundary itself is
  // rendering — the shape that has no parent boundary to climb to.
  const signal = Object.assign(new Error("NEXT_NOT_FOUND"), { digest: "NEXT_NOT_FOUND" });
  throw signal;
}

const notFoundThrowingRootLayoutModule = {
  default: NotFoundThrowingRootLayout,
} satisfies TestModule;

const notFoundModuleWithMetadata = {
  default: NotFoundBoundary,
  metadata: { title: "notfound title" },
} satisfies TestModule;

const routeErrorModule = {
  default: RouteErrorBoundary,
} satisfies TestModule;

const globalErrorModule = {
  default: GlobalErrorBoundary,
} satisfies TestModule;

const globalErrorModuleWithStack = {
  default: GlobalErrorBoundaryWithStack,
} satisfies TestModule;

function ThrowingGlobalErrorBoundary(): React.ReactNode {
  throw new Error("global-error boom");
}

const throwingGlobalErrorModule = {
  default: ThrowingGlobalErrorBoundary,
} satisfies TestModule;

function SignalThrowingGlobalErrorBoundary(): React.ReactNode {
  // Mimics notFound() called from inside global-error: a navigation signal that
  // must propagate rather than being degraded to a built-in 200.
  const signal = Object.assign(new Error("NEXT_NOT_FOUND"), { digest: "NEXT_NOT_FOUND" });
  throw signal;
}

const signalThrowingGlobalErrorModule = {
  default: SignalThrowingGlobalErrorBoundary,
} satisfies TestModule;

const EMPTY_ROOT_LAYOUTS: readonly TestModule[] = [];

describe("app page boundary render helpers", () => {
  it("returns null when no HTTP access fallback boundary exists", async () => {
    const common = createCommonOptions();

    const response = await renderAppPageHttpAccessFallback<TestModule>({
      ...common,
      matchedParams: { slug: "missing" },
      route: {
        pattern: "/posts/[slug]",
        params: { slug: "missing" },
      },
      statusCode: 404,
    });

    expect(response).toBeNull();
    expect(common.loadSsrHandler).not.toHaveBeenCalled();
    expect(common.clearRequestContext).not.toHaveBeenCalled();
  });

  it("converts redirects thrown while rendering HTTP access fallbacks into redirect responses", async () => {
    const common = createCommonOptions();

    const response = await renderAppPageHttpAccessFallback<TestModule>({
      ...common,
      matchedParams: { slug: "missing" },
      rootLayouts: [redirectingRootLayoutModule],
      rootNotFoundModule: notFoundModule,
      route: null,
      statusCode: 404,
    });

    expect(response?.status).toBe(307);
    const location = response?.headers.get("location");
    expect(location).toBeTruthy();
    expect(new URL(location!, common.request.url).pathname).toBe("/login");
    expect(common.clearRequestContext).toHaveBeenCalledTimes(1);
  });

  it("terminates with a status-text response when an http-access signal is thrown while rendering the boundary", async () => {
    // Scope boundary for the route-miss redirect fix. Redirects thrown during
    // boundary rendering are fully handled (see the test above), but a
    // notFound()/forbidden()/unauthorized() re-thrown *inside* the boundary has
    // no parent boundary to climb to. renderBoundarySpecialErrorResponse omits
    // renderFallbackPage precisely so it cannot recurse on the same boundary,
    // so it falls through to a plain status-text response rather than the
    // boundary UI. Pins that deliberate terminal behavior.
    const common = createCommonOptions();

    const response = await renderAppPageHttpAccessFallback<TestModule>({
      ...common,
      matchedParams: { slug: "missing" },
      rootLayouts: [notFoundThrowingRootLayoutModule],
      rootNotFoundModule: notFoundModule,
      route: null,
      statusCode: 404,
    });

    expect(response?.status).toBe(404);
    const body = await response?.text();
    expect(body).toBe("Not Found");
    expect(body).not.toContain('data-boundary="not-found"');
  });

  it("renders HTTP access fallbacks with layout metadata and wrapped HTML", async () => {
    const common = createCommonOptions();

    const response = await renderAppPageHttpAccessFallback<TestModule>({
      ...common,
      matchedParams: { slug: "missing" },
      rootLayouts: [rootLayoutModule],
      route: {
        layoutTreePositions: [0, 1],
        layouts: [rootLayoutModule, leafLayoutModule],
        notFound: notFoundModule,
        params: { slug: "missing" },
        pattern: "/posts/[slug]",
        routeSegments: ["posts", "[slug]"],
      },
      statusCode: 404,
    });

    expect(common.loadSsrHandler).toHaveBeenCalledTimes(1);
    expect(response?.status).toBe(404);
    expect(response?.headers.get("link")).toContain("/font.woff2");

    const html = await response?.text();
    expect(common.clearRequestContext).toHaveBeenCalledTimes(1);
    expect(html).toContain('data-layout="root"');
    expect(html).toContain('data-layout="leaf"');
    expect(html).toContain('data-boundary="not-found"');
    expect(html).toContain('content="Root layout description"');
    expect(html).toContain('name="viewport"');
    expect(html).toContain('name="theme-color" content="#111111"');
    expect(html).toContain('name="robots"');
    expect(html).toContain('content="noindex"');
  });

  it("renders not-found boundary metadata exactly once for HTTP access fallbacks", async () => {
    // Ported from Next.js:
    // test/e2e/app-dir/metadata-streaming/metadata-streaming.test.ts
    //   "should not duplicate metadata with navigation API"
    //
    // The upstream fixture calls notFound() from generateMetadata() and expects
    // the rendered not-found boundary's metadata (`not-found.tsx` static
    // metadata) to produce a single title in the document.
    const common = createCommonOptions();

    const response = await renderAppPageHttpAccessFallback<TestModule>({
      ...common,
      matchedParams: { slug: "missing" },
      rootLayouts: [rootLayoutModule],
      route: {
        layoutTreePositions: [0],
        layouts: [rootLayoutModule],
        notFound: notFoundModuleWithMetadata,
        params: { slug: "missing" },
        pattern: "/posts/[slug]",
        routeSegments: ["posts", "[slug]"],
      },
      statusCode: 404,
    });

    expect(response?.status).toBe(404);

    const html = await response?.text();
    expect(html?.match(/<title>/g) ?? []).toHaveLength(1);
    expect(html).toContain("<title>notfound title</title>");
  });

  it("uses mirrored-slot params and branch-local metadata and viewport for blocking 404s", async () => {
    const common = createCommonOptions();
    const applyMetadata = vi.fn(
      async (metadata: Parameters<typeof applyFileBasedMetadata>[0]) => metadata,
    );
    const metadataParams: unknown[] = [];
    const viewportParams: unknown[] = [];
    const primaryNotFound = {
      default: NotFoundBoundary,
      viewport: { width: "primary-only" },
    } satisfies TestModule;
    const slotNotFound = {
      default: NotFoundBoundary,
      async generateMetadata({ params }: { params: Promise<unknown> }) {
        metadataParams.push(await params);
        return { title: "slot blocking metadata" };
      },
      async generateViewport({ params }: { params: Promise<unknown> }) {
        viewportParams.push(await params);
        return { themeColor: "#abcdef" };
      },
    } satisfies TestModule;
    const route = {
      layouts: [],
      notFound: primaryNotFound,
      notFoundTreePosition: 3,
      pattern: "/distinct/[id]/[...rest]",
      routeSegments: ["distinct", "[id]", "[...rest]"],
      slots: {
        mirrored: {
          layoutIndex: -1,
          name: "mirrored",
          notFound: slotNotFound,
          notFoundTreePosition: 3,
          // The slot's page renders, so its own not-found supplies the head.
          page: { default: () => null },
          routeSegments: ["distinct", "[name]", "[...catchAll]"],
          slotParamNames: ["name", "catchAll"],
          slotPatternParts: ["distinct", ":name", ":catchAll+"],
        },
      },
    } as const;

    const response = await renderAppPageHttpAccessFallback<TestModule>({
      ...common,
      applyFileBasedMetadata: applyMetadata,
      basePath: "/base",
      matchedParams: { id: "alice", rest: ["tail"] },
      metadataRoutes: [
        {
          contentType: "image/png",
          filePath: "/tmp/app/icon.png",
          isDynamic: false,
          routePrefix: "/",
          servedUrl: "/icon.png",
          type: "icon",
        },
      ],
      request: new Request("https://example.com/base/distinct/alice/tail"),
      requestUrl: "https://example.com/base/distinct/alice/tail",
      route,
      statusCode: 404,
    });

    expect(response?.status).toBe(404);
    const html = await response?.text();
    expect(html).toContain("<title>slot blocking metadata</title>");
    expect(html).toContain('name="theme-color" content="#abcdef"');
    expect(html).toContain("width=primary-only");
    expect(metadataParams).toEqual([
      { catchAll: ["tail"], name: "alice" },
      { catchAll: ["tail"], name: "alice" },
    ]);
    expect(viewportParams).toEqual([{ catchAll: ["tail"], name: "alice" }]);
    expect(applyMetadata).toHaveBeenCalledTimes(1);

    metadataParams.length = 0;
    viewportParams.length = 0;
    const rscResponse = await renderAppPageHttpAccessFallback<TestModule>({
      ...common,
      basePath: "/base",
      isRscRequest: true,
      matchedParams: { id: "alice", rest: ["tail"] },
      renderToReadableStream: renderWirePayloadToStream,
      request: new Request("https://example.com/base/distinct/alice/tail.rsc"),
      requestUrl: "https://example.com/base/distinct/alice/tail.rsc",
      route,
      statusCode: 404,
    });
    expect(rscResponse?.status).toBe(404);
    expect(metadataParams).toEqual([
      { catchAll: ["tail"], name: "alice" },
      { catchAll: ["tail"], name: "alice" },
    ]);
    expect(viewportParams).toEqual([{ catchAll: ["tail"], name: "alice" }]);
  });

  it("scopes an explicitly selected ancestor not-found boundary to its layout params", async () => {
    const common = createCommonOptions();
    const seenParams: unknown[] = [];
    const ancestorNotFound = {
      default: NotFoundBoundary,
      async generateMetadata({ params }: { params: Promise<unknown> }) {
        seenParams.push(await params);
        return { title: "ancestor not found" };
      },
    } satisfies TestModule;

    const response = await renderAppPageHttpAccessFallback<TestModule>({
      ...common,
      boundaryModule: ancestorNotFound,
      matchedParams: { locale: "en", slug: "missing" },
      route: {
        layoutTreePositions: [1, 3],
        layouts: [rootLayoutModule, leafLayoutModule],
        notFound: notFoundModule,
        notFoundTreePosition: 3,
        notFounds: [ancestorNotFound, null],
        pattern: "/[locale]/posts/[slug]",
        routeSegments: ["[locale]", "posts", "[slug]"],
      },
      statusCode: 404,
    });

    expect(response?.status).toBe(404);
    expect(seenParams).toEqual([{ locale: "en" }]);
  });

  it("uses loader-tree head traversal for blocking auth fallbacks", async () => {
    const common = createCommonOptions();
    const seenParams: unknown[] = [];
    const forbiddenModule = {
      default: NotFoundBoundary,
      async generateMetadata({ params }: { params: Promise<unknown> }) {
        seenParams.push(await params);
        return { title: "forbidden metadata" };
      },
    } satisfies TestModule;
    const slotLayout = {
      default: RootLayout,
      metadata: { description: "active slot description" },
      viewport: { themeColor: "#403403" },
    } satisfies TestModule;

    const response = await renderAppPageHttpAccessFallback<TestModule>({
      ...common,
      matchedParams: { locale: "en", slug: "private" },
      route: {
        forbidden: forbiddenModule,
        forbiddenTreePosition: 1,
        layoutTreePositions: [1],
        layouts: [rootLayoutModule],
        pattern: "/[locale]/posts/[slug]",
        routeSegments: ["[locale]", "posts", "[slug]"],
        slots: {
          sidebar: {
            layout: slotLayout,
            layoutIndex: 0,
            name: "sidebar",
            routeSegments: ["[locale]", "posts", "[slug]"],
          },
        },
      },
      statusCode: 403,
    });

    expect(response?.status).toBe(403);
    const html = await response?.text();
    expect(html).toContain("<title>forbidden metadata</title>");
    expect(html).toContain('content="active slot description"');
    expect(html).toContain('name="theme-color" content="#403403"');
    expect(seenParams).toEqual([{ locale: "en" }, { locale: "en" }]);
  });

  it("keeps the route's own head when the route's render threw the signal", async () => {
    // Next.js 16.2.7 answers such a document with an error shell headed by the
    // not-found metadata, then renders the route's own Flight payload in the
    // browser, so the visitor ends with the route's head: the page's metadata,
    // then the slot page's, which Turbopack merges after it.
    const common = createCommonOptions();
    const seenSearchParams: unknown[] = [];
    const pageModule = {
      default: () => null,
      async generateMetadata({ searchParams }: { searchParams: Promise<unknown> }) {
        seenSearchParams.push(await searchParams);
        return { description: "Post page description", title: "Post page title" };
      },
    } satisfies TestModule;
    const route = {
      layoutTreePositions: [0],
      layouts: [rootLayoutModule],
      notFound: notFoundModuleWithMetadata,
      notFoundTreePosition: 2,
      page: pageModule,
      pattern: "/posts/[slug]",
      routeSegments: ["posts", "[slug]"],
      slots: {
        sidebar: {
          layoutIndex: 0,
          name: "sidebar",
          page: { default: () => null, metadata: { title: "Sidebar page title" } },
        },
      },
    };

    const response = await renderAppPageHttpAccessFallback<TestModule>({
      ...common,
      matchedParams: { slug: "missing" },
      // A rewrite served /old?ref=feed&_rsc=1 from /posts/missing?ref=rewritten,
      // so the render read the rewritten query, never the request's.
      request: new Request("https://example.com/old?ref=feed&_rsc=1"),
      requestUrl: "https://example.com/old?ref=feed&_rsc=1",
      route,
      routeHead: {
        observeSearchParams: false,
        prepared: null,
        searchParams: new URLSearchParams("ref=rewritten"),
        streamMetadata: false,
      },
      statusCode: 404,
    });

    expect(response?.status).toBe(404);
    const html = await response?.text();
    expect(html?.match(/<title>/g) ?? []).toHaveLength(1);
    expect(html).toContain("<title>Sidebar page title</title>");
    expect(html).toContain('content="Post page description"');
    expect(html).toContain('data-boundary="not-found"');
    expect(seenSearchParams).toEqual([{ ref: "rewritten" }]);

    // A cache candidate reads the query its own head would, as the route's
    // render does, and the read keeps the response out of the cache.
    seenSearchParams.length = 0;
    const { consumeDynamicUsage, headersContextFromRequest, runWithHeadersContext } =
      await import("../packages/vinext/src/shims/headers.js");
    const candidateRequest = new Request("https://example.com/posts/missing?ref=feed");
    const dynamicUsed = await runWithHeadersContext(
      headersContextFromRequest(candidateRequest),
      async () => {
        await renderAppPageHttpAccessFallback<TestModule>({
          ...common,
          isCacheCandidate: true,
          matchedParams: { slug: "missing" },
          request: candidateRequest,
          requestUrl: candidateRequest.url,
          route,
          routeHead: {
            observeSearchParams: true,
            prepared: null,
            searchParams: new URLSearchParams("ref=feed"),
            streamMetadata: false,
          },
          statusCode: 404,
        });
        return consumeDynamicUsage();
      },
    );
    expect(seenSearchParams).toEqual([{ ref: "feed" }]);
    expect(dynamicUsed).toBe(true);
  });

  it("counts a metadata read of searchParams as the route's render would", async () => {
    // The render threw before its head started, so the fallback resolves it,
    // with the render's observer: a read is dynamic usage, so `dynamic =
    // "error"` still fails it. A force-static render's empty query isn't.
    const { consumeDynamicUsage } = await import("../packages/vinext/src/shims/headers.js");
    const common = createCommonOptions();
    const renderWith = (observeSearchParams: boolean) =>
      renderAppPageHttpAccessFallback<TestModule>({
        ...common,
        matchedParams: { slug: "missing" },
        route: {
          layoutTreePositions: [0],
          layouts: [rootLayoutModule],
          notFound: notFoundModuleWithMetadata,
          notFoundTreePosition: 2,
          page: {
            default: () => null,
            async generateViewport({ searchParams }: { searchParams: Promise<unknown> }) {
              await searchParams;
              return {};
            },
          },
          pattern: "/posts/[slug]",
          routeSegments: ["posts", "[slug]"],
        },
        routeHead: {
          ...UNPREPARED_ROUTE_HEAD,
          observeSearchParams,
          searchParams: new URLSearchParams("q=1"),
        },
        statusCode: 404,
      });

    consumeDynamicUsage();
    await (await renderWith(true))?.text();
    expect(consumeDynamicUsage()).toBe(true);

    await (await renderWith(false))?.text();
    expect(consumeDynamicUsage()).toBe(false);
  });

  it("falls back to the convention head when the route's generateMetadata throws the signal", async () => {
    // Next.js's metadata resolves the not-found convention's metadata when
    // generateMetadata() itself calls notFound().
    const common = createCommonOptions();

    const response = await renderAppPageHttpAccessFallback<TestModule>({
      ...common,
      matchedParams: { slug: "missing" },
      route: {
        layoutTreePositions: [0],
        layouts: [rootLayoutModule],
        notFound: notFoundModuleWithMetadata,
        notFoundTreePosition: 2,
        page: {
          default: () => null,
          generateMetadata() {
            throw Object.assign(new Error("NEXT_NOT_FOUND"), {
              digest: "NEXT_HTTP_ERROR_FALLBACK;404",
            });
          },
        },
        pattern: "/posts/[slug]",
        routeSegments: ["posts", "[slug]"],
      },
      routeHead: UNPREPARED_ROUTE_HEAD,
      statusCode: 404,
    });

    expect(response?.status).toBe(404);
    const html = await response?.text();
    expect(html?.match(/<title>/g) ?? []).toHaveLength(1);
    expect(html).toContain("<title>notfound title</title>");
  });

  it("resolves a generateMetadata() signal through the not-found convention whatever the render threw", async () => {
    // Next.js 16.2.7: a page calling forbidden() whose generateMetadata() calls
    // notFound() ends with the not-found convention's title, not forbidden's.
    const common = createCommonOptions();

    const response = await renderAppPageHttpAccessFallback<TestModule>({
      ...common,
      matchedParams: { slug: "private" },
      route: {
        forbidden: { default: NotFoundBoundary, metadata: { title: "forbidden title" } },
        forbiddenTreePosition: 2,
        layoutTreePositions: [0],
        layouts: [rootLayoutModule],
        notFound: notFoundModuleWithMetadata,
        notFoundTreePosition: 2,
        page: {
          default: () => null,
          generateMetadata() {
            throw Object.assign(new Error("NEXT_NOT_FOUND"), {
              digest: "NEXT_HTTP_ERROR_FALLBACK;404",
            });
          },
        },
        pattern: "/posts/[slug]",
        routeSegments: ["posts", "[slug]"],
      },
      routeHead: UNPREPARED_ROUTE_HEAD,
      statusCode: 403,
    });

    expect(response?.status).toBe(403);
    const html = await response?.text();
    expect(html?.match(/<title>/g) ?? []).toHaveLength(1);
    expect(html).toContain("<title>notfound title</title>");
  });

  it("settles a signal from generateMetadata() or generateViewport() on its own branch", async () => {
    // Next.js 16.2.7: a generateViewport() notFound() keeps the route's title,
    // and a generateMetadata() notFound() keeps the route's theme color.
    const common = createCommonOptions();
    const notFoundSignal = () => {
      throw Object.assign(new Error("NEXT_NOT_FOUND"), {
        digest: "NEXT_HTTP_ERROR_FALLBACK;404",
      });
    };
    const renderWithPage = (page: TestModule) =>
      renderAppPageHttpAccessFallback<TestModule>({
        ...common,
        matchedParams: { slug: "missing" },
        route: {
          layoutTreePositions: [0],
          layouts: [rootLayoutModule],
          notFound: notFoundModuleWithMetadata,
          notFoundTreePosition: 2,
          page,
          pattern: "/posts/[slug]",
          routeSegments: ["posts", "[slug]"],
        },
        routeHead: UNPREPARED_ROUTE_HEAD,
        statusCode: 404,
      });

    const viewportSignalHtml = await (
      await renderWithPage({
        default: () => null,
        generateMetadata: () => ({ title: "Route title" }),
        generateViewport: notFoundSignal,
      })
    )?.text();
    expect(viewportSignalHtml).toContain("<title>Route title</title>");
    expect(viewportSignalHtml).toContain('name="theme-color" content="#111111"');

    const metadataSignalHtml = await (
      await renderWithPage({
        default: () => null,
        generateMetadata: notFoundSignal,
        viewport: { themeColor: "#00ff00" },
      })
    )?.text();
    expect(metadataSignalHtml).toContain("<title>notfound title</title>");
    expect(metadataSignalHtml).toContain('name="theme-color" content="#00ff00"');
  });

  it("streams the route's generated metadata without holding back the document", async () => {
    // Next.js 16.2.7 flushes the error shell at once (35ms to first byte
    // against a 3s generateMetadata()), and the route's title arrives later.
    const common = createCommonOptions();
    let resolveMetadata!: (metadata: { title: string }) => void;
    const metadata = new Promise<{ title: string }>((resolve) => {
      resolveMetadata = resolve;
    });
    const rendered = renderAppPageHttpAccessFallback<TestModule>({
      ...common,
      matchedParams: { slug: "missing" },
      renderToReadableStream: renderElementToFizzStream,
      route: {
        layoutTreePositions: [0],
        layouts: [rootLayoutModule],
        notFound: notFoundModuleWithMetadata,
        notFoundTreePosition: 2,
        page: { default: () => null },
        pattern: "/posts/[slug]",
        routeSegments: ["posts", "[slug]"],
      },
      routeHead: {
        prepared: {
          accessError: Promise.resolve(null),
          metadata,
          metadataPlacement: "body",
          viewport: Promise.resolve({ themeColor: "#222222" }),
        },
        observeSearchParams: false,
        searchParams: new URLSearchParams(),
        streamMetadata: true,
      },
      statusCode: 404,
    });

    const response = await Promise.race([
      rendered,
      new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 1000)),
    ]);
    expect(response).not.toBe("blocked");
    resolveMetadata({ title: "Streamed title" });
    const html = await (response as Response).text();
    expect(html.match(/<title>/g) ?? []).toHaveLength(1);
    expect(html.indexOf("<title>Streamed title</title>")).toBeGreaterThan(
      html.indexOf('data-boundary="not-found"'),
    );
    expect(html).toContain('name="theme-color" content="#222222"');
  });

  it("streams the convention's head behind the error page, and only an HTML-limited bot waits for it", async () => {
    // Next.js 16.2.7 streams its error shell's convention metadata behind
    // Suspense: headers in ~10ms against a 3s not-found generateMetadata(),
    // while an HTML-limited bot's document waits the full 3s.
    const common = createCommonOptions();
    let settleConventionMetadata!: () => void;
    const conventionMetadataSettled = new Promise<void>((resolve) => {
      settleConventionMetadata = resolve;
    });
    const route = {
      layoutTreePositions: [0],
      layouts: [rootLayoutModule],
      notFound: {
        default: NotFoundBoundary,
        async generateMetadata() {
          await conventionMetadataSettled;
          return { title: "Slow notfound title" };
        },
      },
      notFoundTreePosition: 2,
      page: { default: () => null },
      pattern: "/posts/[slug]",
      routeSegments: ["posts", "[slug]"],
    };
    const routeHead = {
      prepared: {
        accessError: Promise.resolve(null),
        metadata: Promise.resolve({ title: "Route title" }),
        metadataPlacement: "head" as const,
        viewport: Promise.resolve({}),
      },
      observeSearchParams: false,
      searchParams: new URLSearchParams(),
      streamMetadata: true,
    };
    const unlessBlocked = <T>(rendered: Promise<T>) =>
      Promise.race([
        rendered,
        new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 200)),
      ]);

    const browserResponse = await unlessBlocked(
      renderAppPageHttpAccessFallback<TestModule>({
        ...common,
        matchedParams: { slug: "missing" },
        renderToReadableStream: renderElementToFizzStream,
        route,
        routeHead,
        statusCode: 404,
      }),
    );
    expect(browserResponse).not.toBe("blocked");
    const botRender = renderAppPageHttpAccessFallback<TestModule>({
      ...common,
      matchedParams: { slug: "missing" },
      renderToReadableStream: renderElementToFizzStream,
      route,
      routeHead,
      serveStreamingMetadata: false,
      statusCode: 404,
    });
    expect(await unlessBlocked(botRender)).toBe("blocked");

    settleConventionMetadata();
    const html = await (browserResponse as Response).text();
    expect(html.match(/<title>/g) ?? []).toHaveLength(1);
    expect(html).toContain("<title>Route title</title>");
    expect(await (await botRender)?.text()).toContain("<title>Slow notfound title</title>");
  });

  it("renders no viewport tags for a failed generateViewport(), as Next.js's Viewport renders null", async () => {
    // Next.js 16.2.7's Viewport catches a failed branch to null, so neither
    // its tags nor the defaults (`width=device-width, initial-scale=1`) render.
    const common = createCommonOptions();
    const viewportError = () => {
      throw new Error("viewport boom");
    };
    const notFoundSignal = () => {
      throw Object.assign(new Error("NEXT_NOT_FOUND"), {
        digest: "NEXT_HTTP_ERROR_FALLBACK;404",
      });
    };
    const route = (page: TestModule, notFound: TestModule = notFoundModuleWithMetadata) => ({
      layoutTreePositions: [0],
      layouts: [rootLayoutModule],
      notFound,
      notFoundTreePosition: 2,
      page,
      pattern: "/posts/[slug]",
      routeSegments: ["posts", "[slug]"],
    });
    const render = (
      routeOptions: ReturnType<typeof route>,
      serveStreamingMetadata = true,
    ): Promise<string | undefined> =>
      renderAppPageHttpAccessFallback<TestModule>({
        ...common,
        matchedParams: { slug: "missing" },
        route: routeOptions,
        routeHead: UNPREPARED_ROUTE_HEAD,
        serveStreamingMetadata,
        statusCode: 404,
      }).then((response) => response?.text());

    // The route's own head: an ordinary failure, and a signal whose not-found
    // recovery fails too.
    for (const html of [
      await render(route({ default: () => null, generateViewport: viewportError })),
      await render(
        route(
          { default: () => null, generateViewport: notFoundSignal },
          { default: NotFoundBoundary, generateViewport: viewportError },
        ),
      ),
    ]) {
      expect(html).toContain('data-boundary="not-found"');
      expect(html).not.toContain('name="viewport"');
    }

    // The convention's head, which an HTML-limited bot's error shell renders.
    const botHtml = await render(
      route(
        { default: () => null },
        {
          default: NotFoundBoundary,
          generateViewport: viewportError,
          metadata: { title: "notfound title" },
        },
      ),
      false,
    );
    expect(botHtml).toContain("<title>notfound title</title>");
    expect(botHtml).not.toContain('name="viewport"');
  });

  it("holds the error page for the convention's generateViewport(), which Next.js renders outside Suspense", async () => {
    // Next.js 16.2.7 suspends only its error shell's metadata: the viewport
    // holds back the shell, so a `dynamic = "error"` failure there fails the
    // render before any byte is sent.
    const { headers, runWithHeadersContext } =
      await import("../packages/vinext/src/shims/headers.js");
    const { createStaticGenerationHeadersContext } =
      await import("../packages/vinext/src/server/app-static-generation.js");
    const common = createCommonOptions();
    let releaseViewport!: () => void;
    const viewportGate = new Promise<void>((resolve) => {
      releaseViewport = resolve;
    });
    const route = (notFound: TestModule) => ({
      layoutTreePositions: [0],
      layouts: [rootLayoutModule],
      notFound,
      notFoundTreePosition: 2,
      page: { default: () => null },
      pattern: "/posts/[slug]",
      routeSegments: ["posts", "[slug]"],
    });
    const routeHead = {
      prepared: {
        accessError: Promise.resolve(null),
        metadata: Promise.resolve({ title: "Route title" }),
        metadataPlacement: "head" as const,
        viewport: Promise.resolve({ themeColor: "#222222" }),
      },
      observeSearchParams: false,
      searchParams: new URLSearchParams(),
      streamMetadata: true,
    };

    const rendered = renderAppPageHttpAccessFallback<TestModule>({
      ...common,
      matchedParams: { slug: "missing" },
      renderToReadableStream: renderElementToFizzStream,
      route: route({
        default: NotFoundBoundary,
        async generateViewport() {
          await viewportGate;
          return { themeColor: "#333333" };
        },
      }),
      routeHead,
      statusCode: 404,
    });
    const early = await Promise.race([
      rendered,
      new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 200)),
    ]);
    expect(early).toBe("blocked");
    releaseViewport();
    const html = await (await rendered)?.text();
    expect(html).toContain("<title>Route title</title>");
    expect(html).toContain('name="theme-color" content="#222222"');

    const headersContext = createStaticGenerationHeadersContext({
      dynamicConfig: "error",
      routeKind: "page",
    });
    await runWithHeadersContext(headersContext, async () => {
      const failure = await renderAppPageHttpAccessFallback<TestModule>({
        ...common,
        matchedParams: { slug: "missing" },
        renderToReadableStream: renderElementToFizzStream,
        route: route({
          default: NotFoundBoundary,
          async generateViewport() {
            await headers();
            return {};
          },
        }),
        routeHead,
        statusCode: 404,
      }).then(
        () => "rendered",
        (error: unknown) => error,
      );
      expect(headersContext.accessError).toBeDefined();
      expect(failure).toBe(headersContext.accessError);
    });
  });

  it("drops a redirect() or an error from the convention's generateMetadata(), as Next.js's error shell does", async () => {
    // Next.js 16.2.7 answers 404 with no redirect for a browser and an
    // HTML-limited bot alike: its error shell's metadata has no outlet.
    const common = createCommonOptions();
    const conventionErrors = [
      Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;replace;/login;307;" }),
      new Error("convention boom"),
    ];
    for (const conventionError of conventionErrors) {
      for (const serveStreamingMetadata of [true, false]) {
        const response = await renderAppPageHttpAccessFallback<TestModule>({
          ...common,
          matchedParams: { slug: "missing" },
          route: {
            layoutTreePositions: [0],
            layouts: [rootLayoutModule],
            notFound: {
              default: NotFoundBoundary,
              generateMetadata() {
                throw conventionError;
              },
            },
            notFoundTreePosition: 2,
            page: { default: () => null },
            pattern: "/posts/[slug]",
            routeSegments: ["posts", "[slug]"],
          },
          routeHead: {
            prepared: {
              accessError: Promise.resolve(null),
              metadata: Promise.resolve({ title: "Route title" }),
              metadataPlacement: "head",
              viewport: Promise.resolve({}),
            },
            observeSearchParams: false,
            searchParams: new URLSearchParams(),
            streamMetadata: false,
          },
          serveStreamingMetadata,
          statusCode: 404,
        });

        expect(response?.status).toBe(404);
        const html = await response?.text();
        expect(html).toContain('data-boundary="not-found"');
        if (serveStreamingMetadata) expect(html).toContain("<title>Route title</title>");
        else expect(html).not.toContain("<title>");
      }
    }
  });

  it('fails the fallback on a `dynamic = "error"` read from the route\'s head, and drops any other error', async () => {
    // Next.js 16.2.7 fails the build for such a route, though its metadata
    // tree drops the error. An immediate redirect() or error from the route's
    // generateMetadata() beside an early notFound() still answers 404 with an
    // empty title.
    const { runWithHeadersContext } = await import("../packages/vinext/src/shims/headers.js");
    const { createStaticGenerationHeadersContext } =
      await import("../packages/vinext/src/server/app-static-generation.js");
    const common = createCommonOptions();
    const renderWith = (
      generateMetadata: TestModule["generateMetadata"],
      prepared: AppPagePreparedRouteHead | null = null,
    ) =>
      renderAppPageHttpAccessFallback<TestModule>({
        ...common,
        matchedParams: { slug: "missing" },
        route: {
          layoutTreePositions: [0],
          layouts: [rootLayoutModule],
          notFound: notFoundModuleWithMetadata,
          notFoundTreePosition: 2,
          page: { default: () => null, generateMetadata },
          pattern: "/posts/[slug]",
          routeSegments: ["posts", "[slug]"],
        },
        routeHead: {
          observeSearchParams: true,
          prepared,
          searchParams: new URLSearchParams("q=1"),
          streamMetadata: false,
        },
        statusCode: 404,
      });
    const headersContext = createStaticGenerationHeadersContext({
      dynamicConfig: "error",
      routeKind: "page",
    });

    await runWithHeadersContext(headersContext, async () => {
      await expect(
        renderWith(async ({ searchParams }: { searchParams: Promise<{ q?: string }> }) => ({
          title: (await searchParams).q,
        })),
      ).rejects.toThrow('Page with `dynamic = "error"`');
      await expect(
        renderWith(undefined, {
          accessError: Promise.resolve(headersContext.accessError ?? null),
          metadata: Promise.resolve(null),
          metadataPlacement: "head",
          viewport: Promise.resolve({}),
        }),
      ).rejects.toThrow('Page with `dynamic = "error"`');

      for (const error of [
        Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;replace;/login;307;" }),
        new Error("route metadata boom"),
      ]) {
        const response = await renderWith(() => {
          throw error;
        });
        expect(response?.status).toBe(404);
        const html = await response?.text();
        expect(html).toContain('data-boundary="not-found"');
        expect(html).not.toContain("<title>");
      }
    });
  });

  it('fails an RSC fallback on a `dynamic = "error"` read from the not-found head the route\'s head recovers through', async () => {
    // The route's generateMetadata() signals notFound(), and the not-found
    // convention's generateMetadata() then reads headers(). An RSC response
    // resolves no separate convention head, so only the recovery sees it.
    const { headers, runWithHeadersContext } =
      await import("../packages/vinext/src/shims/headers.js");
    const { createStaticGenerationHeadersContext } =
      await import("../packages/vinext/src/server/app-static-generation.js");
    const common = createCommonOptions();
    const headersContext = createStaticGenerationHeadersContext({
      dynamicConfig: "error",
      routeKind: "page",
    });

    await runWithHeadersContext(headersContext, async () => {
      await expect(
        renderAppPageHttpAccessFallback<TestModule>({
          ...common,
          isRscRequest: true,
          matchedParams: { slug: "missing" },
          renderToReadableStream: renderWirePayloadToStream,
          request: new Request("https://example.com/posts/missing.rsc"),
          requestUrl: "https://example.com/posts/missing.rsc",
          route: {
            layoutTreePositions: [0],
            layouts: [rootLayoutModule],
            notFound: {
              default: NotFoundBoundary,
              async generateMetadata() {
                await headers();
                return { title: "notfound title" };
              },
            },
            notFoundTreePosition: 2,
            page: {
              default: () => null,
              generateMetadata() {
                throw Object.assign(new Error("NEXT_NOT_FOUND"), {
                  digest: "NEXT_HTTP_ERROR_FALLBACK;404",
                });
              },
            },
            pattern: "/posts/[slug]",
            routeSegments: ["posts", "[slug]"],
          },
          routeHead: UNPREPARED_ROUTE_HEAD,
          statusCode: 404,
        }),
      ).rejects.toBe(headersContext.accessError);
    });
  });

  it('fails a streamed fallback document on a late `dynamic = "error"` read, rather than finishing its Suspense boundary', async () => {
    // Inside the streamed metadata's Suspense boundary React would only report
    // the error and finish the 404. The body errors instead, so the document
    // never completes and the ISR cache write, which reads it whole, is
    // skipped.
    const { headers, runWithHeadersContext } =
      await import("../packages/vinext/src/shims/headers.js");
    const { createStaticGenerationHeadersContext } =
      await import("../packages/vinext/src/server/app-static-generation.js");
    const common = createCommonOptions();
    const headersContext = createStaticGenerationHeadersContext({
      dynamicConfig: "error",
      routeKind: "page",
    });
    const route = {
      layoutTreePositions: [0],
      layouts: [rootLayoutModule],
      notFound: notFoundModuleWithMetadata,
      notFoundTreePosition: 2,
      page: { default: () => null },
      pattern: "/posts/[slug]",
      routeSegments: ["posts", "[slug]"],
    };
    const preparedHead = (accessError: Promise<Error | null>): AppPagePreparedRouteHead => ({
      accessError,
      metadata: Promise.resolve({ title: "Route title" }),
      metadataPlacement: "body",
      viewport: Promise.resolve({}),
    });

    await runWithHeadersContext(headersContext, async () => {
      // The route's own streamed head.
      const lateRouteError = new Promise<Error | null>((resolve) =>
        setTimeout(() => resolve(headersContext.accessError ?? null), 20),
      );
      const routeResponse = await renderAppPageHttpAccessFallback<TestModule>({
        ...common,
        matchedParams: { slug: "missing" },
        renderToReadableStream: renderElementToFizzStream,
        route,
        routeHead: {
          observeSearchParams: false,
          prepared: preparedHead(lateRouteError),
          searchParams: new URLSearchParams(),
          streamMetadata: true,
        },
        statusCode: 404,
      });
      expect(routeResponse?.status).toBe(404);
      await expect(routeResponse?.text()).rejects.toBe(headersContext.accessError);

      // The convention's head, which streams behind the error page.
      const conventionResponse = await renderAppPageHttpAccessFallback<TestModule>({
        ...common,
        matchedParams: { slug: "missing" },
        renderToReadableStream: renderElementToFizzStream,
        route: {
          ...route,
          notFound: {
            default: NotFoundBoundary,
            async generateMetadata() {
              await headers();
              return { title: "notfound title" };
            },
          },
        },
        routeHead: {
          observeSearchParams: false,
          prepared: preparedHead(Promise.resolve(null)),
          searchParams: new URLSearchParams(),
          streamMetadata: true,
        },
        statusCode: 404,
      });
      expect(conventionResponse?.status).toBe(404);
      await expect(conventionResponse?.text()).rejects.toBe(headersContext.accessError);
    });
  });

  it("keeps the renderer's Link provenance on a fallback document that streams its head", async () => {
    // Config-header finalization and ISR read the renderer's own Link value
    // from the response's Headers, which the late-error wrapper replaces.
    const { getFrameworkLinkHeader } =
      await import("../packages/vinext/src/server/app-response-header-provenance.js");
    const common = createCommonOptions();
    const response = await renderAppPageHttpAccessFallback<TestModule>({
      ...common,
      matchedParams: { slug: "missing" },
      renderToReadableStream: renderElementToFizzStream,
      route: {
        layoutTreePositions: [0],
        layouts: [rootLayoutModule],
        notFound: notFoundModuleWithMetadata,
        notFoundTreePosition: 2,
        page: { default: () => null },
        pattern: "/posts/[slug]",
        routeSegments: ["posts", "[slug]"],
      },
      routeHead: {
        observeSearchParams: false,
        prepared: {
          accessError: Promise.resolve(null),
          metadata: Promise.resolve({ title: "Route title" }),
          metadataPlacement: "body",
          viewport: Promise.resolve({}),
        },
        searchParams: new URLSearchParams(),
        streamMetadata: true,
      },
      statusCode: 404,
    });

    expect(response?.status).toBe(404);
    expect(getFrameworkLinkHeader(response!.headers)).toContain("</font.woff2>; rel=preload");
    expect(await response?.text()).toContain("<title>Route title</title>");
  });

  it("fails an HTML-limited bot's fallback on a `dynamic = \"error\"` read from the route's head", async () => {
    // The bot gets the convention's head, but Next.js still renders the
    // route's Flight payload, whose head fails such a render, as it does for
    // a browser.
    const { runWithHeadersContext } = await import("../packages/vinext/src/shims/headers.js");
    const { createStaticGenerationHeadersContext } =
      await import("../packages/vinext/src/server/app-static-generation.js");
    const common = createCommonOptions();
    const headersContext = createStaticGenerationHeadersContext({
      dynamicConfig: "error",
      routeKind: "page",
    });
    const renderBot = (prepared: AppPagePreparedRouteHead | null) =>
      renderAppPageHttpAccessFallback<TestModule>({
        ...common,
        matchedParams: { slug: "missing" },
        route: {
          layoutTreePositions: [0],
          layouts: [rootLayoutModule],
          notFound: notFoundModuleWithMetadata,
          notFoundTreePosition: 2,
          page: {
            default: () => null,
            async generateMetadata({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
              return { title: (await searchParams).q };
            },
          },
          pattern: "/posts/[slug]",
          routeSegments: ["posts", "[slug]"],
        },
        routeHead: {
          observeSearchParams: true,
          prepared,
          searchParams: new URLSearchParams("q=1"),
          streamMetadata: false,
        },
        serveStreamingMetadata: false,
        statusCode: 404,
      });

    await runWithHeadersContext(headersContext, async () => {
      await expect(renderBot(null)).rejects.toThrow('Page with `dynamic = "error"`');
      await expect(
        renderBot({
          accessError: Promise.resolve(headersContext.accessError ?? null),
          metadata: Promise.resolve(null),
          metadataPlacement: "head",
          viewport: Promise.resolve({}),
        }),
      ).rejects.toBe(headersContext.accessError);
    });
  });

  it("gives an HTML-limited bot the convention's head, as Next.js's error shell does", async () => {
    // Next.js 16.2.7 serves such a bot the error shell, headed by the not-found
    // convention's metadata; the route's head reaches only the Flight payload.
    const response = await renderBotFallback(false);

    const html = await response?.text();
    expect(html?.match(/<title>/g) ?? []).toHaveLength(1);
    expect(html).toContain("<title>notfound title</title>");
  });

  it("stores the route's head when an HTML-limited bot's render may be stored", async () => {
    // Next.js 16.2.7 stores the same entry whichever user agent triggers the
    // render or its regeneration: an error shell whose Flight head, the title
    // visitors see, is the route's own. vinext stores the route's head too.
    const response = await renderBotFallback(true);

    const html = await response?.text();
    expect(html?.match(/<title>/g) ?? []).toHaveLength(1);
    expect(html).toContain("<title>Route title</title>");
  });

  it("gives an HTML-limited bot the convention's head once its render turns dynamic", async () => {
    // A cache candidate that used a dynamic API is never stored, so the bot
    // gets the error shell's head, as Next.js 16.2.7 serves it on a dynamic 404.
    const response = await renderBotFallback(true, { dynamic: true });

    const html = await response?.text();
    expect(html?.match(/<title>/g) ?? []).toHaveLength(1);
    expect(html).toContain("<title>notfound title</title>");
  });

  async function renderBotFallback(isCacheCandidate: boolean, { dynamic = false } = {}) {
    const { headersContextFromRequest, markDynamicUsage, runWithHeadersContext } =
      await import("../packages/vinext/src/shims/headers.js");
    const request = new Request("https://example.com/posts/missing");
    return runWithHeadersContext(headersContextFromRequest(request), async () => {
      if (dynamic) markDynamicUsage();
      return renderBotFallbackInContext(isCacheCandidate);
    });
  }

  function renderBotFallbackInContext(isCacheCandidate: boolean) {
    const common = createCommonOptions();
    return renderAppPageHttpAccessFallback<TestModule>({
      ...common,
      isCacheCandidate,
      matchedParams: { slug: "missing" },
      route: {
        layoutTreePositions: [0],
        layouts: [rootLayoutModule],
        notFound: notFoundModuleWithMetadata,
        notFoundTreePosition: 2,
        page: { default: () => null },
        pattern: "/posts/[slug]",
        routeSegments: ["posts", "[slug]"],
      },
      routeHead: {
        prepared: {
          accessError: Promise.resolve(null),
          metadata: Promise.resolve({ title: "Route title" }),
          metadataPlacement: "head",
          viewport: Promise.resolve({}),
        },
        observeSearchParams: false,
        searchParams: new URLSearchParams(),
        streamMetadata: false,
      },
      serveStreamingMetadata: false,
      statusCode: 404,
    });
  }

  it("keeps the source route's head for a slot intercept whose render threw the signal", async () => {
    // Next.js's client renders the head of the first leaf on a children-first
    // walk of its router tree that skips `default` segments. A slot intercept
    // leaves the source page in `children`; without one, the walk reaches the
    // intercept's leaf, headed by the intercepting render.
    const interceptPage = {
      default: () => null,
      metadata: { title: "Intercept page title" },
    } satisfies TestModule;
    const renderPayload = async (page: TestModule | null) => {
      const response = await renderAppPageHttpAccessFallback<TestModule>({
        ...createCommonOptions(),
        intercept: {
          interceptLayouts: [],
          interceptPage,
          interceptParams: { id: "1" },
          interceptSlotKey: "modal",
        },
        isRscRequest: true,
        matchedParams: {},
        renderToReadableStream: renderWirePayloadToStream,
        request: new Request("https://example.com/photo/1.rsc"),
        requestUrl: "https://example.com/photo/1.rsc",
        route: {
          ...(page
            ? {}
            : {
                childrenSlot: { id: "children:/", ownerTreePath: "/", state: "unmatched" as const },
              }),
          layoutTreePositions: [0],
          layouts: [{ default: RootLayout, metadata: { title: "Root layout title" } }],
          notFound: notFoundModuleWithMetadata,
          notFoundTreePosition: 0,
          page,
          pattern: "/",
          routeSegments: [],
          slots: { modal: { layoutIndex: 0, name: "modal", page: null } },
        },
        routeHead: UNPREPARED_ROUTE_HEAD,
        statusCode: 404,
      });
      expect(response?.status).toBe(404);
      return response?.text();
    };

    const payload = await renderPayload({ default: () => null });
    expect(payload).toContain("Root layout title");
    expect(payload).not.toContain("Intercept page title");
    expect(payload).not.toContain("notfound title");

    const slotOnlyPayload = await renderPayload(null);
    expect(slotOnlyPayload).toContain("Intercept page title");
    expect(slotOnlyPayload).not.toContain("notfound title");
  });

  it("reuses the head the route's render prepared, so its generateMetadata() runs once", async () => {
    const common = createCommonOptions();
    const pageGenerateMetadata = vi.fn(() => ({ title: "Resolved again" }));
    const conventionGenerateMetadata = vi.fn(() => ({ title: "notfound title" }));
    const route = {
      layoutTreePositions: [0],
      layouts: [rootLayoutModule],
      notFound: { default: NotFoundBoundary, generateMetadata: conventionGenerateMetadata },
      notFoundTreePosition: 2,
      page: { default: () => null, generateMetadata: pageGenerateMetadata },
      pattern: "/posts/[slug]",
      routeSegments: ["posts", "[slug]"],
    };
    const prepared: AppPagePreparedRouteHead = {
      accessError: Promise.resolve(null),
      metadata: Promise.resolve({ title: "Prepared title" }),
      metadataPlacement: "head",
      viewport: Promise.resolve({}),
    };
    const routeHead = { ...UNPREPARED_ROUTE_HEAD, prepared };

    const response = await renderAppPageHttpAccessFallback<TestModule>({
      ...common,
      matchedParams: { slug: "missing" },
      route,
      routeHead,
      statusCode: 404,
    });

    expect(response?.status).toBe(404);
    const html = await response?.text();
    expect(html?.match(/<title>/g) ?? []).toHaveLength(1);
    expect(html).toContain("<title>Prepared title</title>");
    expect(pageGenerateMetadata).not.toHaveBeenCalled();
    // Next.js's document error shell still resolves the convention's metadata.
    expect(conventionGenerateMetadata).toHaveBeenCalledTimes(1);

    // An RSC response is the route's own payload, without an error shell.
    conventionGenerateMetadata.mockClear();
    const rscResponse = await renderAppPageHttpAccessFallback<TestModule>({
      ...common,
      isRscRequest: true,
      matchedParams: { slug: "missing" },
      renderToReadableStream: renderWirePayloadToStream,
      request: new Request("https://example.com/posts/missing.rsc"),
      requestUrl: "https://example.com/posts/missing.rsc",
      route,
      routeHead,
      statusCode: 404,
    });
    expect(await rscResponse?.text()).toContain("Prepared title");
    expect(pageGenerateMetadata).not.toHaveBeenCalled();
    expect(conventionGenerateMetadata).not.toHaveBeenCalled();
  });

  it("resolves an unprepared route head from the whole route under a layout-level fallback", async () => {
    // A layout's signal renders only the layouts above it, but the route's head
    // still covers every segment, so a slot below a dynamic segment keeps its
    // owner's params.
    const common = createCommonOptions();
    const seenParams: unknown[] = [];
    const membersLayout = {
      default: RootLayout,
      async generateMetadata({ params }: { params: Promise<{ team?: string }> }) {
        const resolved = await params;
        seenParams.push(resolved);
        return { title: `members of ${resolved.team}` };
      },
    } satisfies TestModule;

    const response = await renderAppPageHttpAccessFallback<TestModule>({
      ...common,
      headLayoutModules: [rootLayoutModule],
      isRscRequest: true,
      layoutModules: [rootLayoutModule],
      matchedParams: { team: "acme" },
      renderToReadableStream: renderWirePayloadToStream,
      request: new Request("https://example.com/acme/settings.rsc"),
      requestUrl: "https://example.com/acme/settings.rsc",
      route: {
        layoutTreePositions: [0, 1],
        layouts: [rootLayoutModule, leafLayoutModule],
        notFound: notFoundModuleWithMetadata,
        notFoundTreePosition: 0,
        page: { default: () => null },
        pattern: "/[team]/settings",
        routeSegments: ["[team]", "settings"],
        slots: {
          members: {
            layout: membersLayout,
            layoutIndex: 1,
            name: "members",
            page: { default: () => null },
            routeSegments: [],
          },
        },
      },
      routeHead: UNPREPARED_ROUTE_HEAD,
      statusCode: 404,
    });

    expect(response?.status).toBe(404);
    expect(await response?.text()).toContain("members of acme");
    expect(seenParams).toEqual([{ team: "acme" }]);
  });

  it("resolves relative metadata URLs against the normalized route pathname", async () => {
    const common = createCommonOptions();

    const response = await renderAppPageHttpAccessFallback<TestModule>({
      ...common,
      matchedParams: { slug: "missing" },
      request: new Request("https://example.com/legacy/missing"),
      requestUrl: "https://example.com/legacy/missing",
      route: {
        layoutTreePositions: [0],
        layouts: [rootLayoutModule],
        notFound: {
          default: NotFoundBoundary,
          generateMetadata: () => ({
            alternates: { canonical: "./" },
            metadataBase: new URL("https://example.com"),
          }),
        },
        notFoundTreePosition: 2,
        pattern: "/posts/[slug]",
        routeSegments: ["posts", "[slug]"],
      },
      // A rewrite served /legacy/missing from /posts/missing.
      routePathname: "/posts/missing",
      statusCode: 404,
    });

    const html = await response?.text();
    expect(html).toContain('<link rel="canonical" href="https://example.com/posts/missing"/>');
    expect(html).not.toContain("/legacy/missing");
  });

  it("does not inject child route file metadata into layout-level HTTP access fallbacks", async () => {
    const common = createCommonOptions();
    const metadataRoutes: MetadataFileRoute[] = [
      {
        type: "opengraph-image",
        isDynamic: false,
        filePath: "/tmp/app/posts/[slug]/opengraph-image.png",
        routePrefix: "/posts/[slug]",
        routeSegments: ["posts", "[slug]"],
        servedUrl: "/posts/-/opengraph-image.png",
        contentType: "image/png",
        headData: {
          kind: "openGraph",
          href: "/posts/-/opengraph-image.png?hash",
          type: "image/png",
          width: 1200,
          height: 630,
        },
      },
    ];

    const response = await renderAppPageHttpAccessFallback<TestModule>({
      ...common,
      layoutModules: [rootLayoutModule],
      matchedParams: { slug: "missing" },
      metadataRoutes,
      route: {
        layoutTreePositions: [0, 1],
        layouts: [rootLayoutModule, leafLayoutModule],
        notFound: notFoundModule,
        params: { slug: "missing" },
        pattern: "/posts/[slug]",
        routeSegments: ["posts", "[slug]"],
      },
      statusCode: 404,
    });

    expect(response?.status).toBe(404);

    const html = await response?.text();
    expect(html).toContain('content="Root layout description"');
    expect(html).not.toContain("opengraph-image");
  });

  it("preserves middleware headers on HTTP access fallback HTML responses", async () => {
    const common = createCommonOptions();

    const response = await renderAppPageHttpAccessFallback<TestModule>({
      ...common,
      matchedParams: { slug: "missing" },
      middlewareContext: createMiddlewareContext(),
      route: {
        layouts: [rootLayoutModule],
        notFound: notFoundModule,
        params: { slug: "missing" },
        pattern: "/posts/[slug]",
      },
      statusCode: 404,
    });

    expect(response?.status).toBe(404);
    expect(response?.headers.get("x-middleware-security")).toBe("present");
    expect(response?.headers.get("vary")).toBe(`${VINEXT_RSC_VARY_HEADER}, x-auth-state`);
    expect(response?.headers.getSetCookie()).toContain("session=rotated; Path=/; HttpOnly");
  });

  it("renders HTTP access fallback RSC responses as flat payloads", async () => {
    const common = createCommonOptions();

    const response = await renderAppPageHttpAccessFallback<TestModule>({
      ...common,
      isRscRequest: true,
      matchedParams: { slug: "missing" },
      renderToReadableStream: renderWirePayloadToStream,
      rootLayouts: [rootLayoutModule],
      route: {
        layoutTreePositions: [0, 1],
        layouts: [rootLayoutModule, leafLayoutModule],
        notFound: notFoundModule,
        params: { slug: "missing" },
        pattern: "/posts/[slug]",
        routeSegments: ["posts", "[slug]"],
      },
      statusCode: 404,
    });

    expect(response?.status).toBe(404);
    expect(response?.headers.get("Content-Type")).toBe("text/x-component");

    const payload = JSON.parse((await response?.text()) ?? "{}") as Record<string, unknown>;
    expect(payload.__route).toBe("route:/posts/missing");
    expect(payload.__layoutIds).toEqual(["layout:/", "layout:/posts"]);
    expect(payload.__rootLayout).toBe("/");
    expect(payload.__srcPage).toEqual(["posts", "[slug]", "page"]);
    expect(payload["route:/posts/missing"]).toBeTruthy();
  });

  it("derives HTTP access fallback layout metadata from the rendered layout subset", async () => {
    const common = createCommonOptions();

    const response = await renderAppPageHttpAccessFallback<TestModule>({
      ...common,
      isRscRequest: true,
      layoutModules: [rootLayoutModule],
      matchedParams: { slug: "missing" },
      renderToReadableStream: renderWirePayloadToStream,
      route: {
        layoutTreePositions: [0, 1],
        layouts: [rootLayoutModule, leafLayoutModule],
        notFound: notFoundModule,
        params: { slug: "missing" },
        pattern: "/posts/[slug]",
        routeSegments: ["posts", "[slug]"],
      },
      statusCode: 404,
    });

    expect(response?.status).toBe(404);

    const payload = JSON.parse((await response?.text()) ?? "{}") as Record<string, unknown>;
    expect(payload.__layoutIds).toEqual(["layout:/"]);
    expect(payload.__rootLayout).toBe("/");
    expect(payload["route:/posts/missing"]).toBeTruthy();
  });

  it("uses unknown root metadata when no route layout is rendered for an HTTP access fallback", async () => {
    const common = createCommonOptions();

    const response = await renderAppPageHttpAccessFallback<TestModule>({
      ...common,
      isRscRequest: true,
      layoutModules: [],
      matchedParams: { slug: "missing" },
      renderToReadableStream: renderWirePayloadToStream,
      route: {
        layoutTreePositions: [0, 1],
        layouts: [rootLayoutModule, leafLayoutModule],
        notFound: notFoundModule,
        params: { slug: "missing" },
        pattern: "/posts/[slug]",
        routeSegments: ["posts", "[slug]"],
      },
      statusCode: 404,
    });

    expect(response?.status).toBe(404);

    const payload = JSON.parse((await response?.text()) ?? "{}") as Record<string, unknown>;
    expect(payload.__layoutIds).toEqual([]);
    expect(payload.__rootLayout).toBeNull();
    expect(payload["route:/posts/missing"]).toBeTruthy();
  });

  it("preserves middleware headers on HTTP access fallback RSC responses", async () => {
    const common = createCommonOptions();

    const response = await renderAppPageHttpAccessFallback<TestModule>({
      ...common,
      isRscRequest: true,
      matchedParams: { slug: "missing" },
      middlewareContext: createMiddlewareContext(),
      renderToReadableStream: renderWirePayloadToStream,
      route: {
        notFound: notFoundModule,
        params: { slug: "missing" },
        pattern: "/posts/[slug]",
      },
      statusCode: 404,
    });

    expect(response?.status).toBe(404);
    expect(response?.headers.get("x-middleware-security")).toBe("present");
    expect(response?.headers.get("vary")).toBe(`${VINEXT_RSC_VARY_HEADER}, x-auth-state`);
    expect(response?.headers.getSetCookie()).toContain("session=rotated; Path=/; HttpOnly");
  });

  it("uses null root layout metadata when a boundary payload has no route context", async () => {
    const common = createCommonOptions();

    const response = await renderAppPageHttpAccessFallback<TestModule>({
      ...common,
      boundaryComponent: NotFoundBoundary,
      isRscRequest: true,
      matchedParams: { slug: "missing" },
      renderToReadableStream: renderWirePayloadToStream,
      rootLayouts: [rootLayoutModule],
      route: null,
      statusCode: 404,
    });

    expect(response?.status).toBe(404);

    const payload = JSON.parse((await response?.text()) ?? "{}") as Record<string, unknown>;
    expect(payload.__route).toBe("route:/posts/missing");
    expect(payload.__layoutIds).toEqual([]);
    expect(payload.__rootLayout).toBeNull();
    expect(payload.__srcPage).toBeUndefined();
    expect(payload["route:/posts/missing"]).toBeTruthy();
  });

  it("omits source-page metadata when route segments are unavailable", async () => {
    const common = createCommonOptions();
    const response = await renderAppPageHttpAccessFallback<TestModule>({
      ...common,
      isRscRequest: true,
      matchedParams: {},
      renderToReadableStream: renderWirePayloadToStream,
      route: {
        notFound: notFoundModule,
        pattern: "/posts/missing",
      },
      statusCode: 404,
    });

    const payload = JSON.parse((await response?.text()) ?? "{}") as Record<string, unknown>;
    expect(payload.__srcPage).toBeUndefined();
  });

  it("renders route error boundaries with sanitized errors inside layouts", async () => {
    const common = createCommonOptions();
    const sanitizeErrorForClient = vi.fn((error: Error) => new Error(`safe:${error.message}`));

    const response = await renderAppPageErrorBoundary<TestModule>({
      ...common,
      error: new Error("secret"),
      matchedParams: { slug: "post" },
      route: {
        error: routeErrorModule,
        layouts: [rootLayoutModule],
        params: { slug: "post" },
        pattern: "/posts/[slug]",
      },
      sanitizeErrorForClient,
    });

    // Next.js answers 500 when an error rejects the document's shell, even
    // when a local error.tsx catches it (#4394).
    expect(response?.status).toBe(500);
    expect(response?.headers.get("cache-control")).toBe(
      "private, no-cache, no-store, max-age=0, must-revalidate",
    );
    expect(sanitizeErrorForClient).toHaveBeenCalledTimes(1);

    const html = await response?.text();
    expect(common.clearRequestContext).toHaveBeenCalledTimes(1);
    expect(html).toContain('data-layout="root"');
    expect(html).toContain('data-boundary="route-error"');
    expect(html).toContain("route:safe:secret");
  });

  it("does not serialize production SSR stacks into the global error payload", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const common = createCommonOptions();
    const error = new Error("client page error");
    error.stack = "/private/deployment/server.js:42";

    try {
      const response = await renderAppPageErrorBoundary<TestModule>({
        ...common,
        error,
        errorOrigin: "ssr",
        globalErrorModule,
        sanitizeErrorForClient(value: Error) {
          return value;
        },
      });

      const html = await response?.text();
      expect(html).toContain("client page error");
      expect(html).not.toContain("/private/deployment/server.js:42");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("preserves development RSC stacks in the global error payload", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const common = createCommonOptions();
    const error = Object.assign(new Error("server page error"), {
      digest: "12345",
      stack: "/app/rsc/page.tsx:2",
    });

    try {
      const response = await renderAppPageErrorBoundary<TestModule>({
        ...common,
        error,
        errorOrigin: "rsc",
        globalErrorModule: globalErrorModuleWithStack,
        sanitizeErrorForClient(value: Error) {
          return value;
        },
      });

      const html = await response?.text();
      expect(html).toContain("/app/rsc/page.tsx:2");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("preserves middleware headers on error boundary responses", async () => {
    const common = createCommonOptions();

    const response = await renderAppPageErrorBoundary<TestModule>({
      ...common,
      error: new Error("secret"),
      matchedParams: { slug: "post" },
      middlewareContext: createMiddlewareContext(),
      route: {
        error: routeErrorModule,
        params: { slug: "post" },
        pattern: "/posts/[slug]",
      },
      sanitizeErrorForClient(error: Error) {
        return error;
      },
    });

    expect(response?.status).toBe(500);
    expect(response?.headers.get("x-middleware-security")).toBe("present");
    expect(response?.headers.get("vary")).toBe(`${VINEXT_RSC_VARY_HEADER}, x-auth-state`);
    expect(response?.headers.getSetCookie()).toContain("session=rotated; Path=/; HttpOnly");
  });

  it("renders error boundaries when dynamic file metadata resolution fails", async () => {
    const error = new Error("metadata boom");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const common = createCommonOptions();
    const metadataRoutes: MetadataFileRoute[] = [
      {
        type: "opengraph-image",
        isDynamic: true,
        filePath: "/tmp/app/posts/[slug]/opengraph-image.tsx",
        routePrefix: "/posts/[slug]",
        routeSegments: ["posts", "[slug]"],
        servedUrl: "/posts/[slug]/opengraph-image",
        contentType: "image/png",
        contentHash: "hash",
        module: {
          generateImageMetadata() {
            throw error;
          },
        },
      },
    ];

    try {
      const response = await renderAppPageErrorBoundary<TestModule>({
        ...common,
        error: new Error("secret"),
        matchedParams: { slug: "post" },
        metadataRoutes,
        route: {
          error: routeErrorModule,
          layoutTreePositions: [0],
          layouts: [rootLayoutModule],
          params: { slug: "post" },
          pattern: "/posts/[slug]",
          routeSegments: ["posts", "[slug]"],
        },
        sanitizeErrorForClient(error: Error) {
          return error;
        },
      });

      expect(response?.status).toBe(500);
      expect(consoleError).toHaveBeenCalledWith(
        "[vinext] File-based metadata resolution failed while rendering error boundary for /posts/[slug]:",
        error,
      );

      const html = await response?.text();
      expect(html).toContain('data-boundary="route-error"');
      expect(html).toContain("route:secret");
      expect(html).toContain('content="Root layout description"');
      expect(html).not.toContain("opengraph-image");
    } finally {
      consoleError.mockRestore();
    }
  });

  it("renders error boundary RSC responses as flat payloads", async () => {
    const common = createCommonOptions();

    const response = await renderAppPageErrorBoundary<TestModule>({
      ...common,
      error: new Error("secret"),
      isRscRequest: true,
      matchedParams: { slug: "missing" },
      renderToReadableStream: renderWirePayloadToStream,
      route: {
        error: routeErrorModule,
        layoutTreePositions: [0],
        layouts: [rootLayoutModule],
        params: { slug: "missing" },
        pattern: "/posts/[slug]",
        routeSegments: ["posts", "[slug]"],
      },
      sanitizeErrorForClient(error: Error) {
        return new Error(`safe:${error.message}`);
      },
    });

    // A flight response for a local boundary keeps 200, as Next.js' dynamic
    // flight render does.
    expect(response?.status).toBe(200);
    expect(response?.headers.get("cache-control")).not.toBe(
      "private, no-cache, no-store, max-age=0, must-revalidate",
    );
    expect(response?.headers.get("Content-Type")).toBe("text/x-component");

    const payload = JSON.parse((await response?.text()) ?? "{}") as Record<string, unknown>;
    expect(payload.__route).toBe("route:/posts/missing");
    expect(payload.__layoutIds).toEqual(["layout:/"]);
    expect(payload.__rootLayout).toBe("/");
    expect(payload.__srcPage).toEqual(["posts", "[slug]", "page"]);
    expect(payload["route:/posts/missing"]).toBeTruthy();
  });

  it("renders global-error boundaries without layout wrapping", async () => {
    const common = createCommonOptions();

    const response = await renderAppPageErrorBoundary<TestModule>({
      ...common,
      error: new Error("boom"),
      globalErrorModule,
      matchedParams: { slug: "post" },
      route: {
        layouts: [rootLayoutModule],
        params: { slug: "post" },
        pattern: "/posts/[slug]",
      },
      sanitizeErrorForClient(error: Error) {
        return error;
      },
    });

    expect(response?.status).toBe(500);
    expect(response?.headers.get("cache-control")).toBe(
      "private, no-cache, no-store, max-age=0, must-revalidate",
    );

    const html = await response?.text();
    expect(html).toContain('data-boundary="global-error"');
    expect(html).toContain("global:boom");
    expect(html).not.toContain('data-layout="root"');
    expect(html).not.toContain("Root layout description");
    expect(html).not.toContain('name="viewport"');
  });

  it("falls back to the built-in default global-error when the user's global-error throws", async () => {
    // When the resolved global-error boundary itself throws while rendering, the
    // SSR render rejects; renderAppPageErrorBoundary catches it and re-renders
    // with the built-in default global-error so the request still produces a
    // usable error document with the original HTTP 500 semantics. Locks in the server-side
    // retry directly (the integration test in tests/nextjs-compat/global-error
    // exercises the same path through the dev/preview server). Fixes #1548.
    const common = createCommonOptions();

    const response = await renderAppPageErrorBoundary<TestModule>({
      ...common,
      error: new Error("boom"),
      globalErrorModule: throwingGlobalErrorModule,
      matchedParams: { slug: "post" },
      route: {
        layouts: [rootLayoutModule],
        params: { slug: "post" },
        pattern: "/posts/[slug]",
      },
      sanitizeErrorForClient(error: Error) {
        return error;
      },
    });

    expect(response?.status).toBe(500);
    expect(response?.headers.get("cache-control")).toBe(
      "private, no-cache, no-store, max-age=0, must-revalidate",
    );

    const html = await response?.text();
    // The built-in default global-error UI from
    // packages/vinext/src/shims/default-global-error.tsx.
    expect(html).toContain("This page couldn");
    // The user's throwing boundary contributed no markup.
    expect(html).not.toContain("global-error boom");
  });

  it("re-throws navigation signals from a throwing global-error instead of degrading to the built-in fallback", async () => {
    // A redirect()/notFound() thrown from inside global-error must propagate,
    // not be swallowed into a built-in default 200.
    const common = createCommonOptions();

    await expect(
      renderAppPageErrorBoundary<TestModule>({
        ...common,
        error: new Error("boom"),
        globalErrorModule: signalThrowingGlobalErrorModule,
        matchedParams: { slug: "post" },
        route: {
          layouts: [rootLayoutModule],
          params: { slug: "post" },
          pattern: "/posts/[slug]",
        },
        sanitizeErrorForClient(error: Error) {
          return error;
        },
      }),
    ).rejects.toMatchObject({ digest: "NEXT_NOT_FOUND" });
  });
});
