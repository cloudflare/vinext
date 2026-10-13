/**
 * Unit tests for the Pages Router render orchestrator.
 *
 * Tests the behavior of `createPagesPageHandler` through stub closures,
 * verifying route matching, 404/500 fallback, _next/data envelope,
 * i18n redirect, 405 method check, and internal-error guard.
 */
import React from "react";
import { renderToReadableStream } from "react-dom/server.edge";
import { afterEach, describe, it, expect, vi } from "vite-plus/test";
import {
  createPagesPageHandler,
  finalizePagesPreviewResponse,
  shouldEmitPagesClientTraceMetadata,
} from "../packages/vinext/src/server/pages-page-handler.js";
import type { CreatePagesPageHandlerOptions } from "../packages/vinext/src/server/pages-page-handler.js";
import {
  PAGES_PREVIEW_CACHE_CONTROL,
  setPagesPreviewData,
} from "../packages/vinext/src/server/pages-preview.js";
import {
  DefaultCdnCacheAdapter,
  setCdnCacheAdapter,
  type CdnCacheAdapter,
} from "../packages/vinext/src/shims/cdn-cache.js";
import { CloudflareCdnCacheAdapter } from "../packages/cloudflare/src/cache/cdn-adapter.runtime.js";
import {
  getRevalidateSecret,
  isrCacheKey,
  pagesIsrCacheKey,
  isrSet,
  PRERENDER_REVALIDATE_HEADER,
} from "../packages/vinext/src/server/isr-cache.js";
import { after } from "../packages/vinext/src/shims/server.js";
import { Main, NextScript } from "../packages/vinext/src/shims/document.js";
import { VINEXT_REVALIDATED_CACHE_TAG_HEADER } from "../packages/vinext/src/server/headers.js";
import { pagesPathCacheTag } from "../packages/vinext/src/server/pages-cache-tag.js";
import { generatePagesETag } from "../packages/vinext/src/server/pages-page-response.js";
import { runWithExecutionContext } from "../packages/vinext/src/shims/request-context.js";
import {
  CACHEABILITY_REQUEST_STATE,
  type RouteCacheabilityState,
} from "../packages/vinext/src/shims/cacheability-classification.js";

afterEach(() => setCdnCacheAdapter(new DefaultCdnCacheAdapter()));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(pathname = "/", method = "GET"): Request {
  return new Request(`http://localhost${pathname}`, { method });
}

function makePreviewCookieHeader(data: object | string): string {
  const headers = new Map<string, string | string[]>();
  setPagesPreviewData(
    {
      getHeader(name) {
        return headers.get(name.toLowerCase());
      },
      setHeader(name, value) {
        headers.set(name.toLowerCase(), value as string | string[]);
      },
    },
    data,
  );
  const cookies = headers.get("set-cookie");
  if (!Array.isArray(cookies)) throw new Error("expected preview cookies");
  return cookies.map((cookie) => cookie.split(";", 1)[0]).join("; ");
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

describe("createPagesPageHandler — after() lifecycle", () => {
  it("runs callbacks only after the response body closes", async () => {
    let callbackRan = false;
    const handler = createPagesPageHandler(
      makeOpts({
        pageRoutes: [
          makeRoute(
            "/",
            makePageModule({
              getServerSideProps: async () => {
                after(() => {
                  callbackRan = true;
                });
                return { props: {} };
              },
            }),
          ),
        ],
      }),
    );

    const response = await handler(makeRequest(), "/", null, null, null);
    expect(callbackRan).toBe(false);

    await response.text();
    await vi.waitFor(() => expect(callbackRan).toBe(true));
  });
});

describe("createPagesPageHandler — pre-render response headers", () => {
  it("lets getServerSideProps override config cache policy", async () => {
    // Ported from Next.js:
    // test/e2e/middleware-custom-matchers/app/pages/index.js
    // https://github.com/vercel/next.js/blob/canary/test/e2e/middleware-custom-matchers/app/pages/index.js
    const handler = createPagesPageHandler(
      makeOpts({
        pageRoutes: [
          makeRoute(
            "/",
            makePageModule({
              getServerSideProps: async ({
                res,
              }: {
                res: {
                  getHeader(name: string): string | string[] | number | undefined;
                  setHeader(name: string, value: string): void;
                };
              }) => {
                expect(res.getHeader("x-config-variant")).toBe("preview");
                expect(res.getHeader("x-from-middleware")).toBe("present");
                res.setHeader("Cache-Control", "private, no-store");
                return { props: {} };
              },
            }),
          ),
        ],
      }),
    );

    const initialHeaders = new Headers({
      "Cache-Control": "public, s-maxage=60",
      Vary: "x-visitor",
      "x-config-variant": "preview",
      "x-from-middleware": "present",
    });
    const response = await handler(makeRequest(), "/", null, null, null, initialHeaders);

    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Vary")).toBe("x-visitor");
    expect(response.headers.get("x-config-variant")).toBe("preview");
    expect(response.headers.get("x-from-middleware")).toBe("present");
  });
});

// ---------------------------------------------------------------------------
// Route miss → 404 fallback
// ---------------------------------------------------------------------------

describe("createPagesPageHandler — route miss", () => {
  it("preserves a forced error status when serving a prerendered page", async () => {
    const adapter = Object.assign(new DefaultCdnCacheAdapter(), { hasPrerenderedPages: true });
    vi.spyOn(adapter, "get").mockResolvedValue({
      lastModified: 0,
      cacheControl: { revalidate: false },
      value: {
        kind: "PAGES",
        html: "prebuilt error",
        pageData: {},
        status: 200,
        headers: undefined,
      },
    });
    setCdnCacheAdapter(adapter);
    const handler = createPagesPageHandler(makeOpts({ pageRoutes: [makeRoute("/500")] }));
    const response = await handler(makeRequest("/500"), "/500", null, null, { statusCode: 500 });
    expect(response.status).toBe(500);
    expect(await response.text()).toBe("prebuilt error");
  });

  it.each(["/404", "/_error"])(
    "reads %s not-found HTML under its prerender key",
    async (pattern) => {
      const adapter = Object.assign(new DefaultCdnCacheAdapter(), { hasPrerenderedPages: true });
      const get = vi.spyOn(adapter, "get").mockResolvedValue({
        lastModified: 0,
        cacheControl: { revalidate: false },
        value: {
          kind: "PAGES",
          html: "prebuilt 404",
          pageData: {},
          status: 404,
          headers: undefined,
        },
      });
      setCdnCacheAdapter(adapter);
      const route = makeRoute(pattern);
      const handler = createPagesPageHandler(
        makeOpts({ pageRoutes: [route], errorPageRoute: pattern === "/_error" ? route : null }),
      );
      const response = await handler(makeRequest("/missing"), "/missing", null, null, null);
      expect(get).toHaveBeenCalledExactlyOnceWith(pagesIsrCacheKey("/404", "test-build-id"));
      expect(response.status).toBe(404);
      expect(response.headers.get("x-vinext-cache")).toBe("HIT");
      expect(await response.text()).toBe("prebuilt 404");
    },
  );

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
    expect(res.headers.get("cache-control")).toBe(
      "private, no-cache, no-store, max-age=0, must-revalidate",
    );

    const direct = await handler(makeRequest("/404"), "/404", null, null, null);
    expect(direct.status).toBe(404);
    expect(direct.headers.get("cache-control")).toBeNull();
  });

  it("replaces the inner /404 CDN policy with the source notFound policy", async () => {
    const edgeAdapter: CdnCacheAdapter = {
      ownsBackgroundRevalidation: false,
      async get() {
        return null;
      },
      async set() {},
      async revalidateTag() {},
      buildResponseHeaders(input) {
        if (/(?:private|no-store|no-cache)/i.test(input.cacheControl)) {
          return {
            "Cache-Control": "no-store",
            "X-Example-Edge-Policy": null,
            "X-Example-Cache-Tag": null,
          };
        }
        return {
          "Cache-Control": "no-store",
          "X-Example-Edge-Policy": input.cacheControl,
          "X-Example-Cache-Tag": input.tags?.join(",") ?? null,
        };
      },
      responsePolicy: {
        isHeader: (name) => name.toLowerCase() === "x-example-edge-policy",
        readCacheControl: (headers) =>
          headers.get("X-Example-Edge-Policy") ?? headers.get("Cache-Control"),
        hasExplicitNonCacheablePolicy(headers) {
          const edgePolicy = headers.get("X-Example-Edge-Policy");
          if (edgePolicy && /(?:private|no-store|no-cache)/i.test(edgePolicy)) return true;
          return Boolean(
            !edgePolicy &&
            /(?:private|no-store|no-cache)/i.test(headers.get("Cache-Control") ?? ""),
          );
        },
      },
    };
    setCdnCacheAdapter(edgeAdapter);
    try {
      const sourceRoute = makeRoute(
        "/source",
        makePageModule({ getStaticProps: async () => ({ notFound: true, revalidate: 7 }) }),
      );
      const notFoundRoute = makeRoute(
        "/404",
        makePageModule({ getStaticProps: async () => ({ props: {}, revalidate: 6000 }) }),
      );
      const handler = createPagesPageHandler(
        makeOpts({ pageRoutes: [sourceRoute, notFoundRoute] }),
      );

      const sourceResponse = await handler(makeRequest("/source"), "/source", null, null, null);
      expect(sourceResponse.headers.get("cache-control")).toBe("no-store");
      expect(sourceResponse.headers.get("x-example-edge-policy")).toBe(
        "s-maxage=7, stale-while-revalidate",
      );
      expect(sourceResponse.headers.get("x-example-cache-tag")).toBe("_N_T_/source");

      const genericResponse = await handler(makeRequest("/missing"), "/missing", null, null, null);
      expect(genericResponse.headers.get("cache-control")).toBe("no-store");
      expect(genericResponse.headers.get("x-example-edge-policy")).toBeNull();
      expect(genericResponse.headers.get("x-example-cache-tag")).toBeNull();
    } finally {
      setCdnCacheAdapter(new DefaultCdnCacheAdapter());
    }
  });

  it("preserves an explicit no-store policy from a dynamic error page", async () => {
    const sourceRoute = makeRoute(
      "/source",
      makePageModule({ getStaticProps: async () => ({ notFound: true, revalidate: 7 }) }),
    );
    const notFoundRoute = makeRoute(
      "/404",
      makePageModule({ getServerSideProps: async () => ({ props: {} }) }),
    );
    const handler = createPagesPageHandler(makeOpts({ pageRoutes: [sourceRoute, notFoundRoute] }));

    const response = await handler(makeRequest("/source"), "/source", null, null, null);

    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe(
      "private, no-cache, no-store, max-age=0, must-revalidate",
    );
  });

  // Ported from Next.js: test/e2e/no-page-props/no-page-props.test.ts
  // https://github.com/vercel/next.js/blob/v16.3.0-canary.80/test/e2e/no-page-props/no-page-props.test.ts
  it("preserves a custom App initial-props envelope without pageProps on _error", async () => {
    const renderedProps: Record<string, unknown>[] = [];
    const errorComponent = Object.assign(() => null, {
      getInitialProps: ({ res }: { res: { statusCode: number } }) => ({
        statusCode: res.statusCode,
      }),
    });
    const errorRoute = makeRoute("/_error", makePageModule({ default: errorComponent }));
    const AppComponent = Object.assign(() => null, {
      getInitialProps: async () => ({ initialProps: {} }),
    });
    const handler = createPagesPageHandler(
      makeOpts({
        pageRoutes: [],
        errorPageRoute: errorRoute,
        AppComponent,
        createPageElement: (_PageComponent, _AppComponent, props) => {
          renderedProps.push(props);
          return null;
        },
      }),
    );

    const res = await handler(makeRequest("/missing"), "/missing", null, null, null);

    expect(res.status).toBe(404);
    expect(renderedProps).toContainEqual({ initialProps: {} });
  });

  it("returns _next/data 404 JSON on data request route miss", async () => {
    const handler = createPagesPageHandler(makeOpts({ pageRoutes: [] }));
    const res = await handler(makeRequest("/missing"), "/missing", null, null, { isDataReq: true });
    expect(res.status).toBe(404);
    const ct = res.headers.get("content-type");
    expect(ct).toContain("application/json");
  });
});

describe("createPagesPageHandler — on-demand terminal responses", () => {
  it("does not leave a contradictory vinext MISS beside REVALIDATED", async () => {
    const route = makeRoute(
      "/redirect",
      makePageModule({
        getStaticProps: async () => ({
          redirect: { destination: "/target", permanent: false },
          revalidate: 60,
        }),
      }),
    );
    const handler = createPagesPageHandler(makeOpts({ pageRoutes: [route] }));
    const request = new Request("http://localhost/alias", {
      headers: { [PRERENDER_REVALIDATE_HEADER]: getRevalidateSecret() },
    });

    const response = await handler(request, "/redirect", null, null, null);

    expect(response.headers.get("x-nextjs-cache")).toBe("REVALIDATED");
    expect(response.headers.get("x-vinext-cache")).toBeNull();
    expect(response.headers.get(VINEXT_REVALIDATED_CACHE_TAG_HEADER)).toBe(
      encodeURIComponent("_N_T_/redirect"),
    );
  });
});

describe("createPagesPageHandler — percent-encoded pathname cache tags", () => {
  // `/users/%40alice` and `/users/@alice` share one Pages ISR entry. Each
  // spelling's edge copy must carry the decoded path tag that
  // res.revalidate("/users/@alice") and revalidatePath("/users/@alice") purge.
  function captureCacheTags(): void {
    setCdnCacheAdapter({
      ownsBackgroundRevalidation: false,
      async get() {
        return null;
      },
      async set() {},
      async revalidateTag() {},
      buildResponseHeaders(input) {
        return {
          "Cache-Control": input.cacheControl,
          "X-Example-Cache-Tag": input.tags?.join(",") ?? null,
        };
      },
    });
  }

  function makeUsersHandler(getStaticProps: () => Promise<Record<string, unknown>>) {
    const usersRoute: PageRoute = {
      ...makeRoute("/users/:handle", makePageModule({ getStaticProps })),
      params: ["handle"],
    };
    const notFoundRoute = makeRoute(
      "/404",
      makePageModule({ getStaticProps: async () => ({ props: {}, revalidate: 6000 }) }),
    );
    return createPagesPageHandler(
      makeOpts({
        pageRoutes: [usersRoute, notFoundRoute],
        matchRoute: (url, routes) => {
          const pathname = url.split("?")[0];
          const exact = routes.find((route) => route.pattern === pathname);
          const handle = /^\/users\/([^/]+)$/.exec(pathname)?.[1];
          const params: Record<string, string> = handle
            ? { handle: decodeURIComponent(handle) }
            : {};
          if (exact) return { route: exact, params };
          return handle ? { route: usersRoute, params } : null;
        },
      }),
    );
  }

  it.each([
    ["/", "_N_T_/"],
    ["/users/", "_N_T_/users"],
    ["/users/%40alice", "_N_T_/users/@alice"],
    ["/a%2fb", "_N_T_/a%2Fb"],
    ["/caf%C3%A9", "_N_T_/caf%C3%A9"],
    ["/caf\u00e9", "_N_T_/caf%C3%A9"],
    ["/bad%E0%A4%A", "_N_T_/bad%E0%A4%A"],
  ])("derives the path tag for %s from the ISR key identity", (pathname, tag) => {
    expect(pagesPathCacheTag(pathname)).toBe(tag);
  });

  it.each([
    ["props", async () => ({ props: {}, revalidate: false })],
    ["notFound", async () => ({ notFound: true, revalidate: 7 })],
    [
      "redirect",
      async () => ({ redirect: { destination: "/target", permanent: false }, revalidate: 60 }),
    ],
  ])("tags an encoded %s response with the decoded path", async (kind, getStaticProps) => {
    captureCacheTags();
    const handler = makeUsersHandler(getStaticProps);
    const handle = `${kind}-${Date.now()}`;

    const response = await handler(
      makeRequest(`/users/%40${handle}`),
      `/users/%40${handle}`,
      null,
      null,
      null,
    );

    expect(response.headers.get("x-example-cache-tag")).toBe(`_N_T_/users/@${handle}`);
  });

  it.each([
    ["props", "%40", "@", async () => ({ props: {}, revalidate: false })],
    ["notFound", "%40", "@", async () => ({ notFound: true, revalidate: 7 })],
    // Headers trim trailing whitespace, so the reported tag must stay URI-encoded.
    ["trailing-space props", "%20", " ", async () => ({ props: {}, revalidate: false })],
  ])(
    "reports the decoded path tag after an encoded on-demand %s revalidation",
    async (_kind, encoded, decoded, getStaticProps) => {
      const handler = makeUsersHandler(getStaticProps);
      const handle = `on-demand-${Date.now()}`;
      const request = new Request(`http://localhost/users/${handle}${encoded}`, {
        headers: { [PRERENDER_REVALIDATE_HEADER]: getRevalidateSecret() },
      });

      const response = await handler(request, `/users/${handle}${encoded}`, null, null, null);

      expect(response.headers.get("x-nextjs-cache")).toBe("REVALIDATED");
      expect(
        decodeURIComponent(response.headers.get(VINEXT_REVALIDATED_CACHE_TAG_HEADER) ?? ""),
      ).toBe(`_N_T_/users/${handle}${decoded}`);
    },
  );
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

  it("preserves staged Set-Cookie values separately on Pages data responses", async () => {
    const stagedHeaders = new Headers();
    stagedHeaders.append("Set-Cookie", "middleware=one; Path=/");
    stagedHeaders.append("Set-Cookie", "config=two; Expires=Wed, 21 Oct 2037 07:28:00 GMT; Path=/");
    const route = makeRoute(
      "/about",
      makePageModule({
        getServerSideProps: async ({ res }: { res: { getHeader(name: string): unknown } }) => {
          expect(res.getHeader("Set-Cookie")).toEqual(stagedHeaders.getSetCookie());
          return { props: {} };
        },
      }),
    );
    const handler = createPagesPageHandler(makeOpts({ pageRoutes: [route] }));
    const dataUrl = "/_next/data/test-build-id/about.json";

    const response = await handler(
      makeRequest(dataUrl),
      dataUrl,
      null,
      stagedHeaders,
      null,
      stagedHeaders,
    );

    expect(response.headers.getSetCookie()).toEqual(stagedHeaders.getSetCookie());
  });

  it("returns 404 JSON for _next/data with wrong buildId", async () => {
    const handler = createPagesPageHandler(makeOpts());
    const badUrl = "/_next/data/wrong-build-id/about.json";
    const res = await handler(makeRequest(badUrl), badUrl, null, null, null);
    expect(res.status).toBe(404);
    const ct = res.headers.get("content-type");
    expect(ct).toContain("application/json");
  });

  it("uses the HTML path tag for cacheable static-props data responses", async () => {
    const cacheInputs: Array<{ cacheControl: string; tags?: readonly string[] }> = [];
    setCdnCacheAdapter({
      ownsBackgroundRevalidation: false,
      async get() {
        return null;
      },
      async set() {},
      async revalidateTag() {},
      buildResponseHeaders(input) {
        cacheInputs.push(input);
        return {
          "Cache-Control": "public, max-age=0, must-revalidate",
          "X-Example-Cache-Tag": input.tags?.join(",") ?? null,
          "X-Example-Edge-Policy": input.cacheControl,
        };
      },
    });
    const handler = createPagesPageHandler(
      makeOpts({
        pageRoutes: [
          makeRoute(
            "/about",
            makePageModule({
              getStaticProps: async () => ({ props: {}, revalidate: 60 }),
            }),
          ),
        ],
      }),
    );
    const dataUrl = "/_next/data/test-build-id/about.json";

    const response = await handler(makeRequest(dataUrl), dataUrl, null, null, null);

    expect(response.status).toBe(200);
    expect(cacheInputs).toEqual([
      expect.objectContaining({
        tags: ["_N_T_/about"],
      }),
    ]);
    expect(response.headers.get("X-Example-Cache-Tag")).toBe("_N_T_/about");
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

  it("marks preview data and forces private no-store caching", async () => {
    const routeModule = makePageModule({
      getStaticProps: async ({ previewData }: { previewData: unknown }) => ({
        props: { previewData },
      }),
    });
    const handler = createPagesPageHandler(
      makeOpts({ pageRoutes: [makeRoute("/about", routeModule)] }),
    );
    const dataUrl = "/_next/data/test-build-id/about.json";
    const request = new Request(`http://localhost${dataUrl}`, {
      headers: { cookie: makePreviewCookieHeader({ draft: true }) },
    });

    const response = await handler(request, dataUrl, null, null, null);

    expect(response.headers.get("cache-control")).toBe(PAGES_PREVIEW_CACHE_CONTROL);
    expect(await response.json()).toMatchObject({
      __N_PREVIEW: true,
      pageProps: { previewData: { draft: true } },
    });
  });
});

describe("createPagesPageHandler — preview responses", () => {
  it("does not activate preview on pages without static or server props", async () => {
    const setSSRContext = vi.fn();
    const handler = createPagesPageHandler(makeOpts({ setSSRContext }));
    const request = new Request("http://localhost/", {
      headers: { cookie: makePreviewCookieHeader({ draft: true }) },
    });

    const response = await handler(request, "/", null, null, null);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).not.toBe(PAGES_PREVIEW_CACHE_CONTROL);
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(setSSRContext).toHaveBeenCalledWith(
      expect.objectContaining({
        isPreview: false,
        nextData: expect.not.objectContaining({ isPreview: true }),
      }),
    );
  });

  it("activates preview on pages with server props", async () => {
    const setSSRContext = vi.fn();
    const handler = createPagesPageHandler(
      makeOpts({
        pageRoutes: [
          makeRoute(
            "/",
            makePageModule({ getServerSideProps: async () => ({ props: { preview: true } }) }),
          ),
        ],
        setSSRContext,
      }),
    );
    const request = new Request("http://localhost/", {
      headers: { cookie: makePreviewCookieHeader({ draft: true }) },
    });

    const response = await handler(request, "/", null, null, null);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(PAGES_PREVIEW_CACHE_CONTROL);
    expect(setSSRContext).toHaveBeenCalledWith(
      expect.objectContaining({
        isPreview: true,
        nextData: expect.objectContaining({ isPreview: true }),
      }),
    );
  });

  it("clears both cookies when preview data is tampered on a preview-capable page", async () => {
    const handler = createPagesPageHandler(
      makeOpts({
        pageRoutes: [
          makeRoute("/", makePageModule({ getServerSideProps: async () => ({ props: {} }) })),
        ],
      }),
    );
    const cookie = makePreviewCookieHeader({ draft: true }).replace(
      /(__next_preview_data=)([^;])([^;]*)/,
      (_match, prefix: string, first: string, rest: string) =>
        `${prefix}${first === "a" ? "b" : "a"}${rest}`,
    );

    const response = await handler(
      new Request("http://localhost/", { headers: { cookie } }),
      "/",
      null,
      null,
      null,
    );

    expect(response.headers.getSetCookie()).toEqual([
      expect.stringMatching(/^__prerender_bypass=; Expires=/),
      expect.stringMatching(/^__next_preview_data=; Expires=/),
    ]);
  });

  it("preserves unrelated response cookies while clearing tampered preview cookies", async () => {
    const handler = createPagesPageHandler(
      makeOpts({
        pageRoutes: [
          makeRoute(
            "/",
            makePageModule({
              getServerSideProps: async ({
                res,
              }: {
                res: { setHeader(name: string, value: string | string[]): void };
              }) => {
                res.setHeader("Set-Cookie", [
                  "user-session=active; Path=/; HttpOnly",
                  "__prerender_bypass=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Path=/draft",
                ]);
                return { props: {} };
              },
            }),
          ),
        ],
      }),
    );
    const cookie = makePreviewCookieHeader({ draft: true }).replace(
      /(__next_preview_data=)([^;])([^;]*)/,
      (_match, prefix: string, first: string, rest: string) =>
        `${prefix}${first === "a" ? "b" : "a"}${rest}`,
    );

    const response = await handler(
      new Request("http://localhost/", { headers: { cookie } }),
      "/",
      null,
      null,
      null,
    );

    expect(response.headers.getSetCookie()).toEqual([
      "user-session=active; Path=/; HttpOnly",
      "__prerender_bypass=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Path=/draft",
      expect.stringMatching(/^__prerender_bypass=; Expires=/),
      expect.stringMatching(/^__next_preview_data=; Expires=/),
    ]);
  });

  it("clears tampered preview cookies once when notFound renders the 404 page", async () => {
    const pageRoute = makeRoute("/missing", {
      ...makePageModule(),
      getStaticProps: async () => ({ notFound: true }),
    });
    const notFoundRoute = makeRoute("/404");
    const handler = createPagesPageHandler(
      makeOpts({
        pageRoutes: [pageRoute, notFoundRoute],
        matchRoute: (url, routes) => {
          const pathname = url.split("?")[0];
          const route = routes.find((candidate) => candidate.pattern === pathname);
          return route ? { route, params: {} } : null;
        },
      }),
    );
    const cookie = makePreviewCookieHeader({ draft: true }).replace(
      /(__next_preview_data=)([^;])([^;]*)/,
      (_match, prefix: string, first: string, rest: string) =>
        `${prefix}${first === "a" ? "b" : "a"}${rest}`,
    );

    const response = await handler(
      new Request("http://localhost/missing", { headers: { cookie } }),
      "/missing",
      null,
      null,
      null,
    );

    expect(response.status).toBe(404);
    expect(response.headers.getSetCookie()).toEqual([
      expect.stringMatching(/^__prerender_bypass=; Expires=/),
      expect.stringMatching(/^__next_preview_data=; Expires=/),
    ]);
  });

  it.each(
    [false, true].flatMap((prerendered) => [false, true].map((gsp) => ({ prerendered, gsp }))),
  )(
    "preserves getServerSideProps notFound headers (prerendered: $prerendered, GSP: $gsp)",
    async ({ prerendered, gsp }) => {
      // Next.js keeps one ServerResponse while rendering the source and 404
      // pages, so headers set before `notFound: true` remain on the response.
      // https://github.com/vercel/next.js/blob/canary/packages/next/src/server/route-modules/pages/pages-handler.ts
      const pageRoute = makeRoute(
        "/missing",
        makePageModule({
          getServerSideProps: async ({
            res,
          }: {
            res: { setHeader(name: string, value: string | string[]): void };
          }) => {
            res.setHeader("Content-Length", "1");
            res.setHeader("Content-Type", "application/vnd.atlas.not-found+html");
            res.setHeader("Surrogate-Control", "max-age=600s, delta=noop");
            res.setHeader("Transfer-Encoding", "chunked");
            res.setHeader("Set-Cookie", ["session=expired; Path=/", "notice=missing; Path=/"]);
            return { notFound: true };
          },
        }),
      );
      const notFoundRoute = makeRoute(
        "/404",
        makePageModule(gsp ? { getStaticProps: () => ({ props: {} }) } : {}),
      );
      if (prerendered) {
        const adapter = Object.assign(new DefaultCdnCacheAdapter(), { hasPrerenderedPages: true });
        vi.spyOn(adapter, "get").mockResolvedValue({
          lastModified: 0,
          cacheControl: { revalidate: false },
          value: {
            kind: "PAGES",
            html: "prebuilt 404",
            pageData: {},
            status: 404,
            headers: undefined,
          },
        });
        setCdnCacheAdapter(adapter);
      }
      const handler = createPagesPageHandler(makeOpts({ pageRoutes: [pageRoute, notFoundRoute] }));

      const response = await handler(makeRequest("/missing"), "/missing", null, null, null);

      expect(response.status).toBe(404);
      expect(response.headers.get("content-length")).toBeNull();
      expect(response.headers.get("surrogate-control")).toBe("max-age=600s, delta=noop");
      expect(response.headers.get("content-type")).toBe("application/vnd.atlas.not-found+html");
      expect(response.headers.getSetCookie()).toEqual([
        "session=expired; Path=/",
        "notice=missing; Path=/",
      ]);
      expect(response.headers.get("transfer-encoding")).toBeNull();
    },
  );

  it.each([
    { gsp: false, stale: false },
    { gsp: true, stale: false },
    { gsp: true, stale: true },
  ])(
    "keeps cached notFound ETags consistent after source headers (GSP: $gsp, stale: $stale)",
    async ({ gsp, stale }) => {
      // Next.js overwrites the source ETag with the rendered payload's validator
      // before testing freshness, while retaining the existing response headers.
      // https://github.com/vercel/next.js/blob/canary/packages/next/src/server/send-payload.ts
      // Bot ETag coverage: test/e2e/streaming-ssr-edge/streaming-ssr-edge.test.ts
      const html = "prebuilt 404";
      const etag = generatePagesETag(html);
      const sourceEtag = '"source-page"';
      const adapter = Object.assign(new DefaultCdnCacheAdapter(), {
        hasPrerenderedPages: true,
        ownsBackgroundRevalidation: false,
      });
      vi.spyOn(adapter, "get").mockResolvedValue({
        lastModified: 0,
        cacheState: stale ? "stale" : "fresh",
        cacheControl: { revalidate: false },
        value: {
          kind: "PAGES",
          html,
          pageData: {},
          status: 404,
          headers: undefined,
        },
      });
      setCdnCacheAdapter(adapter);
      const handler = createPagesPageHandler(
        makeOpts({
          pageRoutes: [
            makeRoute(
              "/missing",
              makePageModule({
                getServerSideProps: ({
                  res,
                }: {
                  res: { setHeader(name: string, value: string): void };
                }) => {
                  res.setHeader("ETag", sourceEtag);
                  res.setHeader("Cache-Control", "private, no-store");
                  res.setHeader("Set-Cookie", "session=expired; Path=/");
                  res.setHeader("X-Source", "missing");
                  return { notFound: true };
                },
              }),
            ),
            makeRoute("/404", makePageModule(gsp ? { getStaticProps: () => ({ props: {} }) } : {})),
          ],
        }),
      );
      for (const [ifNoneMatch, requestCacheControl, status] of [
        [undefined, undefined, 404],
        [sourceEtag, undefined, 404],
        [etag, undefined, 304],
        [etag, "no-cache", 404],
      ] as const) {
        const headers = new Headers({ "User-Agent": "Googlebot" });
        if (ifNoneMatch) headers.set("If-None-Match", ifNoneMatch);
        if (requestCacheControl) headers.set("Cache-Control", requestCacheControl);
        const response = await handler(
          new Request("http://localhost/missing", { headers }),
          "/missing",
          null,
          null,
          null,
        );
        expect(response.status).toBe(status);
        expect(response.headers.get("etag")).toBe(etag);
        expect(response.headers.get("cache-control")).toBe("private, no-store");
        expect(response.headers.getSetCookie()).toEqual(["session=expired; Path=/"]);
        expect(response.headers.get("x-source")).toBe("missing");
        expect(await response.text()).toBe(status === 304 ? "" : html);
      }

      const unrelated = await handler(
        makeRequest("/other-missing"),
        "/other-missing",
        null,
        null,
        null,
      );
      expect(unrelated.status).toBe(404);
      expect(unrelated.headers.get("set-cookie")).toBeNull();
      expect(unrelated.headers.get("x-source")).toBeNull();
      expect(unrelated.headers.get("etag")).toBeNull();
    },
  );

  it.each([false, true])(
    "lets notFound headers replace source gSSP headers (res.end: %s)",
    async (endResponse) => {
      let appInitialPropsCalls = 0;
      const AppComponent = Object.assign(() => null, {
        getInitialProps({
          ctx,
        }: {
          ctx: {
            res: {
              setHeader(name: string, value: string | string[]): void;
              end(body: string): void;
            };
          };
        }) {
          appInitialPropsCalls += 1;
          ctx.res.setHeader("X-Response-Phase", `app-${appInitialPropsCalls}`);
          ctx.res.setHeader("Set-Cookie", [`app-${appInitialPropsCalls}=1; Path=/`]);
          if (endResponse && appInitialPropsCalls === 2) ctx.res.end("error handled");
          return { pageProps: {} };
        },
      });
      const pageRoute = makeRoute(
        "/missing",
        makePageModule({
          getServerSideProps: async ({
            res,
          }: {
            res: { setHeader(name: string, value: string | string[]): void };
          }) => {
            res.setHeader("X-Response-Phase", "source-gssp");
            res.setHeader("Set-Cookie", ["source-gssp=1; Path=/"]);
            return { notFound: true };
          },
        }),
      );
      const notFoundRoute = makeRoute("/404");
      const handler = createPagesPageHandler(
        makeOpts({ AppComponent, pageRoutes: [pageRoute, notFoundRoute] }),
      );

      const response = await handler(makeRequest("/missing"), "/missing", null, null, null);

      expect(response.status).toBe(404);
      expect(appInitialPropsCalls).toBe(2);
      expect(response.headers.get("x-response-phase")).toBe("app-2");
      expect(response.headers.getSetCookie()).toEqual(["app-2=1; Path=/"]);
      if (endResponse) expect(await response.text()).toBe("error handled");
    },
  );

  it("preserves adapter-unowned headers on preview responses", () => {
    setCdnCacheAdapter(new DefaultCdnCacheAdapter());
    const response = finalizePagesPreviewResponse(
      new Response("preview", {
        headers: {
          "Cache-Control": "s-maxage=6000",
          "X-Example-Edge-Policy": "s-maxage=6000",
          "X-Example-Cache-Tag": "draft-404",
        },
      }),
      { data: { draft: true }, shouldClear: false },
    );

    expect(response.headers.get("cache-control")).toBe(PAGES_PREVIEW_CACHE_CONTROL);
    expect(response.headers.get("x-example-edge-policy")).toBe("s-maxage=6000");
    expect(response.headers.get("x-example-cache-tag")).toBe("draft-404");
  });

  it("keeps invalid preview-cookie cleanup private", () => {
    setCdnCacheAdapter(new CloudflareCdnCacheAdapter());
    const response = finalizePagesPreviewResponse(
      new Response("stale preview", {
        headers: {
          "Cache-Control": "public, max-age=0, must-revalidate",
          "CDN-Cache-Control": "public, s-maxage=60",
        },
      }),
      { data: false, shouldClear: true },
    );

    expect(response.headers.get("cache-control")).toBe(PAGES_PREVIEW_CACHE_CONTROL);
    expect(response.headers.get("cdn-cache-control")).toBeNull();
    expect(response.headers.getSetCookie()).toHaveLength(2);
  });

  it("does not expose preview notFound responses to shared Cloudflare caching", async () => {
    setCdnCacheAdapter(new CloudflareCdnCacheAdapter());
    const pageRoute = makeRoute(
      "/missing",
      makePageModule({ getStaticProps: async () => ({ notFound: true, revalidate: 7 }) }),
    );
    const notFoundRoute = makeRoute(
      "/404",
      makePageModule({ getStaticProps: async () => ({ props: {}, revalidate: 6000 }) }),
    );
    const handler = createPagesPageHandler(makeOpts({ pageRoutes: [pageRoute, notFoundRoute] }));
    const request = new Request("http://localhost/missing", {
      headers: { cookie: makePreviewCookieHeader({ draft: true }) },
    });
    const middlewareHeaders = new Headers({
      "CDN-Cache-Control": "s-maxage=6000",
      "Cloudflare-CDN-Cache-Control": "s-maxage=6000",
      "Cache-Tag": "draft-404",
    });

    const response = await handler(request, "/missing", null, middlewareHeaders, null);

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe(PAGES_PREVIEW_CACHE_CONTROL);
    expect(response.headers.get("cdn-cache-control")).toBeNull();
    expect(response.headers.get("cloudflare-cdn-cache-control")).toBeNull();
    expect(response.headers.get("cache-tag")).toBeNull();
  });

  it("keeps nonce-bearing source notFound HTML out of shared caches", async () => {
    const pageRoute = makeRoute(
      "/missing",
      makePageModule({ getStaticProps: async () => ({ notFound: true, revalidate: 7 }) }),
    );
    const notFoundRoute = makeRoute(
      "/404",
      makePageModule({ getStaticProps: async () => ({ props: {}, revalidate: 6000 }) }),
    );
    const handler = createPagesPageHandler(makeOpts({ pageRoutes: [pageRoute, notFoundRoute] }));
    const request = new Request("http://localhost/missing", {
      headers: { "content-security-policy": "script-src 'nonce-test-nonce'" },
    });

    const response = await handler(request, "/missing", null, null, null);

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store, must-revalidate");
    expect(response.headers.get("cache-control")).not.toContain("s-maxage");
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

describe("createPagesPageHandler — stale ISR regeneration", () => {
  function serveStaleEntry() {
    const adapter = new DefaultCdnCacheAdapter();
    vi.spyOn(adapter, "get").mockResolvedValue({
      lastModified: 0,
      cacheState: "stale",
      cacheControl: { revalidate: 1 },
      value: {
        kind: "PAGES",
        html: '<html><head></head><body><div id="__next"><p>stale</p></div></body></html>',
        pageData: { pageProps: { value: "stale" } },
        status: 200,
        headers: undefined,
      },
    });
    const set = vi.spyOn(adapter, "set").mockResolvedValue();
    setCdnCacheAdapter(adapter);
    // Earlier tests' scheduled writes can land on this adapter, so only look
    // at this page's key.
    return () => set.mock.calls.filter(([key]) => key === pagesIsrCacheKey("/", "test-build-id"));
  }

  function makeStaticPage(page: (props: Record<string, unknown>) => React.ReactNode) {
    return makeOpts({
      pageRoutes: [
        makeRoute(
          "/",
          makePageModule({
            getStaticProps: async () => ({ props: { value: "fresh" }, revalidate: 1 }),
          }),
        ),
      ],
      renderToReadableStream,
      createPageElement: (_Page, _App, props) => page(props),
      enhancePageElement: (_Page, _App, props) => page(props),
    });
  }

  it("regenerates the whole document instead of patching the cached shell", async () => {
    // Next.js re-runs its full render on regeneration, `_document` included.
    const pageWrites = serveStaleEntry();

    let documentRenders = 0;
    const DocumentComponent = Object.assign(
      ({ docValue }: { docValue: string }) =>
        React.createElement(
          "html",
          null,
          React.createElement(
            "head",
            null,
            React.createElement("meta", { name: "doc", content: docValue }),
          ),
          React.createElement(
            "body",
            null,
            React.createElement(Main),
            React.createElement(NextScript),
          ),
        ),
      {
        async getInitialProps(ctx: {
          defaultGetInitialProps: (ctx: unknown) => Promise<Record<string, unknown>>;
        }) {
          documentRenders += 1;
          return { ...(await ctx.defaultGetInitialProps(ctx)), docValue: `doc-${documentRenders}` };
        },
      },
    );
    const handler = createPagesPageHandler({
      ...makeStaticPage((props) =>
        React.createElement("p", null, String((props.pageProps as { value: string }).value)),
      ),
      DocumentComponent:
        DocumentComponent as unknown as CreatePagesPageHandlerOptions["DocumentComponent"],
    });

    const response = await handler(makeRequest(), "/", null, null, null);
    expect(response.headers.get("x-vinext-cache")).toBe("STALE");
    expect(await response.text()).toContain("<p>stale</p>");

    await vi.waitFor(() => expect(pageWrites()).toHaveLength(1));
    const [, entry, context] = pageWrites()[0] ?? [];
    expect(context).toMatchObject({ cacheControl: { revalidate: 1 } });
    if (entry?.kind !== "PAGES") throw new Error("expected a PAGES entry");
    expect(documentRenders).toBe(1);
    expect(entry.pageData).toEqual({ pageProps: { value: "fresh" } });
    expect(entry.status).toBe(200);
    expect(entry.html).toContain('<meta name="doc" content="doc-1"/>');
    expect(entry.html).toContain('<div id="__next"><p>fresh</p></div>');
    expect(entry.html).toContain('"props":{"pageProps":{"value":"fresh"}}');
    expect(entry.html).not.toContain("stale");
  });

  it("waits for every Suspense boundary before storing a regeneration", async () => {
    // Next.js renders a regeneration with `allReady` resolved. React flushes
    // late boundaries inline here either way, so hold `allReady` directly.
    const pageWrites = serveStaleEntry();
    let releaseAllReady: (() => void) | undefined;
    const allReady = new Promise<void>((resolve) => {
      releaseAllReady = resolve;
    });
    const handler = createPagesPageHandler({
      ...makeStaticPage(() => null),
      async renderToReadableStream() {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("<p>fresh</p>"));
            controller.close();
          },
        });
        return Object.assign(stream, { allReady });
      },
    });

    const response = await handler(makeRequest(), "/", null, null, null);
    expect(response.headers.get("x-vinext-cache")).toBe("STALE");
    await response.text();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(pageWrites()).toHaveLength(0);

    releaseAllReady?.();
    await vi.waitFor(() => expect(pageWrites()).toHaveLength(1));
  });

  it("renders the document shell with every Suspense boundary resolved too", async () => {
    const pageWrites = serveStaleEntry();
    const releases: Array<() => void> = [];
    const DocumentComponent = () =>
      React.createElement(
        "html",
        null,
        React.createElement("body", null, React.createElement(Main)),
      );
    const handler = createPagesPageHandler({
      ...makeStaticPage(() => React.createElement("p", null, "fresh")),
      DocumentComponent:
        DocumentComponent as unknown as CreatePagesPageHandlerOptions["DocumentComponent"],
      async renderToReadableStream(element) {
        const stream = await renderToReadableStream(element);
        const allReady = new Promise<void>((resolve) => releases.push(resolve));
        return Object.assign(stream, { allReady });
      },
    });

    const response = await handler(makeRequest(), "/", null, null, null);
    expect(response.headers.get("x-vinext-cache")).toBe("STALE");
    await response.text();

    // The page body renders first, then the `_document` shell.
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    releases[0]?.();
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(pageWrites()).toHaveLength(0);

    releases[1]?.();
    await vi.waitFor(() => expect(pageWrites()).toHaveLength(1));
  });

  it("keeps the route status when `_document` changes the response status", async () => {
    // Next.js stores no status for a Pages entry, so a status `_document` set
    // on its res never replays from the cache.
    const pageWrites = serveStaleEntry();
    const DocumentComponent = Object.assign(
      () =>
        React.createElement(
          "html",
          null,
          React.createElement("body", null, React.createElement(Main)),
        ),
      {
        async getInitialProps(ctx: {
          res: { statusCode: number };
          defaultGetInitialProps: (ctx: unknown) => Promise<Record<string, unknown>>;
        }) {
          ctx.res.statusCode = 404;
          return ctx.defaultGetInitialProps(ctx);
        },
      },
    );
    const handler = createPagesPageHandler({
      ...makeStaticPage(() => React.createElement("p", null, "fresh")),
      DocumentComponent:
        DocumentComponent as unknown as CreatePagesPageHandlerOptions["DocumentComponent"],
    });

    const response = await handler(makeRequest(), "/", null, null, null);
    expect(response.headers.get("x-vinext-cache")).toBe("STALE");
    await response.text();

    await vi.waitFor(() => expect(pageWrites()).toHaveLength(1));
    const [, entry] = pageWrites()[0] ?? [];
    if (entry?.kind !== "PAGES") throw new Error("expected a PAGES entry");
    expect(entry.status).toBe(200);
    expect(entry.html).toContain('<div id="__next"><p>fresh</p></div>');
  });

  it("still stores the regeneration when `_document` ends the response", async () => {
    // Next.js ignores a response sent from `_document` for getStaticProps pages.
    const pageWrites = serveStaleEntry();
    const DocumentComponent = Object.assign(
      () =>
        React.createElement(
          "html",
          null,
          React.createElement("body", null, React.createElement(Main)),
        ),
      {
        async getInitialProps(ctx: {
          res: { end: (body?: string) => void };
          defaultGetInitialProps: (ctx: unknown) => Promise<Record<string, unknown>>;
        }) {
          const props = await ctx.defaultGetInitialProps(ctx);
          ctx.res.end("ended by document");
          return props;
        },
      },
    );
    const handler = createPagesPageHandler({
      ...makeStaticPage(() => React.createElement("p", null, "fresh")),
      DocumentComponent:
        DocumentComponent as unknown as CreatePagesPageHandlerOptions["DocumentComponent"],
    });

    const response = await handler(makeRequest(), "/", null, null, null);
    expect(response.headers.get("x-vinext-cache")).toBe("STALE");
    await response.text();

    await vi.waitFor(() => expect(pageWrites()).toHaveLength(1));
    const [, entry] = pageWrites()[0] ?? [];
    if (entry?.kind !== "PAGES") throw new Error("expected a PAGES entry");
    expect(entry.html).toContain('<div id="__next"><p>fresh</p></div>');
    expect(entry.html).not.toContain("ended by document");
  });

  it("reports a failed regeneration without writing the entry", async () => {
    const pageWrites = serveStaleEntry();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const DocumentComponent = Object.assign(() => null, {
      async getInitialProps() {
        throw new Error("document failed");
      },
    });
    const handler = createPagesPageHandler({
      ...makeStaticPage(() => React.createElement("p", null, "fresh")),
      DocumentComponent:
        DocumentComponent as unknown as CreatePagesPageHandlerOptions["DocumentComponent"],
    });

    try {
      const response = await handler(makeRequest(), "/", null, null, null);
      expect(response.headers.get("x-vinext-cache")).toBe("STALE");
      await vi.waitFor(() =>
        expect(consoleError).toHaveBeenCalledWith(
          expect.stringContaining("ISR background regeneration failed"),
          expect.objectContaining({ message: "document failed" }),
        ),
      );
      expect(pageWrites()).toHaveLength(0);
    } finally {
      consoleError.mockRestore();
    }
  });
});

describe("createPagesPageHandler — getStaticProps page whose response was sent", () => {
  // Next.js ignores a sent response for getStaticProps pages (`isResSent(res)
  // && !isSSG` in render.tsx): it still renders and stores the entry, and the
  // visitor gets the sent response.
  function serveEntry(cacheState: "miss" | "stale") {
    const adapter = new DefaultCdnCacheAdapter();
    vi.spyOn(adapter, "get").mockResolvedValue(
      cacheState === "miss"
        ? null
        : {
            lastModified: 0,
            cacheState: "stale",
            cacheControl: { revalidate: 1 },
            value: {
              kind: "PAGES",
              html: '<html><head></head><body><div id="__next"><p>stale</p></div></body></html>',
              pageData: { pageProps: { value: "stale" } },
              status: 200,
              headers: undefined,
            },
          },
    );
    const set = vi.spyOn(adapter, "set").mockResolvedValue();
    setCdnCacheAdapter(adapter);
    return () => set.mock.calls.filter(([key]) => key === pagesIsrCacheKey("/", "test-build-id"));
  }

  type SendingContext = {
    res: { writeHead: (status: number, headers: Record<string, string>) => void; end: () => void };
  };
  function sendLoginRedirect(res: SendingContext["res"]) {
    res.writeHead(302, { Location: "/login" });
    res.end();
  }

  function makeHandler(
    sender: "_app" | "_document",
    overrides: Partial<Pick<CreatePagesPageHandlerOptions, "renderToReadableStream">> & {
      getStaticProps?: () => Promise<Record<string, unknown>>;
    } = {},
  ) {
    const page = (props: Record<string, unknown>) =>
      React.createElement("p", null, String((props.pageProps as { value: string }).value));
    return createPagesPageHandler({
      ...makeOpts({
        pageRoutes: [
          makeRoute(
            "/",
            makePageModule({
              getStaticProps:
                overrides.getStaticProps ??
                (async () => ({ props: { value: "fresh" }, revalidate: 1 })),
            }),
          ),
        ],
        renderToReadableStream: overrides.renderToReadableStream ?? renderToReadableStream,
        createPageElement: (_Page, _App, props) => page(props),
        enhancePageElement: (_Page, _App, props) => page(props),
      }),
      AppComponent: Object.assign(() => null, {
        async getInitialProps({ ctx }: { ctx: SendingContext }) {
          if (sender === "_app") sendLoginRedirect(ctx.res);
          return { pageProps: {} };
        },
      }) as unknown as CreatePagesPageHandlerOptions["AppComponent"],
      DocumentComponent: Object.assign(
        () =>
          React.createElement(
            "html",
            null,
            React.createElement("body", null, React.createElement(Main)),
          ),
        {
          async getInitialProps(
            ctx: SendingContext & {
              defaultGetInitialProps: (ctx: unknown) => Promise<Record<string, unknown>>;
            },
          ) {
            const props = await ctx.defaultGetInitialProps(ctx);
            if (sender === "_document") sendLoginRedirect(ctx.res);
            return props;
          },
        },
      ) as unknown as CreatePagesPageHandlerOptions["DocumentComponent"],
    });
  }

  it.each(["_app", "_document"] as const)(
    "stores a MISS render and returns the response %s sent",
    async (sender) => {
      const pageWrites = serveEntry("miss");

      const response = await makeHandler(sender)(makeRequest(), "/", null, null, null);
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/login");

      await vi.waitFor(() => expect(pageWrites()).toHaveLength(1));
      const [, entry] = pageWrites()[0] ?? [];
      if (entry?.kind !== "PAGES") throw new Error("expected a PAGES entry");
      expect(entry.html).toContain('<div id="__next"><p>fresh</p></div>');
      // Next.js stores no status for a Pages entry, so the sent 302 never
      // replays from the cache.
      expect(entry.status).toBe(200);
    },
  );

  it("returns the sent response without waiting for the rest of the render", async () => {
    const pageWrites = serveEntry("miss");
    let releaseBody: (() => void) | undefined;
    let renders = 0;
    const handler = makeHandler("_app", {
      async renderToReadableStream(element) {
        const stream = await renderToReadableStream(element);
        renders += 1;
        // Hold the page body open; the `_document` shell renders normally.
        if (renders > 1) return stream;
        const held = new Promise<void>((resolve) => {
          releaseBody = resolve;
        });
        return stream.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            async flush() {
              await held;
            },
          }),
        );
      },
    });

    const response = await handler(makeRequest(), "/", null, null, null);
    expect(response.status).toBe(302);
    await vi.waitFor(() => expect(releaseBody).toBeDefined());
    expect(pageWrites()).toHaveLength(0);

    releaseBody?.();
    await vi.waitFor(() => expect(pageWrites()).toHaveLength(1));
  });

  it("returns the sent response while getStaticProps is still running", async () => {
    const pageWrites = serveEntry("miss");
    let releaseProps: (() => void) | undefined;
    const handler = makeHandler("_app", {
      async getStaticProps() {
        await new Promise<void>((resolve) => {
          releaseProps = resolve;
        });
        return { props: { value: "fresh" }, revalidate: 1 };
      },
    });

    const response = await handler(makeRequest(), "/", null, null, null);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/login");
    expect(pageWrites()).toHaveLength(0);

    releaseProps?.();
    await vi.waitFor(() => expect(pageWrites()).toHaveLength(1));
  });

  it("runs after() callbacks once the sent response closes", async () => {
    const pageWrites = serveEntry("miss");
    let callbackRan = false;
    let releaseProps: (() => void) | undefined;
    const handler = makeHandler("_app", {
      async getStaticProps() {
        after(() => {
          callbackRan = true;
        });
        await new Promise<void>((resolve) => {
          releaseProps = resolve;
        });
        return { props: { value: "fresh" }, revalidate: 1 };
      },
    });

    const response = await handler(makeRequest(), "/", null, null, null);
    expect(response.status).toBe(302);
    expect(callbackRan).toBe(false);

    // `getStaticProps` is still pending, but the visitor's response is done.
    await response.text();
    await vi.waitFor(() => expect(callbackRan).toBe(true));
    releaseProps?.();
    await vi.waitFor(() => expect(pageWrites()).toHaveLength(1));
  });

  it("keeps the sent response out of the shared response cache", async () => {
    const pageWrites = serveEntry("miss");
    const state: RouteCacheabilityState = { captureDeadlineAt: Date.now() + 1_000, mode: "admit" };
    const background: Promise<unknown>[] = [];
    const context = {
      waitUntil(promise: Promise<unknown>) {
        background.push(promise);
      },
    };
    Reflect.set(context, CACHEABILITY_REQUEST_STATE, state);

    const response = await runWithExecutionContext(context, () =>
      makeHandler("_app")(makeRequest(), "/", null, null, null),
    );
    expect(response.status).toBe(302);
    expect(state.finalResponseVetoReason).toBeDefined();

    // The ISR entry itself is still stored.
    await Promise.all(background);
    await vi.waitFor(() => expect(pageWrites()).toHaveLength(1));
  });

  it("reports an on-demand revalidation as regenerated", async () => {
    const pageWrites = serveEntry("miss");
    const request = new Request("http://localhost/", {
      headers: { [PRERENDER_REVALIDATE_HEADER]: getRevalidateSecret() },
    });

    const response = await makeHandler("_app")(request, "/", null, null, null);
    expect(response.headers.get("x-nextjs-cache")).toBe("REVALIDATED");
    expect(response.headers.get(VINEXT_REVALIDATED_CACHE_TAG_HEADER)).toBe(
      encodeURIComponent("_N_T_/"),
    );
    expect(pageWrites()).toHaveLength(1);
  });

  it("keeps the sent response when the page fails afterwards", async () => {
    serveEntry("miss");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await makeHandler("_app", {
        async getStaticProps() {
          throw new Error("getStaticProps failed");
        },
      })(makeRequest(), "/", null, null, null);
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/login");
      await vi.waitFor(() =>
        expect(consoleError).toHaveBeenCalledWith(
          "[vinext] SSR error:",
          expect.objectContaining({ message: "getStaticProps failed" }),
        ),
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it.each(["_app", "_document"] as const)(
    "stores a stale regeneration when %s sends the response",
    async (sender) => {
      const pageWrites = serveEntry("stale");

      const response = await makeHandler(sender)(makeRequest(), "/", null, null, null);
      expect(response.headers.get("x-vinext-cache")).toBe("STALE");
      expect(await response.text()).toContain("<p>stale</p>");

      await vi.waitFor(() => expect(pageWrites()).toHaveLength(1));
      const [, entry] = pageWrites()[0] ?? [];
      if (entry?.kind !== "PAGES") throw new Error("expected a PAGES entry");
      expect(entry.html).toContain('<div id="__next"><p>fresh</p></div>');
    },
  );
});

describe("createPagesPageHandler — i18n ISR identity", () => {
  it("ignores old domain-only entries even when the build ID is unchanged", async () => {
    setCdnCacheAdapter(new DefaultCdnCacheAdapter());
    await isrSet(
      isrCacheKey(
        "pages",
        "/about::i18n=" + encodeURIComponent("domain:example.com"),
        "test-build-id",
      ),
      {
        kind: "PAGES",
        html: "old domain-only HTML",
        pageData: { locale: "fr" },
        headers: undefined,
        status: 200,
      },
      { cacheControl: { revalidate: 3600 } },
    );
    const handler = createPagesPageHandler(
      makeOpts({
        i18nConfig: {
          locales: ["en", "fr"],
          defaultLocale: "en",
          domains: [{ domain: "example.com", defaultLocale: "en" }],
        },
        pageRoutes: [
          makeRoute(
            "/about",
            makePageModule({
              getStaticProps: ({ locale }: { locale: string }) => ({
                props: { locale },
                revalidate: 3600,
              }),
            }),
          ),
        ],
      }),
    );
    const response = await handler(new Request("http://example.com/about"), "/about", null, null, {
      isDataReq: true,
    });
    expect(response.headers.get("x-vinext-cache")).not.toBe("HIT");
    expect(await response.json()).toMatchObject({ pageProps: { locale: "en" } });
  });
});

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
    let finishReporting!: () => void;
    const reportingFinished = new Promise<void>((resolve) => {
      finishReporting = resolve;
    });
    const onRequestError = vi.fn(() => reportingFinished);
    globalThis.__VINEXT_onRequestErrorHandler__ = onRequestError;
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
    let responseSettled = false;
    const responsePromise = handler(makeRequest("/_error"), "/_error", null, null, {
      __isInternalErrorRender: true,
      __forcedRoute: errorRoute,
    }).then((response) => {
      responseSettled = true;
      return response;
    });

    try {
      // Ported from Next.js: packages/next/src/server/route-modules/pages/pages-handler.ts
      // https://github.com/vercel/next.js/blob/canary/packages/next/src/server/route-modules/pages/pages-handler.ts
      await vi.waitFor(() => expect(onRequestError).toHaveBeenCalledOnce());
      expect(responseSettled).toBe(false);
      finishReporting();
      const res = await responsePromise;
      expect(res.status).toBe(500);
      await expect(res.text()).resolves.toBe("Internal Server Error");
    } finally {
      delete globalThis.__VINEXT_onRequestErrorHandler__;
    }
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

  it("strips the active locale prefix from the initial asPath", async () => {
    // Ported from Next.js:
    // test/e2e/i18n-support-fallback-rewrite/i18n-support-fallback-rewrite.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/i18n-support-fallback-rewrite/i18n-support-fallback-rewrite.test.ts
    const setSSRContext = vi.fn();
    const routes = [makeRoute("/about")];
    const handler = createPagesPageHandler(
      makeOpts({
        pageRoutes: routes,
        i18nConfig: {
          locales: ["en", "fr"],
          defaultLocale: "en",
        },
        setSSRContext,
        matchRoute: (url, routeList) => {
          const route = routeList.find((item) => item.pattern === url.split("?")[0]);
          return route ? { route, params: {} } : null;
        },
      }),
    );

    await handler(makeRequest("/en/about?hello=world"), "/en/about?hello=world", null, null, {
      asPath: "/en/about?hello=world",
    });

    const ctx = setSSRContext.mock.calls.find((call) => call[0] !== null)?.[0] as
      | { asPath?: string }
      | undefined;
    expect(ctx?.asPath).toBe("/about?hello=world");
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
