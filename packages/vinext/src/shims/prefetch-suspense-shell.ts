import { getOrCreateAls } from "./internal/als-registry.js";
import { makeHangingPromise } from "./internal/make-hanging-promise.js";

type PrefetchSuspenseShellState = {
  dynamicAbortController: AbortController;
  reactAbortController: AbortController;
  aborted: boolean;
  route: string;
};

const prefetchSuspenseShellAls = getOrCreateAls<PrefetchSuspenseShellState>(
  "vinext.prefetchSuspenseShell.als",
);

export function createPrefetchSuspenseShellState(route: string): PrefetchSuspenseShellState {
  return {
    dynamicAbortController: new AbortController(),
    reactAbortController: new AbortController(),
    aborted: false,
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
  let innerTimer: ReturnType<typeof setTimeout> | undefined;
  const outerTimer = setTimeout(() => {
    innerTimer = setTimeout(() => {
      state.aborted = true;
      state.reactAbortController.abort();
      state.dynamicAbortController.abort();
    }, 0);
  }, 0);

  return () => {
    clearTimeout(outerTimer);
    if (innerTimer !== undefined) clearTimeout(innerTimer);
  };
}

export function wasPrefetchSuspenseShellAborted(state: PrefetchSuspenseShellState): boolean {
  return state.aborted;
}

export function suspendPrefetchSuspenseShell(expression: string): Promise<never> | null {
  const state = prefetchSuspenseShellAls.getStore();
  if (!state) return null;

  return makeHangingPromise(state.dynamicAbortController.signal, state.route, expression);
}
