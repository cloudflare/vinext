import { makeHangingPromise } from "./internal/make-hanging-promise.js";
import { getOrCreateAls } from "./internal/als-registry.js";

export type PartialRscShellState = {
  abortController: AbortController;
  reactAbortController: AbortController;
  // Incremented on every warmup->final transition so that cache tasks tracked
  // in an earlier phase no longer touch the (reset) `pendingCacheTasks` counter
  // when they settle late.
  cacheEpoch: number;
  cacheReadyResolvers: Array<() => void>;
  fallbackParamNames: ReadonlySet<string>;
  hasDynamicBoundary: boolean;
  includePrivateCacheTasks: boolean;
  isFinalRenderStarted: boolean;
  isAbortScheduled: boolean;
  pendingAbortCleanup: (() => void) | null;
  pendingCacheReadyCleanup: (() => void) | null;
  pendingCacheTasks: number;
  phase: "warmup" | "final";
  routePattern: string;
  shellReadyResolvers: Array<() => void>;
};

type CreatePartialRscShellStateOptions = {
  fallbackParamNames: readonly string[];
  includePrivateCacheTasks?: boolean;
  routePattern: string;
};

type PartialRscShellCacheTask = {
  // The `cacheEpoch` the task was created in. A task that settles in a later
  // epoch (after a warmup->final transition) must not decrement the counter.
  epoch: number;
  isIgnored: boolean;
  isPending: boolean;
};

const partialRscShellAls = getOrCreateAls<PartialRscShellState>("vinext.partialRscShell.als");
const partialRscShellCacheTaskStackAls = getOrCreateAls<PartialRscShellCacheTask[]>(
  "vinext.partialRscShell.cacheTaskStack.als",
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

function resolveCacheReadyIfSettled(state: PartialRscShellState): void {
  if (state.pendingCacheTasks !== 0) return;

  const resolvers = state.cacheReadyResolvers.splice(0);
  for (const resolve of resolvers) {
    resolve();
  }
}

function resolveShellReadyIfSettled(state: PartialRscShellState): void {
  if (!state.hasDynamicBoundary || state.pendingCacheTasks !== 0) return;

  const resolvers = state.shellReadyResolvers.splice(0);
  for (const resolve of resolvers) {
    resolve();
  }
}

function cancelPendingCacheReady(state: PartialRscShellState): void {
  if (state.pendingCacheReadyCleanup === null) return;
  state.pendingCacheReadyCleanup();
  state.pendingCacheReadyCleanup = null;
}

function scheduleCacheReadyIfSettled(state: PartialRscShellState): void {
  if (state.pendingCacheTasks !== 0 || state.pendingCacheReadyCleanup !== null) {
    return;
  }

  state.pendingCacheReadyCleanup = scheduleAfterTask(() => {
    state.pendingCacheReadyCleanup = null;
    resolveCacheReadyIfSettled(state);
    resolveShellReadyIfSettled(state);
    if (state.phase === "final") {
      scheduleAbortIfReady(state);
    }
  });
}

function scheduleAbortIfReady(state: PartialRscShellState): void {
  if (
    state.phase !== "final" ||
    !state.isFinalRenderStarted ||
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
      !state.reactAbortController.signal.aborted
    ) {
      state.reactAbortController.abort();
      state.abortController.abort();
    }
  });
}

function completeCacheTask(state: PartialRscShellState, task: PartialRscShellCacheTask): void {
  if (!task.isPending) return;
  task.isPending = false;
  // A task created in an earlier epoch was already accounted for when
  // `preparePartialRscShellFinalRender` reset `pendingCacheTasks` to 0, so a
  // late settle must not decrement the freshly-reset counter below zero (which
  // would permanently block `resolveCacheReadyIfSettled`).
  if (task.epoch !== state.cacheEpoch) return;
  state.pendingCacheTasks--;
  scheduleCacheReadyIfSettled(state);
}

function ignoreCacheTask(state: PartialRscShellState, task: PartialRscShellCacheTask): void {
  if (!task.isPending || task.isIgnored) return;
  task.isIgnored = true;
  completeCacheTask(state, task);
}

export function createPartialRscShellState(
  options: CreatePartialRscShellStateOptions,
): PartialRscShellState {
  const abortController = new AbortController();
  return {
    abortController,
    reactAbortController: abortController,
    cacheEpoch: 0,
    cacheReadyResolvers: [],
    fallbackParamNames: new Set(options.fallbackParamNames),
    hasDynamicBoundary: false,
    includePrivateCacheTasks: options.includePrivateCacheTasks === true,
    isFinalRenderStarted: false,
    isAbortScheduled: false,
    pendingAbortCleanup: null,
    pendingCacheReadyCleanup: null,
    pendingCacheTasks: 0,
    phase: "warmup",
    routePattern: options.routePattern,
    shellReadyResolvers: [],
  };
}

export function runWithPartialRscShellState<T>(state: PartialRscShellState, fn: () => T): T {
  return partialRscShellAls.run(state, fn);
}

export function getPartialRscShellState(): PartialRscShellState | null {
  return partialRscShellAls.getStore() ?? null;
}

export function trackPartialRscShellCacheTask<T>(
  fn: () => Promise<T>,
  cacheVariant: string,
): Promise<T> {
  const state = getPartialRscShellState();
  if (state === null || (cacheVariant === "private" && !state.includePrivateCacheTasks)) {
    return fn();
  }

  cancelPendingCacheReady(state);
  state.pendingCacheTasks++;
  const task: PartialRscShellCacheTask = {
    epoch: state.cacheEpoch,
    isIgnored: false,
    isPending: true,
  };
  const parentStack = partialRscShellCacheTaskStackAls.getStore() ?? [];
  let promise: Promise<T>;
  try {
    promise = partialRscShellCacheTaskStackAls.run([...parentStack, task], fn);
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

export function createPartialRscShellSuspensePromiseForState<T>(
  state: PartialRscShellState,
  expression: string,
): Promise<T> {
  markPartialRscShellDynamicBoundaryForState(state);
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

function markPartialRscShellDynamicBoundaryForState(state: PartialRscShellState): void {
  state.hasDynamicBoundary = true;
  for (const task of partialRscShellCacheTaskStackAls.getStore() ?? []) {
    ignoreCacheTask(state, task);
  }
  // Re-evaluate cache-ready settling even when there is no in-scope cache task
  // to ignore (e.g. a bare `headers()`/`cookies()` access outside any tracked
  // cache task). `ignoreCacheTask` only drives `scheduleCacheReadyIfSettled`
  // when it actually completes a task, so without this call a dynamic boundary
  // hit with an empty cache-task stack would never re-schedule the warmup
  // `waitForPartialRscShellCacheReady` settle. The call is a no-op while
  // `pendingCacheTasks > 0`, so in-scope work still holds the shell open.
  scheduleCacheReadyIfSettled(state);
}

export function markPartialRscShellDynamicBoundary(): void {
  const state = getPartialRscShellState();
  if (state === null || state.fallbackParamNames.size === 0) return;
  markPartialRscShellDynamicBoundaryForState(state);
}

export function createPartialRscShellSuspensePromise<T>(expression: string): Promise<T> | null {
  const state = getPartialRscShellState();
  if (state === null) return null;
  return createPartialRscShellSuspensePromiseForState<T>(state, expression);
}

export function waitForPartialRscShellCacheReady(state: PartialRscShellState): Promise<void> {
  if (state.phase !== "warmup") {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    state.cacheReadyResolvers.push(resolve);
    scheduleCacheReadyIfSettled(state);
  });
}

export function waitForPartialRscShellSettled(state: PartialRscShellState): Promise<void> {
  return new Promise((resolve) => {
    state.shellReadyResolvers.push(resolve);
    scheduleCacheReadyIfSettled(state);
  });
}

export function preparePartialRscShellFinalRender(state: PartialRscShellState): void {
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
  state.isFinalRenderStarted = false;
  state.isAbortScheduled = false;
  state.pendingCacheTasks = 0;
  state.phase = "final";
  state.shellReadyResolvers.length = 0;
}

export function beginPartialRscShellFinalRender(state: PartialRscShellState): void {
  if (state.phase !== "final") return;
  state.isFinalRenderStarted = true;
  scheduleAbortIfReady(state);
}

export function isPartialRscShellAbortError(error: unknown): boolean {
  if (
    typeof DOMException !== "undefined" &&
    error instanceof DOMException &&
    error.name === "AbortError"
  ) {
    return true;
  }
  return error instanceof Error && error.name === "HangingPromiseRejectionError";
}
