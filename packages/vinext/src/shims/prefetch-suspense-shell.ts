import { getOrCreateAls } from "./internal/als-registry.js";
import { makeHangingPromise } from "./internal/make-hanging-promise.js";

type PrefetchSuspenseShellState = {
  dynamicAbortController: AbortController;
  reactAbortController: AbortController;
  aborted: boolean;
  instant: boolean;
  cancelAbort: (() => void) | null;
  route: string;
};

const prefetchSuspenseShellAls = getOrCreateAls<PrefetchSuspenseShellState>(
  "vinext.prefetchSuspenseShell.als",
);

export function createPrefetchSuspenseShellState(
  route: string,
  instant = false,
): PrefetchSuspenseShellState {
  return {
    dynamicAbortController: new AbortController(),
    reactAbortController: new AbortController(),
    aborted: false,
    instant,
    cancelAbort: null,
    route,
  };
}

export function runWithPrefetchSuspenseShellState<T>(
  state: PrefetchSuspenseShellState,
  fn: () => T,
): T {
  return prefetchSuspenseShellAls.run(state, fn);
}

export function schedulePrefetchSuspenseShellAbort(state: PrefetchSuspenseShellState): () => void {
  if (state.cancelAbort) return state.cancelAbort;
  let innerTimer: ReturnType<typeof setTimeout> | undefined;
  const outerTimer = setTimeout(() => {
    innerTimer = setTimeout(() => {
      state.aborted = true;
      state.reactAbortController.abort();
      if (!state.instant) state.dynamicAbortController.abort();
    }, 0);
  }, 0);

  state.cancelAbort = () => {
    clearTimeout(outerTimer);
    if (innerTimer !== undefined) clearTimeout(innerTimer);
    state.cancelAbort = null;
  };
  return state.cancelAbort;
}

export function wasPrefetchSuspenseShellAborted(state: PrefetchSuspenseShellState): boolean {
  return state.aborted;
}

export function cancelPrefetchSuspenseShellAbort(state: PrefetchSuspenseShellState): void {
  state.cancelAbort?.();
}

export function suspendPrefetchSuspenseShell(expression: string): Promise<never> | null {
  const state = prefetchSuspenseShellAls.getStore();
  if (!state) return null;
  if (state.instant && expression !== "connection()") return null;
  if (state.instant) schedulePrefetchSuspenseShellAbort(state);

  return makeHangingPromise(state.dynamicAbortController.signal, state.route, expression);
}
