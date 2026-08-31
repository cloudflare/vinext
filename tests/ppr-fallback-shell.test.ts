import { describe, expect, it } from "vite-plus/test";
import {
  createPprFallbackShellState,
  createPprFallbackShellSuspensePromise,
  getPprFallbackShellState,
  isPprFallbackShellAbortError,
  markPprFallbackShellDynamicBoundary,
  runWithPprFallbackShellState,
  trackPprFallbackShellCacheTask,
  waitForPprFallbackShellCacheReady,
} from "../packages/vinext/src/shims/ppr-fallback-shell.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("ppr fallback shell compatibility wrapper", () => {
  it("keeps fallback param metadata on PPR state", () => {
    const state = createPprFallbackShellState({
      fallbackParamNames: ["slug"],
      includePrivateCacheTasks: true,
      routePattern: "/:locale/blog/:slug",
    });

    expect([...state.fallbackParamNames]).toEqual(["slug"]);
    expect(state.includePrivateCacheTasks).toBe(true);
    expect(state.phase).toBe("warmup");
    expect(state.routePattern).toBe("/:locale/blog/:slug");
  });

  it("exposes the current PPR state through the wrapper accessor", () => {
    const state = createPprFallbackShellState({
      fallbackParamNames: ["slug"],
      routePattern: "/:locale/blog/:slug",
    });

    expect(getPprFallbackShellState()).toBeNull();
    runWithPprFallbackShellState(state, () => {
      expect(getPprFallbackShellState()).toBe(state);
    });
    expect(getPprFallbackShellState()).toBeNull();
  });

  it("creates suspense promises through the shared partial shell machinery", () => {
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

  it("returns null outside shell context", () => {
    const promise = createPprFallbackShellSuspensePromise("params");
    expect(promise).toBeNull();
  });

  it("preserves the PPR fallback-param guard for direct dynamic-boundary marking", () => {
    const staticState = createPprFallbackShellState({
      fallbackParamNames: [],
      routePattern: "/about",
    });
    const fallbackState = createPprFallbackShellState({
      fallbackParamNames: ["slug"],
      routePattern: "/blog/:slug",
    });

    runWithPprFallbackShellState(staticState, () => {
      markPprFallbackShellDynamicBoundary();
    });
    expect(staticState.hasDynamicBoundary).toBe(false);
    expect(staticState.pendingCacheReadyCleanup).toBeNull();

    runWithPprFallbackShellState(fallbackState, () => {
      markPprFallbackShellDynamicBoundary();
    });
    expect(fallbackState.hasDynamicBoundary).toBe(true);
    expect(fallbackState.pendingCacheReadyCleanup).not.toBeNull();

    fallbackState.abortController.abort();
  });

  it("keeps cache-ready tracking compatible through the wrapper", async () => {
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

  it("isPprFallbackShellAbortError returns true for DOMException AbortError", () => {
    const error = new DOMException("aborted", "AbortError");
    expect(isPprFallbackShellAbortError(error)).toBe(true);
  });

  it("isPprFallbackShellAbortError returns false for regular errors", () => {
    expect(isPprFallbackShellAbortError(new Error("something else"))).toBe(false);
    expect(isPprFallbackShellAbortError("string error")).toBe(false);
    expect(isPprFallbackShellAbortError(null)).toBe(false);
  });
});
