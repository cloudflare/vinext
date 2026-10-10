import { describe, expect, it } from "vite-plus/test";
import {
  beginPartialRscShellFinalRender,
  createPartialRscShellState,
  createPartialRscShellSuspensePromise,
  isPartialRscShellAbortError,
  markPartialRscShellDynamicBoundary,
  preparePartialRscShellFinalRender,
  runWithPartialRscShellState,
  trackPartialRscShellCacheTask,
  waitForPartialRscShellCacheReady,
  waitForPartialRscShellSettled,
} from "../packages/vinext/src/shims/partial-rsc-shell.js";

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

function createTestPartialShellState(options?: { includePrivateCacheTasks?: boolean }) {
  return createPartialRscShellState({
    includePrivateCacheTasks: options?.includePrivateCacheTasks,
    routePattern: "/:locale/blog/:slug",
  });
}

describe("partial RSC shell cache task tracking", () => {
  it("waits for public cache work before marking warmup cache-ready", async () => {
    const state = createTestPartialShellState();
    let finishTask!: () => void;
    let isReady = false;

    const tracked = runWithPartialRscShellState(state, () =>
      trackPartialRscShellCacheTask(
        () => new Promise<void>((resolve) => (finishTask = resolve)),
        "default",
      ),
    );
    const ready = waitForPartialRscShellCacheReady(state).then(() => {
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
    const state = createTestPartialShellState();
    let childWorkResolve!: () => void;
    const childWork = new Promise<void>((resolve) => {
      childWorkResolve = resolve;
    });
    let childCompleted = false;
    let isReady = false;
    const readyPromise = waitForPartialRscShellCacheReady(state).then(() => {
      isReady = true;
    });

    runWithPartialRscShellState(state, () =>
      trackPartialRscShellCacheTask(async () => {
        trackPartialRscShellCacheTask(async () => {
          await childWork;
          childCompleted = true;
        }, "default").catch(() => {});

        const suspension = createPartialRscShellSuspensePromise("headers");
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

  it("stops waiting for cache tasks that suspend on partial-shell dynamic work", async () => {
    const state = createTestPartialShellState();
    let reachedAfterSuspend = false;

    const tracked = runWithPartialRscShellState(state, () =>
      trackPartialRscShellCacheTask(
        () =>
          trackPartialRscShellCacheTask(async () => {
            const suspension = createPartialRscShellSuspensePromise<void>("`params`");
            if (suspension) {
              await suspension;
            }
            reachedAfterSuspend = true;
          }, "default"),
        "default",
      ),
    );

    await waitForPartialRscShellCacheReady(state);
    expect(state.pendingCacheTasks).toBe(0);
    expect(reachedAfterSuspend).toBe(false);

    state.abortController.abort();
    await tracked.catch(() => undefined);
  });
});

describe("partial RSC shell render lifecycle", () => {
  it("createPartialRscShellSuspensePromise returns a promise for params expression", () => {
    const state = createTestPartialShellState();

    runWithPartialRscShellState(state, () => {
      const promise = createPartialRscShellSuspensePromise("params");
      expect(promise).not.toBeNull();
      expect(typeof (promise as Promise<void>)?.then).toBe("function");
      expect(state.hasDynamicBoundary).toBe(true);
    });

    state.abortController.abort();
  });

  it("createPartialRscShellSuspensePromise returns a promise for headers expression", () => {
    const state = createTestPartialShellState();

    runWithPartialRscShellState(state, () => {
      const promise = createPartialRscShellSuspensePromise("headers");
      expect(promise).not.toBeNull();
      expect(state.hasDynamicBoundary).toBe(true);
    });

    state.abortController.abort();
  });

  it("createPartialRscShellSuspensePromise returns a promise for cookies expression", () => {
    const state = createTestPartialShellState();

    runWithPartialRscShellState(state, () => {
      const promise = createPartialRscShellSuspensePromise("cookies");
      expect(promise).not.toBeNull();
      expect(state.hasDynamicBoundary).toBe(true);
    });

    state.abortController.abort();
  });

  it("createPartialRscShellSuspensePromise returns null outside shell context", () => {
    const promise = createPartialRscShellSuspensePromise("params");
    expect(promise).toBeNull();
  });

  it("markPartialRscShellDynamicBoundary marks whenever partial shell state exists", () => {
    const state = createTestPartialShellState();

    runWithPartialRscShellState(state, () => {
      markPartialRscShellDynamicBoundary();
    });

    expect(state.hasDynamicBoundary).toBe(true);
    expect(state.pendingCacheReadyCleanup).not.toBeNull();
  });

  it("waitForPartialRscShellCacheReady resolves immediately in final phase", async () => {
    const state = createTestPartialShellState();

    preparePartialRscShellFinalRender(state);
    expect(state.phase).toBe("final");

    const result = await waitForPartialRscShellCacheReady(state);
    expect(result).toBeUndefined();
  });

  it("preparePartialRscShellFinalRender resets state for final render", () => {
    const state = createTestPartialShellState();

    state.hasDynamicBoundary = true;
    state.pendingCacheTasks = 3;

    preparePartialRscShellFinalRender(state);

    expect(state.phase).toBe("final");
    expect(state.hasDynamicBoundary).toBe(false);
    expect(state.isFinalRenderStarted).toBe(false);
    expect(state.pendingCacheTasks).toBe(0);
    expect(state.cacheReadyResolvers.length).toBe(0);
    expect(state.shellReadyResolvers.length).toBe(0);
    expect(state.abortController.signal.aborted).toBe(false);
  });

  it("does not abort the final shell before the React prerender starts", async () => {
    const state = createTestPartialShellState();
    preparePartialRscShellFinalRender(state);

    runWithPartialRscShellState(state, () => {
      void createPartialRscShellSuspensePromise("params");
    });

    await waitForCondition(
      () => state.pendingCacheReadyCleanup === null,
      "Timed out waiting for final shell cache-ready scheduling to settle",
    );
    expect(state.reactAbortController.signal.aborted).toBe(false);

    beginPartialRscShellFinalRender(state);
    await waitForCondition(
      () => state.reactAbortController.signal.aborted,
      "Timed out waiting for final shell abort after React prerender started",
    );
    expect(state.reactAbortController.signal.aborted).toBe(true);
    expect(state.abortController.signal.aborted).toBe(true);
  });

  it("isPartialRscShellAbortError returns true for DOMException AbortError", () => {
    const error = new DOMException("aborted", "AbortError");
    expect(isPartialRscShellAbortError(error)).toBe(true);
  });

  it("isPartialRscShellAbortError returns false for regular errors", () => {
    expect(isPartialRscShellAbortError(new Error("something else"))).toBe(false);
    expect(isPartialRscShellAbortError("string error")).toBe(false);
    expect(isPartialRscShellAbortError(null)).toBe(false);
  });

  it("re-schedules warmup cache-ready when a dynamic boundary has no in-scope cache task", () => {
    const state = createTestPartialShellState();

    expect(state.pendingCacheReadyCleanup).toBeNull();

    // A bare `headers()`/`cookies()` access outside any tracked cache task has
    // an empty cache-task stack, so `ignoreCacheTask` completes nothing and
    // cannot drive the settle. The suspense creation itself must re-schedule
    // the warmup cache-ready settle; previously this only happened in the
    // final phase, leaving a warmup waiter un-settled.
    runWithPartialRscShellState(state, () => {
      void createPartialRscShellSuspensePromise("headers");
    });

    expect(state.pendingCacheReadyCleanup).not.toBeNull();

    state.abortController.abort();
  });

  it("does not drive pendingCacheTasks negative when a warmup task settles after final transition", async () => {
    const state = createTestPartialShellState();

    let finishWarmupTask!: () => void;
    const tracked = runWithPartialRscShellState(state, () =>
      trackPartialRscShellCacheTask(
        () => new Promise<void>((resolve) => (finishWarmupTask = resolve)),
        "default",
      ),
    );
    expect(state.pendingCacheTasks).toBe(1);

    // Transition to the final render while the warmup task is still in flight.
    // This resets `pendingCacheTasks` to 0.
    preparePartialRscShellFinalRender(state);
    expect(state.pendingCacheTasks).toBe(0);

    // The stale warmup task settling must not decrement the reset counter
    // below zero (which would permanently block `waitForPartialRscShellCacheReady`).
    finishWarmupTask();
    await tracked;
    expect(state.pendingCacheTasks).toBe(0);

    // Final-phase cache-ready still resolves immediately.
    await waitForPartialRscShellCacheReady(state);

    state.abortController.abort();
  });

  it("multiple suspense promises in the same warmup phase track correctly", async () => {
    const state = createTestPartialShellState();
    let isReady = false;

    const ready = waitForPartialRscShellCacheReady(state).then(() => {
      isReady = true;
    });

    runWithPartialRscShellState(state, () => {
      const p1 = createPartialRscShellSuspensePromise("params");
      expect(p1).not.toBeNull();
      const p2 = createPartialRscShellSuspensePromise("headers");
      expect(p2).not.toBeNull();
    });

    await ready;
    expect(isReady).toBe(true);
    expect(state.pendingCacheTasks).toBe(0);

    state.abortController.abort();
  });

  it("does not settle final static shell before a dynamic boundary is observed", async () => {
    const state = createTestPartialShellState();
    preparePartialRscShellFinalRender(state);
    let isSettled = false;

    const settled = waitForPartialRscShellSettled(state).then(() => {
      isSettled = true;
    });

    await delay(5);
    expect(isSettled).toBe(false);

    runWithPartialRscShellState(state, () => {
      void createPartialRscShellSuspensePromise("connection");
    });

    await settled;
    expect(isSettled).toBe(true);

    state.abortController.abort();
  });

  it("waits for final static shell public cache work after a dynamic boundary", async () => {
    const state = createTestPartialShellState();
    preparePartialRscShellFinalRender(state);
    let finishTask!: () => void;
    let isSettled = false;

    const tracked = runWithPartialRscShellState(state, () =>
      trackPartialRscShellCacheTask(
        () => new Promise<void>((resolve) => (finishTask = resolve)),
        "default",
      ),
    );
    const settled = waitForPartialRscShellSettled(state).then(() => {
      isSettled = true;
    });

    runWithPartialRscShellState(state, () => {
      void createPartialRscShellSuspensePromise("connection");
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
    const state = createTestPartialShellState();
    preparePartialRscShellFinalRender(state);
    let finishTask!: () => void;
    let isSettled = false;

    const tracked = runWithPartialRscShellState(state, () =>
      trackPartialRscShellCacheTask(
        () => new Promise<void>((resolve) => (finishTask = resolve)),
        "private",
      ),
    );
    const settled = waitForPartialRscShellSettled(state).then(() => {
      isSettled = true;
    });

    runWithPartialRscShellState(state, () => {
      void createPartialRscShellSuspensePromise("connection");
    });

    await settled;
    expect(isSettled).toBe(true);
    expect(state.pendingCacheTasks).toBe(0);

    finishTask();
    await tracked;
    state.abortController.abort();
  });

  it("waits for final static shell private cache work when runtime APIs are included", async () => {
    const state = createTestPartialShellState({ includePrivateCacheTasks: true });
    preparePartialRscShellFinalRender(state);
    let finishTask!: () => void;
    let isSettled = false;

    const tracked = runWithPartialRscShellState(state, () =>
      trackPartialRscShellCacheTask(
        () => new Promise<void>((resolve) => (finishTask = resolve)),
        "private",
      ),
    );
    const settled = waitForPartialRscShellSettled(state).then(() => {
      isSettled = true;
    });

    runWithPartialRscShellState(state, () => {
      void createPartialRscShellSuspensePromise("connection");
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
