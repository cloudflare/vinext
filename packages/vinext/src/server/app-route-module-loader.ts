function hasKey<K extends string, T extends object>(
  value: T,
  key: K,
): value is T & { [P in K]: unknown } {
  return key in value;
}

// Per-route state for the load lifecycle (loaded flag + in-flight promise).
//
// For intercepted routes, `findIntercept` returns a per-request shallow copy
// of the manifest entry, so the WeakMap here keys the state on the copy —
// not the shared lookup entry. That means the route-level `loaded` flag is
// per-request, but the actual `import()` dedup still happens inside
// `createRouteModuleLoader` (whose closure promise is keyed on the loader
// function from the shared manifest entry). So concurrent `loadRouteModules`
// calls for the same intercept still share a single in-flight `import()`.
const lazyRouteStates = new WeakMap<object, LazyRouteState>();

type LazyRouteState = {
  loaded: boolean;
  promise: Promise<unknown> | undefined;
};

function getOrCreateLazyRouteState(route: object): LazyRouteState {
  let state = lazyRouteStates.get(route);
  if (!state) {
    state = { loaded: false, promise: undefined };
    lazyRouteStates.set(route, state);
  }
  return state;
}

async function loadLazyModules(route: object): Promise<void> {
  if (!hasKey(route, "__pageLoader")) return;
  const loader = route.__pageLoader;
  if (typeof loader !== "function") return;
  const pageModule = await loader();
  if (hasKey(route, "page")) {
    route.page = pageModule;
  }
}

// Rejected `import()` results are cached for the lifetime of the loader
// (i.e. the worker instance). This is intentional: the loaders point at
// built JS chunks whose URL is stable for a deploy, so a rejection means
// the chunk is genuinely missing — there is nothing to retry within the
// same deploy. Operators must roll forward (rebuild/redeploy) to recover.
export function createRouteModuleLoader<T>(loadModule: () => Promise<T>): () => Promise<T> {
  let promise: Promise<T> | null = null;
  return () => {
    promise ??= loadModule();
    return promise;
  };
}

export async function loadRouteModules<T extends object>(route: T): Promise<T> {
  if (!route) return route;

  const state = getOrCreateLazyRouteState(route);
  if (state.loaded) return route;
  if (state.promise) {
    await state.promise;
    return route;
  }

  const promise = loadLazyModules(route);
  state.promise = promise;
  await promise;
  state.loaded = true;
  return route;
}

export async function loadRouteMatch<T extends object>(
  match: { route: T } | null,
): Promise<{ route: T } | null> {
  if (!match) return null;
  await loadRouteModules(match.route);
  return match;
}
