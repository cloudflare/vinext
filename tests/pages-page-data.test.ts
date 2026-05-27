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

  it("serves stale ISR entries immediately and regenerates them through typed helpers", async () => {
    let regenPromise: Promise<void> | null = null;
    const applyRequestContexts = vi.fn();
    const isrSet = vi.fn(async () => {});
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
          async getStaticProps() {
            return {
              props: { title: "fresh" },
              revalidate: 15,
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
    expect(applyRequestContexts).toHaveBeenCalledOnce();
    expect(isrSet).toHaveBeenCalledWith(
      "pages:/posts/post",
      expect.objectContaining({
        kind: "PAGES",
        html: expect.stringContaining("<div>fresh-body</div>"),
        pageData: { title: "fresh" },
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
        pageData: { title: "fresh" },
      }),
      15,
      undefined,
      300,
    );
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
      gsspRes: null,
      isrRevalidateSeconds: 30,
      pageProps: { title: "hello" },
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
});
