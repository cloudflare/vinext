import { describe, expect, it, vi } from "vite-plus/test";
import { resolveAppPageSpecialError } from "../packages/vinext/src/server/app-page-execution.js";
import {
  buildAppPageElement,
  resolveAppPageActionRerenderTarget,
  resolveAppPageIntercept,
  resolveAppPageInterceptMatch,
  resolveAppPageGenerateStaticParamsSources,
  validateAppPageDynamicParams,
} from "../packages/vinext/src/server/app-page-request.js";

describe("app page request helpers", () => {
  it("returns 404 when dynamicParams=false receives unknown params", async () => {
    const response = await validateAppPageDynamicParams({
      enforceStaticParamsOnly: true,
      async generateStaticParams() {
        return [{ slug: "known-post" }];
      },
      isDynamicRoute: true,
      params: { slug: "missing-post" },
    });

    expect(response?.status).toBe(404);
    await expect(response?.text()).resolves.toBe("This page could not be found");
  });

  it("returns 404 when dynamicParams=false has no static params sources", async () => {
    const response = await validateAppPageDynamicParams({
      enforceStaticParamsOnly: true,
      generateStaticParams: undefined,
      isDynamicRoute: true,
      params: { slug: "anything" },
    });

    expect(response?.status).toBe(404);
    await expect(response?.text()).resolves.toBe("This page could not be found");
  });

  it("allows matching static params, including nested parent params", async () => {
    const response = await validateAppPageDynamicParams({
      enforceStaticParamsOnly: true,
      async generateStaticParams() {
        return [{ item: "shoe" }];
      },
      isDynamicRoute: true,
      params: { category: "fashion", item: "shoe" },
    });

    expect(response).toBeNull();
  });

  it("allows canonical encoded App Page params from generateStaticParams", async () => {
    const response = await validateAppPageDynamicParams({
      enforceStaticParamsOnly: true,
      async generateStaticParams() {
        return [{ id: "sticks & stones", path: ["a/b", "%61"] }];
      },
      isDynamicRoute: true,
      params: {
        id: "sticks%20%26%20stones",
        path: ["a%2Fb", "%2561"],
      },
    });

    expect(response).toBeNull();
  });

  it("does not treat an encoded delimiter as an alias for a literal static value", async () => {
    const generateStaticParams = async () => [{ id: "a%2Fb" }];

    const encodedLiteral = await validateAppPageDynamicParams({
      enforceStaticParamsOnly: true,
      generateStaticParams,
      isDynamicRoute: true,
      params: { id: "a%252Fb" },
    });
    expect(encodedLiteral).toBeNull();

    const delimiterAlias = await validateAppPageDynamicParams({
      enforceStaticParamsOnly: true,
      generateStaticParams,
      isDynamicRoute: true,
      params: { id: "a%2Fb" },
    });
    expect(delimiterAlias?.status).toBe(404);
  });

  it("requires every segment generateStaticParams source to allow the params", async () => {
    const layoutGenerateStaticParams = async () => [{ category: "docs" }];
    const pageGenerateStaticParams = async () => [{ slug: "intro" }];

    const response = await validateAppPageDynamicParams({
      enforceStaticParamsOnly: true,
      generateStaticParams: [layoutGenerateStaticParams, pageGenerateStaticParams],
      isDynamicRoute: true,
      params: { category: "docs", slug: "missing" },
    });

    expect(response?.status).toBe(404);
  });

  it("passes parent-only params to each generateStaticParams source", async () => {
    const categoryGenerateStaticParams = vi.fn(() => [{ category: "docs" }]);
    const itemGenerateStaticParams = vi.fn(
      ({ params }: { params: Record<string, string | string[]> }) => {
        if (params.category !== "docs" || params.slug !== undefined) {
          return [];
        }
        return [{ slug: "intro" }];
      },
    );

    const response = await validateAppPageDynamicParams({
      enforceStaticParamsOnly: true,
      generateStaticParams: resolveAppPageGenerateStaticParamsSources({
        layouts: [null, { generateStaticParams: categoryGenerateStaticParams }],
        layoutTreePositions: [0, 1],
        page: { generateStaticParams: itemGenerateStaticParams },
        routeSegments: ["[category]", "[slug]"],
      }),
      isDynamicRoute: true,
      params: { category: "docs", slug: "intro" },
    });

    expect(response).toBeNull();
    expect(categoryGenerateStaticParams).toHaveBeenCalledWith({ params: {} });
    expect(itemGenerateStaticParams).toHaveBeenCalledWith({ params: { category: "docs" } });
  });

  it("ignores route groups when finding a layout generateStaticParams boundary", async () => {
    const generateStaticParams = vi.fn(() => [{ region: "SE" }]);
    const response = await validateAppPageDynamicParams({
      enforceStaticParamsOnly: true,
      generateStaticParams: resolveAppPageGenerateStaticParamsSources({
        layouts: [null, { generateStaticParams }],
        layoutTreePositions: [0, 2],
        routeSegments: ["[region]", "(default)", "static-prefetch"],
      }),
      isDynamicRoute: true,
      params: { region: "SE" },
    });

    expect(response).toBeNull();
    expect(generateStaticParams).toHaveBeenCalledWith({ params: {} });
  });

  it("chains parent layout params through a route-group layout", async () => {
    const regionGenerateStaticParams = vi.fn(() => [{ region: "EU" }]);
    const languageGenerateStaticParams = vi.fn(
      ({ params }: { params: Record<string, string | string[]> }) =>
        params.region === "EU" ? [{ lang: "En" }] : [],
    );
    const generateStaticParams = resolveAppPageGenerateStaticParamsSources({
      layouts: [
        null,
        { generateStaticParams: regionGenerateStaticParams },
        { generateStaticParams: languageGenerateStaticParams },
      ],
      layoutTreePositions: [0, 1, 2],
      routeSegments: ["[region]", "(group)", "[lang]"],
    });

    await expect(
      validateAppPageDynamicParams({
        enforceStaticParamsOnly: true,
        generateStaticParams,
        isDynamicRoute: true,
        params: { region: "EU", lang: "En" },
      }),
    ).resolves.toBeNull();
    expect(regionGenerateStaticParams).toHaveBeenCalledWith({ params: {} });
    expect(languageGenerateStaticParams).toHaveBeenCalledWith({ params: { region: "EU" } });

    await expect(
      validateAppPageDynamicParams({
        enforceStaticParamsOnly: true,
        generateStaticParams,
        isDynamicRoute: true,
        params: { region: "EU", lang: "en" },
      }),
    ).resolves.toMatchObject({ status: 404 });
  });

  it("validates chained and parallel branch params independently", async () => {
    const localeGenerateStaticParams = vi.fn(() => [{ locale: "en" }]);
    const slugGenerateStaticParams = vi.fn(() => [{ slug: "static-123" }]);
    const generateStaticParams = resolveAppPageGenerateStaticParamsSources({
      layouts: [null, { generateStaticParams: localeGenerateStaticParams }],
      layoutTreePositions: [0, 1],
      parallelBranches: [
        {
          configLayouts: [null, { generateStaticParams: slugGenerateStaticParams }],
          configLayoutTreePositions: [1, 2],
          paramNames: ["locale", "slug"],
          patternParts: [":locale", "gsp", "stories", ":slug"],
          routeSegments: ["stories", "[slug]"],
        },
      ],
      routePatternParts: [":locale", "gsp", "stories", ":slug"],
      routeSegments: ["[locale]", "gsp", "stories", "[slug]"],
    });
    const validate = (locale: string, slug: string) =>
      validateAppPageDynamicParams({
        enforceStaticParamsOnly: true,
        generateStaticParams,
        isDynamicRoute: true,
        params: { locale, slug },
      });

    await expect(validate("en", "static-123")).resolves.toBeNull();
    await expect(validate("fr", "static-123")).resolves.toMatchObject({ status: 404 });
    await expect(validate("en", "dynamic-123")).resolves.toMatchObject({ status: 404 });
  });

  it("keeps primary params when a parallel generator omits that key", async () => {
    const localeGenerateStaticParams = vi.fn(() => [{ locale: "en" }]);
    const slugGenerateStaticParams = vi.fn(() => [{ slug: "main" }]);
    const parallelGenerateStaticParams = vi.fn(() => [{ locale: "en" }]);
    const generateStaticParams = resolveAppPageGenerateStaticParamsSources({
      layouts: [null, { generateStaticParams: localeGenerateStaticParams }],
      layoutTreePositions: [0, 1],
      page: { generateStaticParams: slugGenerateStaticParams },
      parallelBranches: [
        {
          configLayouts: [null, { generateStaticParams: parallelGenerateStaticParams }],
          configLayoutTreePositions: [1, 2],
          paramNames: ["locale", "slug"],
          patternParts: [":locale", "ownership", "stories", ":slug"],
          routeSegments: ["stories", "[slug]"],
        },
      ],
      routePatternParts: [":locale", "ownership", "stories", ":slug"],
      routeSegments: ["[locale]", "ownership", "stories", "[slug]"],
    });
    const validate = (slug: string) =>
      validateAppPageDynamicParams({
        enforceStaticParamsOnly: true,
        generateStaticParams,
        isDynamicRoute: true,
        params: { locale: "en", slug },
      });

    await expect(validate("main")).resolves.toBeNull();
    await expect(validate("other")).resolves.toMatchObject({ status: 404 });
    expect(parallelGenerateStaticParams).toHaveBeenCalledWith({ params: { locale: "en" } });
  });

  it("preserves ownership for each parallel generator result", async () => {
    const generateStaticParams = resolveAppPageGenerateStaticParamsSources({
      layouts: [null, { generateStaticParams: () => [{ locale: "en" }] }],
      layoutTreePositions: [0, 1],
      page: { generateStaticParams: () => [{ slug: "main" }] },
      parallelBranches: [
        {
          configLayouts: [null, { generateStaticParams: () => [{}, { slug: "parallel" }] }],
          configLayoutTreePositions: [1, 2],
          paramNames: ["locale", "slug"],
          patternParts: [":locale", "ownership", "stories", ":slug"],
          routeSegments: ["stories", "[slug]"],
        },
      ],
      routePatternParts: [":locale", "ownership", "stories", ":slug"],
      routeSegments: ["[locale]", "ownership", "stories", "[slug]"],
    });
    const validate = (slug: string) =>
      validateAppPageDynamicParams({
        enforceStaticParamsOnly: true,
        generateStaticParams,
        isDynamicRoute: true,
        params: { locale: "en", slug },
      });

    await expect(validate("main")).resolves.toBeNull();
    await expect(validate("parallel")).resolves.toBeNull();
    await expect(validate("other")).resolves.toMatchObject({ status: 404 });
  });

  it("preserves primary params when a parallel generator returns no results", async () => {
    const generateStaticParams = resolveAppPageGenerateStaticParamsSources({
      layouts: [null, { generateStaticParams: () => [{ locale: "en" }] }],
      layoutTreePositions: [0, 1],
      page: { generateStaticParams: () => [{ slug: "main" }] },
      parallelBranches: [
        {
          configLayouts: [null, { generateStaticParams: () => [] }],
          configLayoutTreePositions: [1, 2],
          paramNames: ["locale", "slug"],
          patternParts: [":locale", "empty-ownership", "stories", ":slug"],
          routeSegments: ["stories", "[slug]"],
        },
      ],
      routePatternParts: [":locale", "empty-ownership", "stories", ":slug"],
      routeSegments: ["[locale]", "empty-ownership", "stories", "[slug]"],
    });
    const validate = (slug: string) =>
      validateAppPageDynamicParams({
        enforceStaticParamsOnly: true,
        generateStaticParams,
        isDynamicRoute: true,
        params: { locale: "en", slug },
      });

    await expect(validate("main")).resolves.toBeNull();
    await expect(validate("other")).resolves.toMatchObject({ status: 404 });
  });

  it("chains multiple generators within one parallel branch", async () => {
    const firstGenerateStaticParams = vi.fn(() => [{ slug: "a" }]);
    const secondGenerateStaticParams = vi.fn(() => [{ slug: "b" }]);
    const generateStaticParams = resolveAppPageGenerateStaticParamsSources({
      layouts: [null, { generateStaticParams: () => [{ locale: "en" }] }],
      layoutTreePositions: [0, 1],
      page: { generateStaticParams: () => [{ slug: "main" }] },
      parallelBranches: [
        {
          configLayouts: [null, { generateStaticParams: firstGenerateStaticParams }],
          configLayoutTreePositions: [1, 2],
          page: { generateStaticParams: secondGenerateStaticParams },
          paramNames: ["locale", "slug"],
          patternParts: [":locale", "sequential-ownership", "stories", ":slug"],
          routeSegments: ["stories", "[slug]"],
        },
      ],
      routePatternParts: [":locale", "sequential-ownership", "stories", ":slug"],
      routeSegments: ["[locale]", "sequential-ownership", "stories", "[slug]"],
    });
    const validate = (slug: string) =>
      validateAppPageDynamicParams({
        enforceStaticParamsOnly: true,
        generateStaticParams,
        isDynamicRoute: true,
        params: { locale: "en", slug },
      });

    await expect(validate("b")).resolves.toBeNull();
    await expect(validate("a")).resolves.toMatchObject({ status: 404 });
    await expect(validate("main")).resolves.toMatchObject({ status: 404 });
    expect(firstGenerateStaticParams).toHaveBeenCalledWith({ params: { locale: "en" } });
    expect(secondGenerateStaticParams).toHaveBeenCalledWith({
      params: { locale: "en", slug: "a" },
    });
  });

  it("enforces generateStaticParams from a parallel page", async () => {
    const response = await validateAppPageDynamicParams({
      enforceStaticParamsOnly: true,
      generateStaticParams: resolveAppPageGenerateStaticParamsSources({
        parallelBranches: [
          {
            page: { generateStaticParams: () => [{ slug: "static-123" }] },
            paramNames: ["locale", "slug"],
            patternParts: [":locale", "gsp", "stories", ":slug"],
            routeSegments: ["stories", "[slug]"],
          },
        ],
        routePatternParts: [":locale", "gsp", "stories", ":slug"],
        routeSegments: ["[locale]", "gsp", "stories", "[slug]"],
      }),
      isDynamicRoute: true,
      params: { locale: "en", slug: "dynamic-123" },
    });

    expect(response?.status).toBe(404);
  });

  it("remaps parallel page params before validating generateStaticParams", async () => {
    const generateStaticParams = vi.fn(() => [{ name: "post" }]);
    const response = await validateAppPageDynamicParams({
      enforceStaticParamsOnly: true,
      generateStaticParams: resolveAppPageGenerateStaticParamsSources({
        parallelBranches: [
          {
            page: { generateStaticParams },
            paramNames: ["name"],
            patternParts: [":name"],
            routeSegments: ["[name]"],
          },
        ],
        routePatternParts: [":id"],
        routeSegments: ["[id]"],
      }),
      isDynamicRoute: true,
      params: { id: "post" },
    });

    expect(response).toBeNull();
    expect(generateStaticParams).toHaveBeenCalledWith({ params: {} });
  });

  it("collects generateStaticParams from active parallel layouts", async () => {
    const rootLayoutGenerateStaticParams = vi.fn(() => [{ locale: "en" }]);
    const nestedLayoutGenerateStaticParams = vi.fn(() => [{ slug: "static-123" }]);
    const generateStaticParams = resolveAppPageGenerateStaticParamsSources({
      parallelBranches: [
        {
          layout: { generateStaticParams: rootLayoutGenerateStaticParams },
          configLayouts: [null, { generateStaticParams: nestedLayoutGenerateStaticParams }],
          configLayoutTreePositions: [1, 2],
          paramNames: ["locale", "slug"],
          patternParts: [":locale", "gsp", "stories", ":slug"],
          routeSegments: ["stories", "[slug]"],
        },
      ],
      routePatternParts: [":locale", "gsp", "stories", ":slug"],
      routeSegments: ["[locale]", "gsp", "stories", "[slug]"],
    });
    const validate = (slug: string) =>
      validateAppPageDynamicParams({
        enforceStaticParamsOnly: true,
        generateStaticParams,
        isDynamicRoute: true,
        params: { locale: "en", slug },
      });

    await expect(validate("static-123")).resolves.toBeNull();
    await expect(validate("dynamic-123")).resolves.toMatchObject({ status: 404 });
    expect(rootLayoutGenerateStaticParams).toHaveBeenCalledWith({ params: { locale: "en" } });
    expect(nestedLayoutGenerateStaticParams).toHaveBeenCalledWith({ params: { locale: "en" } });
  });

  // Ported from Next.js: packages/next/src/build/static-paths/app.test.ts
  // https://github.com/vercel/next.js/blob/canary/packages/next/src/build/static-paths/app.test.ts
  it("throws when generateStaticParams throws", async () => {
    const error = new Error("boom");

    await expect(
      validateAppPageDynamicParams({
        enforceStaticParamsOnly: true,
        async generateStaticParams() {
          throw error;
        },
        isDynamicRoute: true,
        params: { slug: "post" },
      }),
    ).rejects.toThrow(error);
  });

  // Ported from Next.js: packages/next/src/build/static-paths/app.test.ts
  // https://github.com/vercel/next.js/blob/canary/packages/next/src/build/static-paths/app.test.ts
  it("throws when generateStaticParams rejects", async () => {
    const error = new Error("async boom");

    await expect(
      validateAppPageDynamicParams({
        enforceStaticParamsOnly: true,
        async generateStaticParams() {
          return Promise.reject(error);
        },
        isDynamicRoute: true,
        params: { slug: "post" },
      }),
    ).rejects.toThrow(error);
  });

  // Ported from Next.js: packages/next/src/build/static-paths/app.test.ts
  // https://github.com/vercel/next.js/blob/canary/packages/next/src/build/static-paths/app.test.ts
  it("does not check remaining sources when an earlier generateStaticParams source throws", async () => {
    const throwsSource = vi.fn(() => {
      throw new Error("source 1 failed");
    });
    const rejectsSource = vi.fn(async () => [{ slug: "other" }]);

    await expect(
      validateAppPageDynamicParams({
        enforceStaticParamsOnly: true,
        generateStaticParams: [throwsSource, rejectsSource],
        isDynamicRoute: true,
        params: { slug: "target" },
      }),
    ).rejects.toThrow("source 1 failed");

    expect(throwsSource).toHaveBeenCalledTimes(1);
    expect(rejectsSource).not.toHaveBeenCalled();
  });

  it("returns 404 when generateStaticParams excludes the requested params", async () => {
    const response = await validateAppPageDynamicParams({
      enforceStaticParamsOnly: true,
      generateStaticParams: async () => [{ slug: "other" }],
      isDynamicRoute: true,
      params: { slug: "target" },
    });

    expect(response?.status).toBe(404);
  });

  it("renders intercepted source routes on RSC navigations", async () => {
    const setNavigationContext = vi.fn();
    const buildPageElementMock = vi.fn(async () => ({ type: "intercept-element" }));
    const renderInterceptResponse = vi.fn(async () => new Response("intercepted"));
    const currentRoute = { params: ["id"], pattern: "/photos/[id]" };
    const sourceRoute = { params: ["locale", "tab"], pattern: "/[locale]/feed/[tab]" };

    const result = await resolveAppPageIntercept({
      buildPageElement: buildPageElementMock,
      cleanPathname: "/photos/123",
      currentRoute,
      findIntercept() {
        return {
          matchedParams: { locale: "en", id: "123" },
          sourceMatchedParams: { locale: "en", tab: "recent" },
          page: { default: "modal-page" },
          slotKey: "modal@app/feed/@modal",
          sourceRouteIndex: 0,
        };
      },
      getRouteParamNames(route) {
        return route.params;
      },
      getSourceRoute() {
        return sourceRoute;
      },
      isRscRequest: true,
      resolveNavigationParams(_route, params) {
        return { ...params, catchAll: ["photos", "123"] };
      },
      renderInterceptResponse,
      searchParams: new URLSearchParams("from=feed"),
      setNavigationContext,
      toInterceptOpts(intercept) {
        return {
          interceptPage: intercept.page,
          interceptParams: intercept.matchedParams,
          interceptSlotKey: intercept.slotKey,
        };
      },
    });

    expect(result.interceptOpts).toBeUndefined();
    expect(result.response).toBeInstanceOf(Response);
    expect(setNavigationContext).toHaveBeenCalledWith({
      params: {
        locale: "en",
        tab: "recent",
        id: "123",
        catchAll: ["photos", "123"],
      },
      pathname: "/photos/123",
      searchParams: new URLSearchParams("from=feed"),
    });
    expect(buildPageElementMock).toHaveBeenCalledWith(
      sourceRoute,
      { locale: "en", tab: "recent" },
      {
        interceptPage: { default: "modal-page" },
        interceptParams: { locale: "en", id: "123" },
        interceptSlotKey: "modal@app/feed/@modal",
      },
      new URLSearchParams("from=feed"),
      undefined,
    );
    expect(renderInterceptResponse).toHaveBeenCalledTimes(1);
  });

  it("returns intercept opts when the source route is the current route", async () => {
    const currentRoute = { params: ["id"], pattern: "/photos/[id]" };

    const result = await resolveAppPageIntercept({
      async buildPageElement() {
        throw new Error("should not build a separate intercept element");
      },
      cleanPathname: "/photos/123",
      currentRoute,
      findIntercept() {
        return {
          matchedParams: { id: "123" },
          page: { default: "modal-page" },
          slotKey: "modal@app/feed/@modal",
          sourceRouteIndex: 0,
        };
      },
      getRouteParamNames(route) {
        return route.params;
      },
      getSourceRoute() {
        return currentRoute;
      },
      isRscRequest: true,
      resolveNavigationParams(_route, params) {
        return params;
      },
      async renderInterceptResponse() {
        throw new Error("should not render a separate intercept response");
      },
      searchParams: new URLSearchParams(),
      setNavigationContext() {},
      toInterceptOpts(intercept) {
        return {
          interceptPage: intercept.page,
          interceptParams: intercept.matchedParams,
          interceptSlotKey: intercept.slotKey,
        };
      },
    });

    expect(result.response).toBeNull();
    expect(result.interceptOpts).toEqual({
      interceptPage: { default: "modal-page" },
      interceptParams: { id: "123" },
      interceptSlotKey: "modal@app/feed/@modal",
    });
  });

  it("returns special-error responses from page builds", async () => {
    const result = await buildAppPageElement({
      async buildPageElement() {
        throw { digest: "NEXT_REDIRECT;replace;%2Ftarget;308" };
      },
      async renderErrorBoundaryPage() {
        throw new Error("should not render boundary for special errors");
      },
      async renderSpecialError(specialError) {
        return new Response(`${specialError.kind}:${specialError.statusCode}`);
      },
      resolveSpecialError: resolveAppPageSpecialError,
    });

    expect(result.element).toBeNull();
    await expect(result.response?.text()).resolves.toBe("redirect:308");
  });

  it("falls back to error boundaries for non-special build failures", async () => {
    const boundaryResponse = new Response("boundary", { status: 200 });

    const result = await buildAppPageElement({
      async buildPageElement() {
        throw new Error("boom");
      },
      async renderErrorBoundaryPage(error) {
        expect(error).toBeInstanceOf(Error);
        return boundaryResponse;
      },
      async renderSpecialError() {
        throw new Error("should not handle as a special error");
      },
      resolveSpecialError: resolveAppPageSpecialError,
    });

    expect(result.element).toBeNull();
    expect(result.response).toBe(boundaryResponse);
  });

  it("prefers an already-thrown page notFound over a later metadata notFound", async () => {
    // Ported from Next.js: test/e2e/app-dir/metadata-thrown/metadata-thrown.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/metadata-thrown/metadata-thrown.test.ts
    const pageError = { digest: "NEXT_HTTP_ERROR_FALLBACK;404" };
    const metadataError = { digest: "NEXT_HTTP_ERROR_FALLBACK;404", fromMetadata: true };
    const result = await buildAppPageElement({
      async buildPageElement() {
        await new Promise((resolve) => setTimeout(resolve, 0));
        throw metadataError;
      },
      async probePageSpecialError() {
        return resolveAppPageSpecialError(pageError);
      },
      async renderErrorBoundaryPage() {
        throw new Error("should not render boundary for special errors");
      },
      async renderSpecialError(specialError) {
        return new Response(specialError.fromMetadata ? "metadata" : "page", {
          status: specialError.statusCode,
        });
      },
      resolveSpecialError(error) {
        const specialError = resolveAppPageSpecialError(error);
        if (specialError && error === metadataError) {
          specialError.fromMetadata = true;
        }
        return specialError;
      },
    });

    expect(result.element).toBeNull();
    expect(result.response?.status).toBe(404);
    await expect(result.response?.text()).resolves.toBe("page");
  });
});

describe("resolveAppPageInterceptMatch", () => {
  const sourceRoute = { params: [], pattern: "/feed" };
  const currentRoute = { params: ["id"], pattern: "/photos/[id]" };

  const toInterceptOpts = (intercept: {
    matchedParams: Record<string, string | string[]>;
    page: unknown;
    slotKey: string;
  }) => ({
    interceptPage: intercept.page,
    interceptParams: intercept.matchedParams,
    interceptSlotKey: intercept.slotKey,
  });

  it("returns null on non-RSC requests", async () => {
    const result = await resolveAppPageInterceptMatch({
      cleanPathname: "/photos/123",
      currentRoute,
      findIntercept() {
        throw new Error("should not look up intercepts on non-RSC requests");
      },
      getRouteParamNames: (route) => route.params,
      getSourceRoute: () => sourceRoute,
      isRscRequest: false,
      toInterceptOpts,
    });

    expect(result).toBeNull();
  });

  it("returns null when findIntercept returns nothing", async () => {
    const result = await resolveAppPageInterceptMatch({
      cleanPathname: "/photos/123",
      currentRoute,
      findIntercept: () => null,
      getRouteParamNames: (route) => route.params,
      getSourceRoute: () => sourceRoute,
      isRscRequest: true,
      toInterceptOpts,
    });

    expect(result).toBeNull();
  });

  it("returns null when the source route is the current route", async () => {
    const result = await resolveAppPageInterceptMatch({
      cleanPathname: "/photos/123",
      currentRoute,
      findIntercept: () => ({
        matchedParams: { id: "123" },
        page: { default: "modal-page" },
        slotKey: "modal@app/photos/@modal",
        sourceRouteIndex: 0,
      }),
      getRouteParamNames: (route) => route.params,
      getSourceRoute: () => currentRoute,
      isRscRequest: true,
      toInterceptOpts,
    });

    expect(result).toBeNull();
  });

  it("returns sourceRoute, sourceParams, matchedParams, and interceptOpts when an intercept applies", async () => {
    const matchedParams = { id: "123" };
    const intercept = {
      matchedParams,
      page: { default: "modal-page" },
      slotKey: "modal@app/feed/@modal",
      sourceRouteIndex: 0,
    };

    const result = await resolveAppPageInterceptMatch({
      cleanPathname: "/photos/123",
      currentRoute,
      findIntercept: () => intercept,
      getRouteParamNames: (route) => route.params,
      getSourceRoute: () => sourceRoute,
      isRscRequest: true,
      toInterceptOpts,
    });

    expect(result).not.toBeNull();
    expect(result?.sourceRoute).toBe(sourceRoute);
    expect(result?.matchedParams).toBe(matchedParams);
    // sourceParams keeps only the params declared by the source route.
    // /feed has no dynamic params, so the slice is empty.
    expect(result?.sourceParams).toEqual({});
    expect(result?.interceptOpts).toEqual(toInterceptOpts(intercept));
  });

  it("deduplicates concurrent intercept page and layout loads", async () => {
    const interceptPage = { default: "modal-page" };
    const interceptLayout = { default: "modal-layout" };
    const __pageLoader = vi.fn(async () => interceptPage);
    const __loadInterceptLayout = vi.fn(async () => interceptLayout);
    const sharedLoadState = {
      page: null as unknown,
      pageLoading: null as Promise<unknown> | null,
      interceptLayoutsLoading: null as Promise<readonly unknown[]> | null,
    };
    const intercept = {
      interceptLayouts: [null],
      __loadInterceptLayouts: [__loadInterceptLayout],
      matchedParams: { id: "123" },
      page: null,
      __pageLoader,
      __loadState: sharedLoadState,
      slotKey: "modal@app/feed/@modal",
      sourceRouteIndex: 0,
    };
    const options = {
      cleanPathname: "/photos/123",
      currentRoute,
      findIntercept: () => ({ ...intercept, page: sharedLoadState.page }),
      getRouteParamNames: (route: { params: string[] }) => route.params,
      getSourceRoute: () => sourceRoute,
      isRscRequest: true,
      toInterceptOpts,
    };

    await Promise.all([
      resolveAppPageInterceptMatch(options),
      resolveAppPageInterceptMatch(options),
    ]);

    expect(__pageLoader).toHaveBeenCalledTimes(1);
    expect(__loadInterceptLayout).toHaveBeenCalledTimes(1);
    expect(sharedLoadState.page).toBe(interceptPage);
    expect(intercept.interceptLayouts).toEqual([interceptLayout]);
  });

  it("slices source params down to the source route's declared params", async () => {
    const categorySourceRoute = { params: ["category"], pattern: "/feed/[category]" };
    const matchedParams = { category: "nature", id: "123" };

    const result = await resolveAppPageInterceptMatch({
      cleanPathname: "/photos/123",
      currentRoute,
      findIntercept: () => ({
        matchedParams,
        sourceMatchedParams: { category: "nature", tab: "recent" },
        page: { default: "modal-page" },
        slotKey: "modal@app/feed/[category]/@modal",
        sourceRouteIndex: 0,
      }),
      getRouteParamNames: (route) => route.params,
      getSourceRoute: () => categorySourceRoute,
      isRscRequest: true,
      toInterceptOpts,
    });

    expect(result?.sourceParams).toEqual({ category: "nature" });
    expect(result?.matchedParams).toEqual({ category: "nature", id: "123" });
  });
});

describe("resolveAppPageActionRerenderTarget", () => {
  const sourceRoute = { params: [], pattern: "/feed" };
  const currentRoute = { params: ["id"], pattern: "/photos/[id]" };

  const toInterceptOpts = (intercept: {
    matchedParams: Record<string, string | string[]>;
    page: unknown;
    slotKey: string;
  }) => ({
    interceptPage: intercept.page,
    interceptParams: intercept.matchedParams,
    interceptSlotKey: intercept.slotKey,
  });

  it("falls through to the current route on non-RSC requests", async () => {
    const result = await resolveAppPageActionRerenderTarget({
      cleanPathname: "/photos/123",
      currentParams: { id: "123" },
      currentRoute,
      findIntercept() {
        throw new Error("should not look up intercepts on non-RSC requests");
      },
      getRouteParamNames: (route) => route.params,
      getSourceRoute: () => sourceRoute,
      isRscRequest: false,
      toInterceptOpts,
    });

    expect(result).toEqual({
      interceptOpts: undefined,
      navigationParams: { id: "123" },
      params: { id: "123" },
      route: currentRoute,
    });
  });

  it("falls through to the current route when no intercept matches", async () => {
    const result = await resolveAppPageActionRerenderTarget({
      cleanPathname: "/photos/123",
      currentParams: { id: "123" },
      currentRoute,
      findIntercept: () => null,
      getRouteParamNames: (route) => route.params,
      getSourceRoute: () => sourceRoute,
      isRscRequest: true,
      toInterceptOpts,
    });

    expect(result).toEqual({
      interceptOpts: undefined,
      navigationParams: { id: "123" },
      params: { id: "123" },
      route: currentRoute,
    });
  });

  it("looks up the intercept once when the source route is the current route", async () => {
    const findIntercept = vi.fn(() => ({
      matchedParams: { id: "123" },
      page: { default: "modal-page" },
      slotKey: "modal@app/feed/@modal",
      sourceRouteIndex: 0,
    }));

    const result = await resolveAppPageActionRerenderTarget({
      cleanPathname: "/photos/123",
      currentParams: { id: "123" },
      currentRoute,
      findIntercept,
      getRouteParamNames: (route) => route.params,
      getSourceRoute: () => currentRoute,
      isRscRequest: true,
      toInterceptOpts,
    });

    expect(result).toEqual({
      interceptOpts: {
        interceptPage: { default: "modal-page" },
        interceptParams: { id: "123" },
        interceptSlotKey: "modal@app/feed/@modal",
      },
      navigationParams: { id: "123" },
      params: { id: "123" },
      route: currentRoute,
    });
    expect(findIntercept).toHaveBeenCalledTimes(1);
  });

  it("preserves current-route intercept opts when action rerender stays on the direct route", async () => {
    const result = await resolveAppPageActionRerenderTarget({
      cleanPathname: "/photos/123",
      currentParams: { id: "123" },
      currentRoute,
      findIntercept: () => ({
        matchedParams: { id: "123" },
        page: { default: "modal-page" },
        slotKey: "modal@app/feed/@modal",
        sourceRouteIndex: 0,
      }),
      getRouteParamNames: (route) => route.params,
      getSourceRoute: () => currentRoute,
      isRscRequest: true,
      toInterceptOpts,
    });

    expect(result).toEqual({
      interceptOpts: {
        interceptPage: { default: "modal-page" },
        interceptParams: { id: "123" },
        interceptSlotKey: "modal@app/feed/@modal",
      },
      navigationParams: { id: "123" },
      params: { id: "123" },
      route: currentRoute,
    });
  });

  it("rerenders the intercepted source route when an intercept match applies", async () => {
    const descendantSourceRoute = {
      params: ["locale", "tab"],
      pattern: "/[locale]/feed/[tab]",
    };
    const result = await resolveAppPageActionRerenderTarget({
      cleanPathname: "/photos/123",
      currentParams: { id: "123" },
      currentRoute,
      findIntercept: () => ({
        matchedParams: { locale: "en", id: "123" },
        sourceMatchedParams: { locale: "en", tab: "recent" },
        page: { default: "modal-page" },
        slotKey: "modal@app/feed/@modal",
        sourceRouteIndex: 0,
      }),
      getRouteParamNames: (route) => route.params,
      getSourceRoute: () => descendantSourceRoute,
      isRscRequest: true,
      toInterceptOpts,
    });

    expect(result).toEqual({
      interceptOpts: {
        interceptPage: { default: "modal-page" },
        interceptParams: { locale: "en", id: "123" },
        interceptSlotKey: "modal@app/feed/@modal",
      },
      navigationParams: { locale: "en", tab: "recent", id: "123" },
      params: { locale: "en", tab: "recent" },
      route: descendantSourceRoute,
    });
  });
});
