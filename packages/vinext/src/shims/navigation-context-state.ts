import * as React from "react";

const LAYOUT_SEGMENT_CONTEXT_KEY = Symbol.for("vinext.layoutSegmentContext");
const SERVER_INSERTED_HTML_CONTEXT_KEY = Symbol.for("vinext.serverInsertedHTMLContext");
const BFCACHE_ID_MAP_CONTEXT_KEY = Symbol.for("vinext.bfcacheIdMapContext");
const BFCACHE_SEGMENT_ID_CONTEXT_KEY = Symbol.for("vinext.bfcacheSegmentIdContext");
const GLOBAL_HYDRATION_CONTEXT_KEY = Symbol.for("vinext.navigation.clientHydrationContext");
const NAVIGATION_FALLBACK_STATE_KEY = Symbol.for("vinext.navigation.fallback");

/**
 * Map of parallel route key to child segments below the current layout.
 * The "children" key is always present.
 */
export type SegmentMap = Readonly<Record<string, string[]>> & {
  readonly children: string[];
};

export type NavigationContext = {
  pathname: string;
  searchParams: URLSearchParams;
  params: Record<string, string | string[]>;
};

type NavigationContextsGlobal = typeof globalThis & {
  [LAYOUT_SEGMENT_CONTEXT_KEY]?: React.Context<SegmentMap> | null;
  [SERVER_INSERTED_HTML_CONTEXT_KEY]?: React.Context<
    ((callback: () => unknown) => void) | null
  > | null;
  [BFCACHE_ID_MAP_CONTEXT_KEY]?: React.Context<Readonly<Record<string, string>> | null> | null;
  [BFCACHE_SEGMENT_ID_CONTEXT_KEY]?: React.Context<string | null> | null;
  [GLOBAL_HYDRATION_CONTEXT_KEY]?: NavigationContext | null;
};

function createContextIfAvailable<T>(defaultValue: T): React.Context<T> | null {
  return typeof React.createContext === "function" ? React.createContext(defaultValue) : null;
}

function getServerInsertedHTMLContext(): React.Context<
  ((callback: () => unknown) => void) | null
> | null {
  const globalState = globalThis as NavigationContextsGlobal;
  if (!globalState[SERVER_INSERTED_HTML_CONTEXT_KEY]) {
    globalState[SERVER_INSERTED_HTML_CONTEXT_KEY] = createContextIfAvailable<
      ((callback: () => unknown) => void) | null
    >(null);
  }
  return globalState[SERVER_INSERTED_HTML_CONTEXT_KEY] ?? null;
}

export const ServerInsertedHTMLContext = getServerInsertedHTMLContext();

export function getLayoutSegmentContext(): React.Context<SegmentMap> | null {
  const globalState = globalThis as NavigationContextsGlobal;
  if (!globalState[LAYOUT_SEGMENT_CONTEXT_KEY]) {
    globalState[LAYOUT_SEGMENT_CONTEXT_KEY] = createContextIfAvailable<SegmentMap>({
      children: [],
    });
  }
  return globalState[LAYOUT_SEGMENT_CONTEXT_KEY] ?? null;
}

export function getBfcacheIdMapContext(): React.Context<Readonly<
  Record<string, string>
> | null> | null {
  const globalState = globalThis as NavigationContextsGlobal;
  if (!globalState[BFCACHE_ID_MAP_CONTEXT_KEY]) {
    globalState[BFCACHE_ID_MAP_CONTEXT_KEY] = createContextIfAvailable<Readonly<
      Record<string, string>
    > | null>(null);
  }
  return globalState[BFCACHE_ID_MAP_CONTEXT_KEY] ?? null;
}

export function getBfcacheSegmentIdContext(): React.Context<string | null> | null {
  const globalState = globalThis as NavigationContextsGlobal;
  if (!globalState[BFCACHE_SEGMENT_ID_CONTEXT_KEY]) {
    globalState[BFCACHE_SEGMENT_ID_CONTEXT_KEY] = createContextIfAvailable<string | null>(null);
  }
  return globalState[BFCACHE_SEGMENT_ID_CONTEXT_KEY] ?? null;
}

export type NavigationStateAccessors = {
  getServerContext: () => NavigationContext | null;
  setServerContext: (context: NavigationContext | null) => void;
  getInsertedHTMLCallbacks: () => Array<() => unknown>;
  clearInsertedHTMLCallbacks: () => void;
};

export const GLOBAL_ACCESSORS_KEY = Symbol.for("vinext.navigation.globalAccessors");

type NavigationFallbackState = {
  serverContext: NavigationContext | null;
  serverInsertedHTMLCallbacks: Array<() => unknown>;
};

type NavigationStateGlobal = typeof globalThis & {
  [GLOBAL_ACCESSORS_KEY]?: NavigationStateAccessors;
  [NAVIGATION_FALLBACK_STATE_KEY]?: NavigationFallbackState;
};

function getFallbackState(): NavigationFallbackState {
  const globalState = globalThis as NavigationStateGlobal;
  return (globalState[NAVIGATION_FALLBACK_STATE_KEY] ??= {
    serverContext: null,
    serverInsertedHTMLCallbacks: [],
  });
}

function getGlobalAccessors(): NavigationStateAccessors | undefined {
  return (globalThis as NavigationStateGlobal)[GLOBAL_ACCESSORS_KEY];
}

function getClientHydrationContext(): NavigationContext | null | undefined {
  const globalState = globalThis as NavigationContextsGlobal;
  if (Object.prototype.hasOwnProperty.call(globalState, GLOBAL_HYDRATION_CONTEXT_KEY)) {
    return globalState[GLOBAL_HYDRATION_CONTEXT_KEY] ?? null;
  }
  return undefined;
}

function setClientHydrationContext(context: NavigationContext | null): void {
  (globalThis as NavigationContextsGlobal)[GLOBAL_HYDRATION_CONTEXT_KEY] = context;
}

export function clearClientHydrationContext(): void {
  if (typeof window !== "undefined") {
    setClientHydrationContext(null);
  }
}

let getServerContext = (): NavigationContext | null => {
  if (typeof window !== "undefined") {
    const hydrationContext = getClientHydrationContext();
    return hydrationContext !== undefined ? hydrationContext : getFallbackState().serverContext;
  }
  return getGlobalAccessors()?.getServerContext() ?? getFallbackState().serverContext;
};

let setServerContext = (context: NavigationContext | null): void => {
  if (typeof window !== "undefined") {
    getFallbackState().serverContext = context;
    setClientHydrationContext(context);
    return;
  }
  const accessors = getGlobalAccessors();
  if (accessors) {
    accessors.setServerContext(context);
  } else {
    getFallbackState().serverContext = context;
  }
};

let getInsertedHTMLCallbacks = (): Array<() => unknown> =>
  getGlobalAccessors()?.getInsertedHTMLCallbacks() ??
  getFallbackState().serverInsertedHTMLCallbacks;

let clearInsertedHTMLCallbacks = (): void => {
  const accessors = getGlobalAccessors();
  if (accessors) {
    accessors.clearInsertedHTMLCallbacks();
  } else {
    getFallbackState().serverInsertedHTMLCallbacks = [];
  }
};

/**
 * Register request-scoped accessors supplied by navigation-state.ts.
 * The global accessor key also bridges separate Vite module instances.
 */
export function _registerStateAccessors(accessors: NavigationStateAccessors): void {
  getServerContext = accessors.getServerContext;
  setServerContext = accessors.setServerContext;
  getInsertedHTMLCallbacks = accessors.getInsertedHTMLCallbacks;
  clearInsertedHTMLCallbacks = accessors.clearInsertedHTMLCallbacks;
}

export function getNavigationContext(): NavigationContext | null {
  return getServerContext();
}

export function setNavigationContext(context: NavigationContext | null): void {
  setServerContext(context);
}

export function registerServerInsertedHTMLCallback(callback: () => unknown): void {
  getInsertedHTMLCallbacks().push(callback);
}

function renderInsertedHTMLCallbacks(clear: boolean): unknown[] {
  const callbacks = getInsertedHTMLCallbacks();
  const results: unknown[] = [];
  for (const callback of callbacks) {
    try {
      const result = callback();
      if (result != null) results.push(result);
    } catch {
      // One style registry must not suppress output from the others.
    }
  }
  if (clear) callbacks.length = 0;
  return results;
}

export function flushServerInsertedHTML(): unknown[] {
  return renderInsertedHTMLCallbacks(true);
}

export function renderServerInsertedHTML(): unknown[] {
  return renderInsertedHTMLCallbacks(false);
}

export function clearServerInsertedHTML(): void {
  clearInsertedHTMLCallbacks();
}
