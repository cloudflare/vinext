function hasKey<K extends string, T extends object>(
  value: T,
  key: K,
): value is T & { [P in K]: unknown } {
  return key in value;
}

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
