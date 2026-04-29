import { describe, expect, it, vi } from "vite-plus/test";
import { handleAppPrerenderEndpoint } from "../packages/vinext/src/server/app-prerender-endpoints.js";

type TestPageRoute = {
  pattern: string;
  module?: {
    getStaticPaths?: (opts: { locales: string[]; defaultLocale: string }) => unknown;
  };
};

describe("App prerender endpoint helpers", () => {
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
    await expect(response?.text()).resolves.toBe("Not Found");
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
