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
};

const instantPrefetchShellAls = getOrCreateAls<InstantPrefetchShellState>(
  "vinext.instantPrefetchShell.als",
);

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

export function createInstantPrefetchShellState(route: string): InstantPrefetchShellState {
  return {
    dynamicAbortController: new AbortController(),
    hasDynamicBoundary: false,
    isFinalRenderStarted: false,
    pendingAbortCleanup: null,
    pendingCacheTasks: 0,
    reactAbortController: new AbortController(),
    route,
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
