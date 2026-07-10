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

export type PprFallbackShellState = PartialRscShellState;

export const createPprFallbackShellState = createPartialRscShellState;
export const runWithPprFallbackShellState = runWithPartialRscShellState;
export const getPprFallbackShellState = getPartialRscShellState;
export const trackPprFallbackShellCacheTask = trackPartialRscShellCacheTask;
export const createPprFallbackShellSuspensePromiseForState =
  createPartialRscShellSuspensePromiseForState;
export const markPprFallbackShellDynamicBoundary = markPartialRscShellDynamicBoundary;
export const createPprFallbackShellSuspensePromise = createPartialRscShellSuspensePromise;
export const waitForPprFallbackShellCacheReady = waitForPartialRscShellCacheReady;
export const waitForPprFallbackShellSettled = waitForPartialRscShellSettled;
export const preparePprFallbackShellFinalRender = preparePartialRscShellFinalRender;
export const beginPprFallbackShellFinalRender = beginPartialRscShellFinalRender;
export const isPprFallbackShellAbortError = isPartialRscShellAbortError;
