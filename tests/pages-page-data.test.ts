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
    pageModule: {},
    params: { slug: "post" },
    query: { slug: "post" },
    resolvedUrl: "/posts/post",
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
    });

    expect(html).toContain("<div>fresh-body</div>");
    expect(html).toContain('<aside data-gap="1"></aside>');
    expect(html).toContain('<script src="/tail.js"></script>');
    expect(html).toContain('"page":"/posts/[slug]"');
    expect(html).toContain('"slug":"post"');
  });

  it("returns an HTML 404 when getStaticPaths excludes a dynamic path", async () => {
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

    expect(result.kind).toBe("response");
    if (result.kind !== "response") {
      throw new Error("expected response result");
    }
    expect(result.response.status).toBe(404);
    const html = await result.response.text();
    expect(html).toContain("404 - Page not found");
    expect(html).toContain("This page could not be found.");
  });

  it("matches string paths returned from getStaticPaths", async () => {
    // Ported from Next.js deploy fixture:
    // test/e2e/middleware-general/app/pages/ssg-fallback-false/[slug].js
    const result = await resolvePagesPageData(
      createOptions({
        pageModule: {
          async getStaticPaths() {
            return {
              fallback: false,
              paths: ["/ssg-fallback-false/first", "/ssg-fallback-false/hello"],
            };
          },
          async getStaticProps({ params }) {
            return { props: { params } };
          },
        },
        params: { slug: "hello" },
        query: { slug: "hello" },
        route: { isDynamic: true },
        routePattern: "/ssg-fallback-false/[slug]",
        routeUrl: "/ssg-fallback-false/hello",
      }),
    );

    expect(result).toMatchObject({
      kind: "render",
      pageProps: { params: { slug: "hello" } },
    });
  });

  it("returns a notFound signal for HTML when getStaticProps returns notFound", async () => {
    const result = await resolvePagesPageData(
      createOptions({
        pageModule: {
          async getStaticProps() {
            return { notFound: true };
          },
        },
      }),
    );

    expect(result.kind).toBe("notFound");
  });

  it("returns Next-compatible 404 HTML for data requests when getStaticProps returns notFound", async () => {
    const result = await resolvePagesPageData(
      createOptions({
        isDataRequest: true,
        pageModule: {
          async getStaticProps() {
            return { notFound: true };
          },
        },
      }),
    );

    expect(result.kind).toBe("response");
    if (result.kind !== "response") throw new Error("expected response result");
    expect(result.response.status).toBe(404);
    await expect(result.response.text()).resolves.toContain("This page could not be found.");
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

  it("passes undefined params to getServerSideProps for non-dynamic pages", async () => {
    // Ported from Next.js: test/e2e/edge-pages-support/index.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/edge-pages-support/index.test.ts
    const result = await resolvePagesPageData(
      createOptions({
        pageModule: {
          async getServerSideProps({ params }) {
            return {
              props: {
                params: params ?? null,
              },
            };
          },
        },
        params: {},
        query: {},
        route: { isDynamic: false },
        routePattern: "/",
        routeUrl: "/",
      }),
    );

    expect(result).toMatchObject({
      kind: "render",
      pageProps: { params: null },
    });
  });

  it("awaits promise-valued getServerSideProps props", async () => {
    // Ported from Next.js: test/e2e/getserversideprops/app/pages/promise/index.js
    // https://github.com/vercel/next.js/blob/canary/test/e2e/getserversideprops/app/pages/promise/index.js
    const result = await resolvePagesPageData(
      createOptions({
        pageModule: {
          async getServerSideProps() {
            return {
              props: Promise.resolve({
                text: "promise",
              }),
            };
          },
        },
      }),
    );

    expect(result).toMatchObject({
      kind: "render",
      pageProps: { text: "promise" },
    });
  });

  it("serves stale ISR entries immediately and regenerates them through typed helpers", async () => {
    let regenPromise: Promise<void> | null = null;
    const applyRequestContexts = vi.fn();
    const isrSet = vi.fn(async () => {});
    const getStaticProps = vi.fn(async () => ({
      props: { title: "fresh" },
      revalidate: 15,
    }));
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
          getStaticProps,
        },
        runInFreshUnifiedContext,
        triggerBackgroundRegeneration,
      }),
    );

    expect(result.kind).toBe("response");
    if (result.kind !== "response") {
      throw new Error("expected response result");
    }

    expect(result.response.status).toBe(200);
    expect(result.response.headers.get("x-vinext-cache")).toBe("STALE");
    expect(result.response.headers.get("cache-control")).toBe("s-maxage=0, stale-while-revalidate");
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
    expect(getStaticProps).toHaveBeenCalledWith(
      expect.objectContaining({ revalidateReason: "stale" }),
    );
    expect(applyRequestContexts).toHaveBeenCalledOnce();
    expect(isrSet).toHaveBeenCalledWith(
      "pages:/posts/post",
      expect.objectContaining({
        kind: "PAGES",
        html: expect.stringContaining("<div>fresh-body</div>"),
        pageData: { title: "fresh" },
      }),
      15,
    );
  });

  it("passes build revalidateReason to getStaticProps on prerender cache misses", async () => {
    const getStaticProps = vi.fn(async ({ revalidateReason }) => ({
      props: { reason: revalidateReason },
      revalidate: 30,
    }));

    const result = await resolvePagesPageData(
      createOptions({
        pageModule: {
          getStaticProps,
        },
        revalidateReason: "build",
      }),
    );

    expect(getStaticProps).toHaveBeenCalledWith(
      expect.objectContaining({ revalidateReason: "build" }),
    );
    expect(result).toMatchObject({
      kind: "render",
      pageProps: { reason: "build" },
    });
  });

  it("bypasses a fresh ISR hit for on-demand revalidation", async () => {
    const getStaticProps = vi.fn(async ({ revalidateReason }) => ({
      props: { reason: revalidateReason },
      revalidate: 30,
    }));

    const result = await resolvePagesPageData(
      createOptions({
        isrGet: vi.fn().mockResolvedValue({
          isStale: false,
          value: {
            lastModified: 1,
            cacheState: "hit",
            value: {
              kind: "PAGES",
              html: "<!DOCTYPE html><html><body>cached html</body></html>",
              pageData: { reason: "cached" },
              headers: undefined,
              status: undefined,
            },
          },
        }),
        pageModule: {
          getStaticProps,
        },
        revalidateReason: "on-demand",
      }),
    );

    expect(getStaticProps).toHaveBeenCalledWith(
      expect.objectContaining({ revalidateReason: "on-demand" }),
    );
    expect(result).toMatchObject({
      kind: "render",
      isrRevalidateSeconds: 30,
      pageProps: { reason: "on-demand" },
    });
  });

  it("returns cached page data instead of cached HTML for Pages data requests", async () => {
    // Ported from Next.js: test/e2e/prerender.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/prerender.test.ts
    const result = await resolvePagesPageData(
      createOptions({
        isDataRequest: true,
        isrGet: vi.fn().mockResolvedValue({
          isStale: false,
          value: {
            lastModified: 1,
            cacheState: "hit",
            value: {
              kind: "PAGES",
              html: "<!DOCTYPE html><html><body>cached html</body></html>",
              pageData: { post: "post-1" },
              headers: undefined,
              status: undefined,
            },
          },
        }),
        pageModule: {
          async getStaticProps() {
            return {
              props: { post: "fresh" },
              revalidate: 10,
            };
          },
        },
      }),
    );

    expect(result).toEqual({
      kind: "render",
      gsspRes: null,
      isrRevalidateSeconds: null,
      pageProps: { post: "post-1" },
    });
  });

  it("returns a fallback shell result for missing fallback true HTML paths", async () => {
    const result = await resolvePagesPageData(
      createOptions({
        pageModule: {
          async getStaticPaths() {
            return {
              fallback: true,
              paths: [{ params: { slug: "seeded" } }],
            };
          },
          async getStaticProps() {
            throw new Error("fallback shell should not call getStaticProps");
          },
        },
        params: { slug: "lazy" },
        query: { slug: "lazy" },
        route: { isDynamic: true },
        routeUrl: "/posts/lazy",
      }),
    );

    expect(result).toEqual({
      kind: "render",
      gsspRes: null,
      isFallback: true,
      isrRevalidateSeconds: null,
      pageProps: {},
    });
  });

  it("blocks fallback true HTML paths for crawler requests", async () => {
    // Ported from Next.js: test/e2e/prerender-crawler.test.ts
    const getStaticProps = vi.fn(async ({ params }) => ({
      props: { slug: params.slug },
    }));

    const result = await resolvePagesPageData(
      createOptions({
        isCrawlerRequest: true,
        pageModule: {
          async getStaticPaths() {
            return {
              fallback: true,
              paths: [{ params: { slug: "seeded" } }],
            };
          },
          getStaticProps,
        },
        params: { slug: "bot-slug" },
        query: { slug: "bot-slug" },
        route: { isDynamic: true },
        routeUrl: "/posts/bot-slug",
      }),
    );

    expect(getStaticProps).toHaveBeenCalledWith(
      expect.objectContaining({
        params: { slug: "bot-slug" },
      }),
    );
    expect(result).toEqual({
      kind: "render",
      gsspRes: null,
      isrRevalidateSeconds: null,
      pageProps: { slug: "bot-slug" },
    });
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
      gsspRes: null,
      isrRevalidateSeconds: 30,
      pageProps: { title: "hello" },
    });
  });

  it("runs page getInitialProps for Pages SSR routes", async () => {
    // Ported from Next.js: test/e2e/streaming-ssr-edge/pages/err/index.js
    // https://github.com/vercel/next.js/blob/canary/test/e2e/streaming-ssr-edge/pages/err/index.js
    function Page() {
      return "page";
    }
    Page.getInitialProps = vi.fn(({ pathname, query }) => ({
      pathname,
      slug: query.slug,
    }));

    const result = await resolvePagesPageData(
      createOptions({
        pageModule: {
          default: Page,
        },
      }),
    );

    expect(Page.getInitialProps).toHaveBeenCalledWith(
      expect.objectContaining({
        asPath: "/posts/post",
        pathname: "/posts/[slug]",
        query: { slug: "post" },
      }),
    );
    expect(result).toEqual({
      kind: "render",
      gsspRes: null,
      isrRevalidateSeconds: null,
      pageProps: {
        pathname: "/posts/[slug]",
        slug: "post",
      },
    });
  });

  it("surfaces page getInitialProps errors to the Pages error renderer", async () => {
    // Ported from Next.js: test/e2e/streaming-ssr-edge/streaming-ssr-edge.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/streaming-ssr-edge/streaming-ssr-edge.test.ts
    function Page() {
      return "page";
    }
    Page.getInitialProps = () => {
      throw new Error("gip-oops");
    };

    await expect(
      resolvePagesPageData(
        createOptions({
          pageModule: {
            default: Page,
          },
        }),
      ),
    ).rejects.toThrow("gip-oops");
  });

  it("treats getStaticProps revalidate false as indefinitely cacheable", async () => {
    const result = await resolvePagesPageData(
      createOptions({
        pageModule: {
          async getStaticProps() {
            return {
              props: { title: "static" },
              revalidate: false,
            };
          },
        },
      }),
    );

    expect(result).toEqual({
      kind: "render",
      gsspRes: null,
      isrRevalidateSeconds: 31536000,
      pageProps: { title: "static" },
    });
  });
});
