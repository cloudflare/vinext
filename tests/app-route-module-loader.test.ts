import { describe, expect, it, vi } from "vite-plus/test";
import { createLazyGenerateStaticParamsSource } from "../packages/vinext/src/server/app-prerender-static-params.js";
import {
  createRouteModuleLoader,
  loadRouteMatch,
  loadRouteModules,
} from "../packages/vinext/src/server/app-route-module-loader.js";

type RouteStub = {
  page: unknown;
  __pageLoader?: (() => Promise<unknown>) | null;
};

const MISSING_GENERATE_STATIC_PARAMS = Symbol.for("vinext.generateStaticParams.missing");

describe("createRouteModuleLoader", () => {
  it("calls the underlying loader once across multiple invocations", async () => {
    const pageModule = { default: () => null };
    const loadModule = vi.fn(() => Promise.resolve(pageModule));

    const loader = createRouteModuleLoader(loadModule);

    const [first, second, third] = await Promise.all([loader(), loader(), loader()]);

    expect(first).toBe(pageModule);
    expect(second).toBe(pageModule);
    expect(third).toBe(pageModule);
    expect(loadModule).toHaveBeenCalledTimes(1);
  });

  it("propagates rejections from the underlying loader", async () => {
    const error = new Error("chunk missing");
    const loader = createRouteModuleLoader(() => Promise.reject(error));

    await expect(loader()).rejects.toBe(error);
  });
});

describe("loadRouteModules", () => {
  it("awaits the page loader and assigns the result to route.page", async () => {
    const pageModule = { default: () => null };
    const route: RouteStub = {
      page: null,
      __pageLoader: createRouteModuleLoader(() => Promise.resolve(pageModule)),
    };

    await loadRouteModules(route);

    expect(route.page).toBe(pageModule);
  });

  it("dedups concurrent loadRouteModules calls for the same route", async () => {
    const pageModule = { default: () => null };
    const loadModule = vi.fn(() => Promise.resolve(pageModule));
    const route: RouteStub = {
      page: null,
      __pageLoader: createRouteModuleLoader(loadModule),
    };

    await Promise.all([loadRouteModules(route), loadRouteModules(route), loadRouteModules(route)]);

    expect(loadModule).toHaveBeenCalledTimes(1);
    expect(route.page).toBe(pageModule);
  });

  it("is a no-op on subsequent calls once the route is loaded", async () => {
    const pageModule = { default: () => null };
    const loadModule = vi.fn(() => Promise.resolve(pageModule));
    const route: RouteStub = {
      page: null,
      __pageLoader: createRouteModuleLoader(loadModule),
    };

    await loadRouteModules(route);
    await loadRouteModules(route);

    expect(loadModule).toHaveBeenCalledTimes(1);
  });

  it("returns the route unchanged when it has no __pageLoader", async () => {
    const route: RouteStub = { page: null };

    await expect(loadRouteModules(route)).resolves.toBe(route);
  });

  it("returns the route unchanged when __pageLoader is not a function", async () => {
    const route = { page: null, __pageLoader: "not-a-function" };

    await expect(loadRouteModules(route)).resolves.toBe(route);
  });

  it("leaves route.page untouched if the route has no `page` key", async () => {
    const pageModule = { default: () => null };
    const route = { __pageLoader: createRouteModuleLoader(() => Promise.resolve(pageModule)) };

    await loadRouteModules(route);

    expect("page" in route).toBe(false);
  });
});

describe("loadRouteMatch", () => {
  it("returns null when the match is null", async () => {
    await expect(loadRouteMatch(null)).resolves.toBeNull();
  });

  it("loads the matched route and returns the match", async () => {
    const pageModule = { default: () => null };
    const route: RouteStub = {
      page: null,
      __pageLoader: createRouteModuleLoader(() => Promise.resolve(pageModule)),
    };
    const match = { route };

    const result = await loadRouteMatch(match);

    expect(result).toBe(match);
    expect(route.page).toBe(pageModule);
  });
});

describe("createLazyGenerateStaticParamsSource", () => {
  it("delegates to the loaded module's generateStaticParams", async () => {
    const generateStaticParams = vi.fn(() => [{ slug: "hello" }]);
    const source = createLazyGenerateStaticParamsSource(async () => ({ generateStaticParams }));

    await expect(source({ params: { category: "docs" } })).resolves.toEqual([{ slug: "hello" }]);
    expect(generateStaticParams).toHaveBeenCalledWith({ params: { category: "docs" } });
  });

  it("returns the missing sentinel when the loaded module is null", async () => {
    const source = createLazyGenerateStaticParamsSource(async () => null);

    await expect(source({ params: {} })).resolves.toBe(MISSING_GENERATE_STATIC_PARAMS);
  });

  it("returns the missing sentinel when the module has no generateStaticParams export", async () => {
    const source = createLazyGenerateStaticParamsSource(async () => ({ default: () => null }));

    await expect(source({ params: {} })).resolves.toBe(MISSING_GENERATE_STATIC_PARAMS);
  });

  it("returns the missing sentinel when generateStaticParams is not a function", async () => {
    const source = createLazyGenerateStaticParamsSource(async () => ({ generateStaticParams: 42 }));

    await expect(source({ params: {} })).resolves.toBe(MISSING_GENERATE_STATIC_PARAMS);
  });
});
