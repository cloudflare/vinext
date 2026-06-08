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
 * `ensureAppRouteModulesLoaded` resolves a route's lazy thunks and populates the
 * synchronous `page` / `routeHandler` fields that the rest of the request
 * pipeline reads directly. It is:
 *
 *  - idempotent: once a route is loaded it returns immediately;
 *  - dedup'd: concurrent calls for the same route share one in-flight promise,
 *    so a burst of requests to the same route triggers a single import.
 *
 * Callers must `await` it before any synchronous read of `route.page` or
 * `route.routeHandler` (segment config, fetch-cache mode, runtime resolution,
 * dispatch branch, element building, etc.).
 */

type LazyModuleThunk = () => Promise<unknown>;

export type LazyLoadableRoute = {
  page?: unknown;
  routeHandler?: unknown;
  /** Lazy loader for the page module; `null`/absent when the page is eager. */
  __loadPage?: LazyModuleThunk | null;
  /** Lazy loader for the route-handler module; `null`/absent when none. */
  __loadRouteHandler?: LazyModuleThunk | null;
  /** Set once the lazy modules have been resolved onto `page`/`routeHandler`. */
  __loaded?: boolean;
  /** In-flight hydration promise, used to dedup concurrent loads. */
  __loading?: Promise<unknown> | null;
};

/**
 * Resolve a route's lazy page/route-handler modules and assign them onto the
 * route's synchronous `page` / `routeHandler` fields. Returns the same route
 * reference (synchronously when already loaded, otherwise after the in-flight
 * import resolves). Safe to call on `null`/`undefined` routes and on eager
 * routes that have no lazy thunks.
 */
export function ensureAppRouteModulesLoaded<TRoute extends LazyLoadableRoute>(
  route: TRoute | null | undefined,
): TRoute | Promise<TRoute> {
  if (!route || route.__loaded) return route as TRoute;
  if (route.__loading) return route.__loading as Promise<TRoute>;

  const loadPage = route.__loadPage;
  const loadRouteHandler = route.__loadRouteHandler;
  if (!loadPage && !loadRouteHandler) {
    route.__loaded = true;
    return route;
  }

  const loading = Promise.all([
    loadPage ? loadPage() : undefined,
    loadRouteHandler ? loadRouteHandler() : undefined,
  ])
    .then(([pageModule, routeHandlerModule]) => {
      if (loadPage) route.page = pageModule;
      if (loadRouteHandler) route.routeHandler = routeHandlerModule;
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
