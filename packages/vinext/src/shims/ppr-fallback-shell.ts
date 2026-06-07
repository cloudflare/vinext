import { makeHangingPromise } from "./internal/make-hanging-promise.js";
import { getOrCreateAls } from "./internal/als-registry.js";

export type PprFallbackShellState = {
  abortController: AbortController;
  // Incremented on every warmup->final transition so that cache tasks tracked
  // in an earlier phase no longer touch the (reset) `pendingCacheTasks` counter
  // when they settle late.
  cacheEpoch: number;
  cacheReadyResolvers: Array<() => void>;
  fallbackParamNames: ReadonlySet<string>;
  hasDynamicBoundary: boolean;
  isAbortScheduled: boolean;
  pendingAbortCleanup: (() => void) | null;
  pendingCacheReadyCleanup: (() => void) | null;
  pendingCacheTasks: number;
  phase: "warmup" | "final";
  routePattern: string;
};

type CreatePprFallbackShellStateOptions = {
  fallbackParamNames: readonly string[];
  routePattern: string;
};

type PprFallbackShellCacheTask = {
  // The `cacheEpoch` the task was created in. A task that settles in a later
  // epoch (after a warmup->final transition) must not decrement the counter.
  epoch: number;
  isIgnored: boolean;
  isPending: boolean;
};

const pprFallbackShellAls = getOrCreateAls<PprFallbackShellState>("vinext.pprFallbackShell.als");
const pprFallbackShellCacheTaskStackAls = getOrCreateAls<PprFallbackShellCacheTask[]>(
  "vinext.pprFallbackShell.cacheTaskStack.als",
);

function noop(): void {}

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
    !state.hasDynamicBoundary ||
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
      state.pendingCacheTasks === 0 &&
      state.pendingCacheReadyCleanup === null &&
      !state.abortController.signal.aborted
    ) {
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
}

function ignoreCacheTask(state: PprFallbackShellState, task: PprFallbackShellCacheTask): void {
  if (!task.isPending || task.isIgnored) return;
  task.isIgnored = true;
  completeCacheTask(state, task);
}

export function createPprFallbackShellState(
  options: CreatePprFallbackShellStateOptions,
): PprFallbackShellState {
  return {
    abortController: new AbortController(),
    cacheEpoch: 0,
    cacheReadyResolvers: [],
    fallbackParamNames: new Set(options.fallbackParamNames),
    hasDynamicBoundary: false,
    isAbortScheduled: false,
    pendingAbortCleanup: null,
    pendingCacheReadyCleanup: null,
    pendingCacheTasks: 0,
    phase: "warmup",
    routePattern: options.routePattern,
  };
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
  if (state === null || cacheVariant === "private") {
    return fn();
  }

  cancelPendingCacheReady(state);
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
    if (!task.isIgnored) {
      completeCacheTask(state, task);
    }
  });
}

export function createPprFallbackShellSuspensePromiseForState<T>(
  state: PprFallbackShellState,
  expression: string,
): Promise<T> {
  state.hasDynamicBoundary = true;
  for (const task of pprFallbackShellCacheTaskStackAls.getStore() ?? []) {
    ignoreCacheTask(state, task);
  }
  // Re-evaluate cache-ready settling even when there is no in-scope cache task
  // to ignore (e.g. a bare `headers()`/`cookies()` access outside any tracked
  // cache task). `ignoreCacheTask` only drives `scheduleCacheReadyIfSettled`
  // when it actually completes a task, so without this call a dynamic boundary
  // hit with an empty cache-task stack would never re-schedule the warmup
  // `waitForPprFallbackShellCacheReady` settle. The call is a no-op while
  // `pendingCacheTasks > 0`, so in-scope work still holds the shell open.
  scheduleCacheReadyIfSettled(state);
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
  // Bump the epoch so any warmup cache task still in flight no longer
  // decrements the reset counter when it settles.
  state.cacheEpoch++;
  state.cacheReadyResolvers.length = 0;
  state.hasDynamicBoundary = false;
  state.isAbortScheduled = false;
  state.pendingCacheTasks = 0;
  state.phase = "final";
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
