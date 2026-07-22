import { describe, expect, it, vi } from "vite-plus/test";
import { handleAppPrerenderEndpoint } from "../packages/vinext/src/server/app-prerender-endpoints.js";
import { createAppPrerenderStaticParamsResolver } from "../packages/vinext/src/server/app-prerender-static-params.js";
import { getRootParam } from "../packages/vinext/src/shims/root-params.js";

type TestPageRoute = {
  pattern: string;
  module?: {
    getStaticPaths?: (opts: { locales: string[]; defaultLocale: string }) => unknown;
  };
};

describe("App prerender endpoint helpers", () => {
  it("composes layout and page generateStaticParams sources top-down", async () => {
    // Ported from Next.js: test/e2e/app-dir/app-root-params-getters/generate-static-params.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app-root-params-getters/generate-static-params.test.ts
    const layoutGenerateStaticParams = vi.fn(() => [
      { lang: "en", locale: "us" },
      { lang: "es", locale: "es" },
    ]);
    const pageGenerateStaticParams = vi.fn(({ params }) => [{ slug: `${params.lang}-post` }]);
    const resolveStaticParams = createAppPrerenderStaticParamsResolver([
      layoutGenerateStaticParams,
      pageGenerateStaticParams,
    ]);

    await expect(resolveStaticParams?.({ params: {} })).resolves.toEqual([
      { lang: "en", locale: "us", slug: "en-post" },
      { lang: "es", locale: "es", slug: "es-post" },
    ]);
    expect(pageGenerateStaticParams).toHaveBeenCalledWith({
      params: { lang: "en", locale: "us" },
    });
    expect(pageGenerateStaticParams).toHaveBeenCalledWith({
      params: { lang: "es", locale: "es" },
    });
  });

  it("filters non-root params from root param scope in resolver while preserving them in params argument", async () => {
    const layoutGenerateStaticParams = vi.fn(() => [{ lang: "en", locale: "us" }]);
    const pageGenerateStaticParams = vi.fn(async ({ params }) => {
      const rootLang = await getRootParam("lang");
      const rootLocale = await getRootParam("locale");
      return [{ rootLang, rootLocale, slug: `${params.lang}-post` }];
    });
    const resolveStaticParams = createAppPrerenderStaticParamsResolver(
      [layoutGenerateStaticParams, pageGenerateStaticParams],
      ["lang"],
    );

    await expect(resolveStaticParams?.({ params: {} })).resolves.toEqual([
      { lang: "en", locale: "us", rootLang: "en", rootLocale: undefined, slug: "en-post" },
    ]);
    expect(pageGenerateStaticParams).toHaveBeenCalledWith({
      params: { lang: "en", locale: "us" },
    });
  });

  it("preserves incoming non-root parent params in the resolver", async () => {
    const first = vi.fn(async ({ params }) => {
      expect(params).toEqual({ lang: "en", category: "docs" });
      expect(await getRootParam("lang")).toBe("en");
      expect(await getRootParam("category")).toBeUndefined();
      return [{ slug: `${params.category}-post` }];
    });

    const second = vi.fn(({ params }) => [{ final: params.slug }]);

    const resolve = createAppPrerenderStaticParamsResolver([first, second], ["lang"]);

    await expect(resolve?.({ params: { lang: "en", category: "docs" } })).resolves.toEqual([
      { lang: "en", category: "docs", slug: "docs-post", final: "docs-post" },
    ]);
  });

  it("bails out of composed generateStaticParams when a source returns a non-array", async () => {
    const malformedLayoutGenerateStaticParams = vi.fn(() => undefined);
    const pageGenerateStaticParams = vi.fn(() => [{ slug: "unused" }]);
    const resolveStaticParams = createAppPrerenderStaticParamsResolver([
      malformedLayoutGenerateStaticParams,
      pageGenerateStaticParams,
    ]);

    await expect(resolveStaticParams?.({ params: {} })).resolves.toEqual([]);
    expect(pageGenerateStaticParams).not.toHaveBeenCalled();
  });

  it("treats lazy missing page generateStaticParams exports as absent", async () => {
    const layoutGenerateStaticParams = vi.fn(() => [{ category: "docs" }]);
    const loadMissingPageModule = vi.fn(async () => ({ default: () => null }));
    const resolveStaticParams = createAppPrerenderStaticParamsResolver([
      layoutGenerateStaticParams,
      { load: loadMissingPageModule },
    ]);

    await expect(resolveStaticParams?.({ params: {} })).resolves.toEqual([{ category: "docs" }]);
    expect(loadMissingPageModule).toHaveBeenCalledTimes(1);

    const resolveMissingOnly = createAppPrerenderStaticParamsResolver([
      { load: loadMissingPageModule },
    ]);
    await expect(resolveMissingOnly?.({ params: {} })).resolves.toBeNull();
  });

  it("falls through for non-prerender requests", async () => {
    const response = await handleAppPrerenderEndpoint(new Request("http://localhost/blog/post"), {
      isPrerenderEnabled: () => true,
      pathname: "/blog/post",
      staticParamsMap: {},
    });

    expect(response).toBeNull();
  });

  it("returns 404 for prerender endpoints outside prerender mode", async () => {
    const response = await handleAppPrerenderEndpoint(
      new Request("http://localhost/__vinext/prerender/static-params?pattern=/blog/:slug"),
      {
        isPrerenderEnabled: () => false,
        pathname: "/__vinext/prerender/static-params",
        staticParamsMap: {
          "/blog/:slug": () => [{ slug: "hello" }],
        },
      },
    );

    expect(response?.status).toBe(404);
    await expect(response?.text()).resolves.toBe("This page could not be found");
  });

  it("calls generateStaticParams with object parent params and serializes the result", async () => {
    const generateStaticParams = vi.fn(({ params }) => [
      { category: params.category, slug: "hello" },
    ]);

    const response = await handleAppPrerenderEndpoint(
      new Request(
        "http://localhost/__vinext/prerender/static-params?pattern=/blog/:slug&parentParams=%7B%22category%22%3A%22docs%22%7D",
      ),
      {
        isPrerenderEnabled: () => true,
        pathname: "/__vinext/prerender/static-params",
        staticParamsMap: {
          "/blog/:slug": generateStaticParams,
        },
      },
    );

    expect(generateStaticParams).toHaveBeenCalledWith({ params: { category: "docs" } });
    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toEqual([{ category: "docs", slug: "hello" }]);
  });

  it("seeds root params while calling generateStaticParams", async () => {
    const generateStaticParams = vi.fn(async ({ params }) => [
      { locale: await getRootParam("locale"), slug: params.slug },
    ]);

    const response = await handleAppPrerenderEndpoint(
      new Request(
        "http://localhost/__vinext/prerender/static-params?pattern=/:locale/blog/:slug&parentParams=%7B%22locale%22%3A%22en%22%2C%22slug%22%3A%22hello%22%7D",
      ),
      {
        isPrerenderEnabled: () => true,
        pathname: "/__vinext/prerender/static-params",
        rootParamNamesByPattern: {
          "/:locale/blog/:slug": ["locale"],
        },
        staticParamsMap: {
          "/:locale/blog/:slug": generateStaticParams,
        },
      },
    );

    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toEqual([{ locale: "en", slug: "hello" }]);
    await expect(getRootParam("locale")).resolves.toBeUndefined();
  });

  it("passes empty parent params when static param input is not an object", async () => {
    const generateStaticParams = vi.fn(() => []);

    const response = await handleAppPrerenderEndpoint(
      new Request(
        "http://localhost/__vinext/prerender/static-params?pattern=/blog/:slug&parentParams=5",
      ),
      {
        isPrerenderEnabled: () => true,
        pathname: "/__vinext/prerender/static-params",
        staticParamsMap: {
          "/blog/:slug": generateStaticParams,
        },
      },
    );

    expect(generateStaticParams).toHaveBeenCalledWith({ params: {} });
    expect(response?.status).toBe(200);
  });

  it("loads Pages Router routes lazily and calls getStaticPaths", async () => {
    const getStaticPaths = vi.fn(() => ({
      fallback: false,
      paths: [{ params: { id: "first" } }],
    }));
    const pageRoutes: TestPageRoute[] = [
      {
        module: { getStaticPaths },
        pattern: "/posts/:id",
      },
    ];

    const response = await handleAppPrerenderEndpoint(
      new Request(
        "http://localhost/__vinext/prerender/pages-static-paths?pattern=/posts/:id&locales=%5B%22en%22%5D&defaultLocale=en",
      ),
      {
        isPrerenderEnabled: () => true,
        loadPagesRoutes: async () => pageRoutes,
        pathname: "/__vinext/prerender/pages-static-paths",
        staticParamsMap: {},
      },
    );

    expect(getStaticPaths).toHaveBeenCalledWith({ defaultLocale: "en", locales: ["en"] });
    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toEqual({
      fallback: false,
      paths: [{ params: { id: "first" } }],
    });
  });

  it("returns JSON null when the requested prerender function is absent", async () => {
    const staticParamsResponse = await handleAppPrerenderEndpoint(
      new Request("http://localhost/__vinext/prerender/static-params?pattern=/missing"),
      {
        isPrerenderEnabled: () => true,
        pathname: "/__vinext/prerender/static-params",
        staticParamsMap: {},
      },
    );
    const pagesResponse = await handleAppPrerenderEndpoint(
      new Request("http://localhost/__vinext/prerender/pages-static-paths?pattern=/missing"),
      {
        isPrerenderEnabled: () => true,
        loadPagesRoutes: async () => [],
        pathname: "/__vinext/prerender/pages-static-paths",
        staticParamsMap: {},
      },
    );

    expect(staticParamsResponse?.status).toBe(200);
    await expect(staticParamsResponse?.text()).resolves.toBe("null");
    expect(pagesResponse?.status).toBe(200);
    await expect(pagesResponse?.text()).resolves.toBe("null");
  });

  it("returns JSON null when the Pages Router loader returns a non-route shape", async () => {
    const response = await handleAppPrerenderEndpoint(
      new Request("http://localhost/__vinext/prerender/pages-static-paths?pattern=/missing"),
      {
        isPrerenderEnabled: () => true,
        loadPagesRoutes: async () => ({ pageRoutes: [] }),
        pathname: "/__vinext/prerender/pages-static-paths",
        staticParamsMap: {},
      },
    );

    expect(response?.status).toBe(200);
    await expect(response?.text()).resolves.toBe("null");
  });

  it("returns explicit endpoint errors for missing query fields and thrown user functions", async () => {
    const missingPatternResponse = await handleAppPrerenderEndpoint(
      new Request("http://localhost/__vinext/prerender/static-params"),
      {
        isPrerenderEnabled: () => true,
        pathname: "/__vinext/prerender/static-params",
        staticParamsMap: {},
      },
    );
    const thrownResponse = await handleAppPrerenderEndpoint(
      new Request("http://localhost/__vinext/prerender/static-params?pattern=/blog/:slug"),
      {
        isPrerenderEnabled: () => true,
        pathname: "/__vinext/prerender/static-params",
        staticParamsMap: {
          "/blog/:slug": () => {
            throw new Error("boom");
          },
        },
      },
    );

    expect(missingPatternResponse?.status).toBe(400);
    await expect(missingPatternResponse?.text()).resolves.toBe("missing pattern");
    expect(thrownResponse?.status).toBe(500);
    await expect(thrownResponse?.json()).resolves.toEqual({ error: "Error: boom" });
  });
});
