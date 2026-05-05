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
    const clearRequestContext = vi.fn();

    const response = await validateAppPageDynamicParams({
      clearRequestContext,
      enforceStaticParamsOnly: true,
      async generateStaticParams() {
        return [{ slug: "known-post" }];
      },
      isDynamicRoute: true,
      params: { slug: "missing-post" },
    });

    expect(response?.status).toBe(404);
    await expect(response?.text()).resolves.toBe("Not Found");
    expect(clearRequestContext).toHaveBeenCalledTimes(1);
  });

  it("returns 404 when dynamicParams=false has no static params sources", async () => {
    const clearRequestContext = vi.fn();

    const response = await validateAppPageDynamicParams({
      clearRequestContext,
      enforceStaticParamsOnly: true,
      generateStaticParams: undefined,
      isDynamicRoute: true,
      params: { slug: "anything" },
    });

    expect(response?.status).toBe(404);
    await expect(response?.text()).resolves.toBe("Not Found");
    expect(clearRequestContext).toHaveBeenCalledTimes(1);
  });

  it("allows matching static params, including nested parent params", async () => {
    const clearRequestContext = vi.fn();

    const response = await validateAppPageDynamicParams({
      clearRequestContext,
      enforceStaticParamsOnly: true,
      async generateStaticParams() {
        return [{ item: "shoe" }];
      },
      isDynamicRoute: true,
      params: { category: "fashion", item: "shoe" },
    });

    expect(response).toBeNull();
    expect(clearRequestContext).not.toHaveBeenCalled();
  });

  it("requires every segment generateStaticParams source to allow the params", async () => {
    const clearRequestContext = vi.fn();
    const layoutGenerateStaticParams = async () => [{ category: "docs" }];
    const pageGenerateStaticParams = async () => [{ slug: "intro" }];

    const response = await validateAppPageDynamicParams({
      clearRequestContext,
      enforceStaticParamsOnly: true,
      generateStaticParams: [layoutGenerateStaticParams, pageGenerateStaticParams],
      isDynamicRoute: true,
      params: { category: "docs", slug: "missing" },
    });

    expect(response?.status).toBe(404);
    expect(clearRequestContext).toHaveBeenCalledTimes(1);
  });

  it("passes parent-only params to each generateStaticParams source", async () => {
    const clearRequestContext = vi.fn();
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
      clearRequestContext,
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
    expect(clearRequestContext).not.toHaveBeenCalled();
    expect(categoryGenerateStaticParams).toHaveBeenCalledWith({ params: {} });
    expect(itemGenerateStaticParams).toHaveBeenCalledWith({ params: { category: "docs" } });
  });

  it("logs and falls through when generateStaticParams throws", async () => {
    const logGenerateStaticParamsError = vi.fn();

    const response = await validateAppPageDynamicParams({
      clearRequestContext() {},
      enforceStaticParamsOnly: true,
      async generateStaticParams() {
        throw new Error("boom");
      },
      isDynamicRoute: true,
      logGenerateStaticParamsError,
      params: { slug: "post" },
    });

    expect(response).toBeNull();
    expect(logGenerateStaticParamsError).toHaveBeenCalledTimes(1);
  });

  it("checks remaining sources when an earlier generateStaticParams source throws", async () => {
    const clearRequestContext = vi.fn();
    const logGenerateStaticParamsError = vi.fn();
    const throwsSource = vi.fn(() => {
      throw new Error("source 1 failed");
    });
    const rejectsSource = vi.fn(async () => [{ slug: "other" }]);

    const response = await validateAppPageDynamicParams({
      clearRequestContext,
      enforceStaticParamsOnly: true,
      generateStaticParams: [throwsSource, rejectsSource],
      isDynamicRoute: true,
      logGenerateStaticParamsError,
      params: { slug: "target" },
    });

    // First source threw → logged, then second source checked → rejected → 404.
    expect(response?.status).toBe(404);
    expect(clearRequestContext).toHaveBeenCalledTimes(1);
    expect(logGenerateStaticParamsError).toHaveBeenCalledTimes(1);
    expect(throwsSource).toHaveBeenCalledTimes(1);
    expect(rejectsSource).toHaveBeenCalledTimes(1);
  });

  it("renders intercepted source routes on RSC navigations", async () => {
    const setNavigationContext = vi.fn();
    const buildPageElementMock = vi.fn(async () => ({ type: "intercept-element" }));
    const renderInterceptResponse = vi.fn(async () => new Response("intercepted"));
    const currentRoute = { params: ["id"], pattern: "/photos/[id]" };
    const sourceRoute = { params: [], pattern: "/feed" };

    const result = await resolveAppPageIntercept({
      buildPageElement: buildPageElementMock,
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
        return sourceRoute;
      },
      isRscRequest: true,
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
      params: { id: "123" },
      pathname: "/photos/123",
      searchParams: new URLSearchParams("from=feed"),
    });
    expect(buildPageElementMock).toHaveBeenCalledWith(
      sourceRoute,
      {},
      {
        interceptPage: { default: "modal-page" },
        interceptParams: { id: "123" },
        interceptSlotKey: "modal@app/feed/@modal",
      },
      new URLSearchParams("from=feed"),
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

  it("returns null on non-RSC requests", () => {
    const result = resolveAppPageInterceptMatch({
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

  it("returns null when findIntercept returns nothing", () => {
    const result = resolveAppPageInterceptMatch({
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

  it("returns null when the source route is the current route", () => {
    const result = resolveAppPageInterceptMatch({
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

  it("returns sourceRoute, sourceParams, matchedParams, and interceptOpts when an intercept applies", () => {
    const matchedParams = { id: "123" };
    const intercept = {
      matchedParams,
      page: { default: "modal-page" },
      slotKey: "modal@app/feed/@modal",
      sourceRouteIndex: 0,
    };

    const result = resolveAppPageInterceptMatch({
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

  it("slices source params down to the source route's declared params", () => {
    const categorySourceRoute = { params: ["category"], pattern: "/feed/[category]" };
    const matchedParams = { category: "nature", id: "123" };

    const result = resolveAppPageInterceptMatch({
      cleanPathname: "/photos/123",
      currentRoute,
      findIntercept: () => ({
        matchedParams,
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

  it("falls through to the current route on non-RSC requests", () => {
    const result = resolveAppPageActionRerenderTarget({
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

  it("falls through to the current route when no intercept matches", () => {
    const result = resolveAppPageActionRerenderTarget({
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

  it("looks up the intercept once when the source route is the current route", () => {
    const findIntercept = vi.fn(() => ({
      matchedParams: { id: "123" },
      page: { default: "modal-page" },
      slotKey: "modal@app/feed/@modal",
      sourceRouteIndex: 0,
    }));

    const result = resolveAppPageActionRerenderTarget({
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

  it("preserves current-route intercept opts when action rerender stays on the direct route", () => {
    const result = resolveAppPageActionRerenderTarget({
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

  it("rerenders the intercepted source route when an intercept match applies", () => {
    const result = resolveAppPageActionRerenderTarget({
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
      getSourceRoute: () => sourceRoute,
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
      params: {},
      route: sourceRoute,
    });
  });
});
