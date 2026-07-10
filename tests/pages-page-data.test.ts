import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  renderPagesIsrHtml,
  resolvePagesPageData,
  type ResolvePagesPageDataOptions,
} from "../packages/vinext/src/server/pages-page-data.js";

function createOptions(
  overrides: Partial<ResolvePagesPageDataOptions> = {},
): ResolvePagesPageDataOptions {
  return {
    applyRequestContexts: vi.fn(),
    buildId: "build-123",
    createGsspReqRes() {
      return {
        req: {},
        res: {
          headersSent: false,
          statusCode: 200,
          getHeaders() {
            return {};
          },
        },
        responsePromise: Promise.resolve(new Response("short-circuit", { status: 202 })),
      };
    },
    createPageElement(_pageProps: Record<string, unknown>) {
      return "page";
    },
    fontLinkHeader: "</font.woff2>; rel=preload; as=font; type=font/woff2; crossorigin",
    i18n: {
      locale: "en",
      locales: ["en", "fr"],
      defaultLocale: "en",
      domainLocales: [{ domain: "example.com", defaultLocale: "en", locales: ["en"] }],
    },
    isrCacheKey(_router: string, pathname: string) {
      return `pages:${pathname}`;
    },
    isrGet: vi.fn().mockResolvedValue(null),
    isrSet: vi.fn(async () => {}),
    expireSeconds: 300,
    pageModule: {},
    params: { slug: "post" },
    query: { slug: "post" },
    renderIsrPassToStringAsync: vi.fn(async () => "<div>fresh-body</div>"),
    route: { isDynamic: false },
    routePattern: "/posts/[slug]",
    routeUrl: "/posts/post",
    async runInFreshUnifiedContext<T>(callback: () => Promise<T>): Promise<T> {
      return callback();
    },
    safeJsonStringify(value: unknown) {
      return JSON.stringify(value);
    },
    sanitizeDestination(destination: string) {
      return destination;
    },
    triggerBackgroundRegeneration: vi.fn(),
    ...overrides,
  };
}

describe("pages page data", () => {
  it("preserves non-object pageProps returned by custom app getInitialProps", async () => {
    const result = await resolvePagesPageData(
      createOptions({
        AppComponent: Object.assign(function App() {}, {
          getInitialProps() {
            return { appValue: "preserved", pageProps: null };
          },
        }),
      }),
    );

    expect(result).toMatchObject({
      kind: "render",
      pageProps: {},
      props: { appValue: "preserved", pageProps: null },
    });
  });

  it("renders fresh ISR HTML while preserving custom document gaps and tail scripts", async () => {
    const html = await renderPagesIsrHtml({
      buildId: "build-123",
      cachedHtml:
        '<!DOCTYPE html><html><head><title>cached</title></head><body><div id="__next"><div>stale-body</div></div><aside data-gap="1"></aside><script>window.__NEXT_DATA__ = {"old":1}</script><script src="/tail.js"></script></body></html>',
      createPageElement(_pageProps: Record<string, unknown>) {
        return "page";
      },
      i18n: {
        locale: "en",
        locales: ["en", "fr"],
        defaultLocale: "en",
        domainLocales: [{ domain: "example.com", defaultLocale: "en", locales: ["en"] }],
      },
      pageProps: { title: "fresh" },
      params: { slug: "post" },
      renderIsrPassToStringAsync: vi.fn(async () => "<div>fresh-body</div>"),
      routePattern: "/posts/[slug]",
      safeJsonStringify(value: unknown) {
        return JSON.stringify(value);
      },
      vinext: { hasMiddleware: true },
    });

    expect(html).toContain("<div>fresh-body</div>");
    expect(html).toContain('<aside data-gap="1"></aside>');
    expect(html).toContain('<script src="/tail.js"></script>');
    expect(html).toContain('"page":"/posts/[slug]"');
    expect(html).toContain('"slug":"post"');
    expect(html).toContain('"__vinext":{"hasMiddleware":true}');
  });

  it("preserves custom app props in fallback shells", async () => {
    const AppComponent = Object.assign(function App() {}, {
      getInitialProps() {
        return { appValue: "preserved", pageProps: { discarded: true } };
      },
    });
    const result = await resolvePagesPageData(
      createOptions({
        AppComponent,
        pageModule: {
          default: function Page() {},
          getStaticPaths() {
            return { fallback: true, paths: [] };
          },
        },
        route: { isDynamic: true },
      }),
    );

    expect(result).toMatchObject({
      kind: "render",
      isFallback: true,
      pageProps: {},
      props: { appValue: "preserved", pageProps: {} },
    });
  });

  it("preserves custom app props during stale ISR regeneration", async () => {
    const isrSet = vi.fn(async () => {});
    const createPageElement = vi.fn(() => "page");
    let requestContextsApplied = false;
    let appGetInitialPropsCalls = 0;
    let regenerationPromise: Promise<void> | undefined;
    const result = await resolvePagesPageData(
      createOptions({
        AppComponent: Object.assign(function App() {}, {
          getInitialProps() {
            appGetInitialPropsCalls += 1;
            if (appGetInitialPropsCalls > 1) {
              expect(requestContextsApplied).toBe(true);
            }
            return { appValue: "fresh-app", pageProps: { fromApp: true } };
          },
        }),
        applyRequestContexts() {
          requestContextsApplied = true;
        },
        createPageElement,
        isrGet: vi.fn().mockResolvedValue({
          isStale: true,
          value: {
            cacheControl: { revalidate: 1, expire: undefined },
            value: {
              kind: "PAGES",
              html: '<div id="__next">stale</div><script>window.__NEXT_DATA__ = {}</script>',
              pageData: {},
            },
          },
        }),
        isrSet,
        pageModule: {
          default: function Page() {},
          getStaticProps() {
            expect(requestContextsApplied).toBe(true);
            return { props: { fromStatic: true }, revalidate: 10 };
          },
        },
        triggerBackgroundRegeneration: vi.fn((_key, callback) => {
          regenerationPromise = callback();
        }),
      }),
    );

    expect(result.kind).toBe("response");
    await regenerationPromise;
    expect(createPageElement).toHaveBeenCalledWith({
      appValue: "fresh-app",
      pageProps: { fromApp: true, fromStatic: true },
    });
    expect(isrSet).toHaveBeenCalledWith(
      "pages:/posts/post",
      expect.objectContaining({
        pageData: {
          appValue: "fresh-app",
          pageProps: { fromApp: true, fromStatic: true },
        },
      }),
      10,
      undefined,
      300,
    );
  });

  it("returns a notFound signal when getStaticPaths excludes a dynamic HTML path", async () => {
    const result = await resolvePagesPageData(
      createOptions({
        pageModule: {
          async getStaticPaths() {
            return {
              fallback: false,
              paths: [{ params: { slug: "hello-world" } }],
            };
          },
        },
        params: { slug: "missing" },
        query: { slug: "missing" },
        route: { isDynamic: true },
        routeUrl: "/posts/missing",
      }),
    );

    expect(result).toEqual({ kind: "notFound" });
  });

  it("renders unlisted fallback false paths in preview mode without caching them", async () => {
    const isrSet = vi.fn(async () => {});
    const result = await resolvePagesPageData(
      createOptions({
        isrSet,
        pageModule: {
          async getStaticPaths() {
            return {
              fallback: false,
              paths: [{ params: { slug: "known" } }],
            };
          },
          async getStaticProps(context) {
            return {
              props: {
                preview: context.preview,
                previewData: context.previewData,
                slug: context.params?.slug,
              },
            };
          },
        },
        params: { slug: "missing" },
        previewData: {},
        query: { slug: "missing" },
        route: { isDynamic: true },
        routeUrl: "/posts/missing",
      }),
    );

    expect(result).toMatchObject({
      kind: "render",
      isFallback: false,
      pageProps: { preview: true, previewData: {}, slug: "missing" },
    });
    expect(isrSet).not.toHaveBeenCalled();
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["false", false],
    ["empty array", []],
  ])("accepts optional catch-all %s at the route root", async (_label, slug) => {
    const result = await resolvePagesPageData(
      createOptions({
        pageModule: {
          async getStaticPaths() {
            return {
              fallback: false,
              paths: [{ params: { slug } }],
            };
          },
          async getStaticProps() {
            return { props: { slug: [] } };
          },
        },
        params: {},
        query: {},
        route: { isDynamic: true },
        routePattern: "/catchall-optional/[[...slug]]",
        routeUrl: "/catchall-optional",
      }),
    );

    expect(result).toMatchObject({
      kind: "render",
      pageProps: { slug: [] },
    });
  });

  it("requires every dynamic key for mixed required and optional catch-all routes", async () => {
    const result = await resolvePagesPageData(
      createOptions({
        pageModule: {
          async getStaticPaths() {
            return {
              fallback: false,
              paths: [{ params: { slug: [] } }],
            };
          },
        },
        params: { category: "guides" },
        query: { category: "guides" },
        route: { isDynamic: true },
        routePattern: "/[category]/[[...slug]]",
        routeUrl: "/guides",
      }),
    );

    expect(result).toEqual({ kind: "notFound" });
  });

  it("accepts mixed required and empty optional catch-all params", async () => {
    const result = await resolvePagesPageData(
      createOptions({
        pageModule: {
          async getStaticPaths() {
            return {
              fallback: false,
              paths: [{ params: { category: "guides", slug: false } }],
            };
          },
          async getStaticProps() {
            return { props: { category: "guides", slug: [] } };
          },
        },
        params: { category: "guides" },
        query: { category: "guides" },
        route: { isDynamic: true },
        routePattern: "/[category]/[[...slug]]",
        routeUrl: "/guides",
      }),
    );

    expect(result).toMatchObject({
      kind: "render",
      pageProps: { category: "guides", slug: [] },
    });
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["false", false],
    ["empty array", []],
  ])("rejects required catch-all %s", async (_label, slug) => {
    const result = await resolvePagesPageData(
      createOptions({
        pageModule: {
          async getStaticPaths() {
            return {
              fallback: false,
              paths: [{ params: { slug } }],
            };
          },
        },
        params: { slug: ["guide"] },
        query: { slug: ["guide"] },
        route: { isDynamic: true },
        routePattern: "/docs/[...slug]",
        routeUrl: "/docs/guide",
      }),
    );

    expect(result).toEqual({ kind: "notFound" });
  });

  it("runs page getInitialProps with the original request URL and asPath", async () => {
    const result = await resolvePagesPageData(
      createOptions({
        asPath: "/3",
        createGsspReqRes() {
          return {
            req: { url: "/3" },
            res: {
              headersSent: false,
              statusCode: 200,
              getHeaders() {
                return {};
              },
            },
            responsePromise: Promise.resolve(new Response("short-circuit", { status: 202 })),
          };
        },
        pageModule: {
          default: Object.assign(
            function Page() {
              return null;
            },
            {
              getInitialProps(context: { req?: { url?: string }; asPath?: string }) {
                return {
                  reqUrl: context.req?.url,
                  asPath: context.asPath,
                };
              },
            },
          ),
        },
        routePattern: "/_error",
        routeUrl: "/3",
      }),
    );

    expect(result).toMatchObject({
      kind: "render",
      pageProps: { reqUrl: "/3", asPath: "/3" },
    });
  });

  it("preserves getInitialProps this binding via component receiver", async () => {
    const Page = Object.assign(
      function Page() {
        return null;
      },
      {
        value: "ok",
        getInitialProps(this: { value: string }) {
          return { value: this.value };
        },
      },
    );

    const result = await resolvePagesPageData(
      createOptions({
        createGsspReqRes() {
          return {
            req: {},
            res: {
              headersSent: false,
              statusCode: 200,
              getHeaders() {
                return {};
              },
            },
            responsePromise: Promise.resolve(new Response("short-circuit", { status: 202 })),
          };
        },
        pageModule: {
          default: Page,
        },
      }),
    );

    expect(result).toMatchObject({
      kind: "render",
      pageProps: { value: "ok" },
    });
  });

  it("returns a notFound signal when getServerSideProps returns notFound", async () => {
    const result = await resolvePagesPageData(
      createOptions({
        pageModule: {
          async getServerSideProps() {
            return { notFound: true };
          },
        },
      }),
    );

    expect(result).toEqual({ kind: "notFound" });
  });

  it("returns JSON 404 envelope for data requests when getStaticPaths excludes a path", async () => {
    const result = await resolvePagesPageData(
      createOptions({
        isDataReq: true,
        pageModule: {
          async getStaticPaths() {
            return {
              fallback: false,
              paths: [{ params: { slug: "hello-world" } }],
            };
          },
        },
        params: { slug: "missing" },
        query: { slug: "missing" },
        route: { isDynamic: true },
        routeUrl: "/posts/missing",
      }),
    );

    expect(result.kind).toBe("response");
    if (result.kind !== "response") {
      throw new Error("expected response result");
    }
    expect(result.response.status).toBe(404);
    expect(result.response.headers.get("content-type")).toBe("application/json");
    await expect(result.response.text()).resolves.toBe("{}");
  });

  it("returns JSON 404 envelope for data requests when getStaticProps returns notFound", async () => {
    const result = await resolvePagesPageData(
      createOptions({
        isDataReq: true,
        pageModule: {
          async getStaticProps() {
            return { notFound: true };
          },
        },
      }),
    );

    expect(result.kind).toBe("response");
    if (result.kind !== "response") {
      throw new Error("expected response result");
    }
    expect(result.response.status).toBe(404);
    expect(result.response.headers.get("content-type")).toBe("application/json");
    await expect(result.response.text()).resolves.toBe("{}");
  });

  it("returns JSON 404 envelope for data requests when getServerSideProps returns notFound", async () => {
    const result = await resolvePagesPageData(
      createOptions({
        isDataReq: true,
        pageModule: {
          async getServerSideProps() {
            return { notFound: true };
          },
        },
      }),
    );

    expect(result.kind).toBe("response");
    if (result.kind !== "response") {
      throw new Error("expected response result");
    }
    expect(result.response.status).toBe(404);
    expect(result.response.headers.get("content-type")).toBe("application/json");
    await expect(result.response.text()).resolves.toBe("{}");
  });

  // Refs #1543: a crawler/bot UA hitting an unlisted `fallback: true` path
  // must NOT receive the loading shell — it should render synchronously so
  // the bot indexes real content. Mirrors Next.js's bot check in
  // `.nextjs-ref/packages/next/src/server/route-modules/pages/pages-handler.ts`.
  it("does not set isFallback for bot User-Agent on unlisted fallback: true paths", async () => {
    let gspCalled = false;
    const result = await resolvePagesPageData(
      createOptions({
        pageModule: {
          async getStaticPaths() {
            return {
              fallback: true,
              paths: [{ params: { slug: "hello-world" } }],
            };
          },
          async getStaticProps({ params }) {
            gspCalled = true;
            return { props: { slug: params?.slug ?? null } };
          },
        },
        params: { slug: "unknown" },
        query: { slug: "unknown" },
        route: { isDynamic: true },
        routeUrl: "/posts/unknown",
        userAgent: "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
      }),
    );

    expect(result.kind).toBe("render");
    if (result.kind !== "render") throw new Error("expected render result");
    expect(result.isFallback).toBe(false);
    expect(gspCalled).toBe(true);
    expect(result.pageProps).toMatchObject({ slug: "unknown" });
  });

  it("sets isFallback for normal browser User-Agent on unlisted fallback: true paths", async () => {
    const result = await resolvePagesPageData(
      createOptions({
        pageModule: {
          async getStaticPaths() {
            return {
              fallback: true,
              paths: [{ params: { slug: "hello-world" } }],
            };
          },
          async getStaticProps() {
            throw new Error("getStaticProps should not run on a fallback shell render");
          },
        },
        params: { slug: "unknown" },
        query: { slug: "unknown" },
        route: { isDynamic: true },
        routeUrl: "/posts/unknown",
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/93.0.4577.82 Safari/537.36",
      }),
    );

    expect(result.kind).toBe("render");
    if (result.kind !== "render") throw new Error("expected render result");
    expect(result.isFallback).toBe(true);
    expect(result.pageProps).toEqual({});
  });

  it("skips the fallback shell after its data request generated the path", async () => {
    const getStaticProps = vi.fn(async () => ({ props: { slug: "regenerated" } }));
    const result = await resolvePagesPageData(
      createOptions({
        isrGet: vi.fn().mockResolvedValue({
          isStale: false,
          value: {
            cacheControl: { revalidate: 60 },
            lastModified: 1,
            value: {
              kind: "PAGES",
              html: "",
              pageData: { pageProps: { slug: "unknown" } },
              generatedFromDataRequest: true,
              headers: undefined,
              status: undefined,
            },
          },
        }),
        pageModule: {
          async getStaticPaths() {
            return { fallback: true, paths: [] };
          },
          getStaticProps,
        },
        params: { slug: "unknown" },
        query: { slug: "unknown" },
        route: { isDynamic: true },
        routeUrl: "/posts/unknown",
      }),
    );

    expect(result).toMatchObject({
      kind: "render",
      isFallback: false,
      isrRevalidateSeconds: 60,
      pageProps: { slug: "unknown" },
    });
    expect(getStaticProps).not.toHaveBeenCalled();
  });

  it("reruns getStaticProps for on-demand revalidation of fallback data", async () => {
    const getStaticProps = vi.fn(async () => ({ props: { slug: "regenerated" }, revalidate: 60 }));
    const result = await resolvePagesPageData(
      createOptions({
        isOnDemandRevalidate: true,
        isrGet: vi.fn().mockResolvedValue({
          isStale: false,
          value: {
            cacheControl: { revalidate: 60 },
            lastModified: 1,
            value: {
              kind: "PAGES",
              html: "",
              pageData: { pageProps: { slug: "cached" } },
              generatedFromDataRequest: true,
              headers: undefined,
              status: undefined,
            },
          },
        }),
        pageModule: { getStaticProps },
      }),
    );

    expect(getStaticProps).toHaveBeenCalledWith(
      expect.objectContaining({ revalidateReason: "on-demand" }),
    );
    expect(result).toMatchObject({ kind: "render", pageProps: { slug: "regenerated" } });
  });

  it("reruns getStaticProps when generated fallback data is stale", async () => {
    const getStaticProps = vi.fn(async () => ({ props: { slug: "regenerated" }, revalidate: 60 }));
    const result = await resolvePagesPageData(
      createOptions({
        isrGet: vi.fn().mockResolvedValue({
          isStale: true,
          value: {
            cacheControl: { revalidate: 60 },
            lastModified: 1,
            value: {
              kind: "PAGES",
              html: "",
              pageData: { pageProps: { slug: "cached" } },
              generatedFromDataRequest: true,
              headers: undefined,
              status: undefined,
            },
          },
        }),
        pageModule: { getStaticProps },
      }),
    );

    expect(getStaticProps).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ kind: "render", pageProps: { slug: "regenerated" } });
  });

  it("short-circuits getServerSideProps responses after res.end()", async () => {
    const responsePromise = Promise.resolve(
      new Response('{"ok":true}', {
        status: 202,
        headers: { "content-type": "application/json" },
      }),
    );

    const result = await resolvePagesPageData(
      createOptions({
        createGsspReqRes() {
          const res = {
            headersSent: false,
            statusCode: 202,
            getHeaders() {
              return { "content-type": "application/json" };
            },
          };
          return {
            req: { method: "GET" },
            res,
            responsePromise,
          };
        },
        pageModule: {
          async getServerSideProps(context) {
            context.res.headersSent = true;
            return {};
          },
        },
      }),
    );

    expect(result.kind).toBe("response");
    if (result.kind !== "response") {
      throw new Error("expected response result");
    }
    expect(result.response.status).toBe(202);
    await expect(result.response.text()).resolves.toBe('{"ok":true}');
  });

  it("short-circuits getServerSideProps responses when only writableEnded is set", async () => {
    const responsePromise = Promise.resolve(
      new Response('{"ok":true}', {
        status: 202,
        headers: { "content-type": "application/json" },
      }),
    );

    const result = await resolvePagesPageData(
      createOptions({
        createGsspReqRes() {
          const res = {
            headersSent: false,
            writableEnded: true,
            statusCode: 202,
            getHeaders() {
              return { "content-type": "application/json" };
            },
          };
          return {
            req: { method: "GET" },
            res,
            responsePromise,
          };
        },
        pageModule: {
          async getServerSideProps() {
            return {};
          },
        },
      }),
    );

    expect(result.kind).toBe("response");
    if (result.kind !== "response") {
      throw new Error("expected response result");
    }
    expect(result.response.status).toBe(202);
    await expect(result.response.text()).resolves.toBe('{"ok":true}');
  });

  it("short-circuits getInitialProps responses when only writableEnded is set", async () => {
    const responsePromise = Promise.resolve(
      new Response('{"ok":true}', {
        status: 202,
        headers: { "content-type": "application/json" },
      }),
    );

    const result = await resolvePagesPageData(
      createOptions({
        createGsspReqRes() {
          const res = {
            headersSent: false,
            writableEnded: true,
            statusCode: 202,
            getHeaders() {
              return { "content-type": "application/json" };
            },
          };
          return {
            req: {},
            res,
            responsePromise,
          };
        },
        pageModule: {
          default: Object.assign(
            function Page() {
              return null;
            },
            {
              getInitialProps() {
                return {};
              },
            },
          ),
        },
      }),
    );

    expect(result.kind).toBe("response");
    if (result.kind !== "response") {
      throw new Error("expected response result");
    }
    expect(result.response.status).toBe(202);
    await expect(result.response.text()).resolves.toBe('{"ok":true}');
  });

  it("serves stale ISR entries immediately and regenerates them through typed helpers", async () => {
    let regenPromise: Promise<void> | null = null;
    const applyRequestContexts = vi.fn();
    const isrSet = vi.fn<ResolvePagesPageDataOptions["isrSet"]>(async () => {});
    const runInFreshUnifiedContext = vi.fn(
      async <T>(callback: () => Promise<T>): Promise<T> => callback(),
    ) as ResolvePagesPageDataOptions["runInFreshUnifiedContext"];
    const triggerBackgroundRegeneration = vi.fn((_key: string, renderFn: () => Promise<void>) => {
      regenPromise = renderFn();
    });

    const result = await resolvePagesPageData(
      createOptions({
        applyRequestContexts,
        isrGet: vi.fn().mockResolvedValue({
          isStale: true,
          value: {
            lastModified: 1,
            cacheState: "stale",
            cacheControl: { revalidate: 15, expire: 300 },
            value: {
              kind: "PAGES",
              html: '<!DOCTYPE html><html><head><title>cached</title></head><body><div id="__next"><div>stale-body</div></div><div data-gap="1"></div><script>window.__NEXT_DATA__ = {"old":1}</script><script src="/tail.js"></script></body></html>',
              pageData: { stale: true },
              headers: undefined,
              status: undefined,
            },
          },
        }),
        isrSet,
        pageModule: {
          async getStaticProps() {
            return {
              props: { title: "fresh" },
            };
          },
        },
        runInFreshUnifiedContext,
        triggerBackgroundRegeneration,
        vinext: { hasMiddleware: true },
      }),
    );

    expect(result.kind).toBe("response");
    if (result.kind !== "response") {
      throw new Error("expected response result");
    }

    expect(result.response.status).toBe(200);
    expect(result.response.headers.get("x-vinext-cache")).toBe("STALE");
    expect(result.response.headers.get("cache-control")).toBe(
      "s-maxage=15, stale-while-revalidate=285",
    );
    expect(result.response.headers.get("link")).toBe(
      "</font.woff2>; rel=preload; as=font; type=font/woff2; crossorigin",
    );
    await expect(result.response.text()).resolves.toContain("stale-body");

    expect(triggerBackgroundRegeneration).toHaveBeenCalledOnce();
    if (!regenPromise) {
      throw new Error("expected stale ISR regeneration to start");
    }

    const pendingRegen: Promise<void> = regenPromise;
    await pendingRegen;

    expect(runInFreshUnifiedContext).toHaveBeenCalledOnce();
    expect(applyRequestContexts).toHaveBeenCalledOnce();
    expect(isrSet).toHaveBeenCalledWith(
      "pages:/posts/post",
      expect.objectContaining({
        kind: "PAGES",
        html: expect.stringContaining("<div>fresh-body</div>"),
        pageData: { pageProps: { title: "fresh" } },
      }),
      15,
      undefined,
      300,
    );
    expect(isrSet).toHaveBeenCalledWith(
      "pages:/posts/post",
      expect.objectContaining({
        kind: "PAGES",
        html: expect.stringContaining('"__vinext":{"hasMiddleware":true}'),
        pageData: { pageProps: { title: "fresh" } },
      }),
      15,
      undefined,
      300,
    );
  });

  it("preserves _app.getInitialProps app-level props during stale ISR regeneration", async () => {
    let regenPromise: Promise<void> | null = null;
    const isrSet = vi.fn<ResolvePagesPageDataOptions["isrSet"]>(async () => {});
    const triggerBackgroundRegeneration = vi.fn((_key: string, renderFn: () => Promise<void>) => {
      regenPromise = renderFn();
    });
    let capturedRenderProps: Record<string, unknown> | undefined;
    function createPageElement(props: Record<string, unknown>): ReactNode {
      capturedRenderProps = props;
      return null;
    }

    const result = await resolvePagesPageData(
      createOptions({
        AppComponent: Object.assign(
          function App() {
            return null;
          },
          {
            getInitialProps() {
              return {
                appProp: "from-app",
                pageProps: {},
              };
            },
          },
        ),
        createPageElement,
        isrGet: vi.fn().mockResolvedValue({
          isStale: true,
          value: {
            lastModified: 1,
            cacheState: "stale",
            value: {
              kind: "PAGES",
              html: '<!DOCTYPE html><html><body><div id="__next"><div>stale-body</div></div><script>window.__NEXT_DATA__ = {"old":1}</script></body></html>',
              pageData: { stale: true },
              headers: undefined,
              status: undefined,
            },
          },
        }),
        isrSet,
        pageModule: {
          async getStaticProps() {
            return {
              props: { pageProp: "from-page" },
              revalidate: 60,
            };
          },
        },
        triggerBackgroundRegeneration,
      }),
    );

    expect(result.kind).toBe("response");
    if (result.kind !== "response") {
      throw new Error("expected response result");
    }
    expect(result.response.headers.get("x-vinext-cache")).toBe("STALE");

    if (!regenPromise) {
      throw new Error("expected stale ISR regeneration to start");
    }
    const pendingRegen: Promise<void> = regenPromise;
    await pendingRegen;

    expect(capturedRenderProps).toEqual(
      expect.objectContaining({
        appProp: "from-app",
        pageProps: { pageProp: "from-page" },
      }),
    );

    expect(isrSet).toHaveBeenCalledOnce();
    const regeneratedCacheValue = isrSet.mock.calls[0]?.[1];
    expect(regeneratedCacheValue).toEqual(
      expect.objectContaining({
        kind: "PAGES",
        pageData: {
          appProp: "from-app",
          pageProps: { pageProp: "from-page" },
        },
      }),
    );
    expect(regeneratedCacheValue?.html).toContain('"appProp":"from-app"');
    expect(regeneratedCacheValue?.html).toContain('"pageProp":"from-page"');
    expect(regeneratedCacheValue?.html).toContain('"page":"/posts/[slug]"');
  });

  it("does not run _app.getInitialProps on a fresh ISR cache HIT", async () => {
    const appGip = vi.fn().mockResolvedValue({
      appProp: "from-app",
      pageProps: {},
    });

    const result = await resolvePagesPageData(
      createOptions({
        AppComponent: Object.assign(
          function App() {
            return null;
          },
          { getInitialProps: appGip },
        ),
        isrGet: vi.fn().mockResolvedValue({
          isStale: false,
          value: {
            lastModified: 1,
            cacheState: "fresh",
            value: {
              kind: "PAGES",
              html: '<!DOCTYPE html><html><body><div id="__next"><div>cached-body</div></div></body></html>',
              pageData: { pageProp: "cached" },
              headers: undefined,
              status: undefined,
            },
          },
        }),
        pageModule: {
          async getStaticProps() {
            return { props: { pageProp: "fresh" }, revalidate: 60 };
          },
        },
        triggerBackgroundRegeneration: vi.fn(),
      }),
    );

    expect(result.kind).toBe("response");
    if (result.kind !== "response") {
      throw new Error("expected response result");
    }
    expect(result.response.headers.get("x-vinext-cache")).toBe("HIT");
    expect(appGip).not.toHaveBeenCalled();
  });

  it("only runs _app.getInitialProps in the stale ISR regeneration path, not on the immediate stale response", async () => {
    let regenPromise: Promise<void> | null = null;
    const isrSet = vi.fn<ResolvePagesPageDataOptions["isrSet"]>(async () => {});
    const triggerBackgroundRegeneration = vi.fn((_key: string, renderFn: () => Promise<void>) => {
      regenPromise = renderFn();
    });

    let insideRegenContext = false;
    let foregroundGipCalls = 0;
    let regenGipCalls = 0;
    const appGip = vi.fn().mockImplementation(() => {
      if (insideRegenContext) {
        regenGipCalls++;
      } else {
        foregroundGipCalls++;
      }
      return Promise.resolve({ appProp: "from-app", pageProps: {} });
    });

    const result = await resolvePagesPageData(
      createOptions({
        AppComponent: Object.assign(
          function App() {
            return null;
          },
          { getInitialProps: appGip },
        ),
        isrGet: vi.fn().mockResolvedValue({
          isStale: true,
          value: {
            lastModified: 1,
            cacheState: "stale",
            value: {
              kind: "PAGES",
              html: '<!DOCTYPE html><html><body><div id="__next"><div>stale-body</div></div></body></html>',
              pageData: { stale: true },
              headers: undefined,
              status: undefined,
            },
          },
        }),
        isrSet,
        pageModule: {
          async getStaticProps() {
            return { props: { pageProp: "from-page" }, revalidate: 60 };
          },
        },
        runInFreshUnifiedContext: async (callback) => {
          insideRegenContext = true;
          try {
            return await callback();
          } finally {
            insideRegenContext = false;
          }
        },
        triggerBackgroundRegeneration,
      }),
    );

    expect(result.kind).toBe("response");
    if (result.kind !== "response") {
      throw new Error("expected response result");
    }
    expect(result.response.headers.get("x-vinext-cache")).toBe("STALE");
    // App GIP must not run before serving the stale response.
    expect(foregroundGipCalls).toBe(0);

    if (!regenPromise) {
      throw new Error("expected stale ISR regeneration to start");
    }
    const pendingRegen: Promise<void> = regenPromise;
    await pendingRegen;

    // App GIP must run exactly once, inside the background regeneration callback.
    expect(regenGipCalls).toBe(1);
    expect(appGip).toHaveBeenCalledOnce();
    expect(isrSet).toHaveBeenCalledOnce();
  });

  it("preserves vinext module metadata during stale ISR regeneration", async () => {
    let regenPromise: Promise<void> | null = null;
    const isrSet = vi.fn<ResolvePagesPageDataOptions["isrSet"]>(async () => {});
    const triggerBackgroundRegeneration = vi.fn((_key: string, renderFn: () => Promise<void>) => {
      regenPromise = renderFn();
    });

    const result = await resolvePagesPageData(
      createOptions({
        isrGet: vi.fn().mockResolvedValue({
          isStale: true,
          value: {
            lastModified: 1,
            cacheState: "stale",
            value: {
              kind: "PAGES",
              html: '<!DOCTYPE html><html><body><div id="__next"><main>stale 404</main></div><script>window.__NEXT_DATA__ = {"page":"/404","query":{},"props":{"pageProps":{"marker":"stale"}}}</script></body></html>',
              pageData: { marker: "stale" },
              headers: undefined,
              status: 404,
            },
          },
        }),
        isrSet,
        pageModule: {
          async getStaticProps() {
            return {
              props: { marker: "fresh" },
              revalidate: 60,
            };
          },
        },
        renderIsrPassToStringAsync: vi.fn(async () => "<main>fresh 404</main>"),
        routePattern: "/404",
        routeUrl: "/missing",
        statusCode: 404,
        triggerBackgroundRegeneration,
        vinext: {
          pageModuleUrl: "/assets/pages/404.js",
          appModuleUrl: "/assets/pages/_app.js",
        },
      }),
    );

    expect(result.kind).toBe("response");
    if (result.kind !== "response") {
      throw new Error("expected response result");
    }
    expect(result.response.status).toBe(404);

    if (!regenPromise) {
      throw new Error("expected stale ISR regeneration to start");
    }
    const pendingRegen: Promise<void> = regenPromise;
    await pendingRegen;

    expect(isrSet).toHaveBeenCalledOnce();
    const regeneratedCacheValue = isrSet.mock.calls[0]?.[1];
    expect(regeneratedCacheValue?.html).toContain("<main>fresh 404</main>");
    expect(regeneratedCacheValue?.html).toContain('"__vinext"');
    expect(regeneratedCacheValue?.html).toContain('"pageModuleUrl":"/assets/pages/404.js"');
    expect(regeneratedCacheValue?.html).toContain('"appModuleUrl":"/assets/pages/_app.js"');
    expect(regeneratedCacheValue?.status).toBe(404);
  });

  it("uses stored cache-control metadata for Pages Router cached HIT responses", async () => {
    const result = await resolvePagesPageData(
      createOptions({
        expireSeconds: 31_536_000,
        isrGet: vi.fn().mockResolvedValue({
          isStale: false,
          value: {
            cacheControl: { revalidate: 15, expire: 300 },
            lastModified: 1,
            value: {
              kind: "PAGES",
              html: "<html><body>cached</body></html>",
              pageData: { cached: true },
              headers: undefined,
              status: undefined,
            },
          },
        }),
        pageModule: {
          async getStaticProps() {
            return {
              props: { title: "fresh" },
              revalidate: 15,
            };
          },
        },
      }),
    );

    expect(result.kind).toBe("response");
    if (result.kind !== "response") {
      throw new Error("expected response result");
    }
    expect(result.response.headers.get("x-vinext-cache")).toBe("HIT");
    expect(result.response.headers.get("x-nextjs-cache")).toBe("HIT");
    expect(result.response.headers.get("cache-control")).toBe(
      "s-maxage=15, stale-while-revalidate=285",
    );
  });

  it("returns normalized render data for cache misses", async () => {
    const result = await resolvePagesPageData(
      createOptions({
        pageModule: {
          async getStaticProps() {
            return {
              props: { title: "hello" },
              revalidate: 30,
            };
          },
        },
      }),
    );

    expect(result).toEqual({
      kind: "render",
      documentReqRes: null,
      gsspRes: null,
      isrRevalidateSeconds: 30,
      pageProps: { title: "hello" },
      props: { pageProps: { title: "hello" } },
      isFallback: false,
    });
  });

  // Matches Next.js behavior: for non-dynamic routes, `params` in
  // getServerSideProps context is null (not `{}`).
  // Ported from Next.js: test/e2e/edge-pages-support/index.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/edge-pages-support/index.test.ts#L67-L77
  it("passes params: null to getServerSideProps on non-dynamic routes", async () => {
    let received: unknown = "untouched";
    await resolvePagesPageData(
      createOptions({
        pageModule: {
          async getServerSideProps(context) {
            received = context.params;
            return { props: {} };
          },
        },
        params: {},
        query: {},
        route: { isDynamic: false },
        routePattern: "/",
        routeUrl: "/",
      }),
    );

    expect(received).toBeNull();
  });

  it("passes the matched params object to getServerSideProps on dynamic routes", async () => {
    let received: unknown = null;
    await resolvePagesPageData(
      createOptions({
        pageModule: {
          async getServerSideProps(context) {
            received = context.params;
            return { props: {} };
          },
        },
        params: { id: "123" },
        query: { id: "123" },
        route: { isDynamic: true },
        routePattern: "/[id]",
        routeUrl: "/123",
      }),
    );

    expect(received).toEqual({ id: "123" });
  });

  // `getStaticProps` receives `context.revalidateReason` describing why the
  // function was called. Mirrors Next.js's render.tsx — see
  // `.nextjs-ref/test/e2e/revalidate-reason/revalidate-reason.test.ts` for
  // the authoritative tri-state assertions.
  it("passes revalidateReason: 'build' to getStaticProps during build-time prerendering", async () => {
    let received: unknown = "untouched";
    await resolvePagesPageData(
      createOptions({
        isBuildTimePrerendering: true,
        pageModule: {
          async getStaticProps(context) {
            received = context.revalidateReason;
            return { props: {} };
          },
        },
      }),
    );

    expect(received).toBe("build");
  });

  it("passes revalidateReason: 'on-demand' to getStaticProps when on-demand revalidation is signalled", async () => {
    let received: unknown = "untouched";
    await resolvePagesPageData(
      createOptions({
        isOnDemandRevalidate: true,
        pageModule: {
          async getStaticProps(context) {
            received = context.revalidateReason;
            return { props: {} };
          },
        },
      }),
    );

    expect(received).toBe("on-demand");
  });

  it("passes preview context to getStaticProps and bypasses fresh ISR hits", async () => {
    let received: unknown = "untouched";
    const getStaticProps = vi.fn(async (context) => {
      received = {
        draftMode: context.draftMode,
        preview: context.preview,
        previewData: context.previewData,
      };
      return { props: { fromPreview: true } };
    });

    const result = await resolvePagesPageData(
      createOptions({
        isrGet: vi.fn().mockResolvedValue({
          isStale: false,
          value: {
            lastModified: 1,
            cacheState: "hit",
            value: {
              kind: "PAGES",
              html: "<html>cached</html>",
              pageData: { pageProps: { cached: true } },
              headers: undefined,
              status: undefined,
            },
          },
        }),
        pageModule: { getStaticProps },
        previewData: { hello: "world" },
      }),
    );

    expect(getStaticProps).toHaveBeenCalledOnce();
    expect(received).toEqual({
      draftMode: true,
      preview: true,
      previewData: { hello: "world" },
    });
    expect(result.kind).toBe("render");
    if (result.kind !== "render") throw new Error("expected render");
    expect(result.pageProps).toEqual({ fromPreview: true });
  });

  it("disables preview context for on-demand getStaticProps regeneration", async () => {
    let received: unknown = "untouched";
    await resolvePagesPageData(
      createOptions({
        isOnDemandRevalidate: true,
        pageModule: {
          async getStaticProps(context) {
            received = {
              draftMode: context.draftMode,
              preview: context.preview,
              previewData: context.previewData,
              revalidateReason: context.revalidateReason,
            };
            return { props: {} };
          },
        },
        previewData: { hello: "world" },
      }),
    );

    expect(received).toEqual({
      draftMode: undefined,
      preview: undefined,
      previewData: undefined,
      revalidateReason: "on-demand",
    });
  });

  it("passes preview context to getServerSideProps", async () => {
    let received: unknown = "untouched";
    await resolvePagesPageData(
      createOptions({
        pageModule: {
          async getServerSideProps(context) {
            received = {
              draftMode: context.draftMode,
              preview: context.preview,
              previewData: context.previewData,
            };
            return { props: {} };
          },
        },
        previewData: "draft",
      }),
    );

    expect(received).toEqual({
      draftMode: true,
      preview: true,
      previewData: "draft",
    });
  });

  it("passes revalidateReason: 'stale' to getStaticProps for runtime cache-miss requests", async () => {
    let received: unknown = "untouched";
    await resolvePagesPageData(
      createOptions({
        pageModule: {
          async getStaticProps(context) {
            received = context.revalidateReason;
            return { props: {} };
          },
        },
      }),
    );

    expect(received).toBe("stale");
  });

  it("passes revalidateReason: 'stale' to getStaticProps during stale-while-revalidate regeneration", async () => {
    let received: unknown = "untouched";
    let regenPromise: Promise<void> | null = null;
    const runInFreshUnifiedContext = vi.fn(
      async <T>(callback: () => Promise<T>): Promise<T> => callback(),
    ) as ResolvePagesPageDataOptions["runInFreshUnifiedContext"];
    const triggerBackgroundRegeneration = vi.fn((_key: string, renderFn: () => Promise<void>) => {
      regenPromise = renderFn();
    });

    await resolvePagesPageData(
      createOptions({
        // Even when the dispatch itself is a build-time prerender, the SWR
        // refresh path is still a stale regeneration — matches Next.js.
        isBuildTimePrerendering: true,
        isrGet: vi.fn().mockResolvedValue({
          isStale: true,
          value: {
            lastModified: 1,
            cacheState: "stale",
            value: {
              kind: "PAGES",
              html: '<!DOCTYPE html><html><body><div id="__next"><div>stale</div></div><script>window.__NEXT_DATA__ = {}</script></body></html>',
              pageData: {},
              headers: undefined,
              status: undefined,
            },
          },
        }),
        pageModule: {
          async getStaticProps(context) {
            received = context.revalidateReason;
            return { props: {}, revalidate: 5 };
          },
        },
        runInFreshUnifiedContext,
        triggerBackgroundRegeneration,
      }),
    );

    expect(triggerBackgroundRegeneration).toHaveBeenCalledOnce();
    if (!regenPromise) {
      throw new Error("expected stale regeneration to start");
    }
    const pendingRegen: Promise<void> = regenPromise;
    await pendingRegen;

    expect(received).toBe("stale");
  });

  // Mirrors Next.js's `isSerializableProps` check from render.tsx (~line 982).
  // Without this validation vinext silently rendered an empty page for
  // non-JSON values like `new Date()`. Tracked in vinext#1478.
  // See .nextjs-ref/packages/next/src/lib/is-serializable-props.ts and the
  // `non-json`/`non-json-blocking` cases in .nextjs-ref/test/e2e/prerender.test.ts.
  it("throws a Next.js-style error when getStaticProps returns non-serializable props", async () => {
    await expect(
      resolvePagesPageData(
        createOptions({
          pageModule: {
            async getStaticProps() {
              return { props: { date: new Date(0) } };
            },
          },
          routePattern: "/non-json",
          routeUrl: "/non-json",
        }),
      ),
    ).rejects.toThrow(
      /Error serializing `\.date` returned from `getStaticProps` in "\/non-json"\.\s*Reason: `object` \("\[object Date\]"\) cannot be serialized as JSON/,
    );
  });

  it("allows non-serializable getStaticProps props when production SSR validation is disabled", async () => {
    const result = await resolvePagesPageData(
      createOptions({
        pageModule: {
          async getStaticProps() {
            return { props: { date: new Date(0) } };
          },
        },
        routePattern: "/non-json",
        routeUrl: "/non-json",
        validatePropsSerialization: false,
      }),
    );

    expect(result.kind).toBe("render");
    if (result.kind !== "render") throw new Error("expected render");
    expect(result.pageProps.date).toBeInstanceOf(Date);
  });

  it("throws a Next.js-style error when getServerSideProps returns non-serializable props", async () => {
    await expect(
      resolvePagesPageData(
        createOptions({
          pageModule: {
            async getServerSideProps() {
              return { props: { fn: () => "nope" } };
            },
          },
          routePattern: "/gssp-bad",
          routeUrl: "/gssp-bad",
        }),
      ),
    ).rejects.toThrow(
      /Error serializing `\.fn` returned from `getServerSideProps` in "\/gssp-bad"\.\s*Reason: `function` cannot be serialized as JSON/,
    );
  });

  // ── x-nextjs-deployment-id header ─────────────────────────────────────────
  // Mirrors Next.js pages-handler.ts: set x-nextjs-deployment-id on ALL
  // `_next/data` exits (success, redirect, notFound) for deployment-skew
  // protection. Fixes #1829.

  it("includes x-nextjs-deployment-id on notFound data response when deploymentId is set", async () => {
    const result = await resolvePagesPageData(
      createOptions({
        isDataReq: true,
        deploymentId: "test-deploy-abc",
        pageModule: {
          async getServerSideProps() {
            return { notFound: true };
          },
        },
      }),
    );

    expect(result.kind).toBe("response");
    if (result.kind !== "response") throw new Error("expected response");
    expect(result.response.status).toBe(404);
    expect(result.response.headers.get("x-nextjs-deployment-id")).toBe("test-deploy-abc");
  });

  it("includes x-nextjs-deployment-id on notFound data response from getStaticProps", async () => {
    const result = await resolvePagesPageData(
      createOptions({
        isDataReq: true,
        deploymentId: "test-deploy-abc",
        pageModule: {
          async getStaticProps() {
            return { notFound: true };
          },
        },
      }),
    );

    expect(result.kind).toBe("response");
    if (result.kind !== "response") throw new Error("expected response");
    expect(result.response.status).toBe(404);
    expect(result.response.headers.get("x-nextjs-deployment-id")).toBe("test-deploy-abc");
  });

  it("includes x-nextjs-deployment-id on notFound data response from getStaticPaths exclusion", async () => {
    const result = await resolvePagesPageData(
      createOptions({
        isDataReq: true,
        deploymentId: "test-deploy-abc",
        pageModule: {
          async getStaticPaths() {
            return { fallback: false, paths: [{ params: { slug: "known" } }] };
          },
        },
        params: { slug: "unknown" },
        query: { slug: "unknown" },
        route: { isDynamic: true },
        routeUrl: "/posts/unknown",
      }),
    );

    expect(result.kind).toBe("response");
    if (result.kind !== "response") throw new Error("expected response");
    expect(result.response.status).toBe(404);
    expect(result.response.headers.get("x-nextjs-deployment-id")).toBe("test-deploy-abc");
  });

  it("includes x-nextjs-deployment-id on redirect data response from getServerSideProps", async () => {
    const result = await resolvePagesPageData(
      createOptions({
        AppComponent: Object.assign(function App() {}, {
          getInitialProps() {
            return { appValue: "preserved", pageProps: {} };
          },
        }),
        isDataReq: true,
        deploymentId: "test-deploy-abc",
        pageModule: {
          async getServerSideProps() {
            return { redirect: { destination: "/new-page", permanent: false } };
          },
        },
      }),
    );

    expect(result.kind).toBe("response");
    if (result.kind !== "response") throw new Error("expected response");
    expect(result.response.status).toBe(200);
    expect(result.response.headers.get("x-nextjs-deployment-id")).toBe("test-deploy-abc");
    const body = (await result.response.json()) as {
      __N_SSP?: boolean;
      appValue?: string;
      pageProps: Record<string, unknown>;
    };
    expect(body.__N_SSP).toBe(true);
    expect(body.appValue).toBe("preserved");
    expect(body.pageProps.__N_REDIRECT).toBe("/new-page");
  });

  it("includes x-nextjs-deployment-id on redirect data response from getStaticProps", async () => {
    const result = await resolvePagesPageData(
      createOptions({
        isDataReq: true,
        deploymentId: "test-deploy-abc",
        pageModule: {
          async getStaticProps() {
            return { redirect: { destination: "/new-page", permanent: false } };
          },
        },
      }),
    );

    expect(result.kind).toBe("response");
    if (result.kind !== "response") throw new Error("expected response");
    expect(result.response.status).toBe(200);
    expect(result.response.headers.get("x-nextjs-deployment-id")).toBe("test-deploy-abc");
    const body = (await result.response.json()) as { pageProps: Record<string, unknown> };
    expect(body.pageProps.__N_REDIRECT).toBe("/new-page");
  });

  it("omits x-nextjs-deployment-id on redirect/notFound data responses when deploymentId is not set", async () => {
    const notFoundResult = await resolvePagesPageData(
      createOptions({
        isDataReq: true,
        // deploymentId intentionally omitted
        pageModule: {
          async getServerSideProps() {
            return { notFound: true };
          },
        },
      }),
    );
    expect(notFoundResult.kind).toBe("response");
    if (notFoundResult.kind !== "response") throw new Error("expected response");
    expect(notFoundResult.response.headers.get("x-nextjs-deployment-id")).toBeNull();
  });

  // Redirect and notFound short-circuits must continue to work even if the
  // page also returns `props` — mirrors Next.js, which only validates when
  // !metadata.isRedirect && !metadata.isNotFound.
  it("does not throw on getStaticProps redirect even when props would be invalid", async () => {
    const result = await resolvePagesPageData(
      createOptions({
        pageModule: {
          async getStaticProps() {
            return { redirect: { destination: "/elsewhere", permanent: false } };
          },
        },
      }),
    );

    expect(result.kind).toBe("response");
    if (result.kind !== "response") throw new Error("expected response");
    expect(result.response.status).toBe(307);
    expect(result.response.headers.get("location")).toBe("/elsewhere");
  });

  // Matches Next.js behavior: for non-dynamic routes, `params` in
  // getStaticProps context is null (not `{}`).
  it("passes params: null to getStaticProps on non-dynamic routes", async () => {
    let received: unknown = "untouched";
    await resolvePagesPageData(
      createOptions({
        pageModule: {
          async getStaticProps(context) {
            received = context.params;
            return { props: {} };
          },
        },
        params: {},
        query: {},
        route: { isDynamic: false },
        routePattern: "/",
        routeUrl: "/",
      }),
    );

    expect(received).toBeNull();
  });

  it("isResponseSent detects both headersSent and writableEnded", async () => {
    const { isResponseSent } =
      await import("../packages/vinext/src/server/pages-get-initial-props.js");

    expect(isResponseSent({ headersSent: true })).toBe(true);
    expect(isResponseSent({ writableEnded: true })).toBe(true);
    expect(isResponseSent({ headersSent: true, writableEnded: true })).toBe(true);
    expect(isResponseSent({ headersSent: false })).toBe(false);
    expect(isResponseSent({ writableEnded: false })).toBe(false);
    expect(isResponseSent({})).toBe(false);
    expect(isResponseSent(undefined)).toBe(false);
    expect(isResponseSent(null)).toBe(false);
    // The prod PagesReqResResponse type only declares headersSent; the helper
    // must not throw or treat the absent writableEnded as truthy.
    const prodShaped: { headersSent: boolean } = { headersSent: false };
    expect(isResponseSent(prodShaped)).toBe(false);
    prodShaped.headersSent = true;
    expect(isResponseSent(prodShaped)).toBe(true);
  });
});
