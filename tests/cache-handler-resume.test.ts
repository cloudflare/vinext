import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  MemoryCacheHandler,
  getResumeDataCacheFallbackParamNames,
  getCacheHandler,
  runWithResumeDataCache,
  setCacheHandler,
  shouldUseResumeDataCacheLayoutKeys,
  type CacheHandler,
  type CachedFetchValue,
  type ResumeDataCacheEntry,
} from "../packages/vinext/src/shims/cache-handler.js";
import { prepareAppLayoutPropsForFallbackCacheKey } from "../packages/vinext/src/shims/internal/app-layout-props-cache-key.js";
import { registerCachedFunction } from "../packages/vinext/src/shims/cache-runtime.js";
import { cacheLife, cacheTag } from "../packages/vinext/src/shims/cache.js";
import { _captureRequestScopedCacheLifeAccessors } from "../packages/vinext/src/shims/cache-request-state.js";
import { getCollectedFetchTags } from "../packages/vinext/src/shims/fetch-cache.js";
import {
  createRequestContext,
  runWithRequestContext,
} from "../packages/vinext/src/shims/unified-request-context.js";
import {
  createPprFallbackShellSuspensePromise,
  createPprFallbackShellState,
  isPprFallbackShellAbortError,
  preparePprFallbackShellFinalRender,
  runWithPprFallbackShellState,
  waitForPprFallbackShellCacheReady,
} from "../packages/vinext/src/shims/ppr-fallback-shell.js";

function fetchValue(key: string, body: string): CachedFetchValue {
  return {
    kind: "FETCH",
    data: { body, headers: {}, url: key },
    revalidate: 900,
  };
}

function createDelegate(value: CachedFetchValue | null = null): {
  get: ReturnType<typeof vi.fn>;
  handler: CacheHandler;
  set: ReturnType<typeof vi.fn>;
} {
  const get = vi.fn(async () => (value ? { lastModified: 1, value } : null));
  const set = vi.fn(async () => {});
  return {
    get,
    handler: {
      get,
      set,
      revalidateTag: vi.fn(async () => {}),
    },
    set,
  };
}

afterEach(() => {
  setCacheHandler(new MemoryCacheHandler());
});

describe("resume data cache handler", () => {
  it("keeps fallback cache work reserved through async key setup and dynamic classification", async () => {
    const state = createPprFallbackShellState({
      fallbackParamNames: ["slug"],
      routePattern: "/[slug]",
    });
    let releaseDecryption!: () => void;
    const decryptionGate = new Promise<void>((resolve) => {
      releaseDecryption = resolve;
    });
    const cached = registerCachedFunction(
      async () => {
        cacheLife({ expire: 120 });
        return "dynamic";
      },
      "test:fallback-readiness",
      undefined,
      {
        decryptCaptures: async () => {
          await decryptionGate;
          return undefined;
        },
      },
    );

    const pending = runWithPprFallbackShellState(state, () => cached());
    let isReady = false;
    const ready = waitForPprFallbackShellCacheReady(state).then(() => {
      isReady = true;
    });
    expect(state.pendingCacheTasks).toBe(1);

    // Readiness uses two task turns to discover cache work. It must remain
    // blocked even after that grace period while capture decryption is gated.
    await new Promise<void>((resolve) => setTimeout(() => setTimeout(resolve, 0), 0));
    expect(isReady).toBe(false);
    expect(state.pendingCacheTasks).toBe(1);

    releaseDecryption();
    await ready;
    expect(state.hasDynamicBoundary).toBe(true);
    expect(state.pendingCacheTasks).toBe(0);
    expect(state.resumeDataCache.size).toBe(0);

    state.abortController.abort();
    await expect(pending).rejects.toMatchObject({ name: "HangingPromiseRejectionError" });
  });

  it("stops stale key setup before it can mutate the final fallback render", async () => {
    const state = createPprFallbackShellState({
      fallbackParamNames: ["slug"],
      routePattern: "/[slug]",
    });
    let abandonedDynamicInput!: Promise<unknown>;
    runWithPprFallbackShellState(state, () => {
      abandonedDynamicInput = createPprFallbackShellSuspensePromise("params")!;
      abandonedDynamicInput.catch(() => {});
    });
    let abortedDuringKeySetup = false;
    const taskyInput = {
      get value(): string {
        if (!abortedDuringKeySetup) {
          abortedDuringKeySetup = true;
          state.abortController.abort();
        }
        return "value";
      },
    };

    let releaseDecryption!: () => void;
    let markDecryptionStarted!: () => void;
    const decryptionStarted = new Promise<void>((resolve) => {
      markDecryptionStarted = resolve;
    });
    const decryptionGate = new Promise<void>((resolve) => {
      releaseDecryption = resolve;
    });
    let originalFunctionRan = false;
    const cached = registerCachedFunction(
      async (_input: unknown) => {
        originalFunctionRan = true;
        return "late";
      },
      "test:fallback-stale-setup",
      undefined,
      {
        decryptCaptures: async () => {
          markDecryptionStarted();
          await decryptionGate;
          return undefined;
        },
      },
    );

    const pending = runWithPprFallbackShellState(state, () => cached(taskyInput));
    await decryptionStarted;
    expect(state.pendingCacheTasks).toBe(1);

    releaseDecryption();
    await expect(pending).rejects.toSatisfy(isPprFallbackShellAbortError);
    expect(abortedDuringKeySetup).toBe(true);
    expect(originalFunctionRan).toBe(false);
    expect(state.pendingCacheTasks).toBe(0);
    expect(state.phase).toBe("warmup");

    preparePprFallbackShellFinalRender(state);
    expect(state.hasDynamicBoundary).toBe(false);
    expect(state.resumeDataCache.size).toBe(0);
    state.abortController.abort();
  });

  it("stops private cache setup against the original fallback abort signal", async () => {
    const state = createPprFallbackShellState({
      fallbackParamNames: ["slug"],
      routePattern: "/[slug]",
    });
    let releaseDecryption!: () => void;
    let markDecryptionStarted!: () => void;
    const decryptionStarted = new Promise<void>((resolve) => {
      markDecryptionStarted = resolve;
    });
    const decryptionGate = new Promise<void>((resolve) => {
      releaseDecryption = resolve;
    });
    let originalFunctionRan = false;
    const cached = registerCachedFunction(
      async () => {
        originalFunctionRan = true;
        return "late-private";
      },
      "test:fallback-private-stale-setup",
      "private",
      {
        decryptCaptures: async () => {
          markDecryptionStarted();
          await decryptionGate;
          return undefined;
        },
      },
    );

    const pending = runWithPprFallbackShellState(state, () => cached());
    await decryptionStarted;
    expect(state.pendingCacheTasks).toBe(0);

    state.abortController.abort();
    preparePprFallbackShellFinalRender(state);
    releaseDecryption();

    await expect(pending).rejects.toSatisfy(isPprFallbackShellAbortError);
    expect(originalFunctionRan).toBe(false);
    expect(state.pendingCacheTasks).toBe(0);
    expect(state.hasDynamicBoundary).toBe(false);
    expect(state.resumeDataCache.size).toBe(0);
    state.abortController.abort();
  });

  // Ported from Next.js: test/e2e/app-dir/fallback-shells/fallback-shells.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/fallback-shells/fallback-shells.test.ts
  it("returns a resume entry without consulting the global handler", async () => {
    const key = "use-cache:resumed";
    const delegate = createDelegate(fetchValue(key, "global"));
    const entries: ResumeDataCacheEntry[] = [
      { key, lastModified: 42, value: fetchValue(key, "resumed") },
    ];
    setCacheHandler(delegate.handler);

    const result = await runWithResumeDataCache(
      entries,
      () => getCacheHandler().get(key, { cacheKind: "use-cache" }),
      { blockUseCacheMisses: true },
    );

    expect(result).toMatchObject({
      lastModified: 42,
      value: { kind: "FETCH", data: { body: "resumed" } },
    });
    expect(delegate.get).not.toHaveBeenCalled();
  });

  it("does not consult the global handler for a missing use-cache entry", async () => {
    const delegate = createDelegate(fetchValue("use-cache:missing", "global"));
    setCacheHandler(delegate.handler);

    const result = await runWithResumeDataCache(
      [],
      () => getCacheHandler().get("use-cache:missing", { cacheKind: "use-cache" }),
      { blockUseCacheMisses: true },
    );

    expect(result).toBeNull();
    expect(delegate.get).not.toHaveBeenCalled();
  });

  it("delegates a missing fetch entry while use-cache misses are blocked", async () => {
    const value = fetchValue("fetch:missing", "global-fetch");
    const delegate = createDelegate(value);
    setCacheHandler(delegate.handler);

    const result = await runWithResumeDataCache(
      [],
      () => getCacheHandler().get("fetch:missing", { cacheKind: "fetch" }),
      { blockUseCacheMisses: true },
    );

    expect(result?.value).toEqual(value);
    expect(delegate.get).toHaveBeenCalledOnce();
  });

  it("keeps a filled use-cache resume miss out of the global handler", async () => {
    const delegate = createDelegate();
    setCacheHandler(delegate.handler);
    const key = "use-cache:runtime-only";

    const result = await runWithResumeDataCache(
      [],
      async () => {
        const handler = getCacheHandler();
        expect(await handler.get(key, { cacheKind: "use-cache" })).toBeNull();
        await handler.set(key, fetchValue(key, "runtime"), {
          cacheKind: "use-cache",
          cacheControl: { revalidate: 900 },
        });
        return handler.get(key, { cacheKind: "use-cache" });
      },
      { blockUseCacheMisses: true },
    );

    expect(result).toMatchObject({ value: { kind: "FETCH", data: { body: "runtime" } } });
    expect(delegate.set).not.toHaveBeenCalled();
  });

  it("scopes fallback layout keys to an actual resume render", async () => {
    expect(shouldUseResumeDataCacheLayoutKeys()).toBe(false);

    const active = await runWithResumeDataCache(
      [{ key: "resume", lastModified: 1, value: fetchValue("resume", "value") }],
      async () => {
        await Promise.resolve();
        return {
          active: shouldUseResumeDataCacheLayoutKeys(),
          fallbackParamNames: [...(getResumeDataCacheFallbackParamNames() ?? [])],
        };
      },
      { fallbackParamNames: ["slug"], useFallbackLayoutKeys: true },
    );

    expect(active).toEqual({ active: true, fallbackParamNames: ["slug"] });
    expect(shouldUseResumeDataCacheLayoutKeys()).toBe(false);
  });

  it("preserves known parent params while omitting fallback params from layout keys", () => {
    const fallbackParamNames = new Set(["slug"]);
    const props = (locale: string, slug: string) => ({
      $$isLayout: true as const,
      children: null,
      params: { locale, slug },
    });

    const fallbackKey = prepareAppLayoutPropsForFallbackCacheKey(
      props("en", "[slug]"),
      fallbackParamNames,
    );
    const sameParentResumeKey = prepareAppLayoutPropsForFallbackCacheKey(
      props("en", "post-a"),
      fallbackParamNames,
    );
    const otherParentResumeKey = prepareAppLayoutPropsForFallbackCacheKey(
      props("fr", "post-a"),
      fallbackParamNames,
    );

    expect(sameParentResumeKey).toEqual(fallbackKey);
    expect(otherParentResumeKey).not.toEqual(fallbackKey);
    expect(fallbackKey).toMatchObject({ params: { locale: "en" } });
  });

  it("keeps fallback-shell fills out of the global memory handler", async () => {
    const globalHandler = new MemoryCacheHandler();
    const state = createPprFallbackShellState({
      fallbackParamNames: ["slug"],
      routePattern: "/[slug]",
    });
    const key = "use-cache:fallback-memory";
    setCacheHandler(globalHandler);

    await runWithPprFallbackShellState(state, async () => {
      const handler = getCacheHandler();
      expect(await handler.get(key, { cacheKind: "use-cache" })).toBeNull();
      await handler.set(key, fetchValue(key, "fallback"), { cacheKind: "use-cache" });
      await expect(handler.get(key, { cacheKind: "use-cache" })).resolves.toMatchObject({
        value: { kind: "FETCH", data: { body: "fallback" } },
      });
    });

    await expect(globalHandler.get(key, { cacheKind: "use-cache" })).resolves.toBeNull();
    expect([...state.resumeDataCache.values()]).toMatchObject([{ key }]);
  });

  it.each([
    ["revalidate zero", { revalidate: 0 }],
    ["short expire", { expire: 120 }],
  ] as const)(
    "leaves explicit %s use-cache results as dynamic fallback holes",
    async (_name, life) => {
      const globalHandler = new MemoryCacheHandler();
      const state = createPprFallbackShellState({
        fallbackParamNames: ["slug"],
        routePattern: "/[slug]",
      });
      setCacheHandler(globalHandler);
      const cached = registerCachedFunction(async () => {
        cacheLife(life);
        cacheTag(`dynamic-${_name}`);
        return "dynamic";
      }, `test:fallback-dynamic:${_name}`);

      await runWithRequestContext(createRequestContext(), async () => {
        const requestCacheLife = _captureRequestScopedCacheLifeAccessors();
        const pending = runWithPprFallbackShellState(state, () => cached());
        await waitForPprFallbackShellCacheReady(state);

        expect(state.hasDynamicBoundary).toBe(true);
        expect(state.resumeDataCache.size).toBe(0);
        expect(requestCacheLife.peek()).toBeNull();
        expect(getCollectedFetchTags()).toEqual([]);
        state.abortController.abort();
        await expect(pending).rejects.toMatchObject({ name: "HangingPromiseRejectionError" });
      });
    },
  );

  it("removes a short-expire global hit from fallback resume data and suspends", async () => {
    const state = createPprFallbackShellState({
      fallbackParamNames: ["slug"],
      routePattern: "/[slug]",
    });
    let calls = 0;
    const cached = registerCachedFunction(async () => {
      calls++;
      cacheLife({ expire: 120 });
      return "short-lived";
    }, "test:fallback-dynamic-hit");
    expect(await cached()).toBe("short-lived");

    const pending = runWithPprFallbackShellState(state, () => cached());
    await waitForPprFallbackShellCacheReady(state);

    expect(calls).toBe(1);
    expect(state.resumeDataCache.size).toBe(0);
    state.abortController.abort();
    await expect(pending).rejects.toMatchObject({ name: "HangingPromiseRejectionError" });
  });
});
