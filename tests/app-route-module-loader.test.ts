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
    const nestedSlotNotFound = { default: () => null };
    const __loadPage = vi.fn(async () => slotPage);
    const __loadLayout = vi.fn(async () => slotLayout);
    const __loadNotFound = vi.fn(async () => slotNotFound);
    const __loadConfigLayout = vi.fn(async () => nestedSlotLayout);
    const __loadSlotLoading = vi.fn(async () => nestedSlotLoading);
    const __loadSlotNotFound = vi.fn(async () => nestedSlotNotFound);
    const route: LazyLoadableRoute = {
      slots: {
        "@modal": {
          page: null,
          layout: null,
          configLayouts: [null],
          loadings: [null],
          notFounds: [null],
          __loadPage,
          __loadLayout,
          __loadNotFound,
          __loadConfigLayouts: [__loadConfigLayout],
          __loadLoadings: [__loadSlotLoading],
          __loadNotFounds: [__loadSlotNotFound],
        },
      },
    };

    await ensureAppRouteModulesLoaded(route);

    expect(route.slots?.["@modal"].page).toBe(slotPage);
    expect(route.slots?.["@modal"].layout).toBe(slotLayout);
    expect(route.slots?.["@modal"].notFound).toBe(slotNotFound);
    expect(route.slots?.["@modal"].configLayouts).toEqual([nestedSlotLayout]);
    expect(route.slots?.["@modal"].loadings).toEqual([nestedSlotLoading]);
    expect(route.slots?.["@modal"].notFounds).toEqual([nestedSlotNotFound]);
  });

  // Like Next.js's intercepting route, whose tree holds neither the owner's
  // page nor another slot's branch, a render of the whole intercepting route
  // never imports those, so a module of theirs that throws can't fail it.
  it("loads only what a render of the whole intercepting route shows", async () => {
    const throwing = (name: string) =>
      vi.fn(async () => {
        throw new Error(`${name} module throws`);
      });
    const layout = { default: () => null };
    const asideDefault = { default: () => null };
    const modalLayout = { default: () => null };
    const modalLoading = { default: () => null };
    const __loadPage = throwing("owner page");
    const __loadAsidePage = throwing("aside page");
    const __loadAsideLayout = throwing("aside layout");
    const __loadAsideConfigLayout = throwing("aside branch layout");
    const __loadModalBranchLoading = throwing("modal branch loading");
    const route: LazyLoadableRoute = {
      page: null,
      __loadPage,
      layouts: [null],
      __loadLayouts: [async () => layout],
      slots: {
        aside: {
          page: null,
          default: null,
          layout: null,
          configLayouts: [null],
          __loadPage: __loadAsidePage,
          __loadDefault: async () => asideDefault,
          __loadLayout: __loadAsideLayout,
          __loadConfigLayouts: [__loadAsideConfigLayout],
        },
        modal: {
          page: null,
          layout: null,
          loadings: [null, null],
          loadingTreePositions: [0, 2],
          __loadPage: throwing("modal page"),
          __loadLayout: async () => modalLayout,
          __loadLoadings: [async () => modalLoading, __loadModalBranchLoading],
        },
      },
    };

    await ensureAppRouteModulesLoaded(route, {
      interceptSlotKey: "modal",
      rendersInterceptionSource: true,
      rendersWholeInterceptingRoute: true,
    });

    expect(route.layouts).toEqual([layout]);
    expect(route.slots?.aside.default).toBe(asideDefault);
    expect(route.slots?.modal.layout).toBe(modalLayout);
    expect(route.slots?.modal.loadings).toEqual([modalLoading, null]);
    for (const loader of [
      __loadPage,
      __loadAsidePage,
      __loadAsideLayout,
      __loadAsideConfigLayout,
      __loadModalBranchLoading,
    ]) {
      expect(loader).not.toHaveBeenCalled();
    }
    // The route's own render still loads everything.
    expect(route.__loaded).toBeFalsy();
    await expect(ensureAppRouteModulesLoaded(route)).rejects.toThrow("module throws");
  });

  // club/(children)/page.tsx beside club/@modal: the whole intercepting route
  // stops at club, so a module of the route group, or of a slot it owns,
  // can't fail it.
  it("loads none of a route group's files below a whole intercepting route's owner", async () => {
    const throwing = (name: string) =>
      vi.fn(async () => {
        throw new Error(`${name} module throws`);
      });
    const file = (name: string) => ({ default: () => name });
    const [
      rootLayout,
      clubLayout,
      clubTemplate,
      clubLoading,
      rootNotFound,
      clubForbidden,
      clubUnauthorized,
      asideDefault,
    ] = [
      file("root layout"),
      file("club layout"),
      file("club template"),
      file("club loading"),
      file("root not found"),
      file("club forbidden"),
      file("club unauthorized"),
      file("aside default"),
    ];
    const groupLoaders = {
      default: throwing("group slot default"),
      error: throwing("group error"),
      forbidden: throwing("group forbidden"),
      layout: throwing("group layout"),
      leafError: throwing("group leaf error"),
      leafLoading: throwing("group leaf loading"),
      loading: throwing("group loading"),
      notFound: throwing("group not found"),
      template: throwing("group template"),
      unauthorized: throwing("group unauthorized"),
    };
    const route: LazyLoadableRoute = {
      routeSegments: ["club", "(children)"],
      layouts: [null, null, null],
      layoutTreePositions: [0, 1, 2],
      __loadLayouts: [async () => rootLayout, async () => clubLayout, groupLoaders.layout],
      templates: [null, null],
      templateTreePositions: [1, 2],
      __loadTemplates: [async () => clubTemplate, groupLoaders.template],
      loadings: [null, null],
      loadingTreePositions: [1, 2],
      __loadLoadings: [async () => clubLoading, groupLoaders.loading],
      errors: [null, null, null],
      __loadErrors: [null, null, groupLoaders.error],
      errorPaths: [null],
      errorTreePositions: [2],
      __loadErrorPaths: [groupLoaders.error],
      notFound: null,
      notFoundTreePosition: 2,
      __loadNotFound: groupLoaders.notFound,
      segmentNotFounds: [null, null],
      segmentNotFoundTreePositions: [0, 2],
      __loadSegmentNotFounds: [async () => rootNotFound, groupLoaders.notFound],
      forbiddens: [null, null, null],
      __loadForbiddens: [null, async () => clubForbidden, groupLoaders.forbidden],
      unauthorizeds: [null, null, null],
      __loadUnauthorizeds: [null, async () => clubUnauthorized, groupLoaders.unauthorized],
      forbidden: null,
      forbiddenTreePosition: 2,
      __loadForbidden: groupLoaders.forbidden,
      unauthorized: null,
      unauthorizedTreePosition: 2,
      __loadUnauthorized: groupLoaders.unauthorized,
      segmentForbiddens: [null, null],
      segmentForbiddenTreePositions: [1, 2],
      __loadSegmentForbiddens: [async () => clubForbidden, groupLoaders.forbidden],
      segmentUnauthorizeds: [null, null],
      segmentUnauthorizedTreePositions: [1, 2],
      __loadSegmentUnauthorizeds: [async () => clubUnauthorized, groupLoaders.unauthorized],
      loading: null,
      __loadLoading: groupLoaders.leafLoading,
      error: null,
      __loadError: groupLoaders.leafError,
      slots: {
        aside: {
          default: null,
          layoutIndex: 1,
          ownerTreePosition: 1,
          __loadDefault: async () => asideDefault,
        },
        modal: { layout: null, layoutIndex: 1, ownerTreePosition: 1 },
        side: {
          default: null,
          layoutIndex: 2,
          ownerTreePosition: 2,
          __loadDefault: groupLoaders.default,
        },
      },
    };

    await ensureAppRouteModulesLoaded(route, {
      interceptSlotKey: "modal",
      rendersInterceptionSource: true,
      rendersWholeInterceptingRoute: true,
    });

    expect(route.layouts).toEqual([rootLayout, clubLayout, null]);
    expect(route.templates).toEqual([clubTemplate, null]);
    expect(route.loadings).toEqual([clubLoading, null]);
    expect(route.segmentNotFounds).toEqual([rootNotFound, null]);
    expect(route.forbiddens).toEqual([null, clubForbidden, null]);
    expect(route.unauthorizeds).toEqual([null, clubUnauthorized, null]);
    expect(route.segmentForbiddens).toEqual([clubForbidden, null]);
    expect(route.segmentUnauthorizeds).toEqual([clubUnauthorized, null]);
    expect(route.forbidden).toBeNull();
    expect(route.unauthorized).toBeNull();
    expect(route.slots?.aside.default).toBe(asideDefault);
    for (const loader of Object.values(groupLoaders)) {
      expect(loader).not.toHaveBeenCalled();
    }
  });
});

describe("loadAppInterceptLayouts", () => {
  it("hydrates intercept layouts, loadings and not-founds from their loaders and returns the layouts", async () => {
    const layoutA = { default: () => null };
    const layoutB = { default: () => null };
    const loading = { default: () => null };
    const notFound = { default: () => null };
    const intercept = {
      interceptLayouts: [null, null],
      __loadInterceptLayouts: [async () => layoutA, async () => layoutB],
      interceptLoadings: [null],
      __loadInterceptLoadings: [async () => loading],
      interceptNotFounds: [null],
      __loadInterceptNotFounds: [async () => notFound],
    };

    const result = await loadAppInterceptLayouts(intercept);

    expect(intercept.interceptLayouts).toEqual([layoutA, layoutB]);
    expect(intercept.interceptLoadings).toEqual([loading]);
    expect(intercept.interceptNotFounds).toEqual([notFound]);
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
    // The module attached nothing to the request's lifecycle. The only
    // waitUntil() is the one keeping the shared load itself alive.
    expect(waitUntil).toHaveBeenCalledOnce();
  });
});

describe("lazy hydration request lifetime", () => {
  function deferred<T>() {
    let resolve: (value: T) => void = () => {};
    let reject: (error: unknown) => void = () => {};
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  // workerd drops a canceled request's pending I/O, so a load shared with later
  // requests must keep the request that started it alive until it settles.
  it.each<[string, (load: () => Promise<unknown>) => unknown]>([
    [
      "route modules",
      (load: () => Promise<unknown>) =>
        ensureAppRouteModulesLoaded({ page: null, __loadPage: load } as LazyLoadableRoute),
    ],
    [
      "a render of the whole intercepting route",
      (load: () => Promise<unknown>) =>
        ensureAppRouteModulesLoaded(
          { layouts: [null], __loadLayouts: [load] } as LazyLoadableRoute,
          {
            interceptSlotKey: "modal",
            rendersInterceptionSource: true,
            rendersWholeInterceptingRoute: true,
          },
        ),
    ],
    [
      "intercept layouts",
      (load: () => Promise<unknown>) =>
        loadAppInterceptLayouts({
          interceptLayouts: [null],
          __loadInterceptLayouts: [load],
          __loadState: { interceptLayoutsLoading: null },
        }),
    ],
    [
      "an intercept page",
      (load: () => Promise<unknown>) =>
        loadAppInterceptPage({
          page: null,
          __pageLoader: load,
          __loadState: { interceptLayoutsLoading: null },
        }),
    ],
  ])("keeps the request that starts loading %s alive until it settles", async (_label, start) => {
    const load = deferred<unknown>();
    const creator = { waitUntil: vi.fn() };
    const loading = runWithExecutionContext(creator, () => start(() => load.promise));

    expect(creator.waitUntil).toHaveBeenCalledOnce();
    let kept = false;
    void creator.waitUntil.mock.calls[0][0].then(() => {
      kept = true;
    });
    await Promise.resolve();
    expect(kept).toBe(false);

    load.reject(new Error("chunk load failed"));
    await expect(loading).rejects.toThrow("chunk load failed");
    // waitUntil() only extends the request; it never sees the rejection.
    await creator.waitUntil.mock.calls[0][0];
    expect(kept).toBe(true);
  });

  it.each([true, false])(
    "fully loads a route whose own load overlaps a whole intercepting route's (own first: %s)",
    async (ownFirst) => {
      const layoutLoad = deferred<unknown>();
      const pageLoad = deferred<unknown>();
      const route: LazyLoadableRoute = {
        page: null,
        __loadPage: () => pageLoad.promise,
        layouts: [null],
        __loadLayouts: [() => layoutLoad.promise],
      };
      const loadWhole = () =>
        ensureAppRouteModulesLoaded(route, {
          interceptSlotKey: "modal",
          rendersInterceptionSource: true,
          rendersWholeInterceptingRoute: true,
        });
      const loads = (
        ownFirst
          ? [ensureAppRouteModulesLoaded(route), loadWhole()]
          : [loadWhole(), ensureAppRouteModulesLoaded(route)]
      ).map((loading) => Promise.resolve(loading));
      const layout = { default: () => null };
      const page = { default: () => null };
      layoutLoad.resolve(layout);
      pageLoad.resolve(page);
      await Promise.all(loads);

      expect(route.__loaded).toBe(true);
      expect(route.layouts).toEqual([layout]);
      expect(route.page).toBe(page);
    },
  );

  it("does not extend a request that joins a load already in flight", async () => {
    const load = deferred<unknown>();
    const route: LazyLoadableRoute = { page: null, __loadPage: () => load.promise };
    const creator = { waitUntil: vi.fn() };
    const joiner = { waitUntil: vi.fn() };

    const first = runWithExecutionContext(creator, () => ensureAppRouteModulesLoaded(route));
    const second = runWithExecutionContext(joiner, () => ensureAppRouteModulesLoaded(route));
    load.resolve({ default: () => null });
    await Promise.all([first, second]);

    expect(creator.waitUntil).toHaveBeenCalledOnce();
    expect(joiner.waitUntil).not.toHaveBeenCalled();
  });
});
