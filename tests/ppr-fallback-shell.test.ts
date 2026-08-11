import { describe, expect, it } from "vite-plus/test";
import {
  advanceCachedNavigationToDynamicStage,
  beginPprFallbackShellFinalRender,
  createPprFallbackShellState,
  createPprFallbackShellSuspensePromise,
  delayPprFallbackShellRequestApi,
  isPprFallbackShellAbortError,
  markPprFallbackShellRuntimeEligibleComponent,
  preparePprFallbackShellFinalRender,
  runWithPprFallbackShellState,
  runWithPprFallbackShellRuntimeDiscovery,
  shouldPprFallbackShellSuspendRequestApi,
  trackPprFallbackShellCacheTask,
  waitForPprFallbackShellCacheReady,
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
  it("does not build request API diagnostics outside fallback-shell renders", () => {
    let expressionBuilt = false;

    expect(
      delayPprFallbackShellRequestApi(
        "fetch",
        () => {
          expressionBuilt = true;
          return 'fetch("https://example.com/data")';
        },
        () => Promise.resolve(new Response()),
      ),
    ).toBeNull();
    expect(expressionBuilt).toBe(false);
  });

  it("suspends a private-cache invocation before executing it in the static stage", async () => {
    const state = createPprFallbackShellState({
      fallbackParamNames: [],
      requestApiStage: "static",
      routePattern: "/runtime-prefetchable",
    });
    let executed = false;

    const result = runWithPprFallbackShellState(state, () =>
      trackPprFallbackShellCacheTask(async () => {
        executed = true;
        return "private";
      }, "private"),
    );

    await Promise.resolve();
    expect(executed).toBe(false);
    expect(state.hasDynamicBoundary).toBe(true);
    state.abortController.abort();
    await expect(result).rejects.toMatchObject({ name: expect.any(String) });
  });

  it("suspends all request APIs in a cached-navigation static stage", () => {
    const state = createPprFallbackShellState({
      fallbackParamNames: [],
      requestApiStage: "static",
      routePattern: "/runtime-prefetchable",
    });

    runWithPprFallbackShellState(state, () => {
      expect(shouldPprFallbackShellSuspendRequestApi("searchParams")).toBe(true);
      expect(shouldPprFallbackShellSuspendRequestApi("cookies")).toBe(true);
      expect(shouldPprFallbackShellSuspendRequestApi("headers")).toBe(true);
      expect(shouldPprFallbackShellSuspendRequestApi("connection")).toBe(true);
    });
  });

  it("defers request API snapshots until the cached-navigation dynamic stage", async () => {
    const { cookies, headers, setHeadersContext } =
      await import("../packages/vinext/src/shims/headers.js");
    const context = {
      cookies: new Map([["session", "abc123"]]),
      headers: new Headers({ "x-test": "value" }),
    };
    const state = createPprFallbackShellState({
      cachedNavigationStage: "navigation",
      fallbackParamNames: [],
      requestApiStage: "static",
      routePattern: "/runtime-prefetchable",
    });
    setHeadersContext(context);

    try {
      const staged = runWithPprFallbackShellState(state, () => [headers(), cookies()] as const);
      expect(context).not.toHaveProperty("readonlyHeaders");
      expect(context).not.toHaveProperty("readonlyCookies");

      advanceCachedNavigationToDynamicStage(state);
      await Promise.all(staged);

      expect(context).toHaveProperty("readonlyHeaders");
      expect(context).toHaveProperty("readonlyCookies");
    } finally {
      setHeadersContext(null);
      state.abortController.abort();
    }
  });

  it("allows request-derived cache inputs but suspends connection in a runtime stage", () => {
    const state = createPprFallbackShellState({
      fallbackParamNames: [],
      requestApiStage: "runtime",
      routePattern: "/runtime-prefetchable",
    });

    runWithPprFallbackShellState(state, () => {
      expect(shouldPprFallbackShellSuspendRequestApi("searchParams")).toBe(false);
      expect(shouldPprFallbackShellSuspendRequestApi("cookies")).toBe(false);
      expect(shouldPprFallbackShellSuspendRequestApi("headers")).toBe(false);
      expect(shouldPprFallbackShellSuspendRequestApi("connection")).toBe(true);
    });
  });

  it("waits for private cache work before completing a cached-navigation runtime stage", async () => {
    const state = createPprFallbackShellState({
      fallbackParamNames: [],
      requestApiStage: "runtime",
      routePattern: "/runtime-prefetchable",
    });
    let finishTask!: () => void;
    let isReady = false;

    const tracked = runWithPprFallbackShellState(state, () =>
      trackPprFallbackShellCacheTask(
        () => new Promise<void>((resolve) => (finishTask = resolve)),
        "private",
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
    expect(state.isAbortScheduled).toBe(false);
    expect(state.cacheReadyResolvers.length).toBe(0);
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

  it("waits for an opted component, then terminates without private cache work", async () => {
    const state = createPprFallbackShellState({
      cachedNavigationStage: "runtime",
      fallbackParamNames: [],
      requestApiStage: "runtime",
      routePattern: "/runtime-prefetchable",
    });
    preparePprFallbackShellFinalRender(state);

    runWithPprFallbackShellState(state, () => {
      void createPprFallbackShellSuspensePromise("`connection()`");
      beginPprFallbackShellFinalRender(state);
    });

    await delay(10);
    expect(state.reactAbortController.signal.aborted).toBe(false);

    runWithPprFallbackShellState(state, () => {
      markPprFallbackShellRuntimeEligibleComponent();
    });
    await waitForCondition(
      () => state.reactAbortController.signal.aborted,
      "Timed out waiting for runtime shell abort after the opted component started",
    );
  });

  it("terminates an opted runtime branch after discovery without requiring a private cache hit", async () => {
    const state = createPprFallbackShellState({
      cachedNavigationStage: "runtime",
      fallbackParamNames: [],
      requestApiStage: "runtime",
      routePattern: "/runtime-prefetchable",
    });
    preparePprFallbackShellFinalRender(state);

    runWithPprFallbackShellState(state, () => {
      markPprFallbackShellRuntimeEligibleComponent();
      void createPprFallbackShellSuspensePromise("`connection()`");
      beginPprFallbackShellFinalRender(state);
    });

    expect(state.pendingCacheTasks).toBe(0);
    await waitForCondition(
      () => state.reactAbortController.signal.aborted,
      "Timed out waiting for opted runtime shell abort without private cache work",
    );
  });

  it("does not let one private task cut off a second opted async discovery scope", async () => {
    const state = createPprFallbackShellState({
      cachedNavigationStage: "runtime",
      fallbackParamNames: [],
      requestApiStage: "runtime",
      routePattern: "/runtime-prefetchable",
    });
    preparePprFallbackShellFinalRender(state);

    let continueSlowBranch!: () => void;
    const slowBranchGate = new Promise<void>((resolve) => (continueSlowBranch = resolve));
    let finishSlowPrivateCache!: () => void;
    let fastBranch!: Promise<void>;
    let slowBranch!: Promise<void>;

    runWithPprFallbackShellState(state, () => {
      markPprFallbackShellRuntimeEligibleComponent();
      fastBranch = runWithPprFallbackShellRuntimeDiscovery(async () => {
        await trackPprFallbackShellCacheTask(() => Promise.resolve(), "private");
      });
      slowBranch = runWithPprFallbackShellRuntimeDiscovery(async () => {
        await slowBranchGate;
        await trackPprFallbackShellCacheTask(
          () => new Promise<void>((resolve) => (finishSlowPrivateCache = resolve)),
          "private",
        );
      });
      void createPprFallbackShellSuspensePromise("`connection()`");
      beginPprFallbackShellFinalRender(state);
    });

    await fastBranch;
    await delay(10);
    expect(state.pendingRuntimeDiscoveryScopes).toBe(1);
    expect(state.reactAbortController.signal.aborted).toBe(false);

    continueSlowBranch();
    await waitForCondition(
      () => state.pendingCacheTasks === 1,
      "Timed out waiting for the slow private cache task to register",
    );
    expect(state.reactAbortController.signal.aborted).toBe(false);

    finishSlowPrivateCache();
    await slowBranch;
    await waitForCondition(
      () => state.reactAbortController.signal.aborted,
      "Timed out waiting for runtime shell abort after both opted branches settled",
    );
  });

  it("releases an opted async discovery scope when its branch reaches connection", async () => {
    const state = createPprFallbackShellState({
      cachedNavigationStage: "runtime",
      fallbackParamNames: [],
      requestApiStage: "runtime",
      routePattern: "/runtime-prefetchable",
    });
    preparePprFallbackShellFinalRender(state);

    let branch!: Promise<void>;
    runWithPprFallbackShellState(state, () => {
      markPprFallbackShellRuntimeEligibleComponent();
      branch = runWithPprFallbackShellRuntimeDiscovery(async () => {
        await trackPprFallbackShellCacheTask(() => Promise.resolve(), "private");
        await createPprFallbackShellSuspensePromise<void>("`connection()`");
      });
      beginPprFallbackShellFinalRender(state);
    });

    await waitForCondition(
      () => state.reactAbortController.signal.aborted,
      "Timed out waiting for connection to release its runtime discovery scope",
    );
    expect(state.pendingRuntimeDiscoveryScopes).toBe(0);
    await expect(branch).rejects.toMatchObject({ name: expect.any(String) });
  });

  it("does not let a discovery scope started after abort scheduling get cut off", async () => {
    const state = createPprFallbackShellState({
      cachedNavigationStage: "runtime",
      fallbackParamNames: [],
      requestApiStage: "runtime",
      routePattern: "/runtime-prefetchable",
    });
    preparePprFallbackShellFinalRender(state);

    let finishLateScope!: () => void;
    let lateScope!: Promise<void>;
    runWithPprFallbackShellState(state, () => {
      markPprFallbackShellRuntimeEligibleComponent();
      // Isolate the delayed-abort race after private-cache discovery has
      // already been proven, dynamic discovery has completed, and all cache
      // work has settled.
      state.hasDynamicBoundary = true;
      beginPprFallbackShellFinalRender(state);
      expect(state.isAbortScheduled).toBe(true);
      lateScope = runWithPprFallbackShellRuntimeDiscovery(
        () => new Promise<void>((resolve) => (finishLateScope = resolve)),
      );
    });

    await delay(10);
    expect(state.pendingRuntimeDiscoveryScopes).toBe(1);
    expect(state.reactAbortController.signal.aborted).toBe(false);

    finishLateScope();
    await lateScope;
    await waitForCondition(
      () => state.reactAbortController.signal.aborted,
      "Timed out waiting for abort after the late discovery scope settled",
    );
  });

  it("does not decrement final discovery scopes when a warmup scope settles late", async () => {
    const state = createPprFallbackShellState({
      cachedNavigationStage: "runtime",
      fallbackParamNames: [],
      requestApiStage: "runtime",
      routePattern: "/runtime-prefetchable",
    });
    let finishWarmupScope!: () => void;
    let warmupScope!: Promise<void>;

    runWithPprFallbackShellState(state, () => {
      warmupScope = runWithPprFallbackShellRuntimeDiscovery(
        () => new Promise<void>((resolve) => (finishWarmupScope = resolve)),
      );
    });
    expect(state.pendingRuntimeDiscoveryScopes).toBe(1);

    preparePprFallbackShellFinalRender(state);
    expect(state.pendingRuntimeDiscoveryScopes).toBe(0);
    finishWarmupScope();
    await warmupScope;
    await Promise.resolve();
    expect(state.pendingRuntimeDiscoveryScopes).toBe(0);
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
});
