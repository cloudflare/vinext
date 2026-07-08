/**
 * Unit tests for the Pages Router render orchestrator.
 *
 * Tests the behavior of `createPagesPageHandler` through stub closures,
 * verifying route matching, 404/500 fallback, _next/data envelope,
 * i18n redirect, 405 method check, and internal-error guard.
 */
import { afterEach, describe, it, expect, vi } from "vite-plus/test";
import { CloudflareCdnCacheAdapter } from "../packages/cloudflare/src/cache/cdn-adapter.runtime.js";
import { setCdnCacheAdapter } from "../packages/vinext/src/shims/cdn-cache.js";
import {
  MemoryCacheHandler,
  setDataCacheHandler,
} from "../packages/vinext/src/shims/cache-handler.js";
import {
  createPagesPageHandler,
  shouldEmitPagesClientTraceMetadata,
} from "../packages/vinext/src/server/pages-page-handler.js";
import type { CreatePagesPageHandlerOptions } from "../packages/vinext/src/server/pages-page-handler.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(pathname = "/", method = "GET"): Request {
  return new Request(`http://localhost${pathname}`, { method });
}

function makePageModule(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { default: () => null, ...overrides };
}

type PageRoute = {
  pattern: string;
  patternParts: string[];
  isDynamic: boolean;
  params: string[];
  module: Record<string, unknown>;
  filePath: string;
};

function makeRoute(pattern: string, module: Record<string, unknown> = makePageModule()): PageRoute {
  return {
    pattern,
    patternParts: pattern === "/" ? [] : pattern.split("/").filter(Boolean),
    isDynamic: pattern.includes(":"),
    params: [],
    module,
    filePath: `/project/pages${pattern === "/" ? "/index" : pattern}.tsx`,
  };
}

// Default stubs — most tests override only the pieces they care about.
function makeOpts(
  overrides: Partial<CreatePagesPageHandlerOptions> = {},
): CreatePagesPageHandlerOptions {
  const pageRoutes: PageRoute[] = overrides.pageRoutes ?? [makeRoute("/")];
  return {
    pageRoutes,
    errorPageRoute: null,
    matchRoute: (url, routes) => {
      const p = url.split("?")[0];
      const route = routes.find((r) => r.pattern === p || r.pattern === p.replace(/\/$/, ""));
      return route ? { route, params: {} } : null;
    },
    i18nConfig: null,
    vinextConfig: {
      basePath: "",
      assetPrefix: "",
      trailingSlash: false,
      disableOptimizedLoading: true,
    },
    buildId: "test-build-id",
    hasMiddleware: false,
    appAssetPath: null,
    hasRewrites: false,
    setSSRContext: null,
    getPagesNavigationIsReadyFromSerializedState: null,
    setI18nContext: null,
    wrapWithRouterContext: null,
    resetSSRHead: undefined,
    getSSRHeadHTML: undefined,
    setDocumentInitialHead: undefined,
    flushPreloads: undefined,
    getFontLinks: () => [],
    getFontStyles: () => [],
    getFontPreloads: () => [],
    renderToReadableStream: async (_element) => {
      const encoder = new TextEncoder();
      return new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode("<html><body>page</body></html>"));
          controller.close();
        },
      });
    },
    renderIsrPassToStringAsync: async (_element) => "<html><body>isr</body></html>",
    safeJsonStringify: (v) => JSON.stringify(v),
    sanitizeDestination: (d) => d,
    createPageElement: (_PageComp, _AppComp, _props) => null,
    enhancePageElement: (_PageComp, _AppComp, _props, _opts) => null,
    AppComponent: null,
    DocumentComponent: null,
    ...overrides,
  };
}

describe("shouldEmitPagesClientTraceMetadata", () => {
  it("emits only for request-time production renders", () => {
    expect(shouldEmitPagesClientTraceMetadata(makePageModule(), null)).toBe(false);
    expect(
      shouldEmitPagesClientTraceMetadata(
        makePageModule({ getStaticProps: async () => ({ props: {} }) }),
        null,
      ),
    ).toBe(false);
    expect(
      shouldEmitPagesClientTraceMetadata(
        makePageModule({ getServerSideProps: async () => ({ props: {} }) }),
        null,
      ),
    ).toBe(true);

    const page = Object.assign(() => null, { getInitialProps: async () => ({}) });
    const app = Object.assign(() => null, { getInitialProps: async () => ({}) });
    expect(shouldEmitPagesClientTraceMetadata(makePageModule({ default: page }), null)).toBe(true);
    expect(shouldEmitPagesClientTraceMetadata(makePageModule(), app)).toBe(true);
  });
});

describe("createPagesPageHandler — serialized route metadata", () => {
  it("strips basePath and locale from production SSR asPath", async () => {
    const setSSRContext = vi.fn();
    const route = makeRoute(
      "/posts/:id",
      makePageModule({ getStaticProps: async () => ({ props: {} }) }),
    );
    const handler = createPagesPageHandler(
      makeOpts({
        pageRoutes: [route],
        i18nConfig: { locales: ["en", "fr"], defaultLocale: "en" },
        vinextConfig: {
          basePath: "/docs",
          assetPrefix: "",
          trailingSlash: false,
          disableOptimizedLoading: true,
        },
        matchRoute: () => ({ route, params: { id: "001" } }),
        setSSRContext,
      }),
    );

    const response = await handler(
      makeRequest("/docs/fr/visible/1?draft=1"),
      "/fr/posts/001?draft=1",
      null,
      null,
      { asPath: "/docs/fr/visible/1?draft=1" },
    );
    expect(response.status).toBe(200);
    await response.text();
    expect(setSSRContext).toHaveBeenCalledWith(
      expect.objectContaining({ asPath: "/visible/1?draft=1" }),
    );
  });

  async function renderNextData(pageModule: Record<string, unknown>) {
    let nextData: Record<string, any> | undefined;
    const route = makeRoute("/posts/:id", pageModule);
    const handler = createPagesPageHandler(
      makeOpts({
        pageRoutes: [route],
        matchRoute: () => ({ route, params: { id: "001" } }),
        safeJsonStringify(value) {
          if (value && typeof value === "object" && "page" in value && "__vinext" in value) {
            nextData = value as Record<string, any>;
          }
          return JSON.stringify(value);
        },
      }),
    );

    const response = await handler(
      makeRequest("/visible/1?draft=1"),
      "/posts/001?draft=1",
      null,
      null,
      { asPath: "/visible/1?draft=1" },
    );
    expect(response.status).toBe(200);
    await response.text();
    expect(nextData).toBeDefined();
    return nextData!;
  }

  it("serializes only cache-key-stable route metadata into static-props HTML", async () => {
    const nextData = await renderNextData(
      makePageModule({ getStaticProps: async () => ({ props: {} }) }),
    );

    expect(nextData.__vinext).not.toHaveProperty("routeUrl");
    expect(nextData.__vinext.routeParams).toEqual({ id: "001" });
  });

  it("retains request-specific route metadata for request-time HTML", async () => {
    const nextData = await renderNextData(
      makePageModule({ getServerSideProps: async () => ({ props: {} }) }),
    );

    expect(nextData.__vinext).toMatchObject({
      routeUrl: "/posts/001?draft=1",
      routeParams: { id: "001" },
    });
  });

  it("omits routeUrl for ordinary request-time HTML", async () => {
    let nextData: Record<string, any> | undefined;
    const route = makeRoute(
      "/posts/[id]",
      makePageModule({ getServerSideProps: async () => ({ props: {} }) }),
    );
    const handler = createPagesPageHandler(
      makeOpts({
        pageRoutes: [route],
        matchRoute: () => ({ route, params: { id: "001" } }),
        safeJsonStringify(value) {
          if (value && typeof value === "object" && "page" in value && "__vinext" in value) {
            nextData = value as Record<string, any>;
          }
          return JSON.stringify(value);
        },
      }),
    );

    const response = await handler(
      makeRequest("/posts/001?draft=1"),
      "/posts/001?draft=1",
      null,
      null,
      null,
    );
    expect(response.status).toBe(200);
    await response.text();
    expect(nextData?.__vinext).not.toHaveProperty("routeUrl");
    expect(nextData?.__vinext.routeParams).toEqual({ id: "001" });
  });

  it("passes only route params to _app for getStaticProps renders", async () => {
    let appRouterQuery: unknown;
    let appContextQuery: unknown;
    const route = makeRoute(
      "/posts/:id",
      makePageModule({ getStaticProps: async () => ({ props: {} }) }),
    );
    const AppComponent = Object.assign(() => null, {
      async getInitialProps(context: { router: { query: unknown }; ctx: { query: unknown } }) {
        appRouterQuery = context.router.query;
        appContextQuery = context.ctx.query;
        return { pageProps: {} };
      },
    });
    const handler = createPagesPageHandler(
      makeOpts({
        AppComponent,
        pageRoutes: [route],
        matchRoute: () => ({ route, params: { id: "001" } }),
      }),
    );

    const response = await handler(
      makeRequest("/posts/001?theme=dark"),
      "/posts/001?theme=dark",
      null,
      null,
      null,
    );
    expect(response.status).toBe(200);
    await response.text();
    expect(appRouterQuery).toEqual({ id: "001" });
    expect(appContextQuery).toEqual({ id: "001" });
  });
});

// ---------------------------------------------------------------------------
// Route miss → 404 fallback
// ---------------------------------------------------------------------------

describe("createPagesPageHandler — route miss", () => {
  it("returns default 404 when no custom 404 page and no _error page", async () => {
    const handler = createPagesPageHandler(makeOpts({ pageRoutes: [] }));
    const res = await handler(makeRequest("/missing"), "/missing", null, null, null);
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).toContain("This page could not be found");
  });

  it("renders custom /404 page on route miss", async () => {
    const notFoundModule = makePageModule();
    const routes = [makeRoute("/404", notFoundModule)];
    const handler = createPagesPageHandler(
      makeOpts({
        pageRoutes: routes,
        matchRoute: (url, r) => {
          const p = url.split("?")[0];
          const route = r.find((rt) => rt.pattern === p);
          return route ? { route, params: {} } : null;
        },
      }),
    );
    const res = await handler(makeRequest("/nonexistent"), "/nonexistent", null, null, null);
    // Custom 404 renders successfully (200 body, 404 status via override)
    expect(res.status).toBe(404);
  });

  it("returns _next/data 404 JSON on data request route miss", async () => {
    const handler = createPagesPageHandler(makeOpts({ pageRoutes: [] }));
    const res = await handler(makeRequest("/missing"), "/missing", null, null, { isDataReq: true });
    expect(res.status).toBe(404);
    const ct = res.headers.get("content-type");
    expect(ct).toContain("application/json");
  });
});

describe("createPagesPageHandler — recursive middleware metadata", () => {
  it("preserves initial middleware matching through custom 404 renders", async () => {
    let nextData: Record<string, any> | undefined;
    const pageRoute = makeRoute(
      "/posts/:id",
      makePageModule({ getServerSideProps: async () => ({ notFound: true }) }),
    );
    const notFoundRoute = makeRoute("/404");
    const handler = createPagesPageHandler(
      makeOpts({
        pageRoutes: [pageRoute, notFoundRoute],
        matchRoute: () => ({ route: pageRoute, params: { id: "missing" } }),
        safeJsonStringify(value) {
          if (value && typeof value === "object" && "page" in value && "__vinext" in value) {
            nextData = value as Record<string, any>;
          }
          return JSON.stringify(value);
        },
      }),
    );

    const response = await handler(makeRequest("/posts/missing"), "/posts/missing", null, null, {
      initialMiddlewareMatched: true,
    });
    expect(response.status).toBe(404);
    await response.text();
    expect(nextData?.__vinext.initialMiddlewareMatched).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Page has no default export
// ---------------------------------------------------------------------------

describe("createPagesPageHandler — no default export", () => {
  it("returns 500 when page module has no default export", async () => {
    const routes = [makeRoute("/", {})]; // no `default`
    const handler = createPagesPageHandler(makeOpts({ pageRoutes: routes }));
    const res = await handler(makeRequest("/"), "/", null, null, null);
    expect(res.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// _next/data JSON envelope
// ---------------------------------------------------------------------------

describe("createPagesPageHandler — _next/data", () => {
  const CDN_KEY = Symbol.for("vinext.cdnCacheAdapter");

  afterEach(() => {
    delete (globalThis as Record<PropertyKey, unknown>)[CDN_KEY];
  });

  it("detects /_next/data URL and returns JSON envelope", async () => {
    const routes = [makeRoute("/about")];
    const handler = createPagesPageHandler(
      makeOpts({
        pageRoutes: routes,
        matchRoute: (url, r) => {
          const route = r.find((rt) => rt.pattern === url.split("?")[0]);
          return route ? { route, params: {} } : null;
        },
      }),
    );
    const dataUrl = "/_next/data/test-build-id/about.json";
    const res = await handler(makeRequest(dataUrl), dataUrl, null, null, null);
    expect(res.status).toBe(200);
    const ct = res.headers.get("content-type");
    expect(ct).toContain("application/json");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toHaveProperty("pageProps");
  });

  it("returns 404 JSON for _next/data with wrong buildId", async () => {
    const handler = createPagesPageHandler(makeOpts());
    const badUrl = "/_next/data/wrong-build-id/about.json";
    const res = await handler(makeRequest(badUrl), badUrl, null, null, null);
    expect(res.status).toBe(404);
    const ct = res.headers.get("content-type");
    expect(ct).toContain("application/json");
  });

  it("prevents edge caching when middleware matching can vary by request", async () => {
    setCdnCacheAdapter(new CloudflareCdnCacheAdapter());
    const routes = [
      makeRoute(
        "/about",
        makePageModule({
          getStaticProps: async () => ({ props: {}, revalidate: 60 }),
        }),
      ),
    ];
    const handler = createPagesPageHandler(makeOpts({ pageRoutes: routes }));

    const response = await handler(makeRequest("/about"), "/about", null, null, {
      isDataReq: true,
      initialMiddlewareMatchCanVaryByRequest: true,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe(
      "private, no-cache, no-store, max-age=0, must-revalidate",
    );
    expect(response.headers.get("CDN-Cache-Control")).toBeNull();
    expect(response.headers.get("Cloudflare-CDN-Cache-Control")).toBeNull();
    expect(response.headers.get("Cache-Tag")).toBeNull();
  });

  it("prevents edge caching when matched middleware can vary its response", async () => {
    setCdnCacheAdapter(new CloudflareCdnCacheAdapter());
    const routes = [
      makeRoute(
        "/about",
        makePageModule({
          getStaticProps: async () => ({ props: {}, revalidate: 60 }),
        }),
      ),
    ];
    const handler = createPagesPageHandler(makeOpts({ pageRoutes: routes }));

    const response = await handler(makeRequest("/about"), "/about", null, null, {
      isDataReq: true,
      initialMiddlewareMatched: true,
    });

    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(response.headers.get("CDN-Cache-Control")).toBeNull();
    expect(response.headers.get("Cache-Tag")).toBeNull();
  });

  it("isolates origin ISR entries by visible rewrite source and tags", async () => {
    class RecordingCacheHandler extends MemoryCacheHandler {
      writes: Array<{ key: string; tags: unknown }> = [];

      override async set(
        key: string,
        data: Parameters<MemoryCacheHandler["set"]>[1],
        ctx?: Record<string, unknown>,
      ) {
        this.writes.push({ key, tags: ctx?.tags });
        await super.set(key, data, ctx);
      }
    }

    const cache = new RecordingCacheHandler();
    setDataCacheHandler(cache);
    try {
      const route = makeRoute(
        "/posts/:id",
        makePageModule({ getStaticProps: async () => ({ props: {}, revalidate: 60 }) }),
      );
      const handler = createPagesPageHandler(
        makeOpts({
          pageRoutes: [route],
          matchRoute: () => ({ route, params: { id: "001" } }),
        }),
      );

      for (const source of ["/visible-a?draft=1", "/visible-b?draft=2"]) {
        const response = await handler(makeRequest(source), "/posts/001", null, null, {
          asPath: source,
          initialMiddlewareMatched: true,
        });
        await response.text();
      }
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(cache.writes.map(({ key }) => key)).toEqual(
        expect.arrayContaining([
          expect.stringContaining("/visible-a?draft=1"),
          expect.stringContaining("/visible-b?draft=2"),
        ]),
      );
      expect(cache.writes.map(({ tags }) => tags)).toEqual(
        expect.arrayContaining([["_N_T_/visible-a"], ["_N_T_/visible-b"]]),
      );
    } finally {
      setDataCacheHandler(new MemoryCacheHandler());
    }
  });

  it("preserves no-middleware trailingSlash data request resolvedUrl and asPath", async () => {
    // Next.js derives Pages data resolvedUrl/asPath from the parsed data
    // pathname. The trailingSlash data-path adjustment is middleware-only.
    const setSSRContext = vi.fn();
    const routes = [
      makeRoute(
        "/about",
        makePageModule({
          getServerSideProps: async ({ resolvedUrl }: { resolvedUrl: string }) => ({
            props: { resolvedUrl },
          }),
        }),
      ),
    ];
    const handler = createPagesPageHandler(
      makeOpts({
        pageRoutes: routes,
        setSSRContext,
        vinextConfig: {
          basePath: "",
          assetPrefix: "",
          trailingSlash: true,
          disableOptimizedLoading: true,
        },
      }),
    );

    const dataUrl = "/_next/data/test-build-id/about.json?x=1";
    const res = await handler(makeRequest(dataUrl), dataUrl, null, null, null);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { pageProps: { resolvedUrl: string } };
    expect(body.pageProps.resolvedUrl).toBe("/about?x=1");

    const context = setSSRContext.mock.calls.find((call) => call[0] !== null)?.[0] as
      | { asPath?: string }
      | undefined;
    expect(context?.asPath).toBe("/about?x=1");
  });
});

// ---------------------------------------------------------------------------
// 405 method check
// ---------------------------------------------------------------------------

describe("createPagesPageHandler — 405 method check", () => {
  it("returns 405 for POST to a static page (no getServerSideProps)", async () => {
    const routes = [makeRoute("/about", makePageModule())];
    const handler = createPagesPageHandler(
      makeOpts({
        pageRoutes: routes,
        matchRoute: (url, r) => {
          const route = r.find((rt) => rt.pattern === url.split("?")[0]);
          return route ? { route, params: {} } : null;
        },
      }),
    );
    const res = await handler(makeRequest("/about", "POST"), "/about", null, null, null);
    expect(res.status).toBe(405);
    const allow = res.headers.get("Allow");
    expect(allow).toContain("GET");
  });

  it("skips 405 check when page exports getServerSideProps", async () => {
    // The 405 guard only applies to static (no-gSSP) pages. When gSSP is
    // present, resolvePagesPageMethodResponse returns null and the render
    // pipeline proceeds. Verify by spying on the module method check result.
    // We use a module that returns { props: {} } from gSSP so the render
    // can complete without hitting renderToReadableStream errors.
    const gsspModule = makePageModule({
      getServerSideProps: async () => ({ props: {} }),
    });
    const routes = [makeRoute("/about", gsspModule)];
    const handler = createPagesPageHandler(
      makeOpts({
        pageRoutes: routes,
        matchRoute: (url, r) => {
          const route = r.find((rt) => rt.pattern === url.split("?")[0]);
          return route ? { route, params: {} } : null;
        },
      }),
    );
    const res = await handler(makeRequest("/about", "POST"), "/about", null, null, null);
    // Must not be 405 — the method check is bypassed for gSSP pages
    expect(res.status).not.toBe(405);
    // Must not be 405 Allow header either
    expect(res.headers.get("Allow")).toBeNull();
  });

  it("does not 405 on /404 pattern (error pages are exempt)", async () => {
    const routes = [makeRoute("/404", makePageModule())];
    const handler = createPagesPageHandler(
      makeOpts({
        pageRoutes: routes,
        matchRoute: (url, r) => {
          const route = r.find((rt) => rt.pattern === url.split("?")[0]);
          return route ? { route, params: {} } : null;
        },
      }),
    );
    const res = await handler(makeRequest("/404", "POST"), "/404", null, null, null);
    expect(res.status).not.toBe(405);
  });
});

// ---------------------------------------------------------------------------
// i18n redirect — 307 short-circuit from resolvePagesI18nRequest
// ---------------------------------------------------------------------------

describe("createPagesPageHandler — i18n redirect", () => {
  // getLocaleRedirect fires when pathname === "/" and the Accept-Language
  // header prefers a non-default locale. The handler must return a 307
  // before attempting any route match.
  it("returns 307 when i18n locale detection produces a redirect", async () => {
    const handler = createPagesPageHandler(
      makeOpts({
        pageRoutes: [makeRoute("/")],
        i18nConfig: {
          locales: ["en", "fr"],
          defaultLocale: "en",
        },
      }),
    );
    // Visit / with Accept-Language: fr — resolvePagesI18nRequest redirects to /fr
    const req = new Request("http://localhost/", {
      headers: { "accept-language": "fr" },
    });
    const res = await handler(req, "/", null, null, null);
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/fr");
  });

  it("does not redirect when locale prefix is already present", async () => {
    const routes = [makeRoute("/fr/about")];
    const handler = createPagesPageHandler(
      makeOpts({
        pageRoutes: routes,
        i18nConfig: {
          locales: ["en", "fr"],
          defaultLocale: "en",
        },
        matchRoute: (url, r) => {
          const route = r.find((rt) => rt.pattern === url.split("?")[0]);
          return route ? { route, params: {} } : null;
        },
      }),
    );
    const res = await handler(makeRequest("/fr/about"), "/fr/about", null, null, null);
    // Not a 307 — the locale prefix is already present
    expect(res.status).not.toBe(307);
  });
});

// ---------------------------------------------------------------------------
// Internal error guard (prevents infinite recursion on error pages)
// ---------------------------------------------------------------------------

describe("createPagesPageHandler — internal error guard", () => {
  it("returns 500 text when __isInternalErrorRender is set and render throws", async () => {
    const errorRoute = makeRoute("/_error", makePageModule());
    const handler = createPagesPageHandler(
      makeOpts({
        pageRoutes: [errorRoute],
        errorPageRoute: errorRoute,
        matchRoute: (url, r) => {
          const route = r.find((rt) => rt.pattern === url.split("?")[0]);
          return route ? { route, params: {} } : null;
        },
        // Cause an error during render
        renderToReadableStream: async () => {
          throw new Error("render failure");
        },
      }),
    );
    const res = await handler(makeRequest("/_error"), "/_error", null, null, {
      __isInternalErrorRender: true,
      __forcedRoute: errorRoute,
    });
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).toBe("Internal Server Error");
  });

  it("falls back to 500 text on data request even without __isInternalErrorRender", async () => {
    // Data requests skip renderToReadableStream (JSON envelope path), so we
    // need to throw earlier — in createPageElement, which is called inside
    // resolvePagesPageData to build the element for ISR/SSR rendering.
    const routes = [
      makeRoute("/about", {
        ...makePageModule(),
        getStaticProps: async () => {
          throw new Error("gssp failure");
        },
      }),
    ];
    const handler = createPagesPageHandler(
      makeOpts({
        pageRoutes: routes,
        matchRoute: (url, r) => {
          const route = r.find((rt) => rt.pattern === url.split("?")[0]);
          return route ? { route, params: {} } : null;
        },
        // getFontPreloads is called before the isDataReq branch.
        // Throwing here triggers the catch block regardless of isDataReq.
        getFontPreloads: () => {
          throw new Error("font failure");
        },
      }),
    );
    // isDataReq=true → no error-page recursion, direct 500
    const res = await handler(makeRequest("/about"), "/about", null, null, { isDataReq: true });
    expect(res.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// renderErrorPageOnMiss: false — no 404 recursion
// ---------------------------------------------------------------------------

describe("createPagesPageHandler — renderErrorPageOnMiss: false", () => {
  it("returns default 404 without recursing when renderErrorPageOnMiss=false", async () => {
    const handler = createPagesPageHandler(makeOpts({ pageRoutes: [] }));
    const res = await handler(makeRequest("/missing"), "/missing", null, null, {
      renderErrorPageOnMiss: false,
    });
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).toContain("This page could not be found");
  });
});

// ---------------------------------------------------------------------------
// setSSRContext called
// ---------------------------------------------------------------------------

describe("createPagesPageHandler — SSR context", () => {
  it("calls setSSRContext with the matched route pattern", async () => {
    const setSSRContext = vi.fn();
    const routes = [makeRoute("/about")];
    const handler = createPagesPageHandler(
      makeOpts({
        pageRoutes: routes,
        setSSRContext,
        matchRoute: (url, r) => {
          const route = r.find((rt) => rt.pattern === url.split("?")[0]);
          return route ? { route, params: {} } : null;
        },
      }),
    );
    await handler(makeRequest("/about"), "/about", null, null, null);
    expect(setSSRContext).toHaveBeenCalled();
    const ctx = setSSRContext.mock.calls[0][0] as Record<string, unknown>;
    expect(ctx.pathname).toBe("/about");
  });
});

// ---------------------------------------------------------------------------
// x-nextjs-deployment-id header — _next/data success / redirect / notFound
// ---------------------------------------------------------------------------

describe("createPagesPageHandler — x-nextjs-deployment-id", () => {
  const DEPLOYMENT_ID = "prod-deploy-xyz";

  it("sets x-nextjs-deployment-id on _next/data success response when env var is set", async () => {
    const savedId = process.env.__VINEXT_DEPLOYMENT_ID;
    process.env.__VINEXT_DEPLOYMENT_ID = DEPLOYMENT_ID;
    try {
      const routes = [makeRoute("/about")];
      const handler = createPagesPageHandler(
        makeOpts({
          pageRoutes: routes,
          matchRoute: (url, r) => {
            const route = r.find((rt) => rt.pattern === url.split("?")[0]);
            return route ? { route, params: {} } : null;
          },
        }),
      );
      const dataUrl = "/_next/data/test-build-id/about.json";
      const res = await handler(makeRequest(dataUrl), dataUrl, null, null, null);
      expect(res.status).toBe(200);
      expect(res.headers.get("x-nextjs-deployment-id")).toBe(DEPLOYMENT_ID);
    } finally {
      if (savedId === undefined) {
        delete process.env.__VINEXT_DEPLOYMENT_ID;
      } else {
        process.env.__VINEXT_DEPLOYMENT_ID = savedId;
      }
    }
  });

  it("sets x-nextjs-deployment-id on _next/data redirect response when env var is set", async () => {
    const savedId = process.env.__VINEXT_DEPLOYMENT_ID;
    process.env.__VINEXT_DEPLOYMENT_ID = DEPLOYMENT_ID;
    try {
      const routes = [
        makeRoute("/about", {
          ...makePageModule(),
          getServerSideProps: async () => ({
            redirect: { destination: "/new-about", permanent: false },
          }),
        }),
      ];
      const handler = createPagesPageHandler(
        makeOpts({
          pageRoutes: routes,
          matchRoute: (url, r) => {
            const route = r.find((rt) => rt.pattern === url.split("?")[0]);
            return route ? { route, params: {} } : null;
          },
        }),
      );
      const dataUrl = "/_next/data/test-build-id/about.json";
      const res = await handler(makeRequest(dataUrl), dataUrl, null, null, null);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(res.headers.get("x-nextjs-deployment-id")).toBe(DEPLOYMENT_ID);
      const body = (await res.json()) as { pageProps: Record<string, unknown> };
      expect(body.pageProps.__N_REDIRECT).toBe("/new-about");
    } finally {
      if (savedId === undefined) {
        delete process.env.__VINEXT_DEPLOYMENT_ID;
      } else {
        process.env.__VINEXT_DEPLOYMENT_ID = savedId;
      }
    }
  });

  it("sets x-nextjs-deployment-id on _next/data notFound response when env var is set", async () => {
    const savedId = process.env.__VINEXT_DEPLOYMENT_ID;
    process.env.__VINEXT_DEPLOYMENT_ID = DEPLOYMENT_ID;
    try {
      const routes = [
        makeRoute("/about", {
          ...makePageModule(),
          getServerSideProps: async () => ({ notFound: true }),
        }),
      ];
      const handler = createPagesPageHandler(
        makeOpts({
          pageRoutes: routes,
          matchRoute: (url, r) => {
            const route = r.find((rt) => rt.pattern === url.split("?")[0]);
            return route ? { route, params: {} } : null;
          },
        }),
      );
      const dataUrl = "/_next/data/test-build-id/about.json";
      const res = await handler(makeRequest(dataUrl), dataUrl, null, null, null);
      expect(res.status).toBe(404);
      expect(res.headers.get("x-nextjs-deployment-id")).toBe(DEPLOYMENT_ID);
    } finally {
      if (savedId === undefined) {
        delete process.env.__VINEXT_DEPLOYMENT_ID;
      } else {
        process.env.__VINEXT_DEPLOYMENT_ID = savedId;
      }
    }
  });

  it("omits x-nextjs-deployment-id on _next/data responses when no deployment env var is set", async () => {
    const savedVinext = process.env.__VINEXT_DEPLOYMENT_ID;
    const savedNext = process.env.NEXT_DEPLOYMENT_ID;
    delete process.env.__VINEXT_DEPLOYMENT_ID;
    delete process.env.NEXT_DEPLOYMENT_ID;
    try {
      const routes = [makeRoute("/about")];
      const handler = createPagesPageHandler(
        makeOpts({
          pageRoutes: routes,
          matchRoute: (url, r) => {
            const route = r.find((rt) => rt.pattern === url.split("?")[0]);
            return route ? { route, params: {} } : null;
          },
        }),
      );
      const dataUrl = "/_next/data/test-build-id/about.json";
      const res = await handler(makeRequest(dataUrl), dataUrl, null, null, null);
      expect(res.status).toBe(200);
      expect(res.headers.get("x-nextjs-deployment-id")).toBeNull();
    } finally {
      if (savedVinext !== undefined) process.env.__VINEXT_DEPLOYMENT_ID = savedVinext;
      if (savedNext !== undefined) process.env.NEXT_DEPLOYMENT_ID = savedNext;
    }
  });

  it("omits x-nextjs-deployment-id on _next/data success responses for /_error and /500", async () => {
    const savedId = process.env.__VINEXT_DEPLOYMENT_ID;
    process.env.__VINEXT_DEPLOYMENT_ID = DEPLOYMENT_ID;
    try {
      // Next.js pages-handler.ts guards the success-path header with
      // `!isErrorPage && !is500Page`; mirror that exclusion here.
      for (const pattern of ["/_error", "/500"]) {
        const routes = [makeRoute(pattern)];
        const handler = createPagesPageHandler(
          makeOpts({
            pageRoutes: routes,
            matchRoute: (url, r) => {
              const route = r.find((rt) => rt.pattern === url.split("?")[0]);
              return route ? { route, params: {} } : null;
            },
          }),
        );
        const dataUrl = `/_next/data/test-build-id${pattern}.json`;
        const res = await handler(makeRequest(dataUrl), dataUrl, null, null, null);
        expect(res.status).toBe(200);
        expect(res.headers.get("x-nextjs-deployment-id")).toBeNull();
      }
    } finally {
      if (savedId === undefined) {
        delete process.env.__VINEXT_DEPLOYMENT_ID;
      } else {
        process.env.__VINEXT_DEPLOYMENT_ID = savedId;
      }
    }
  });

  it("sets x-nextjs-deployment-id on _next/data wrong-buildId 404 response", async () => {
    const savedId = process.env.__VINEXT_DEPLOYMENT_ID;
    process.env.__VINEXT_DEPLOYMENT_ID = DEPLOYMENT_ID;
    try {
      const handler = createPagesPageHandler(makeOpts());
      const badUrl = "/_next/data/stale-build-id/about.json";
      const res = await handler(makeRequest(badUrl), badUrl, null, null, null);
      expect(res.status).toBe(404);
      expect(res.headers.get("x-nextjs-deployment-id")).toBe(DEPLOYMENT_ID);
    } finally {
      if (savedId === undefined) {
        delete process.env.__VINEXT_DEPLOYMENT_ID;
      } else {
        process.env.__VINEXT_DEPLOYMENT_ID = savedId;
      }
    }
  });

  it("sets x-nextjs-deployment-id on _next/data route-miss 404 response", async () => {
    const savedId = process.env.__VINEXT_DEPLOYMENT_ID;
    process.env.__VINEXT_DEPLOYMENT_ID = DEPLOYMENT_ID;
    try {
      // Handler with no routes for /unknown — will hit the route-miss data exit.
      const handler = createPagesPageHandler(
        makeOpts({
          pageRoutes: [makeRoute("/about")],
          matchRoute: () => null, // always misses
        }),
      );
      const dataUrl = "/_next/data/test-build-id/unknown.json";
      const res = await handler(makeRequest(dataUrl), dataUrl, null, null, null);
      expect(res.status).toBe(404);
      expect(res.headers.get("x-nextjs-deployment-id")).toBe(DEPLOYMENT_ID);
    } finally {
      if (savedId === undefined) {
        delete process.env.__VINEXT_DEPLOYMENT_ID;
      } else {
        process.env.__VINEXT_DEPLOYMENT_ID = savedId;
      }
    }
  });
});
