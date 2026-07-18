/**
 * Lazy route-module hydration for the App Router RSC entry.
 *
 * The generated route table (see `entries/app-rsc-manifest.ts`) emits page and
 * route-handler modules as lazy `() => import()` thunks instead of eager
 * `import * as mod_N` namespaces. This keeps those modules out of the RSC
 * entry's top-level evaluation, so an app with many routes — or routes with
 * expensive module-level initialization — does not pay to evaluate every route
 * module at Worker startup. Only the module(s) for the matched route are
 * evaluated, on demand.
 *
 * `ensureAppRouteModulesLoaded` resolves a route's lazy thunks and populates
 * the synchronous module fields that the rest of the request pipeline reads
 * directly (`page`, `routeHandler`, layouts, templates, boundaries, and
 * parallel-slot modules). It is:
 *
 *  - idempotent: once a route is loaded it returns immediately;
 *  - dedup'd: concurrent calls for the same route share one in-flight promise,
 *    so a burst of requests to the same route triggers a single import.
 *
 * Callers must `await` it before any synchronous read of route modules
 * (segment config, fetch-cache mode, runtime resolution, dispatch branch,
 * element building, etc.).
 */

type LazyModuleThunk = () => Promise<unknown>;
type LazyModuleLoaderArray = readonly (LazyModuleThunk | null | undefined)[];

type LazyLoadableIntercept = {
  interceptLayouts?: readonly unknown[] | null;
  __loadInterceptLayouts?: LazyModuleLoaderArray | null;
  interceptLoadings?: readonly unknown[] | null;
  __loadInterceptLoadings?: LazyModuleLoaderArray | null;
  __loadState?: {
    interceptLayoutsLoading: Promise<readonly unknown[]> | null;
  };
};

type LazyLoadableSlot = {
  page?: unknown;
  default?: unknown;
  layout?: unknown;
  configLayouts?: readonly unknown[];
  loading?: unknown;
  loadings?: readonly unknown[];
  error?: unknown;
  notFound?: unknown;
  __loadPage?: LazyModuleThunk | null;
  __loadDefault?: LazyModuleThunk | null;
  __loadLayout?: LazyModuleThunk | null;
  __loadConfigLayouts?: LazyModuleLoaderArray | null;
  __loadLoading?: LazyModuleThunk | null;
  __loadLoadings?: LazyModuleLoaderArray | null;
  __loadError?: LazyModuleThunk | null;
  __loadNotFound?: LazyModuleThunk | null;
  /** Hydrated only after an intercept matches, not with the slot's base modules. */
  intercepts?: LazyLoadableIntercept[];
};

export type LazyLoadableRoute = {
  page?: unknown;
  routeHandler?: unknown;
  layouts?: unknown[];
  templates?: unknown[];
  loadings?: unknown[];
  errors?: unknown[];
  errorPaths?: unknown[];
  notFounds?: unknown[];
  forbiddens?: unknown[];
  unauthorizeds?: unknown[];
  loading?: unknown;
  error?: unknown;
  notFound?: unknown;
  forbidden?: unknown;
  unauthorized?: unknown;
  slots?: Record<string, LazyLoadableSlot>;
  siblingIntercepts?: LazyLoadableIntercept[];
  /** Lazy loader for the page module; `null`/absent when the page is eager. */
  __loadPage?: LazyModuleThunk | null;
  /** Lazy loader for the route-handler module; `null`/absent when none. */
  __loadRouteHandler?: LazyModuleThunk | null;
  __loadLayouts?: LazyModuleLoaderArray | null;
  __loadTemplates?: LazyModuleLoaderArray | null;
  __loadLoadings?: LazyModuleLoaderArray | null;
  __loadErrors?: LazyModuleLoaderArray | null;
  __loadErrorPaths?: LazyModuleLoaderArray | null;
  __loadNotFounds?: LazyModuleLoaderArray | null;
  __loadForbiddens?: LazyModuleLoaderArray | null;
  __loadUnauthorizeds?: LazyModuleLoaderArray | null;
  __loadLoading?: LazyModuleThunk | null;
  __loadError?: LazyModuleThunk | null;
  __loadNotFound?: LazyModuleThunk | null;
  __loadForbidden?: LazyModuleThunk | null;
  __loadUnauthorized?: LazyModuleThunk | null;
  /** Set once the route's lazy module fields have been resolved. */
  __loaded?: boolean;
  /** In-flight hydration promise, used to dedup concurrent loads. */
  __loading?: Promise<unknown> | null;
};

function pushFieldLoad(
  loads: Promise<unknown>[],
  target: Record<string, unknown>,
  field: string,
  loader: LazyModuleThunk | null | undefined,
): void {
  if (!loader || target[field] != null) return;
  loads.push(
    loader().then((module) => {
      target[field] = module;
    }),
  );
}

function pushArrayLoads(
  loads: Promise<unknown>[],
  target: readonly unknown[] | null | undefined,
  loaders: LazyModuleLoaderArray | null | undefined,
): void {
  if (!target || !loaders) return;

  // The manifest emits these arrays as fresh mutable literals (e.g. `[null,
  // null]`) sized to match `loaders`; the loader is their sole writer, filling
  // each slot once on first resolve. The public field types stay `readonly`
  // because callers must not mutate route metadata — so the in-place write is a
  // boundary-local cast here rather than a widening of the shared contract.
  const slots = target as unknown[];
  for (const [index, loader] of loaders.entries()) {
    if (index >= slots.length || !loader || slots[index] != null) continue;
    loads.push(
      loader().then((module) => {
        slots[index] = module;
      }),
    );
  }
}

export function loadAppInterceptLayouts(
  intercept: LazyLoadableIntercept,
): Promise<readonly unknown[]> {
  const loadState = intercept.__loadState;
  if (loadState?.interceptLayoutsLoading) return loadState.interceptLayoutsLoading;

  const loads: Promise<unknown>[] = [];
  pushArrayLoads(loads, intercept.interceptLayouts, intercept.__loadInterceptLayouts);
  pushArrayLoads(loads, intercept.interceptLoadings, intercept.__loadInterceptLoadings);
  if (loads.length === 0) return Promise.resolve(intercept.interceptLayouts ?? []);

  const loading = Promise.all(loads)
    .then(() => {
      if (loadState) loadState.interceptLayoutsLoading = null;
      return intercept.interceptLayouts ?? [];
    })
    .catch((error: unknown) => {
      if (loadState) loadState.interceptLayoutsLoading = null;
      throw error;
    });
  if (loadState) loadState.interceptLayoutsLoading = loading;
  return loading;
}

/**
 * Resolve a route's lazy modules and assign them onto the route's synchronous
 * module fields. Returns the same route reference (synchronously when already
 * loaded, otherwise after the in-flight import resolves). Safe to call on
 * `null`/`undefined` routes and on eager routes that have no lazy thunks.
 */
export function ensureAppRouteModulesLoaded<TRoute extends LazyLoadableRoute>(
  route: TRoute | null | undefined,
): TRoute | Promise<TRoute> {
  if (!route || route.__loaded) return route as TRoute;
  if (route.__loading) return route.__loading as Promise<TRoute>;

  const loadPage = route.__loadPage;
  const loadRouteHandler = route.__loadRouteHandler;
  const loads: Promise<unknown>[] = [];

  pushFieldLoad(loads, route as Record<string, unknown>, "page", loadPage);
  pushFieldLoad(loads, route as Record<string, unknown>, "routeHandler", loadRouteHandler);
  pushFieldLoad(loads, route as Record<string, unknown>, "loading", route.__loadLoading);
  pushFieldLoad(loads, route as Record<string, unknown>, "error", route.__loadError);
  pushFieldLoad(loads, route as Record<string, unknown>, "notFound", route.__loadNotFound);
  pushFieldLoad(loads, route as Record<string, unknown>, "forbidden", route.__loadForbidden);
  pushFieldLoad(loads, route as Record<string, unknown>, "unauthorized", route.__loadUnauthorized);
  pushArrayLoads(loads, route.layouts, route.__loadLayouts);
  pushArrayLoads(loads, route.templates, route.__loadTemplates);
  pushArrayLoads(loads, route.loadings, route.__loadLoadings);
  pushArrayLoads(loads, route.errors, route.__loadErrors);
  pushArrayLoads(loads, route.errorPaths, route.__loadErrorPaths);
  pushArrayLoads(loads, route.notFounds, route.__loadNotFounds);
  pushArrayLoads(loads, route.forbiddens, route.__loadForbiddens);
  pushArrayLoads(loads, route.unauthorizeds, route.__loadUnauthorizeds);

  for (const slot of Object.values(route.slots ?? {})) {
    pushFieldLoad(loads, slot as Record<string, unknown>, "page", slot.__loadPage);
    pushFieldLoad(loads, slot as Record<string, unknown>, "default", slot.__loadDefault);
    pushFieldLoad(loads, slot as Record<string, unknown>, "layout", slot.__loadLayout);
    pushArrayLoads(loads, slot.configLayouts, slot.__loadConfigLayouts);
    pushFieldLoad(loads, slot as Record<string, unknown>, "loading", slot.__loadLoading);
    pushArrayLoads(loads, slot.loadings, slot.__loadLoadings);
    pushFieldLoad(loads, slot as Record<string, unknown>, "error", slot.__loadError);
    pushFieldLoad(loads, slot as Record<string, unknown>, "notFound", slot.__loadNotFound);
  }

  if (loads.length === 0) {
    route.__loaded = true;
    return route;
  }

  const loading = Promise.all(loads)
    .then(() => {
      route.__loaded = true;
      route.__loading = null;
      return route;
    })
    .catch((error: unknown) => {
      // A rejected dynamic import() must not be cached: clearing `__loading`
      // (and leaving `__loaded` false) lets the next request retry instead of
      // wedging the route into a permanent failure for the isolate's lifetime.
      // Re-throw so the current request still observes the error. This mirrors
      // the eager model, where a module-eval failure is retried per isolate
      // rather than stuck on a stored rejected promise.
      route.__loading = null;
      throw error;
    });

  route.__loading = loading;
  return loading;
}
