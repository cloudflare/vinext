import { makeHangingPromise } from "./internal/make-hanging-promise.js";
import { getOrCreateAls } from "./internal/als-registry.js";
import { isPromiseLike } from "../utils/promise.js";

export type PprFallbackShellState = {
  abortController: AbortController;
  cachedNavigationStage: "navigation" | "runtime" | "static" | null;
  cachedNavigationDynamicPromise: Promise<void> | null;
  cachedNavigationDynamicResolvers: Array<() => void>;
  cachedNavigationRuntimeStage: CachedNavigationRuntimeWireStage | null;
  cachedNavigationStaticStagePromise: Promise<CachedNavigationStaticWireStage> | null;
  cachedNavigationStaticStageResolve: ((stage: CachedNavigationStaticWireStage) => void) | null;
  cachedNavigationRuntimeReadyCleanup: (() => void) | null;
  cachedNavigationRuntimeReadyResolvers: Array<() => void>;
  reactAbortController: AbortController;
  // Incremented on every warmup->final transition so that cache tasks tracked
  // in an earlier phase no longer touch the (reset) `pendingCacheTasks` counter
  // when they settle late.
  cacheEpoch: number;
  cacheReadyResolvers: Array<() => void>;
  fallbackParamNames: ReadonlySet<string>;
  hasDynamicBoundary: boolean;
  hasRuntimeEligibleComponent: boolean;
  isFinalRenderStarted: boolean;
  isAbortScheduled: boolean;
  pendingAbortCleanup: (() => void) | null;
  pendingCacheReadyCleanup: (() => void) | null;
  pendingCacheTasks: number;
  pendingRuntimeDiscoveryScopes: number;
  phase: "warmup" | "final";
  routePattern: string;
  requestApiStage: "runtime" | "static";
};

type CreatePprFallbackShellStateOptions = {
  cachedNavigationStage?: "navigation" | "runtime" | "static" | null;
  fallbackParamNames: readonly string[];
  requestApiStage?: "runtime" | "static";
  routePattern: string;
};

export type CachedNavigationStaticWireStage = Readonly<{
  byteLength: number;
  partial: boolean;
  staleTimeSeconds?: number;
}>;

export type CachedNavigationRuntimeWireStage = Readonly<{
  partial: Promise<boolean>;
  readable: ReadableStream<Uint8Array>;
  resolvePartial: (partial: boolean) => void;
  staleTimeSeconds: Promise<number | undefined>;
  resolveStaleTimeSeconds: (seconds: number | undefined) => void;
  writable: WritableStream<Uint8Array>;
}>;

export type CachedNavigationWireData = Readonly<{
  runtimeStage: Pick<
    CachedNavigationRuntimeWireStage,
    "partial" | "readable" | "staleTimeSeconds"
  > | null;
  staticStage: Promise<CachedNavigationStaticWireStage>;
}>;

type PprFallbackShellCacheTask = {
  // The `cacheEpoch` the task was created in. A task that settles in a later
  // epoch (after a warmup->final transition) must not decrement the counter.
  epoch: number;
  isIgnored: boolean;
  isPending: boolean;
};

type PprFallbackShellRuntimeDiscoveryScope = {
  epoch: number;
  isIgnored: boolean;
  isPending: boolean;
};

const pprFallbackShellAls = getOrCreateAls<PprFallbackShellState>("vinext.pprFallbackShell.als");
const pprFallbackShellCacheTaskStackAls = getOrCreateAls<PprFallbackShellCacheTask[]>(
  "vinext.pprFallbackShell.cacheTaskStack.als",
);
const pprFallbackShellRuntimeDiscoveryStackAls = getOrCreateAls<
  PprFallbackShellRuntimeDiscoveryScope[]
>("vinext.pprFallbackShell.runtimeDiscoveryStack.als");

function noop(): void {}

function scheduleAfterTask(callback: () => void, quietPeriodMs = 0): () => void {
  let firstTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    firstTimer = null;
    secondTimer = setTimeout(() => {
      secondTimer = null;
      callback();
    }, quietPeriodMs);
  }, 0);
  let secondTimer: ReturnType<typeof setTimeout> | null = null;

  return () => {
    if (firstTimer !== null) {
      clearTimeout(firstTimer);
      firstTimer = null;
    }
    if (secondTimer !== null) {
      clearTimeout(secondTimer);
      secondTimer = null;
    }
  };
}

function resolveCacheReadyIfSettled(state: PprFallbackShellState): void {
  if (state.pendingCacheTasks !== 0) return;

  const resolvers = state.cacheReadyResolvers.splice(0);
  for (const resolve of resolvers) {
    resolve();
  }
}

function cancelPendingCacheReady(state: PprFallbackShellState): void {
  if (state.pendingCacheReadyCleanup === null) return;
  state.pendingCacheReadyCleanup();
  state.pendingCacheReadyCleanup = null;
}

function cancelPendingCachedNavigationRuntimeReady(state: PprFallbackShellState): void {
  if (state.cachedNavigationRuntimeReadyCleanup === null) return;
  state.cachedNavigationRuntimeReadyCleanup();
  state.cachedNavigationRuntimeReadyCleanup = null;
}

function scheduleCachedNavigationRuntimeReadyIfSettled(state: PprFallbackShellState): void {
  if (
    state.cachedNavigationStage !== "navigation" ||
    state.pendingCacheTasks !== 0 ||
    state.pendingRuntimeDiscoveryScopes !== 0 ||
    state.cachedNavigationRuntimeReadyCleanup !== null
  ) {
    return;
  }
  state.cachedNavigationRuntimeReadyCleanup = scheduleAfterTask(() => {
    state.cachedNavigationRuntimeReadyCleanup = null;
    if (state.pendingCacheTasks !== 0 || state.pendingRuntimeDiscoveryScopes !== 0) return;
    for (const resolve of state.cachedNavigationRuntimeReadyResolvers.splice(0)) resolve();
  });
}

function scheduleCacheReadyIfSettled(state: PprFallbackShellState): void {
  if (state.pendingCacheTasks !== 0 || state.pendingCacheReadyCleanup !== null) {
    return;
  }

  state.pendingCacheReadyCleanup = scheduleAfterTask(() => {
    state.pendingCacheReadyCleanup = null;
    resolveCacheReadyIfSettled(state);
    if (state.phase === "final") {
      scheduleAbortIfReady(state);
    }
  });
}

function scheduleAbortIfReady(state: PprFallbackShellState): void {
  if (
    state.phase !== "final" ||
    !state.isFinalRenderStarted ||
    !state.hasDynamicBoundary ||
    (state.cachedNavigationStage === "runtime" &&
      (!state.hasRuntimeEligibleComponent || state.pendingRuntimeDiscoveryScopes > 0)) ||
    state.pendingCacheTasks > 0 ||
    state.pendingCacheReadyCleanup !== null ||
    state.isAbortScheduled
  ) {
    return;
  }

  state.isAbortScheduled = true;
  state.pendingAbortCleanup = scheduleAfterTask(() => {
    state.pendingAbortCleanup = null;
    state.isAbortScheduled = false;
    if (
      state.phase === "final" &&
      state.hasDynamicBoundary &&
      (state.cachedNavigationStage !== "runtime" ||
        (state.hasRuntimeEligibleComponent && state.pendingRuntimeDiscoveryScopes === 0)) &&
      state.pendingCacheTasks === 0 &&
      state.pendingCacheReadyCleanup === null &&
      !state.reactAbortController.signal.aborted
    ) {
      state.reactAbortController.abort();
      state.abortController.abort();
    }
  });
}

function completeCacheTask(state: PprFallbackShellState, task: PprFallbackShellCacheTask): void {
  if (!task.isPending) return;
  task.isPending = false;
  // A task created in an earlier epoch was already accounted for when
  // `preparePprFallbackShellFinalRender` reset `pendingCacheTasks` to 0, so a
  // late settle must not decrement the freshly-reset counter below zero (which
  // would permanently block `resolveCacheReadyIfSettled`).
  if (task.epoch !== state.cacheEpoch) return;
  state.pendingCacheTasks--;
  scheduleCacheReadyIfSettled(state);
  scheduleCachedNavigationRuntimeReadyIfSettled(state);
}

function ignoreCacheTask(state: PprFallbackShellState, task: PprFallbackShellCacheTask): void {
  if (!task.isPending || task.isIgnored) return;
  task.isIgnored = true;
  completeCacheTask(state, task);
}

function completeRuntimeDiscoveryScope(
  state: PprFallbackShellState,
  scope: PprFallbackShellRuntimeDiscoveryScope,
): void {
  if (!scope.isPending) return;
  scope.isPending = false;
  if (scope.epoch !== state.cacheEpoch) return;
  state.pendingRuntimeDiscoveryScopes--;
  scheduleAbortIfReady(state);
  scheduleCachedNavigationRuntimeReadyIfSettled(state);
}

function ignoreRuntimeDiscoveryScope(
  state: PprFallbackShellState,
  scope: PprFallbackShellRuntimeDiscoveryScope,
): void {
  if (!scope.isPending || scope.isIgnored) return;
  scope.isIgnored = true;
  completeRuntimeDiscoveryScope(state, scope);
}

export function createPprFallbackShellState(
  options: CreatePprFallbackShellStateOptions,
): PprFallbackShellState {
  const abortController = new AbortController();
  let resolveStaticStage: ((stage: CachedNavigationStaticWireStage) => void) | null = null;
  const staticStagePromise =
    options.cachedNavigationStage === "navigation"
      ? new Promise<CachedNavigationStaticWireStage>((resolve) => {
          resolveStaticStage = resolve;
        })
      : null;
  let resolveDynamic!: () => void;
  const dynamicPromise =
    options.cachedNavigationStage === "navigation"
      ? new Promise<void>((resolve) => {
          resolveDynamic = resolve;
        })
      : null;
  return {
    abortController,
    cachedNavigationStage: options.cachedNavigationStage ?? null,
    cachedNavigationDynamicPromise: dynamicPromise,
    cachedNavigationDynamicResolvers: resolveDynamic ? [resolveDynamic] : [],
    cachedNavigationRuntimeStage: null,
    cachedNavigationRuntimeReadyCleanup: null,
    cachedNavigationRuntimeReadyResolvers: [],
    cachedNavigationStaticStagePromise: staticStagePromise,
    cachedNavigationStaticStageResolve: resolveStaticStage,
    reactAbortController: abortController,
    cacheEpoch: 0,
    cacheReadyResolvers: [],
    fallbackParamNames: new Set(options.fallbackParamNames),
    hasDynamicBoundary: false,
    hasRuntimeEligibleComponent: false,
    isFinalRenderStarted: false,
    isAbortScheduled: false,
    pendingAbortCleanup: null,
    pendingCacheReadyCleanup: null,
    pendingCacheTasks: 0,
    pendingRuntimeDiscoveryScopes: 0,
    phase: "warmup",
    routePattern: options.routePattern,
    requestApiStage: options.requestApiStage ?? "static",
  };
}

export function shouldPprFallbackShellSuspendRequestApi(
  api: "connection" | "cookies" | "fetch" | "headers" | "searchParams",
): boolean {
  const state = getPprFallbackShellState();
  if (state === null) return false;
  return api === "connection" || state.requestApiStage === "static";
}

export function delayPprFallbackShellRequestApi<T>(
  api: "connection" | "cookies" | "fetch" | "headers" | "searchParams",
  expression: string,
  resolveValue: () => T | PromiseLike<T>,
): Promise<T> | null {
  const state = getPprFallbackShellState();
  if (state?.cachedNavigationStage === "navigation") {
    return delayCachedNavigationValueForState(state, resolveValue);
  }
  if (!shouldPprFallbackShellSuspendRequestApi(api)) return null;
  return createPprFallbackShellSuspensePromiseForState<T>(state!, expression);
}

export function delayCachedNavigationValueForState<T>(
  state: PprFallbackShellState,
  resolveValue: () => T | PromiseLike<T>,
): Promise<T> {
  markPprFallbackShellDynamicBoundaryForState(state);
  return (state.cachedNavigationDynamicPromise ?? Promise.resolve()).then(resolveValue);
}

export function delayCachedNavigationValue<T>(
  resolveValue: () => T | PromiseLike<T>,
): Promise<T> | null {
  const state = getPprFallbackShellState();
  return state?.cachedNavigationStage === "navigation"
    ? delayCachedNavigationValueForState(state, resolveValue)
    : null;
}

export function enableCachedNavigationRuntimeStage(): void {
  const state = getPprFallbackShellState();
  if (state?.cachedNavigationStage !== "navigation" || state.cachedNavigationRuntimeStage) return;
  const stream = new TransformStream<Uint8Array>();
  let resolvePartial!: (partial: boolean) => void;
  let resolveStaleTimeSeconds!: (seconds: number | undefined) => void;
  state.cachedNavigationRuntimeStage = {
    partial: new Promise<boolean>((resolve) => (resolvePartial = resolve)),
    readable: stream.readable,
    resolvePartial,
    staleTimeSeconds: new Promise<number | undefined>(
      (resolve) => (resolveStaleTimeSeconds = resolve),
    ),
    resolveStaleTimeSeconds,
    writable: stream.writable,
  };
}

export function getCachedNavigationWireData(): CachedNavigationWireData | null {
  const state = getPprFallbackShellState();
  if (
    state?.cachedNavigationStage !== "navigation" ||
    state.cachedNavigationStaticStagePromise === null
  ) {
    return null;
  }
  return {
    runtimeStage: state.cachedNavigationRuntimeStage
      ? {
          partial: state.cachedNavigationRuntimeStage.partial,
          readable: state.cachedNavigationRuntimeStage.readable,
          staleTimeSeconds: state.cachedNavigationRuntimeStage.staleTimeSeconds,
        }
      : null,
    staticStage: state.cachedNavigationStaticStagePromise,
  };
}

export function advanceCachedNavigationToDynamicStage(state: PprFallbackShellState): boolean {
  if (state.cachedNavigationStage !== "navigation") return state.hasDynamicBoundary;
  for (const resolve of state.cachedNavigationDynamicResolvers.splice(0)) resolve();
  return state.hasDynamicBoundary;
}

export function resolveCachedNavigationStaticStage(
  state: PprFallbackShellState,
  stage: CachedNavigationStaticWireStage,
): void {
  const resolve = state.cachedNavigationStaticStageResolve;
  state.cachedNavigationStaticStageResolve = null;
  resolve?.(stage);
}

export function prepareCachedNavigationRuntimeRender(
  state: PprFallbackShellState,
): PprFallbackShellState {
  const runtimeState = createPprFallbackShellState({
    cachedNavigationStage: "runtime",
    fallbackParamNames: [...state.fallbackParamNames],
    requestApiStage: "runtime",
    routePattern: state.routePattern,
  });
  preparePprFallbackShellFinalRender(runtimeState);
  return runtimeState;
}

export function waitForCachedNavigationRuntimeReady(state: PprFallbackShellState): Promise<void> {
  if (state.cachedNavigationStage !== "navigation") return Promise.resolve();
  return new Promise((resolve) => {
    state.cachedNavigationRuntimeReadyResolvers.push(resolve);
    scheduleCachedNavigationRuntimeReadyIfSettled(state);
  });
}

export function runWithPprFallbackShellState<T>(state: PprFallbackShellState, fn: () => T): T {
  return pprFallbackShellAls.run(state, fn);
}

export function getPprFallbackShellState(): PprFallbackShellState | null {
  return pprFallbackShellAls.getStore() ?? null;
}

export function trackPprFallbackShellCacheTask<T>(
  fn: () => Promise<T>,
  cacheVariant: string,
): Promise<T> {
  const state = getPprFallbackShellState();
  if (state === null) {
    return fn();
  }
  const startTrackedTask = (): Promise<T> => {
    cancelPendingCacheReady(state);
    cancelPendingCachedNavigationRuntimeReady(state);
    state.pendingCacheTasks++;
    const task: PprFallbackShellCacheTask = {
      epoch: state.cacheEpoch,
      isIgnored: false,
      isPending: true,
    };
    const parentStack = pprFallbackShellCacheTaskStackAls.getStore() ?? [];
    let promise: Promise<T>;
    try {
      promise = pprFallbackShellCacheTaskStackAls.run([...parentStack, task], fn);
    } catch (error) {
      completeCacheTask(state, task);
      return Promise.reject(error);
    }

    return promise.finally(() => {
      if (!task.isIgnored) completeCacheTask(state, task);
    });
  };
  if (state.cachedNavigationStage === "navigation" && cacheVariant === "private") {
    return (state.cachedNavigationDynamicPromise ?? Promise.resolve()).then(startTrackedTask);
  }
  if (cacheVariant === "private" && state.requestApiStage === "static") {
    return createPprFallbackShellSuspensePromiseForState<T>(state, '"use cache: private"');
  }

  return startTrackedTask();
}

export function createPprFallbackShellSuspensePromiseForState<T>(
  state: PprFallbackShellState,
  expression: string,
): Promise<T> {
  markPprFallbackShellDynamicBoundaryForState(state);
  if (state.phase === "final") {
    scheduleAbortIfReady(state);
  }
  const promise = makeHangingPromise<T>(
    state.abortController.signal,
    state.routePattern,
    expression,
  );
  promise.catch(noop);
  return promise;
}

function markPprFallbackShellDynamicBoundaryForState(state: PprFallbackShellState): void {
  state.hasDynamicBoundary = true;
  for (const task of pprFallbackShellCacheTaskStackAls.getStore() ?? []) {
    ignoreCacheTask(state, task);
  }
  // An opted async component can legitimately reach a private cache and then
  // await connection(). The connection boundary only settles when this render
  // aborts, so keeping the component's discovery scope pending until promise
  // settlement would deadlock the abort gate. Once the branch itself reaches a
  // dynamic boundary, it has completed discovery for this stage.
  if (state.cachedNavigationStage === "runtime") {
    for (const scope of pprFallbackShellRuntimeDiscoveryStackAls.getStore() ?? []) {
      ignoreRuntimeDiscoveryScope(state, scope);
    }
  }
  // Re-evaluate cache-ready settling even when there is no in-scope cache task
  // to ignore (e.g. a bare `headers()`/`cookies()` access outside any tracked
  // cache task). `ignoreCacheTask` only drives `scheduleCacheReadyIfSettled`
  // when it actually completes a task, so without this call a dynamic boundary
  // hit with an empty cache-task stack would never re-schedule the warmup
  // `waitForPprFallbackShellCacheReady` settle. The call is a no-op while
  // `pendingCacheTasks > 0`, so in-scope work still holds the shell open.
  scheduleCacheReadyIfSettled(state);
  scheduleCachedNavigationRuntimeReadyIfSettled(state);
}

export function markPprFallbackShellDynamicBoundary(): void {
  const state = getPprFallbackShellState();
  if (state === null || state.fallbackParamNames.size === 0) return;
  markPprFallbackShellDynamicBoundaryForState(state);
}

export function markPprFallbackShellOmittedBoundary(): void {
  const state = getPprFallbackShellState();
  if (state === null) return;
  markPprFallbackShellDynamicBoundaryForState(state);
}

export function markPprFallbackShellRuntimeEligibleComponent(): void {
  const state = getPprFallbackShellState();
  if (
    state === null ||
    (state.cachedNavigationStage !== "runtime" && state.cachedNavigationStage !== "navigation")
  ) {
    return;
  }
  state.hasRuntimeEligibleComponent = true;
  if (state.phase === "final") {
    scheduleAbortIfReady(state);
  }
}

export function runWithPprFallbackShellRuntimeDiscovery<T>(fn: () => T): T {
  const state = getPprFallbackShellState();
  if (
    state === null ||
    (state.cachedNavigationStage !== "runtime" && state.cachedNavigationStage !== "navigation")
  ) {
    return fn();
  }

  const scope: PprFallbackShellRuntimeDiscoveryScope = {
    epoch: state.cacheEpoch,
    isIgnored: false,
    isPending: true,
  };
  cancelPendingCachedNavigationRuntimeReady(state);
  state.pendingRuntimeDiscoveryScopes++;
  const parentStack = pprFallbackShellRuntimeDiscoveryStackAls.getStore() ?? [];

  try {
    const result = pprFallbackShellRuntimeDiscoveryStackAls.run([...parentStack, scope], fn);
    if (!isPromiseLike(result)) {
      completeRuntimeDiscoveryScope(state, scope);
      return result;
    }
    void Promise.resolve(result).then(
      () => completeRuntimeDiscoveryScope(state, scope),
      () => completeRuntimeDiscoveryScope(state, scope),
    );
    return result;
  } catch (error) {
    if (isPromiseLike(error)) {
      void Promise.resolve(error).then(
        () => completeRuntimeDiscoveryScope(state, scope),
        () => completeRuntimeDiscoveryScope(state, scope),
      );
    } else {
      completeRuntimeDiscoveryScope(state, scope);
    }
    throw error;
  }
}

export function createPprFallbackShellSuspensePromise<T>(expression: string): Promise<T> | null {
  const state = getPprFallbackShellState();
  if (state === null) return null;
  return createPprFallbackShellSuspensePromiseForState<T>(state, expression);
}

export function waitForPprFallbackShellCacheReady(state: PprFallbackShellState): Promise<void> {
  if (state.phase !== "warmup") {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    state.cacheReadyResolvers.push(resolve);
    scheduleCacheReadyIfSettled(state);
  });
}

export function preparePprFallbackShellFinalRender(state: PprFallbackShellState): void {
  cancelPendingCacheReady(state);
  if (state.pendingAbortCleanup !== null) {
    state.pendingAbortCleanup();
    state.pendingAbortCleanup = null;
  }
  state.abortController = new AbortController();
  state.reactAbortController = new AbortController();
  // Bump the epoch so any warmup cache task still in flight no longer
  // decrements the reset counter when it settles.
  state.cacheEpoch++;
  state.cacheReadyResolvers.length = 0;
  state.hasDynamicBoundary = false;
  state.hasRuntimeEligibleComponent = false;
  state.isFinalRenderStarted = false;
  state.isAbortScheduled = false;
  state.pendingCacheTasks = 0;
  state.pendingRuntimeDiscoveryScopes = 0;
  state.phase = "final";
}

export function beginPprFallbackShellFinalRender(state: PprFallbackShellState): void {
  if (state.phase !== "final") return;
  state.isFinalRenderStarted = true;
  scheduleAbortIfReady(state);
}

export function isPprFallbackShellAbortError(error: unknown): boolean {
  if (
    typeof DOMException !== "undefined" &&
    error instanceof DOMException &&
    error.name === "AbortError"
  ) {
    return true;
  }
  return error instanceof Error && error.name === "HangingPromiseRejectionError";
}
