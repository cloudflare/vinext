import { describe, expect, it, vi } from "vite-plus/test";
import {
  cacheLife,
  MemoryCacheHandler,
  setCacheHandler,
} from "../packages/vinext/src/shims/cache.js";
import { registerCachedFunction } from "../packages/vinext/src/shims/cache-runtime.js";
import { _peekRequestScopedCacheLife } from "../packages/vinext/src/shims/cache-request-state.js";
import { withUseCacheLayoutMarker } from "../packages/vinext/src/shims/internal/app-page-props-cache-key.js";
import { makeThenableParams } from "../packages/vinext/src/shims/thenable-params.js";
import {
  createRequestContext,
  runWithRequestContext,
} from "../packages/vinext/src/shims/unified-request-context.js";
import {
  beginPprFallbackShellFinalRender,
  createPprFallbackShellState,
  createPprFallbackShellSuspensePromise,
  isPprFallbackShellAbortError,
  preparePprFallbackShellFinalRender,
  runWithPprFallbackShellState,
  trackPprFallbackShellCacheTask,
  waitForPprFallbackShellCacheInput,
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
    await delay(5);
    // The abort leaves the suspension pending instead of rejecting it.
    expect(reachedAfterSuspend).toBe(false);
    void tracked;
  });
  it("does not wait for a cache task whose arguments never resolve", async () => {
    const state = createPprFallbackShellState({
      fallbackParamNames: ["slug"],
      routePattern: "/:locale/blog/:slug",
    });
    let reachedAfterInput = false;

    runWithPprFallbackShellState(state, () => {
      const hangingInput = createPprFallbackShellSuspensePromise<void>("`params`");
      void trackPprFallbackShellCacheTask(async () => {
        await waitForPprFallbackShellCacheInput(hangingInput ?? Promise.resolve());
        reachedAfterInput = true;
      }, "default");
    });

    await waitForPprFallbackShellCacheReady(state);
    expect(state.pendingCacheTasks).toBe(0);
    expect(reachedAfterInput).toBe(false);
    state.abortController.abort();
  });

  it("halts a warmup cache task whose arguments resolve after the final render starts", async () => {
    const state = createPprFallbackShellState({
      fallbackParamNames: ["slug"],
      routePattern: "/:locale/blog/:slug",
    });
    let resolveInput!: () => void;
    let reachedAfterInput = false;

    void runWithPprFallbackShellState(state, () =>
      trackPprFallbackShellCacheTask(async () => {
        await waitForPprFallbackShellCacheInput(
          new Promise<void>((resolve) => (resolveInput = resolve)),
        );
        reachedAfterInput = true;
      }, "default"),
    );
    await waitForPprFallbackShellCacheReady(state);
    preparePprFallbackShellFinalRender(state);

    resolveInput();
    await delay(5);
    expect(reachedAfterInput).toBe(false);
    expect(state.pendingCacheTasks).toBe(0);
  });

  it("halts a warmup cache task whose arguments resolve once the warmup aborts", async () => {
    const state = createPprFallbackShellState({
      fallbackParamNames: ["slug"],
      routePattern: "/:locale/blog/:slug",
    });
    let resolveInput!: () => void;
    let reachedAfterInput = false;

    void runWithPprFallbackShellState(state, () =>
      trackPprFallbackShellCacheTask(async () => {
        await waitForPprFallbackShellCacheInput(
          new Promise<void>((resolve) => (resolveInput = resolve)),
        );
        reachedAfterInput = true;
      }, "default"),
    );
    await waitForPprFallbackShellCacheReady(state);
    // The warmup drains its stream between the abort and the final render.
    state.abortController.abort();

    resolveInput();
    await delay(5);
    expect(reachedAfterInput).toBe(false);
  });

  it("halts a warmup cache task that reaches its arguments after the final render starts", async () => {
    const state = createPprFallbackShellState({
      fallbackParamNames: ["slug"],
      routePattern: "/:locale/blog/:slug",
    });
    let startEncoding!: () => void;
    let reachedAfterInput = false;

    void runWithPprFallbackShellState(state, () =>
      trackPprFallbackShellCacheTask(async () => {
        await new Promise<void>((resolve) => (startEncoding = resolve));
        await waitForPprFallbackShellCacheInput(Promise.resolve());
        reachedAfterInput = true;
      }, "default"),
    );
    preparePprFallbackShellFinalRender(state);

    startEncoding();
    await delay(5);
    expect(reachedAfterInput).toBe(false);
    expect(state.pendingCacheTasks).toBe(0);
  });

  it("halts an ignored cache task whose arguments resolve", async () => {
    const state = createPprFallbackShellState({
      fallbackParamNames: ["slug"],
      routePattern: "/:locale/blog/:slug",
    });
    let resolveInput!: () => void;
    let reachedAfterInput = false;

    void runWithPprFallbackShellState(state, () =>
      trackPprFallbackShellCacheTask(async () => {
        const input = waitForPprFallbackShellCacheInput(
          new Promise<void>((resolve) => (resolveInput = resolve)),
        );
        // Reading fallback params leaves the task out of the shell.
        void createPprFallbackShellSuspensePromise("`params`");
        await input;
        reachedAfterInput = true;
      }, "default"),
    );

    resolveInput();
    await delay(5);
    expect(reachedAfterInput).toBe(false);
    expect(state.pendingCacheTasks).toBe(0);
    state.abortController.abort();
  });

  it("counts a cache task again once its arguments resolve", async () => {
    const state = createPprFallbackShellState({
      fallbackParamNames: ["slug"],
      routePattern: "/:locale/blog/:slug",
    });
    let resolveInput!: () => void;
    let finishTask!: () => void;
    let isReady = false;

    const tracked = runWithPprFallbackShellState(state, () =>
      trackPprFallbackShellCacheTask(async () => {
        await waitForPprFallbackShellCacheInput(
          new Promise<void>((resolve) => (resolveInput = resolve)),
        );
        await new Promise<void>((resolve) => (finishTask = resolve));
      }, "default"),
    );
    // Like an argument another cache produces: still pending work.
    const producer = runWithPprFallbackShellState(state, () =>
      trackPprFallbackShellCacheTask(async () => {
        await delay(5);
        resolveInput();
      }, "default"),
    );
    const ready = waitForPprFallbackShellCacheReady(state).then(() => {
      isReady = true;
    });

    await producer;
    await delay(5);
    expect(isReady).toBe(false);
    expect(state.pendingCacheTasks).toBe(1);
    finishTask();
    await tracked;
    await ready;
    expect(state.pendingCacheTasks).toBe(0);
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

  it("leaves request-data reads as holes without making the shell dynamic", async () => {
    const { consumeDynamicUsage, cookies, headers, setHeadersContext } =
      await import("../packages/vinext/src/shims/headers.js");
    const { connection } = await import("../packages/vinext/src/shims/server.js");
    const state = createPprFallbackShellState({
      fallbackParamNames: [],
      routePattern: "/:locale/about",
    });

    await runWithRequestContext(createRequestContext(), async () => {
      setHeadersContext({ headers: new Headers(), cookies: new Map() });
      const { registerCachedFunction } =
        await import("../packages/vinext/src/shims/cache-runtime.js");
      const privateCache = registerCachedFunction(
        async () => "private",
        "test:shell-private",
        "private",
      );
      runWithPprFallbackShellState(state, () => {
        void cookies();
        void headers();
        void connection();
        void privateCache();
      });
      await delay(0);
      expect(state.hasDynamicBoundary).toBe(true);
      // The shell holds the reads as holes, so it stays storable.
      expect(consumeDynamicUsage()).toBe(false);

      void cookies();
      expect(consumeDynamicUsage()).toBe(true);
    });

    state.abortController.abort();
  });

  // A runtime fallback shell renders in a prerender work unit.
  it("leaves a private cache as a hole in a shell rendered in a prerender work unit", async () => {
    const { runWithPrerenderWorkUnit } =
      await import("../packages/vinext/src/server/prerender-work-unit-setup.js");
    const privateCache = registerCachedFunction(
      async () => "private",
      "test:shell-private-prerender",
      "private",
    );
    const state = createPprFallbackShellState({
      fallbackParamNames: [],
      routePattern: "/:locale/about",
    });

    const response = await runWithRequestContext(createRequestContext(), () =>
      runWithPrerenderWorkUnit(
        () =>
          runWithPprFallbackShellState(state, async () => {
            void privateCache();
            await delay(0);
            return new Response("shell");
          }),
        { cacheComponents: true, prerender: true, route: "/:locale/about" },
      ),
    );

    // The render carries on to its shell instead of bailing out of it.
    await expect(response.text()).resolves.toBe("shell");
    expect(state.hasDynamicBoundary).toBe(true);
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

// Like Next.js's final prerender (use-cache-wrapper.ts, `DYNAMIC_EXPIRE`), a
// shell leaves out a cache that's short-lived, though the entry is stored.
describe("ppr fallback shell short-lived caches", () => {
  async function renderCached(phase: "warmup" | "final", profile: string, id: string) {
    const handler = new MemoryCacheHandler();
    const set = vi.spyOn(handler, "set");
    setCacheHandler(handler);
    const cached = registerCachedFunction(async () => {
      cacheLife(profile);
      return "value";
    }, id);
    const state = createPprFallbackShellState({ fallbackParamNames: [], routePattern: "/page" });
    if (phase === "final") preparePprFallbackShellFinalRender(state);
    const result = runWithPprFallbackShellState(state, () => cached());
    const settled = await Promise.race([result, delay(20).then(() => "pending")]);
    state.abortController.abort();
    return { hasDynamicBoundary: state.hasDynamicBoundary, set, settled };
  }

  it("leaves a short-lived cache out of the final render", async () => {
    const { hasDynamicBoundary, set, settled } = await renderCached(
      "final",
      "seconds",
      "shell-short-lived-final",
    );
    expect(settled).toBe("pending");
    expect(hasDynamicBoundary).toBe(true);
    expect(set).toHaveBeenCalledTimes(1);
  });

  it("leaves a short-lived cache given unread fallback params out of the final render", async () => {
    setCacheHandler(new MemoryCacheHandler());
    const cached = registerCachedFunction(async (_props: { params: Promise<unknown> }) => {
      cacheLife("seconds");
      return "value";
    }, "shell-short-lived-fallback-params");
    const state = createPprFallbackShellState({
      fallbackParamNames: ["slug"],
      routePattern: "/blog/:slug",
    });
    preparePprFallbackShellFinalRender(state);

    const settled = await runWithRequestContext(createRequestContext(), () =>
      runWithPprFallbackShellState(state, async () => {
        // A cached layout's props, as the route wiring passes them.
        const result = cached(
          withUseCacheLayoutMarker(cached, { params: makeThenableParams({ slug: "[slug]" }) }),
        );
        const settled = await Promise.race([result, delay(20).then(() => "pending")]);
        return { life: _peekRequestScopedCacheLife(), settled };
      }),
    );
    state.abortController.abort();
    expect(settled.settled).toBe("pending");
    expect(state.hasDynamicBoundary).toBe(true);
    // Its life doesn't count toward the shell's.
    expect(settled.life).toBeNull();
  });

  it("keeps a short-lived cache in the warmup render", async () => {
    const { hasDynamicBoundary, settled } = await renderCached(
      "warmup",
      "seconds",
      "shell-short-lived-warmup",
    );
    expect(settled).toBe("value");
    expect(hasDynamicBoundary).toBe(false);
  });

  it("leaves a left-out cache's life out of the shell's, a nested cache's included", async () => {
    setCacheHandler(new MemoryCacheHandler());
    const shortLived = registerCachedFunction(async () => {
      cacheLife("seconds");
      return "short";
    }, "shell-life-short");
    const nestedShortLived = registerCachedFunction(
      async () => `outer ${await shortLived()}`,
      "shell-life-nested-short",
    );
    const longLived = registerCachedFunction(async () => {
      cacheLife("minutes");
      return "long";
    }, "shell-life-long");
    const state = createPprFallbackShellState({ fallbackParamNames: [], routePattern: "/page" });
    preparePprFallbackShellFinalRender(state);

    const life = await runWithRequestContext(createRequestContext(), () =>
      runWithPprFallbackShellState(state, async () => {
        void shortLived();
        void nestedShortLived();
        await longLived();
        await delay(20);
        return _peekRequestScopedCacheLife();
      }),
    );
    state.abortController.abort();
    // Like Next.js, only the caches the shell keeps count toward its life.
    expect(life).toEqual({ stale: 300, revalidate: 60, expire: 3600 });
  });

  it("keeps a long-lived cache in the final render", async () => {
    const { hasDynamicBoundary, settled } = await renderCached(
      "final",
      "minutes",
      "shell-long-lived-final",
    );
    expect(settled).toBe("value");
    expect(hasDynamicBoundary).toBe(false);
  });
});

// Like Next.js's runtime prerender (use-cache-wrapper.ts,
// `RUNTIME_PREFETCH_DYNAMIC_STALE`), a runtime prefetch renders private and
// short-lived caches, and leaves out only those about to go stale.
describe("ppr fallback shell runtime prefetch caches", () => {
  async function renderRuntimeCached(
    life: string | { stale: number; revalidate: number; expire: number },
    id: string,
    variant?: string,
  ) {
    setCacheHandler(new MemoryCacheHandler());
    const cached = registerCachedFunction(
      async () => {
        cacheLife(life);
        return "value";
      },
      id,
      variant,
    );
    const state = createPprFallbackShellState({
      fallbackParamNames: [],
      isRuntimePrefetch: true,
      routePattern: "/page",
    });
    preparePprFallbackShellFinalRender(state);
    const result = runWithPprFallbackShellState(state, () => cached());
    const settled = await Promise.race([result, delay(20).then(() => "pending")]);
    state.abortController.abort();
    return { hasDynamicBoundary: state.hasDynamicBoundary, settled };
  }

  it("keeps a short-lived cache", async () => {
    const { hasDynamicBoundary, settled } = await renderRuntimeCached(
      "seconds",
      "runtime-short-lived",
    );
    expect(settled).toBe("value");
    expect(hasDynamicBoundary).toBe(false);
  });

  it("leaves out a cache about to go stale", async () => {
    const { hasDynamicBoundary, settled } = await renderRuntimeCached(
      { stale: 10, revalidate: 60, expire: 600 },
      "runtime-soon-stale",
    );
    expect(settled).toBe("pending");
    expect(hasDynamicBoundary).toBe(true);
  });

  it("leaves out a private cache about to go stale", async () => {
    const { hasDynamicBoundary, settled } = await renderRuntimeCached(
      { stale: 10, revalidate: 60, expire: 600 },
      "runtime-private-soon-stale",
      "private",
    );
    expect(settled).toBe("pending");
    expect(hasDynamicBoundary).toBe(true);
  });

  it("renders a private cache", async () => {
    const { hasDynamicBoundary, settled } = await renderRuntimeCached(
      "minutes",
      "runtime-private",
      "private",
    );
    expect(settled).toBe("value");
    expect(hasDynamicBoundary).toBe(false);
  });
});
