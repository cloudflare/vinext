import { getOrCreateAls } from "./internal/als-registry.js";
import { makeHangingPromise } from "./internal/make-hanging-promise.js";

export type InstantPrefetchShellState = {
  dynamicAbortController: AbortController;
  hasDynamicBoundary: boolean;
  isFinalRenderStarted: boolean;
  pendingAbortCleanup: (() => void) | null;
  pendingCacheTasks: number;
  reactAbortController: AbortController;
  route: string;
  stage: "runtime" | "static";
};

const instantPrefetchShellAls = getOrCreateAls<InstantPrefetchShellState>(
  "vinext.instantPrefetchShell.als",
);

const useCacheAlsKey = Symbol.for("vinext.cacheRuntime.contextAls");
const unstableCacheAlsKey = Symbol.for("vinext.unstableCache.als");

type CacheScopeStorage = {
  getStore: () => unknown;
};

function getCacheScopeStore(key: symbol): unknown {
  const storage = Reflect.get(globalThis, key);
  if (!storage || typeof storage !== "object") return undefined;
  const getStore = Reflect.get(storage, "getStore");
  if (typeof getStore !== "function") return undefined;
  return getStore.call(storage as CacheScopeStorage);
}

function isInsideStaticRequestDataCacheScope(): boolean {
  const useCacheStore = getCacheScopeStore(useCacheAlsKey);
  if (
    useCacheStore &&
    typeof useCacheStore === "object" &&
    Reflect.get(useCacheStore, "variant") !== "private"
  ) {
    return true;
  }
  return getCacheScopeStore(unstableCacheAlsKey) === true;
}

function scheduleAfterTask(callback: () => void): () => void {
  let firstTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    firstTimer = null;
    secondTimer = setTimeout(() => {
      secondTimer = null;
      callback();
    }, 0);
  }, 0);
  let secondTimer: ReturnType<typeof setTimeout> | null = null;

  return () => {
    if (firstTimer !== null) clearTimeout(firstTimer);
    if (secondTimer !== null) clearTimeout(secondTimer);
  };
}

function cancelPendingAbort(state: InstantPrefetchShellState): void {
  if (state.pendingAbortCleanup === null) return;
  state.pendingAbortCleanup();
  state.pendingAbortCleanup = null;
}

function scheduleAbortIfReady(state: InstantPrefetchShellState): void {
  if (
    !state.isFinalRenderStarted ||
    !state.hasDynamicBoundary ||
    state.pendingCacheTasks > 0 ||
    state.pendingAbortCleanup !== null ||
    state.reactAbortController.signal.aborted
  ) {
    return;
  }

  state.pendingAbortCleanup = scheduleAfterTask(() => {
    state.pendingAbortCleanup = null;
    if (
      state.isFinalRenderStarted &&
      state.hasDynamicBoundary &&
      state.pendingCacheTasks === 0 &&
      !state.reactAbortController.signal.aborted
    ) {
      // Keep the dynamic promise pending so React records a hole instead of
      // serializing its abort rejection into the Flight payload.
      state.reactAbortController.abort();
    }
  });
}

export function createInstantPrefetchShellState(
  route: string,
  stage: "runtime" | "static" = "runtime",
): InstantPrefetchShellState {
  return {
    dynamicAbortController: new AbortController(),
    hasDynamicBoundary: false,
    isFinalRenderStarted: false,
    pendingAbortCleanup: null,
    pendingCacheTasks: 0,
    reactAbortController: new AbortController(),
    route,
    stage,
  };
}

export function runWithInstantPrefetchShellState<T>(
  state: InstantPrefetchShellState,
  fn: () => T,
): T {
  return instantPrefetchShellAls.run(state, fn);
}

export function trackInstantPrefetchShellCacheTask<T>(
  fn: () => Promise<T>,
  _cacheVariant: string,
): Promise<T> {
  const state = instantPrefetchShellAls.getStore();
  if (state === undefined) return fn();

  cancelPendingAbort(state);
  state.pendingCacheTasks++;
  let promise: Promise<T>;
  try {
    promise = fn();
  } catch (error) {
    state.pendingCacheTasks--;
    scheduleAbortIfReady(state);
    return Promise.reject(error);
  }
  return promise.finally(() => {
    state.pendingCacheTasks--;
    scheduleAbortIfReady(state);
  });
}

export function beginInstantPrefetchShellFinalRender(state: InstantPrefetchShellState): void {
  state.isFinalRenderStarted = true;
  scheduleAbortIfReady(state);
}

export function getInstantPrefetchShellReactSignal(state: InstantPrefetchShellState): AbortSignal {
  return state.reactAbortController.signal;
}

export function wasInstantPrefetchShellAborted(state: InstantPrefetchShellState): boolean {
  return state.hasDynamicBoundary && state.reactAbortController.signal.aborted;
}

export function suspendInstantPrefetchConnection(): Promise<never> | null {
  const state = instantPrefetchShellAls.getStore();
  if (!state) return null;
  state.hasDynamicBoundary = true;
  scheduleAbortIfReady(state);
  return makeHangingPromise(state.dynamicAbortController.signal, state.route, "connection()");
}

/**
 * Static instant shells stop before request-time data. Runtime instant shells
 * intentionally include headers/cookies and stop only at `connection()`.
 */
export function suspendStaticInstantPrefetchRequestData(expression: string): Promise<never> | null {
  const state = instantPrefetchShellAls.getStore();
  if (!state || state.stage !== "static") return null;
  // Public cache scopes own the request data they admitted into their key.
  // Suspending those reads would leave the tracked cache task waiting for the
  // static-stage abort while the abort itself waits for that task to settle.
  // Next.js similarly exposes cache-scope providers instead of the staged
  // request-data promise from inside `cache` / `unstable-cache` work units.
  if (isInsideStaticRequestDataCacheScope()) return null;
  state.hasDynamicBoundary = true;
  scheduleAbortIfReady(state);
  return makeHangingPromise(state.dynamicAbortController.signal, state.route, expression);
}

/**
 * A private cache is request-stage work. Stop before both lookup and execution
 * so even a warm per-request hit becomes a hole in a static instant shell.
 */
export function suspendStaticInstantPrefetchPrivateCache(): Promise<never> | null {
  const state = instantPrefetchShellAls.getStore();
  if (!state || state.stage !== "static") return null;
  state.hasDynamicBoundary = true;
  scheduleAbortIfReady(state);
  return makeHangingPromise(
    state.dynamicAbortController.signal,
    state.route,
    '"use cache: private"',
  );
}
