import { describe, expect, it } from "vite-plus/test";
import {
  beginPprFallbackShellFinalRender,
  createPprFallbackShellState,
  createPprFallbackShellSuspensePromise,
  isPprFallbackShellAbortError,
  preparePprFallbackShellFinalRender,
  runWithPprFallbackShellState,
  trackPprFallbackShellCacheTask,
  waitForPprFallbackShellCacheReady,
  waitForPprFallbackShellSettled,
} from "../packages/vinext/src/shims/ppr-fallback-shell.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForCondition(predicate: () => boolean, message: string): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > 200) {
      throw new Error(message);
    }
    await delay(1);
  }
}

describe("ppr fallback shell cache task tracking", () => {
  it("waits for public cache work before marking warmup cache-ready", async () => {
    const state = createPprFallbackShellState({
      fallbackParamNames: ["slug"],
      routePattern: "/:locale/blog/:slug",
    });
    let finishTask!: () => void;
    let isReady = false;

    const tracked = runWithPprFallbackShellState(state, () =>
      trackPprFallbackShellCacheTask(
        () => new Promise<void>((resolve) => (finishTask = resolve)),
        "default",
      ),
    );
    const ready = waitForPprFallbackShellCacheReady(state).then(() => {
      isReady = true;
    });

    await delay(5);
    expect(isReady).toBe(false);
    finishTask();
    await tracked;
    await ready;
    expect(state.pendingCacheTasks).toBe(0);
  });

  it("completes independent child public cache work before cache-ready when parent hits dynamic boundary", async () => {
    const state = createPprFallbackShellState({
      fallbackParamNames: ["slug"],
      routePattern: "/:locale/blog/:slug",
    });
    let childWorkResolve!: () => void;
    const childWork = new Promise<void>((resolve) => {
      childWorkResolve = resolve;
    });
    let childCompleted = false;
    let isReady = false;
    const readyPromise = waitForPprFallbackShellCacheReady(state).then(() => {
      isReady = true;
    });

    runWithPprFallbackShellState(state, () =>
      trackPprFallbackShellCacheTask(async () => {
        trackPprFallbackShellCacheTask(async () => {
          await childWork;
          childCompleted = true;
        }, "default").catch(() => {});

        const suspension = createPprFallbackShellSuspensePromise("headers");
        if (suspension) throw suspension;
      }, "default"),
    ).catch(() => {});

    await delay(5);
    expect(isReady).toBe(false);

    childWorkResolve();
    await readyPromise;

    expect(isReady).toBe(true);
    expect(childCompleted).toBe(true);
    expect(state.pendingCacheTasks).toBe(0);

    state.abortController.abort();
  });

  it("stops waiting for cache tasks that suspend on fallback-shell dynamic work", async () => {
    const state = createPprFallbackShellState({
      fallbackParamNames: ["slug"],
      routePattern: "/:locale/blog/:slug",
    });
    let reachedAfterSuspend = false;

    const tracked = runWithPprFallbackShellState(state, () =>
      trackPprFallbackShellCacheTask(
        () =>
          trackPprFallbackShellCacheTask(async () => {
            const suspension = createPprFallbackShellSuspensePromise<void>("`params`");
            if (suspension) {
              await suspension;
            }
            reachedAfterSuspend = true;
          }, "default"),
        "default",
      ),
    );

    await waitForPprFallbackShellCacheReady(state);
    expect(state.pendingCacheTasks).toBe(0);
    expect(reachedAfterSuspend).toBe(false);

    state.abortController.abort();
    await tracked.catch(() => undefined);
  });
});

describe("ppr fallback shell render lifecycle", () => {
  it("createPprFallbackShellSuspensePromise returns a promise for params expression", () => {
    const state = createPprFallbackShellState({
      fallbackParamNames: ["slug"],
      routePattern: "/:locale/blog/:slug",
    });

    runWithPprFallbackShellState(state, () => {
      const promise = createPprFallbackShellSuspensePromise("params");
      expect(promise).not.toBeNull();
      expect(typeof (promise as Promise<void>)?.then).toBe("function");
      expect(state.hasDynamicBoundary).toBe(true);
    });

    state.abortController.abort();
  });

  it("createPprFallbackShellSuspensePromise returns a promise for headers expression", () => {
    const state = createPprFallbackShellState({
      fallbackParamNames: ["slug"],
      routePattern: "/:locale/blog/:slug",
    });

    runWithPprFallbackShellState(state, () => {
      const promise = createPprFallbackShellSuspensePromise("headers");
      expect(promise).not.toBeNull();
      expect(state.hasDynamicBoundary).toBe(true);
    });

    state.abortController.abort();
  });

  it("createPprFallbackShellSuspensePromise returns a promise for cookies expression", () => {
    const state = createPprFallbackShellState({
      fallbackParamNames: ["slug"],
      routePattern: "/:locale/blog/:slug",
    });

    runWithPprFallbackShellState(state, () => {
      const promise = createPprFallbackShellSuspensePromise("cookies");
      expect(promise).not.toBeNull();
      expect(state.hasDynamicBoundary).toBe(true);
    });

    state.abortController.abort();
  });

  it("createPprFallbackShellSuspensePromise returns null outside shell context", () => {
    const promise = createPprFallbackShellSuspensePromise("params");
    expect(promise).toBeNull();
  });

  it("waitForPprFallbackShellCacheReady resolves immediately in final phase", async () => {
    const state = createPprFallbackShellState({
      fallbackParamNames: ["slug"],
      routePattern: "/:locale/blog/:slug",
    });

    preparePprFallbackShellFinalRender(state);
    expect(state.phase).toBe("final");

    const result = await waitForPprFallbackShellCacheReady(state);
    expect(result).toBeUndefined();
  });

  it("preparePprFallbackShellFinalRender resets state for final render", () => {
    const state = createPprFallbackShellState({
      fallbackParamNames: ["slug"],
      routePattern: "/:locale/blog/:slug",
    });

    state.hasDynamicBoundary = true;
    state.pendingCacheTasks = 3;

    preparePprFallbackShellFinalRender(state);

    expect(state.phase).toBe("final");
    expect(state.hasDynamicBoundary).toBe(false);
    expect(state.isFinalRenderStarted).toBe(false);
    expect(state.pendingCacheTasks).toBe(0);
    expect(state.cacheReadyResolvers.length).toBe(0);
    expect(state.shellReadyResolvers.length).toBe(0);
    expect(state.abortController.signal.aborted).toBe(false);
  });

  it("does not abort the final shell before the React prerender starts", async () => {
    const state = createPprFallbackShellState({
      fallbackParamNames: ["slug"],
      routePattern: "/:locale/blog/:slug",
    });
    preparePprFallbackShellFinalRender(state);

    runWithPprFallbackShellState(state, () => {
      void createPprFallbackShellSuspensePromise("params");
    });

    await waitForCondition(
      () => state.pendingCacheReadyCleanup === null,
      "Timed out waiting for final shell cache-ready scheduling to settle",
    );
    expect(state.reactAbortController.signal.aborted).toBe(false);

    beginPprFallbackShellFinalRender(state);
    await waitForCondition(
      () => state.reactAbortController.signal.aborted,
      "Timed out waiting for final shell abort after React prerender started",
    );
    expect(state.reactAbortController.signal.aborted).toBe(true);
    expect(state.abortController.signal.aborted).toBe(true);
  });

  it("isPprFallbackShellAbortError returns true for DOMException AbortError", () => {
    const error = new DOMException("aborted", "AbortError");
    expect(isPprFallbackShellAbortError(error)).toBe(true);
  });

  it("isPprFallbackShellAbortError returns false for regular errors", () => {
    expect(isPprFallbackShellAbortError(new Error("something else"))).toBe(false);
    expect(isPprFallbackShellAbortError("string error")).toBe(false);
    expect(isPprFallbackShellAbortError(null)).toBe(false);
  });

  it("re-schedules warmup cache-ready when a dynamic boundary has no in-scope cache task", () => {
    const state = createPprFallbackShellState({
      fallbackParamNames: ["slug"],
      routePattern: "/:locale/blog/:slug",
    });

    expect(state.pendingCacheReadyCleanup).toBeNull();

    // A bare `headers()`/`cookies()` access outside any tracked cache task has
    // an empty cache-task stack, so `ignoreCacheTask` completes nothing and
    // cannot drive the settle. The suspense creation itself must re-schedule
    // the warmup cache-ready settle; previously this only happened in the
    // final phase, leaving a warmup waiter un-settled.
    runWithPprFallbackShellState(state, () => {
      void createPprFallbackShellSuspensePromise("headers");
    });

    expect(state.pendingCacheReadyCleanup).not.toBeNull();

    state.abortController.abort();
  });

  it("does not drive pendingCacheTasks negative when a warmup task settles after final transition", async () => {
    const state = createPprFallbackShellState({
      fallbackParamNames: ["slug"],
      routePattern: "/:locale/blog/:slug",
    });

    let finishWarmupTask!: () => void;
    const tracked = runWithPprFallbackShellState(state, () =>
      trackPprFallbackShellCacheTask(
        () => new Promise<void>((resolve) => (finishWarmupTask = resolve)),
        "default",
      ),
    );
    expect(state.pendingCacheTasks).toBe(1);

    // Transition to the final render while the warmup task is still in flight.
    // This resets `pendingCacheTasks` to 0.
    preparePprFallbackShellFinalRender(state);
    expect(state.pendingCacheTasks).toBe(0);

    // The stale warmup task settling must not decrement the reset counter
    // below zero (which would permanently block `waitForPprFallbackShellCacheReady`).
    finishWarmupTask();
    await tracked;
    expect(state.pendingCacheTasks).toBe(0);

    // Final-phase cache-ready still resolves immediately.
    await waitForPprFallbackShellCacheReady(state);

    state.abortController.abort();
  });

  it("multiple suspense promises in the same warmup phase track correctly", async () => {
    const state = createPprFallbackShellState({
      fallbackParamNames: ["slug"],
      routePattern: "/:locale/blog/:slug",
    });
    let isReady = false;

    const ready = waitForPprFallbackShellCacheReady(state).then(() => {
      isReady = true;
    });

    runWithPprFallbackShellState(state, () => {
      const p1 = createPprFallbackShellSuspensePromise("params");
      expect(p1).not.toBeNull();
      const p2 = createPprFallbackShellSuspensePromise("headers");
      expect(p2).not.toBeNull();
    });

    await ready;
    expect(isReady).toBe(true);
    expect(state.pendingCacheTasks).toBe(0);

    state.abortController.abort();
  });

  it("does not settle final static shell before a dynamic boundary is observed", async () => {
    const state = createPprFallbackShellState({
      fallbackParamNames: ["slug"],
      routePattern: "/:locale/blog/:slug",
    });
    preparePprFallbackShellFinalRender(state);
    let isSettled = false;

    const settled = waitForPprFallbackShellSettled(state).then(() => {
      isSettled = true;
    });

    await delay(5);
    expect(isSettled).toBe(false);

    runWithPprFallbackShellState(state, () => {
      void createPprFallbackShellSuspensePromise("connection");
    });

    await settled;
    expect(isSettled).toBe(true);

    state.abortController.abort();
  });

  it("waits for final static shell public cache work after a dynamic boundary", async () => {
    const state = createPprFallbackShellState({
      fallbackParamNames: ["slug"],
      routePattern: "/:locale/blog/:slug",
    });
    preparePprFallbackShellFinalRender(state);
    let finishTask!: () => void;
    let isSettled = false;

    const tracked = runWithPprFallbackShellState(state, () =>
      trackPprFallbackShellCacheTask(
        () => new Promise<void>((resolve) => (finishTask = resolve)),
        "default",
      ),
    );
    const settled = waitForPprFallbackShellSettled(state).then(() => {
      isSettled = true;
    });

    runWithPprFallbackShellState(state, () => {
      void createPprFallbackShellSuspensePromise("connection");
    });

    await delay(5);
    expect(isSettled).toBe(false);

    finishTask();
    await tracked;
    await settled;
    expect(isSettled).toBe(true);
    expect(state.pendingCacheTasks).toBe(0);

    state.abortController.abort();
  });

  it("ignores final static shell private cache work by default", async () => {
    const state = createPprFallbackShellState({
      fallbackParamNames: ["slug"],
      routePattern: "/:locale/blog/:slug",
    });
    preparePprFallbackShellFinalRender(state);
    let finishTask!: () => void;
    let isSettled = false;

    const tracked = runWithPprFallbackShellState(state, () =>
      trackPprFallbackShellCacheTask(
        () => new Promise<void>((resolve) => (finishTask = resolve)),
        "private",
      ),
    );
    const settled = waitForPprFallbackShellSettled(state).then(() => {
      isSettled = true;
    });

    runWithPprFallbackShellState(state, () => {
      void createPprFallbackShellSuspensePromise("connection");
    });

    await settled;
    expect(isSettled).toBe(true);
    expect(state.pendingCacheTasks).toBe(0);

    finishTask();
    await tracked;
    state.abortController.abort();
  });

  it("waits for final static shell private cache work when runtime APIs are included", async () => {
    const state = createPprFallbackShellState({
      fallbackParamNames: ["slug"],
      includePrivateCacheTasks: true,
      routePattern: "/:locale/blog/:slug",
    });
    preparePprFallbackShellFinalRender(state);
    let finishTask!: () => void;
    let isSettled = false;

    const tracked = runWithPprFallbackShellState(state, () =>
      trackPprFallbackShellCacheTask(
        () => new Promise<void>((resolve) => (finishTask = resolve)),
        "private",
      ),
    );
    const settled = waitForPprFallbackShellSettled(state).then(() => {
      isSettled = true;
    });

    runWithPprFallbackShellState(state, () => {
      void createPprFallbackShellSuspensePromise("connection");
    });

    await delay(5);
    expect(isSettled).toBe(false);

    finishTask();
    await tracked;
    await settled;
    expect(isSettled).toBe(true);
    expect(state.pendingCacheTasks).toBe(0);

    state.abortController.abort();
  });
});
