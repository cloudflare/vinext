import { describe, expect, it, vi } from "vitest";
import {
  ensureAppRouteModulesLoaded,
  loadAppInterceptLayouts,
  type LazyLoadableRoute,
} from "../packages/vinext/src/server/app-route-module-loader.js";

describe("ensureAppRouteModulesLoaded", () => {
  it("returns the route synchronously when there are no lazy thunks (eager route)", () => {
    const pageModule = { default: () => null };
    const route: LazyLoadableRoute = { page: pageModule };

    const result = ensureAppRouteModulesLoaded(route);

    // No promise — eager routes resolve synchronously.
    expect(result).toBe(route);
    expect(route.page).toBe(pageModule);
    expect(route.__loaded).toBe(true);
  });

  it("hydrates a lazy page module onto route.page", async () => {
    const pageModule = { default: () => null, generateMetadata: () => ({}) };
    const __loadPage = vi.fn(async () => pageModule);
    const route: LazyLoadableRoute = { page: null, __loadPage };

    const loaded = await ensureAppRouteModulesLoaded(route);

    expect(loaded).toBe(route);
    expect(route.page).toBe(pageModule);
    expect(route.routeHandler).toBeUndefined();
    expect(__loadPage).toHaveBeenCalledTimes(1);
  });

  it("hydrates a lazy route-handler module onto route.routeHandler", async () => {
    const handlerModule = { GET: () => new Response("ok") };
    const __loadRouteHandler = vi.fn(async () => handlerModule);
    const route: LazyLoadableRoute = { routeHandler: null, __loadRouteHandler };

    await ensureAppRouteModulesLoaded(route);

    expect(route.routeHandler).toBe(handlerModule);
  });

  it("loads both page and route handler in parallel", async () => {
    const pageModule = { default: () => null };
    const handlerModule = { POST: () => new Response() };
    const route: LazyLoadableRoute = {
      page: null,
      routeHandler: null,
      __loadPage: async () => pageModule,
      __loadRouteHandler: async () => handlerModule,
    };

    await ensureAppRouteModulesLoaded(route);

    expect(route.page).toBe(pageModule);
    expect(route.routeHandler).toBe(handlerModule);
  });

  it("is idempotent: a second call does not re-import", async () => {
    const pageModule = { default: () => null };
    const __loadPage = vi.fn(async () => pageModule);
    const route: LazyLoadableRoute = { page: null, __loadPage };

    await ensureAppRouteModulesLoaded(route);
    const second = ensureAppRouteModulesLoaded(route);

    // Already loaded → returns the route synchronously (not a promise).
    expect(second).toBe(route);
    expect(__loadPage).toHaveBeenCalledTimes(1);
  });

  it("dedups concurrent calls into a single import", async () => {
    let resolveImport: (mod: unknown) => void = () => {};
    const importPromise = new Promise((resolve) => {
      resolveImport = resolve;
    });
    const pageModule = { default: () => null };
    const __loadPage = vi.fn(() => importPromise);
    const route: LazyLoadableRoute = { page: null, __loadPage };

    const a = ensureAppRouteModulesLoaded(route);
    const b = ensureAppRouteModulesLoaded(route);

    // Both callers observe the same in-flight promise.
    expect(a).toBe(b);
    resolveImport(pageModule);
    await Promise.all([a, b]);

    expect(__loadPage).toHaveBeenCalledTimes(1);
    expect(route.page).toBe(pageModule);
  });

  it("does not cache a failed import: re-throws and retries on the next call", async () => {
    const pageModule = { default: () => null };
    const __loadPage = vi
      .fn()
      .mockRejectedValueOnce(new Error("chunk load failed"))
      .mockResolvedValueOnce(pageModule);
    const route: LazyLoadableRoute = { page: null, __loadPage };

    // First call rejects and the rejection propagates to the caller.
    await expect(ensureAppRouteModulesLoaded(route)).rejects.toThrow("chunk load failed");
    // The failure is not stuck: state is reset for a retry.
    expect(route.__loaded).toBeFalsy();
    expect(route.__loading).toBeNull();

    // Next call retries the import and succeeds.
    await ensureAppRouteModulesLoaded(route);
    expect(route.page).toBe(pageModule);
    expect(__loadPage).toHaveBeenCalledTimes(2);
  });

  it("tolerates null / undefined routes", () => {
    expect(ensureAppRouteModulesLoaded(null)).toBeNull();
    expect(ensureAppRouteModulesLoaded(undefined)).toBeUndefined();
  });

  it("hydrates array module fields positionally, skipping null loaders and pre-filled slots", async () => {
    const rootLayout = { default: () => null };
    const childLayout = { default: () => null };
    const eagerLayout = { default: () => null };
    // Index 1 has a null loader (no module at that position); index 2 is already
    // populated and must not be re-imported — mirrors the manifest emitting
    // `[null, load_x]` plus an eagerly-set entry.
    const __loadLayouts = [vi.fn(async () => rootLayout), null, vi.fn(async () => childLayout)];
    const route: LazyLoadableRoute = {
      layouts: [null, null, eagerLayout],
      __loadLayouts,
    };

    await ensureAppRouteModulesLoaded(route);

    expect(route.layouts).toEqual([rootLayout, null, eagerLayout]);
    expect(__loadLayouts[0]).toHaveBeenCalledTimes(1);
    expect(__loadLayouts[2]).not.toHaveBeenCalled();
  });

  it("ignores array loaders beyond the manifest placeholder length", async () => {
    const layout = { default: () => null };
    const outOfRangeLoader = vi.fn(async () => layout);
    const route: LazyLoadableRoute = {
      layouts: [null],
      __loadLayouts: [null, outOfRangeLoader],
    };

    await ensureAppRouteModulesLoaded(route);

    expect(route.layouts).toEqual([null]);
    expect(outOfRangeLoader).not.toHaveBeenCalled();
  });

  it("hydrates parallel-slot modules onto each slot", async () => {
    const slotPage = { default: () => null };
    const slotLayout = { default: () => null };
    const nestedSlotLayout = { default: () => null, revalidate: 30 };
    const __loadPage = vi.fn(async () => slotPage);
    const __loadLayout = vi.fn(async () => slotLayout);
    const __loadConfigLayout = vi.fn(async () => nestedSlotLayout);
    const route: LazyLoadableRoute = {
      slots: {
        "@modal": {
          page: null,
          layout: null,
          configLayouts: [null],
          __loadPage,
          __loadLayout,
          __loadConfigLayouts: [__loadConfigLayout],
        },
      },
    };

    await ensureAppRouteModulesLoaded(route);

    expect(route.slots?.["@modal"].page).toBe(slotPage);
    expect(route.slots?.["@modal"].layout).toBe(slotLayout);
    expect(route.slots?.["@modal"].configLayouts).toEqual([nestedSlotLayout]);
  });
});

describe("loadAppInterceptLayouts", () => {
  it("hydrates intercept layouts from their loaders and returns the array", async () => {
    const layoutA = { default: () => null };
    const layoutB = { default: () => null };
    const intercept = {
      interceptLayouts: [null, null],
      __loadInterceptLayouts: [async () => layoutA, async () => layoutB],
    };

    const result = await loadAppInterceptLayouts(intercept);

    expect(intercept.interceptLayouts).toEqual([layoutA, layoutB]);
    expect(result).toBe(intercept.interceptLayouts);
  });

  it("resolves synchronously to the existing array when there are no loaders", () => {
    const intercept = { interceptLayouts: [] as unknown[] };

    // No loaders → returns a resolved promise wrapping the same array, no imports.
    return expect(loadAppInterceptLayouts(intercept)).resolves.toBe(intercept.interceptLayouts);
  });
});
