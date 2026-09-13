export type NavigationContext = {
  pathname: string;
  searchParams: URLSearchParams;
  params: Record<string, string | string[]>;
};

type NavigationStateAccessors = {
  setServerContext: (context: NavigationContext | null) => void;
};

const GLOBAL_ACCESSORS_KEY = Symbol.for("vinext.navigation.globalAccessors");
const NAVIGATION_FALLBACK_STATE_KEY = Symbol.for("vinext.navigation.fallback");

type NavigationStateGlobal = typeof globalThis & {
  [GLOBAL_ACCESSORS_KEY]?: NavigationStateAccessors;
  [NAVIGATION_FALLBACK_STATE_KEY]?: {
    serverContext: NavigationContext | null;
    serverInsertedHTMLCallbacks: Array<() => unknown>;
  };
};

/** Lightweight server context setter for request-only runtimes such as middleware. */
export function setNavigationContext(context: NavigationContext | null): void {
  const globalState = globalThis as NavigationStateGlobal;
  const accessors = globalState[GLOBAL_ACCESSORS_KEY];
  if (accessors) {
    accessors.setServerContext(context);
    return;
  }
  const fallback = (globalState[NAVIGATION_FALLBACK_STATE_KEY] ??= {
    serverContext: null,
    serverInsertedHTMLCallbacks: [],
  });
  fallback.serverContext = context;
}
