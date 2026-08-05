import { describe, expect, it, vi } from "vite-plus/test";
import {
  ensureAppRouteModulesLoaded,
  loadAppInterceptNotFound,
  loadAppInterceptPage,
  loadAppInterceptLayouts,
  type LazyLoadableRoute,
} from "../packages/vinext/src/server/app-route-module-loader.js";
import { cookies, headersContextFromRequest } from "../packages/vinext/src/shims/headers.js";
import {
  createRequestContext,
  runWithRequestContext,
} from "../packages/vinext/src/shims/unified-request-context.js";
import {
  getRequestExecutionContext,
  runWithExecutionContext,
} from "../packages/vinext/src/shims/request-context.js";
import { after } from "../packages/vinext/src/shims/server.js";

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

  it("hydrates per-segment loading modules positionally", async () => {
    const parentLoading = { default: () => null };
    const leafLoading = { default: () => null };
    const __loadLoadings = [vi.fn(async () => parentLoading), vi.fn(async () => leafLoading)];
    const route: LazyLoadableRoute = {
      loadings: [null, null],
      __loadLoadings,
    };

    await ensureAppRouteModulesLoaded(route);

    expect(route.loadings).toEqual([parentLoading, leafLoading]);
    expect(__loadLoadings[0]).toHaveBeenCalledTimes(1);
    expect(__loadLoadings[1]).toHaveBeenCalledTimes(1);
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
    const slotNotFound = { default: () => null, metadata: { title: "slot not found" } };
    const nestedSlotLayout = { default: () => null, revalidate: 30 };
    const nestedSlotLoading = { default: () => null };
    const __loadPage = vi.fn(async () => slotPage);
    const __loadLayout = vi.fn(async () => slotLayout);
    const __loadNotFound = vi.fn(async () => slotNotFound);
    const __loadConfigLayout = vi.fn(async () => nestedSlotLayout);
    const __loadSlotLoading = vi.fn(async () => nestedSlotLoading);
    const route: LazyLoadableRoute = {
      slots: {
        "@modal": {
          page: null,
          layout: null,
          configLayouts: [null],
          loadings: [null],
          __loadPage,
          __loadLayout,
          __loadNotFound,
          __loadConfigLayouts: [__loadConfigLayout],
          __loadLoadings: [__loadSlotLoading],
        },
      },
    };

    await ensureAppRouteModulesLoaded(route);

    expect(route.slots?.["@modal"].page).toBe(slotPage);
    expect(route.slots?.["@modal"].layout).toBe(slotLayout);
    expect(route.slots?.["@modal"].notFound).toBe(slotNotFound);
    expect(route.slots?.["@modal"].configLayouts).toEqual([nestedSlotLayout]);
    expect(route.slots?.["@modal"].loadings).toEqual([nestedSlotLoading]);
  });
});

describe("loadAppInterceptLayouts", () => {
  it("hydrates intercept layouts from their loaders and returns the array", async () => {
    const layoutA = { default: () => null };
    const layoutB = { default: () => null };
    const loading = { default: () => null };
    const intercept = {
      interceptLayouts: [null, null],
      __loadInterceptLayouts: [async () => layoutA, async () => layoutB],
      interceptLoadings: [null],
      __loadInterceptLoadings: [async () => loading],
    };

    const result = await loadAppInterceptLayouts(intercept);

    expect(intercept.interceptLayouts).toEqual([layoutA, layoutB]);
    expect(intercept.interceptLoadings).toEqual([loading]);
    expect(result).toBe(intercept.interceptLayouts);
  });

  it("resolves synchronously to the existing array when there are no loaders", () => {
    const intercept = { interceptLayouts: [] as unknown[] };

    // No loaders → returns a resolved promise wrapping the same array, no imports.
    return expect(loadAppInterceptLayouts(intercept)).resolves.toBe(intercept.interceptLayouts);
  });
});

describe.each([
  ["page", "__pageLoader", "pageLoading", loadAppInterceptPage],
  ["notFound", "__loadNotFound", "notFoundLoading", loadAppInterceptNotFound],
] as const)("loadAppIntercept%s", (field, loaderField, loadingField, load) => {
  it("publishes a shared concurrent load onto every request-local intercept clone", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const module = { default: () => null };
    const loader = vi.fn(async () => {
      await gate;
      return module;
    });
    const loadState = {
      page: null,
      pageLoading: null,
      notFound: null,
      notFoundLoading: null,
      interceptLayoutsLoading: null,
    };
    const first = {
      [field]: null,
      [loaderField]: loader,
      __loadState: loadState,
    };
    const second = {
      [field]: null,
      [loaderField]: loader,
      __loadState: loadState,
    };

    const firstLoad = load(first);
    const secondLoad = load(second);
    expect(loadState[loadingField]).not.toBeNull();
    release();
    await Promise.all([firstLoad, secondLoad]);

    expect(loader).toHaveBeenCalledTimes(1);
    expect(first[field]).toBe(module);
    expect(second[field]).toBe(module);
    expect(loadState[field]).toBe(module);
    expect(loadState[loadingField]).toBeNull();
  });
});

describe("lazy hydration request-context isolation", () => {
  it("evaluates a lazy module outside the request context that triggered hydration", async () => {
    const request = new Request("https://example.com/dashboard", {
      headers: { cookie: "session=victim-secret" },
    });
    const requestContext = createRequestContext({
      headersContext: headersContextFromRequest(request),
    });
    const route: LazyLoadableRoute = {
      page: null,
      __loadPage: () => import("./fixtures/module-scope-request-capture.js"),
    };

    const liveCookie = await runWithRequestContext(requestContext, async () => {
      // Read first: proves the request context really is active at the
      // hydration call site, so the assertion below is isolation rather than
      // an absent context.
      const live = (await cookies()).get("session")?.value;
      await ensureAppRouteModulesLoaded(route);
      return live;
    });

    expect(liveCookie).toBe("victim-secret");
    // Module scope must see no request at all — matching Next.js, which loads
    // components before entering the request store. Anything else would be
    // cached on `route.page` and reused for every later visitor.
    expect((route.page as { moduleScopeCookieAccess: string }).moduleScopeCookieAccess).toBe(
      "rejected-no-request-context",
    );
  });

  it("also escapes the execution-context scope the Cloudflare entry enters outside the request context", async () => {
    // app-router-entry.ts wraps the whole handler in runWithExecutionContext()
    // before app-rsc-handler.ts opens the unified request context, so the two
    // stores nest at different depths. Exiting only the unified one would leave
    // the worker's ExecutionContext visible — and after() takes its
    // getRequestExecutionContext() fallback precisely when the unified store is
    // absent, so a partial exit enables that path instead of closing it.
    const waitUntil = vi.fn();
    const executionContext = { waitUntil, passThroughOnException() {} };
    let moduleScopeExecutionContext: unknown = "loader-not-called";
    let moduleScopeAfter = "loader-not-called";

    const route: LazyLoadableRoute = {
      page: null,
      __loadPage: async () => {
        moduleScopeExecutionContext = getRequestExecutionContext();
        try {
          after(() => {});
          moduleScopeAfter = "registered";
        } catch (error) {
          moduleScopeAfter = (error as Error).message;
        }
        return { default: () => null };
      },
    };

    const requestContext = createRequestContext({
      headersContext: headersContextFromRequest(new Request("https://example.com/dashboard")),
      executionContext,
    });

    await runWithExecutionContext(executionContext, () =>
      runWithRequestContext(requestContext, () => ensureAppRouteModulesLoaded(route)),
    );

    expect(moduleScopeExecutionContext).toBeNull();
    expect(moduleScopeAfter).toBe("`after()` was called outside a request scope");
    // Nothing was attached to the first request's lifecycle.
    expect(waitUntil).not.toHaveBeenCalled();
  });
});
