import { describe, expect, it, vi } from "vite-plus/test";
import { handleAppPrerenderEndpoint } from "../packages/vinext/src/server/app-prerender-endpoints.js";
import { createAppPrerenderStaticParamsResolver } from "../packages/vinext/src/server/app-prerender-static-params.js";
import {
  paramsToJson,
  staticParamsFromJson,
  staticPathsFromJson,
} from "../packages/vinext/src/server/prerender-static-params-json.js";
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
      // `locale` is not a root param here, so it is not in the scope.
      expect(() => getRootParam("locale")).toThrow(
        "the `locale` parameter was not provided by a parent `generateStaticParams`",
      );
      return [{ rootLang, slug: `${params.lang}-post` }];
    });
    const resolveStaticParams = createAppPrerenderStaticParamsResolver(
      [layoutGenerateStaticParams, pageGenerateStaticParams],
      ["lang"],
    );

    await expect(resolveStaticParams?.({ params: {} })).resolves.toEqual([
      { lang: "en", locale: "us", rootLang: "en", slug: "en-post" },
    ]);
    expect(pageGenerateStaticParams).toHaveBeenCalledWith({
      params: { lang: "en", locale: "us" },
    });
  });

  it("preserves incoming non-root parent params in the resolver", async () => {
    const first = vi.fn(async ({ params }) => {
      expect(params).toEqual({ lang: "en", category: "docs" });
      expect(await getRootParam("lang")).toBe("en");
      expect(() => getRootParam("category")).toThrow(
        "the `category` parameter was not provided by a parent `generateStaticParams`",
      );
      return [{ slug: `${params.category}-post` }];
    });

    const second = vi.fn(({ params }) => [{ final: params.slug }]);

    const resolve = createAppPrerenderStaticParamsResolver([first, second], ["lang"]);

    await expect(resolve?.({ params: { lang: "en", category: "docs" } })).resolves.toEqual([
      { lang: "en", category: "docs", slug: "docs-post", final: "docs-post" },
    ]);
  });

  it("rejects composed generateStaticParams when a source returns a non-array", async () => {
    const malformedLayoutGenerateStaticParams = vi.fn(() => undefined);
    const pageGenerateStaticParams = vi.fn(() => [{ slug: "unused" }]);
    const resolveStaticParams = createAppPrerenderStaticParamsResolver([
      malformedLayoutGenerateStaticParams,
      pageGenerateStaticParams,
    ]);

    await expect(resolveStaticParams?.({ params: {} })).rejects.toThrow(
      "generateStaticParams must return an array",
    );
    expect(pageGenerateStaticParams).not.toHaveBeenCalled();
  });

  // Next.js rejects malformed output in every mode (build/static-paths/app.ts
  // callGenerateStaticParams), so the endpoint must not report it as [].
  it("fails the static params endpoint on malformed output outside path discovery", async () => {
    const response = await handleAppPrerenderEndpoint(
      new Request("http://localhost/__vinext/prerender/static-params?pattern=layouts%3A%5Blang%5D"),
      {
        isPrerenderEnabled: () => true,
        pathname: "/__vinext/prerender/static-params",
        staticParamsMap: {
          "layouts:[lang]": createAppPrerenderStaticParamsResolver([() => [null]]),
        },
      },
    );

    expect(response?.status).toBe(500);
    await expect(response?.json()).resolves.toEqual({
      error: "Error: generateStaticParams must return an array of objects",
    });
  });

  // Next.js passes each parent set through a later generateStaticParams that
  // returns no params, and calls it once with `{}` while no parent sets exist
  // (build/static-paths/app.ts generateRouteStaticParams).
  it("passes parents through an empty composed source and calls the next one with no params", async () => {
    const pageGenerateStaticParams = vi.fn(() => [{ slug: "post" }]);
    const resolveStaticParams = createAppPrerenderStaticParamsResolver([
      () => [],
      pageGenerateStaticParams,
    ]);

    await expect(resolveStaticParams?.({ params: { lang: "en" } })).resolves.toEqual([
      { lang: "en", slug: "post" },
    ]);
    expect(pageGenerateStaticParams).toHaveBeenLastCalledWith({ params: { lang: "en" } });

    await expect(resolveStaticParams?.({ params: {} })).resolves.toEqual([{ slug: "post" }]);
    expect(pageGenerateStaticParams).toHaveBeenLastCalledWith({ params: {} });

    await expect(
      createAppPrerenderStaticParamsResolver([() => [], () => []])?.({ params: { lang: "en" } }),
    ).resolves.toEqual([{ lang: "en" }]);
  });

  // Under `output: "export"` and Cache Components, Next.js fails the build on
  // any empty result, so the resolver hands it back for the caller to reject.
  it("returns an empty composed result when the endpoint asks to reject empty results", async () => {
    const pageGenerateStaticParams = vi.fn(() => [{ slug: "post" }]);
    const response = await handleAppPrerenderEndpoint(
      new Request(
        "http://localhost/__vinext/prerender/static-params?pattern=%2F%3Alang%2F%3Aslug" +
          `&parentParams=${encodeURIComponent(JSON.stringify({ lang: "en" }))}&rejectEmptyResults=1`,
      ),
      {
        isPrerenderEnabled: () => true,
        pathname: "/__vinext/prerender/static-params",
        staticParamsMap: {
          "/:lang/:slug": createAppPrerenderStaticParamsResolver([
            () => [],
            pageGenerateStaticParams,
          ]),
        },
      },
    );

    await expect(response?.json()).resolves.toEqual([]);
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
    expect(response?.headers.get("cache-control")).toBe("no-store");
    await expect(response?.text()).resolves.toBe("This page could not be found");
  });

  it("asks for prerender or warm-up metadata routes by the request's query", async () => {
    const getMetadataRoutePaths = vi.fn(async (request: unknown) => [request]);
    const request = (search: string) =>
      handleAppPrerenderEndpoint(
        new Request(`http://localhost/__vinext/prerender/metadata-routes${search}`),
        {
          getMetadataRoutePaths,
          isPrerenderEnabled: () => true,
          pathname: "/__vinext/prerender/metadata-routes",
          staticParamsMap: {},
        },
      );

    await expect((await request(""))?.json()).resolves.toEqual([
      { enumerateDynamicPaths: true, warm: false },
    ]);
    await expect((await request("?warm=1"))?.json()).resolves.toEqual([
      { enumerateDynamicPaths: true, warm: true },
    ]);
    await expect((await request("?warm=1&dynamicPaths=0"))?.json()).resolves.toEqual([
      { enumerateDynamicPaths: false, warm: true },
    ]);
  });

  it("lists no metadata routes for a build without any", async () => {
    // Discovery asks every staged App Worker; page routing would otherwise
    // answer, e.g. with a trailingSlash redirect.
    const response = await handleAppPrerenderEndpoint(
      new Request("http://localhost/__vinext/prerender/metadata-routes?warm=1"),
      {
        isPrerenderEnabled: () => true,
        pathname: "/__vinext/prerender/metadata-routes",
        staticParamsMap: {},
      },
    );

    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toEqual([]);
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
    expect(response?.headers.get("cache-control")).toBe("no-store");
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

  // Next.js reads a present undefined optional catch-all as the root path but
  // a missing one as not provided (build/static-paths/pages.ts and app.ts
  // validateParams), so JSON must not drop the key.
  it("keeps a present undefined param through JSON and leaves a missing one out", async () => {
    const pageRoutes: TestPageRoute[] = [
      {
        module: {
          getStaticPaths: () => ({
            fallback: false,
            paths: ["/posts", { params: { slug: undefined }, locale: "fr" }, { params: {} }],
          }),
        },
        pattern: "/posts/:slug*",
      },
    ];
    const pagesResponse = await handleAppPrerenderEndpoint(
      new Request("http://localhost/__vinext/prerender/pages-static-paths?pattern=/posts/:slug*"),
      {
        isPrerenderEnabled: () => true,
        loadPagesRoutes: async () => pageRoutes,
        pathname: "/__vinext/prerender/pages-static-paths",
        staticParamsMap: {},
      },
    );
    const pagesResult = staticPathsFromJson(await pagesResponse?.json()) as {
      paths: [string, { params: object }, { params: object }];
    };
    expect(pagesResult).toEqual({
      fallback: false,
      paths: ["/posts", { params: { slug: undefined }, locale: "fr" }, { params: {} }],
    });
    expect(pagesResult.paths[1].params).toHaveProperty("slug");
    expect(pagesResult.paths[2].params).not.toHaveProperty("slug");

    const appResponse = await handleAppPrerenderEndpoint(
      new Request("http://localhost/__vinext/prerender/static-params?pattern=/:locale/:slug*"),
      {
        isPrerenderEnabled: () => true,
        pathname: "/__vinext/prerender/static-params",
        staticParamsMap: {
          "/:locale/:slug*": () => [{ locale: "en", slug: undefined }, { locale: "fr" }],
        },
      },
    );
    const appResult = staticParamsFromJson(await appResponse?.json()) as object[];
    expect(appResult).toEqual([{ locale: "en", slug: undefined }, { locale: "fr" }]);
    expect(appResult[0]).toHaveProperty("slug");
    expect(appResult[1]).not.toHaveProperty("slug");
  });

  it("reads every object param value back as an invalid object", async () => {
    // An object is never a valid param value, so Next.js rejects it. Through
    // JSON it must stay an object: not an undefined param (a valid root path)
    // and not whatever its toJSON returns.
    const response = await handleAppPrerenderEndpoint(
      new Request("http://localhost/__vinext/prerender/static-params?pattern=/:slug*"),
      {
        isPrerenderEnabled: () => true,
        pathname: "/__vinext/prerender/static-params",
        staticParamsMap: {
          "/:slug*": () => [
            { slug: { __vinextParam: "undefined" } },
            { slug: { toJSON: () => undefined } },
            { slug: { toJSON: (key: string) => (key === "slug" ? { invalid: true } : "a") } },
          ],
        },
      },
    );
    expect(staticParamsFromJson(await response?.json())).toEqual([
      { slug: {} },
      { slug: {} },
      { slug: {} },
    ]);
  });

  it("reads each getStaticPaths result property once", async () => {
    let reads = 0;
    const result = {
      fallback: false,
      get paths() {
        if (++reads > 1) throw new Error("read twice");
        return [{ params: { slug: undefined } }];
      },
    };
    const response = await handleAppPrerenderEndpoint(
      new Request("http://localhost/__vinext/prerender/pages-static-paths?pattern=/:slug*"),
      {
        isPrerenderEnabled: () => true,
        loadPagesRoutes: async () => [
          { module: { getStaticPaths: () => result }, pattern: "/:slug*" },
        ],
        pathname: "/__vinext/prerender/pages-static-paths",
        staticParamsMap: {},
      },
    );
    expect(response?.status).toBe(200);
    expect(staticPathsFromJson(await response?.json())).toEqual({
      fallback: false,
      paths: [{ params: { slug: undefined } }],
    });
  });

  // Next.js passes a layout's own undefined param to the child
  // generateStaticParams (build/static-paths/app.ts generateRouteStaticParams).
  it("passes a parent's own undefined param to generateStaticParams", async () => {
    const generateStaticParams = vi.fn((_input: { params: object }) => []);
    const search = new URLSearchParams({
      pattern: "/:locale/:slug",
      parentParams: JSON.stringify(paramsToJson({ locale: undefined })),
    });
    await handleAppPrerenderEndpoint(
      new Request(`http://localhost/__vinext/prerender/static-params?${search}`),
      {
        isPrerenderEnabled: () => true,
        pathname: "/__vinext/prerender/static-params",
        staticParamsMap: { "/:locale/:slug": generateStaticParams },
      },
    );
    expect(generateStaticParams).toHaveBeenCalledWith({ params: { locale: undefined } });
    expect(generateStaticParams.mock.calls[0]?.[0]).toHaveProperty("params.locale");
  });

  it("returns no content when the requested prerender function is absent", async () => {
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

    expect(staticParamsResponse?.status).toBe(204);
    expect(staticParamsResponse?.headers.get("cache-control")).toBe("no-store");
    await expect(staticParamsResponse?.text()).resolves.toBe("");
    expect(pagesResponse?.status).toBe(204);
    await expect(pagesResponse?.text()).resolves.toBe("");
  });

  it("returns no content when a lazy App route resolves without a generator", async () => {
    const response = await handleAppPrerenderEndpoint(
      new Request("http://localhost/__vinext/prerender/static-params?pattern=/dynamic/:slug"),
      {
        isPrerenderEnabled: () => true,
        pathname: "/__vinext/prerender/static-params",
        staticParamsMap: { "/dynamic/:slug": async () => null },
      },
    );

    expect(response?.status).toBe(204);
    await expect(response?.text()).resolves.toBe("");
  });

  it("returns no content when the Pages Router loader returns a non-route shape", async () => {
    const response = await handleAppPrerenderEndpoint(
      new Request("http://localhost/__vinext/prerender/pages-static-paths?pattern=/missing"),
      {
        isPrerenderEnabled: () => true,
        loadPagesRoutes: async () => ({ pageRoutes: [] }),
        pathname: "/__vinext/prerender/pages-static-paths",
        staticParamsMap: {},
      },
    );

    expect(response?.status).toBe(204);
    await expect(response?.text()).resolves.toBe("");
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
    expect(missingPatternResponse?.headers.get("cache-control")).toBe("no-store");
    await expect(missingPatternResponse?.text()).resolves.toBe("missing pattern");
    expect(thrownResponse?.status).toBe(500);
    await expect(thrownResponse?.json()).resolves.toEqual({ error: "Error: boom" });
  });
});
