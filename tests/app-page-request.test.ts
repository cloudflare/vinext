import { describe, expect, it, vi } from "vite-plus/test";
import { resolveAppPageSpecialError } from "../packages/vinext/src/server/app-page-execution.js";
import {
  buildAppPageElement,
  resolveAppPageIntercept,
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
