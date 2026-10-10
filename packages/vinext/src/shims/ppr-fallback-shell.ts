import {
  beginPartialRscShellFinalRender,
  createPartialRscShellState,
  createPartialRscShellSuspensePromise,
  createPartialRscShellSuspensePromiseForState,
  getPartialRscShellState,
  isPartialRscShellAbortError,
  markPartialRscShellDynamicBoundary,
  preparePartialRscShellFinalRender,
  runWithPartialRscShellState,
  trackPartialRscShellCacheTask,
  waitForPartialRscShellCacheReady,
  waitForPartialRscShellSettled,
  type PartialRscShellState,
} from "./partial-rsc-shell.js";

export type PprFallbackShellState = PartialRscShellState & {
  fallbackParamNames: ReadonlySet<string>;
};

type CreatePprFallbackShellStateOptions = {
  fallbackParamNames: readonly string[];
  includePrivateCacheTasks?: boolean;
  routePattern: string;
};

function isPprFallbackShellState(state: PartialRscShellState): state is PprFallbackShellState {
  return "fallbackParamNames" in state;
}

export function createPprFallbackShellState(
  options: CreatePprFallbackShellStateOptions,
): PprFallbackShellState {
  return {
    ...createPartialRscShellState({
      includePrivateCacheTasks: options.includePrivateCacheTasks,
      routePattern: options.routePattern,
    }),
    fallbackParamNames: new Set(options.fallbackParamNames),
  };
}

export const runWithPprFallbackShellState = runWithPartialRscShellState;

export function getPprFallbackShellState(): PprFallbackShellState | null {
  const state = getPartialRscShellState();
  if (state === null || !isPprFallbackShellState(state)) return null;
  return state;
}

export const trackPprFallbackShellCacheTask = trackPartialRscShellCacheTask;
export const createPprFallbackShellSuspensePromiseForState =
  createPartialRscShellSuspensePromiseForState;

export function markPprFallbackShellDynamicBoundary(): void {
  const state = getPprFallbackShellState();
  if (state === null || state.fallbackParamNames.size === 0) return;
  markPartialRscShellDynamicBoundary();
}

export const createPprFallbackShellSuspensePromise = createPartialRscShellSuspensePromise;
export const waitForPprFallbackShellCacheReady = waitForPartialRscShellCacheReady;
export const waitForPprFallbackShellSettled = waitForPartialRscShellSettled;
export const preparePprFallbackShellFinalRender = preparePartialRscShellFinalRender;
export const beginPprFallbackShellFinalRender = beginPartialRscShellFinalRender;
export const isPprFallbackShellAbortError = isPartialRscShellAbortError;
