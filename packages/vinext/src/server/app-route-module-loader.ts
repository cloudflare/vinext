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
 *
 * Every thunk is invoked via `runOutsideRequestScopes`. Hydration runs inside
 * the matched request's scopes, and a dynamic `import()` propagates
 * AsyncLocalStorage into the imported module's top-level evaluation — so
 * without that guard, module-scope `headers()`/`cookies()`/`after()` would bind
 * to whichever request happened to be first. Since a module evaluates once per
 * isolate and its namespace is cached here, that first request's data would
 * then be served to every later one. Matching Next.js, which loads components
 * before entering the request store, module scope simply sees no request.
 */

import { runOutsideRequestScopes } from "vinext/shims/internal/als-registry";
import { isUnknownRecord } from "../utils/record.js";
import { shareIsolatePromise } from "./isolate-shared-promise.js";
import {
  isOwnerLevelSlot,
  keepOwnerLevelEntries,
  resolveWholeInterceptingRouteEnd,
} from "./app-page-whole-intercepting-route.js";

type LazyModuleThunk = () => Promise<unknown>;
type LazyModuleLoaderArray = readonly (LazyModuleThunk | null | undefined)[];

type LazyLoadableIntercept = {
  page?: unknown;
  __pageLoader?: LazyModuleThunk | null;
  notFound?: unknown;
  __loadNotFound?: LazyModuleThunk | null;
  ownerDefault?: unknown;
  __loadOwnerDefault?: LazyModuleThunk | null;
  interceptLayouts?: readonly unknown[] | null;
  __loadInterceptLayouts?: LazyModuleLoaderArray | null;
  interceptLoadings?: readonly unknown[] | null;
  __loadInterceptLoadings?: LazyModuleLoaderArray | null;
  interceptNotFounds?: readonly unknown[] | null;
  __loadInterceptNotFounds?: LazyModuleLoaderArray | null;
  interceptForbiddens?: readonly unknown[] | null;
  __loadInterceptForbiddens?: LazyModuleLoaderArray | null;
  interceptUnauthorizeds?: readonly unknown[] | null;
  __loadInterceptUnauthorizeds?: LazyModuleLoaderArray | null;
  interceptErrors?: readonly unknown[] | null;
  __loadInterceptErrors?: LazyModuleLoaderArray | null;
  __loadState?: {
    page?: unknown;
    pageLoading?: Promise<unknown> | null;
    notFound?: unknown;
    notFoundLoading?: Promise<unknown> | null;
    ownerDefault?: unknown;
    ownerDefaultLoading?: Promise<unknown> | null;
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
  errors?: readonly unknown[];
  notFound?: unknown;
  notFounds?: readonly unknown[];
  loadingTreePositions?: readonly number[] | null;
  layoutIndex?: number;
  ownerTreePosition?: number | null;
  __loadPage?: LazyModuleThunk | null;
  __loadDefault?: LazyModuleThunk | null;
  __loadLayout?: LazyModuleThunk | null;
  __loadConfigLayouts?: LazyModuleLoaderArray | null;
  __loadLoading?: LazyModuleThunk | null;
  __loadLoadings?: LazyModuleLoaderArray | null;
  __loadError?: LazyModuleThunk | null;
  __loadErrors?: LazyModuleLoaderArray | null;
  __loadNotFound?: LazyModuleThunk | null;
  __loadNotFounds?: LazyModuleLoaderArray | null;
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
  segmentNotFounds?: unknown[];
  segmentForbiddens?: unknown[];
  segmentUnauthorizeds?: unknown[];
  loading?: unknown;
  error?: unknown;
  notFound?: unknown;
  forbidden?: unknown;
  unauthorized?: unknown;
  routeSegments?: readonly string[];
  layoutTreePositions?: readonly number[] | null;
  templateTreePositions?: readonly number[] | null;
  loadingTreePositions?: readonly number[] | null;
  errorTreePositions?: readonly number[] | null;
  notFoundTreePosition?: number | null;
  forbiddenTreePosition?: number | null;
  unauthorizedTreePosition?: number | null;
  segmentNotFoundTreePositions?: readonly number[] | null;
  segmentForbiddenTreePositions?: readonly number[] | null;
  segmentUnauthorizedTreePositions?: readonly number[] | null;
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
  __loadSegmentNotFounds?: LazyModuleLoaderArray | null;
  __loadSegmentForbiddens?: LazyModuleLoaderArray | null;
  __loadSegmentUnauthorizeds?: LazyModuleLoaderArray | null;
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
    runOutsideRequestScopes(loader).then((module) => {
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
      runOutsideRequestScopes(loader).then((module) => {
        slots[index] = module;
      }),
    );
  }
}

/**
 * Hydrate one lazily-imported intercept module onto the intercept, dedup'd
 * through `__loadState` so concurrent navigations share a single import.
 *
 * The intercept's page and not-found modules were loaded inline at their call
 * sites, which meant they missed the isolation every other route module gets.
 * They are user modules cached for the isolate's lifetime just like the rest,
 * so they belong on this path.
 */
async function hydrateInterceptModule(
  intercept: LazyLoadableIntercept,
  loader: LazyModuleThunk | null | undefined,
  field: "page" | "notFound" | "ownerDefault",
  loadingField: "pageLoading" | "notFoundLoading" | "ownerDefaultLoading",
): Promise<void> {
  const loadState = intercept.__loadState;
  const cached = loadState?.[field];
  if (cached != null) intercept[field] = cached;
  if (!loader || intercept[field] != null) return;

  const loading =
    loadState?.[loadingField] ??
    shareIsolatePromise(
      runOutsideRequestScopes(loader)
        .then((module) => {
          intercept[field] = module;
          if (loadState) {
            loadState[field] = module;
            loadState[loadingField] = null;
          }
          return module;
        })
        .catch((error: unknown) => {
          if (loadState) loadState[loadingField] = null;
          throw error;
        }),
    );
  if (loadState) loadState[loadingField] = loading;
  // Each matched interception is a request-local clone that shares only
  // `__loadState`. A concurrent caller can therefore observe the in-flight
  // promise above without being the clone assigned by its `.then()` callback.
  // Publish the resolved namespace onto every caller's clone before returning.
  intercept[field] = await loading;
}

/** Hydrate an intercepting route's page module onto `intercept.page`. */
export function loadAppInterceptPage(intercept: LazyLoadableIntercept): Promise<void> {
  return hydrateInterceptModule(intercept, intercept.__pageLoader, "page", "pageLoading");
}

/** Hydrate an intercepting route's not-found boundary onto `intercept.notFound`. */
export function loadAppInterceptNotFound(intercept: LazyLoadableIntercept): Promise<void> {
  return hydrateInterceptModule(intercept, intercept.__loadNotFound, "notFound", "notFoundLoading");
}

/**
 * Hydrate the `default` file of the directory holding an intercepting route's
 * slot onto `intercept.ownerDefault`, which a render of the whole intercepting
 * route shows in the owner's children.
 */
export function loadAppInterceptOwnerDefault(intercept: LazyLoadableIntercept): Promise<void> {
  return hydrateInterceptModule(
    intercept,
    intercept.__loadOwnerDefault,
    "ownerDefault",
    "ownerDefaultLoading",
  );
}

export function loadAppInterceptLayouts(
  intercept: LazyLoadableIntercept,
): Promise<readonly unknown[]> {
  const loadState = intercept.__loadState;
  if (loadState?.interceptLayoutsLoading) return loadState.interceptLayoutsLoading;

  const loads: Promise<unknown>[] = [];
  pushArrayLoads(loads, intercept.interceptLayouts, intercept.__loadInterceptLayouts);
  pushArrayLoads(loads, intercept.interceptLoadings, intercept.__loadInterceptLoadings);
  pushArrayLoads(loads, intercept.interceptNotFounds, intercept.__loadInterceptNotFounds);
  pushArrayLoads(loads, intercept.interceptForbiddens, intercept.__loadInterceptForbiddens);
  pushArrayLoads(loads, intercept.interceptUnauthorizeds, intercept.__loadInterceptUnauthorizeds);
  pushArrayLoads(loads, intercept.interceptErrors, intercept.__loadInterceptErrors);
  if (loads.length === 0) return Promise.resolve(intercept.interceptLayouts ?? []);

  const loading = shareIsolatePromise(
    Promise.all(loads)
      .then(() => {
        if (loadState) loadState.interceptLayoutsLoading = null;
        return intercept.interceptLayouts ?? [];
      })
      .catch((error: unknown) => {
        if (loadState) loadState.interceptLayoutsLoading = null;
        throw error;
      }),
  );
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
  interceptOpts?: unknown,
): TRoute | Promise<TRoute> {
  if (!route || route.__loaded) return route as TRoute;
  if (
    isUnknownRecord(interceptOpts) &&
    interceptOpts.rendersInterceptionSource === true &&
    interceptOpts.rendersWholeInterceptingRoute === true
  ) {
    return loadWholeInterceptingRouteModules(route, interceptOpts.interceptSlotKey);
  }
  if (route.__loading) return route.__loading as Promise<TRoute>;

  const loadPage = route.__loadPage;
  const loadRouteHandler = route.__loadRouteHandler;
  const loads: Promise<unknown>[] = [];

  pushFieldLoad(loads, route as Record<string, unknown>, "page", loadPage);
  pushFieldLoad(loads, route as Record<string, unknown>, "routeHandler", loadRouteHandler);
  pushRouteSegmentLoads(loads, route);

  for (const slot of Object.values(route.slots ?? {})) {
    pushFieldLoad(loads, slot as Record<string, unknown>, "page", slot.__loadPage);
    pushFieldLoad(loads, slot as Record<string, unknown>, "default", slot.__loadDefault);
    pushFieldLoad(loads, slot as Record<string, unknown>, "layout", slot.__loadLayout);
    pushArrayLoads(loads, slot.configLayouts, slot.__loadConfigLayouts);
    pushFieldLoad(loads, slot as Record<string, unknown>, "loading", slot.__loadLoading);
    pushArrayLoads(loads, slot.loadings, slot.__loadLoadings);
    pushFieldLoad(loads, slot as Record<string, unknown>, "error", slot.__loadError);
    pushArrayLoads(loads, slot.errors, slot.__loadErrors);
    pushFieldLoad(loads, slot as Record<string, unknown>, "notFound", slot.__loadNotFound);
    pushArrayLoads(loads, slot.notFounds, slot.__loadNotFounds);
  }

  if (loads.length === 0) {
    route.__loaded = true;
    return route;
  }

  const loading = shareIsolatePromise(
    Promise.all(loads)
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
      }),
  );

  route.__loading = loading;
  return loading;
}

/**
 * A render of the whole intercepting route (see app-page-element-builder.ts)
 * shows the layouts and segment files down to the slot owner's folder, every
 * other slot's default and the intercepted slot's own files, but never the
 * owner's page, another slot's branch, or the files and slots of a route
 * group below the owner's folder that holds the owner's page (see
 * app-page-whole-intercepting-route.ts). Like Next.js, whose intercepting
 * route imports only its own tree, it loads only those, so a module it
 * doesn't show can't fail it. The route stays unloaded for a render of its
 * own.
 */
function loadWholeInterceptingRouteModules<TRoute extends LazyLoadableRoute>(
  route: TRoute,
  interceptSlotKey: unknown,
): TRoute | Promise<TRoute> {
  const loads: Promise<unknown>[] = [];
  const ownerTreePosition = resolveWholeInterceptingRouteEnd(route, interceptSlotKey);
  pushRouteSegmentLoads(loads, route, ownerTreePosition);
  for (const [slotKey, slot] of Object.entries(route.slots ?? {})) {
    if (ownerTreePosition !== undefined && !isOwnerLevelSlot(route, slot, ownerTreePosition)) {
      continue;
    }
    if (slotKey !== interceptSlotKey) {
      pushFieldLoad(loads, slot as Record<string, unknown>, "default", slot.__loadDefault);
      continue;
    }
    pushFieldLoad(loads, slot as Record<string, unknown>, "layout", slot.__loadLayout);
    pushFieldLoad(loads, slot as Record<string, unknown>, "loading", slot.__loadLoading);
    // Only the slot root's loading wraps an interception (see
    // app-page-route-wiring.tsx).
    pushArrayLoads(
      loads,
      slot.loadings,
      slot.__loadLoadings?.map((loader, index) =>
        slot.loadingTreePositions?.[index] === 0 ? loader : null,
      ),
    );
    pushFieldLoad(loads, slot as Record<string, unknown>, "error", slot.__loadError);
    pushFieldLoad(loads, slot as Record<string, unknown>, "notFound", slot.__loadNotFound);
  }
  if (loads.length === 0) return route;
  // Like the route's own load, its imports outlive the request that starts
  // them (see isolate-shared-promise.ts).
  return shareIsolatePromise(Promise.all(loads).then(() => route));
}

/**
 * Queue the loads of a route's layouts, templates and segment boundaries, or
 * with `ownerTreePosition`, of those down to that folder only.
 */
function pushRouteSegmentLoads(
  loads: Promise<unknown>[],
  route: LazyLoadableRoute,
  ownerTreePosition?: number,
): void {
  const keep = (
    loaders: LazyModuleLoaderArray | null | undefined,
    treePositions: readonly number[] | null | undefined,
  ) =>
    ownerTreePosition === undefined
      ? loaders
      : keepOwnerLevelEntries(loaders, treePositions, ownerTreePosition);
  const keepsFile = (treePosition: number | null | undefined) =>
    ownerTreePosition === undefined || (treePosition != null && treePosition <= ownerTreePosition);
  const target = route as Record<string, unknown>;
  // The route's own `loading` and `error` are in its folder.
  const routeTreePosition = route.routeSegments?.length ?? 0;
  if (keepsFile(routeTreePosition)) {
    pushFieldLoad(loads, target, "loading", route.__loadLoading);
    pushFieldLoad(loads, target, "error", route.__loadError);
  }
  if (keepsFile(route.notFoundTreePosition)) {
    pushFieldLoad(loads, target, "notFound", route.__loadNotFound);
  }
  if (keepsFile(route.forbiddenTreePosition)) {
    pushFieldLoad(loads, target, "forbidden", route.__loadForbidden);
  }
  if (keepsFile(route.unauthorizedTreePosition)) {
    pushFieldLoad(loads, target, "unauthorized", route.__loadUnauthorized);
  }
  const layoutTreePositions = route.layoutTreePositions;
  pushArrayLoads(loads, route.layouts, keep(route.__loadLayouts, layoutTreePositions));
  pushArrayLoads(loads, route.templates, keep(route.__loadTemplates, route.templateTreePositions));
  pushArrayLoads(loads, route.loadings, keep(route.__loadLoadings, route.loadingTreePositions));
  pushArrayLoads(loads, route.errors, keep(route.__loadErrors, layoutTreePositions));
  pushArrayLoads(loads, route.errorPaths, keep(route.__loadErrorPaths, route.errorTreePositions));
  pushArrayLoads(loads, route.notFounds, keep(route.__loadNotFounds, layoutTreePositions));
  pushArrayLoads(loads, route.forbiddens, keep(route.__loadForbiddens, layoutTreePositions));
  pushArrayLoads(loads, route.unauthorizeds, keep(route.__loadUnauthorizeds, layoutTreePositions));
  pushArrayLoads(
    loads,
    route.segmentNotFounds,
    keep(route.__loadSegmentNotFounds, route.segmentNotFoundTreePositions),
  );
  pushArrayLoads(
    loads,
    route.segmentForbiddens,
    keep(route.__loadSegmentForbiddens, route.segmentForbiddenTreePositions),
  );
  pushArrayLoads(
    loads,
    route.segmentUnauthorizeds,
    keep(route.__loadSegmentUnauthorizeds, route.segmentUnauthorizedTreePositions),
  );
}
