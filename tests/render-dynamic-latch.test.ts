import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createAppLayoutParamAccessTracker } from "../packages/vinext/src/server/app-layout-param-observation.js";
import {
  consumeDynamicUsage,
  headersContextFromRequest,
  isRenderDynamicLatched,
  markDynamicUsage,
  onRenderDynamicLatched,
  runWithConnectionProbe,
  runWithHeadersContext,
  runWithDetachedDynamicUsage,
  runWithIsolatedDynamicUsage,
} from "../packages/vinext/src/shims/headers.js";
import { cacheForRequest } from "../packages/vinext/src/shims/cache-for-request.js";
import { registerCachedFunction } from "../packages/vinext/src/shims/cache-runtime.js";
import {
  addCollectedRequestTags,
  getCollectedFetchTags,
} from "../packages/vinext/src/shims/fetch-cache.js";
import {
  cacheLife,
  MemoryCacheHandler,
  setCacheHandler,
  unstable_cache,
} from "../packages/vinext/src/shims/cache.js";
import { runWithDetachedCacheObservations } from "../packages/vinext/src/shims/cache-request-state.js";
import {
  createRequestContext,
  getRequestContext,
  runWithRequestContext,
  runWithUnifiedStateMutation,
} from "../packages/vinext/src/shims/unified-request-context.js";

function headersContext(init?: { forceStatic?: boolean }) {
  return {
    ...headersContextFromRequest(new Request("https://example.test/")),
    ...init,
  };
}

describe("render dynamic latch", () => {
  it("stays set after the dynamic usage flag is consumed", async () => {
    await runWithHeadersContext(headersContext(), async () => {
      markDynamicUsage();
      expect(consumeDynamicUsage()).toBe(true);
      expect(isRenderDynamicLatched()).toBe(true);
    });
  });

  it("notifies a waiter once, when the render first turns dynamic", async () => {
    await runWithHeadersContext(headersContext(), async () => {
      const listener = vi.fn();
      onRenderDynamicLatched(listener);
      expect(listener).not.toHaveBeenCalled();
      markDynamicUsage();
      markDynamicUsage();
      expect(listener).toHaveBeenCalledOnce();
    });
  });

  it("notifies every waiter when one throws, without failing the dynamic API", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await runWithHeadersContext(headersContext(), async () => {
        const failure = new Error("listener failed");
        const later = vi.fn();
        onRenderDynamicLatched(() => {
          throw failure;
        });
        onRenderDynamicLatched(later);
        expect(() => markDynamicUsage()).not.toThrow();
        expect(later).toHaveBeenCalledOnce();
        expect(consoleError).toHaveBeenCalledWith(failure);
      });
    } finally {
      consoleError.mockRestore();
    }
  });

  it("stops notifying an unsubscribed waiter", async () => {
    await runWithHeadersContext(headersContext(), async () => {
      const listener = vi.fn();
      const unsubscribe = onRenderDynamicLatched(listener);
      unsubscribe();
      markDynamicUsage();
      expect(listener).not.toHaveBeenCalled();
    });
  });

  it("ignores dynamic APIs under force-static", async () => {
    await runWithHeadersContext(headersContext({ forceStatic: true }), async () => {
      markDynamicUsage();
      expect(isRenderDynamicLatched()).toBe(false);
    });
  });

  it("starts unset for each request", async () => {
    await runWithHeadersContext(headersContext(), async () => {
      markDynamicUsage();
    });
    await runWithHeadersContext(headersContext(), async () => {
      expect(isRenderDynamicLatched()).toBe(false);
    });
  });

  it("sees dynamic usage inside a non-unified isolated scope", async () => {
    await runWithHeadersContext(headersContext(), async () => {
      const { dynamicDetected } = await runWithIsolatedDynamicUsage(() => markDynamicUsage());
      expect(dynamicDetected).toBe(true);
      expect(consumeDynamicUsage()).toBe(false);
      expect(isRenderDynamicLatched()).toBe(true);
    });
  });

  it("sees dynamic usage inside a unified state mutation and an isolated scope", async () => {
    await runWithRequestContext(createRequestContext(), async () => {
      await runWithHeadersContext(headersContext(), async () => {
        await runWithUnifiedStateMutation(
          (ctx) => {
            ctx.dynamicUsageDetected = false;
          },
          () => markDynamicUsage(),
        );
        expect(isRenderDynamicLatched()).toBe(true);
      });
      await runWithHeadersContext(headersContext(), async () => {
        await runWithIsolatedDynamicUsage(() => markDynamicUsage());
        expect(consumeDynamicUsage()).toBe(false);
        expect(isRenderDynamicLatched()).toBe(true);
      });
    });
  });

  it("sees dynamic usage inside the layout probe", async () => {
    await runWithRequestContext(createRequestContext(), async () => {
      await runWithHeadersContext(headersContext(), async () => {
        const tracker = createAppLayoutParamAccessTracker();
        await tracker.runLayoutProbe("layout:/", async () => {
          markDynamicUsage();
        });
        expect(consumeDynamicUsage()).toBe(false);
        expect(isRenderDynamicLatched()).toBe(true);
      });
    });
  });

  describe("with a fallback state persisted before the latch existed", () => {
    const fallbackKey = Symbol.for("vinext.nextHeadersShim.fallback");
    const globalState = globalThis as unknown as Record<PropertyKey, unknown>;
    const originalFallback = globalState[fallbackKey];

    afterEach(() => {
      globalState[fallbackKey] = originalFallback;
      vi.resetModules();
    });

    async function reloadWithPreLatchFallback(dynamicUsageDetected = false) {
      // The shape the fallback had before the latch was added, as left on
      // globalThis by the module instance an HMR update replaced.
      globalState[fallbackKey] = {
        headersContext: null,
        dynamicUsageDetected,
        renderRequestApiUsage: new Set(),
        connectionProbe: null,
        invalidDynamicUsageError: null,
        pendingSetCookies: [],
        draftModeCookieHeader: null,
        phase: "render",
      };
      vi.resetModules();
      return await import("../packages/vinext/src/shims/headers.js");
    }

    it("creates the latch on first access after the shim reloads", async () => {
      const reloaded = await reloadWithPreLatchFallback();

      expect(reloaded.isRenderDynamicLatched()).toBe(false);
      const listener = vi.fn();
      reloaded.onRenderDynamicLatched(listener);
      reloaded.markDynamicUsage();
      expect(listener).toHaveBeenCalledOnce();
      expect(reloaded.isRenderDynamicLatched()).toBe(true);
    });

    it("starts the latch set when dynamic usage was already recorded", async () => {
      const reloaded = await reloadWithPreLatchFallback(true);

      expect(reloaded.isRenderDynamicLatched()).toBe(true);
    });

    it("shares the latch it creates with an isolated child scope", async () => {
      const reloaded = await reloadWithPreLatchFallback();

      await reloaded.runWithIsolatedDynamicUsage(() => reloaded.markDynamicUsage());
      expect(reloaded.isRenderDynamicLatched()).toBe(true);
    });

    it("shares the latch it creates with a connection probe", async () => {
      const reloaded = await reloadWithPreLatchFallback();

      await reloaded.runWithConnectionProbe(() => reloaded.markDynamicUsage());
      expect(reloaded.isRenderDynamicLatched()).toBe(true);
    });
  });

  describe("createRequestContext", () => {
    it("starts the default latch set when pre-populated with dynamic usage", async () => {
      const ctx = createRequestContext({
        headersContext: headersContext(),
        dynamicUsageDetected: true,
      });

      expect(ctx.renderDynamicLatch.dynamic).toBe(true);
      await runWithRequestContext(ctx, async () => {
        await runWithIsolatedDynamicUsage(() => {
          expect(isRenderDynamicLatched()).toBe(true);
        });
        expect(isRenderDynamicLatched()).toBe(true);
      });
    });

    it("keeps an explicitly passed latch", () => {
      const renderDynamicLatch = { dynamic: false, listeners: new Set<() => void>() };
      const ctx = createRequestContext({
        headersContext: headersContext(),
        dynamicUsageDetected: true,
        renderDynamicLatch,
      });

      expect(ctx.renderDynamicLatch).toBe(renderDynamicLatch);
    });
  });

  describe("with a unified request context created before the latch existed", () => {
    // A request that was in flight when an HMR update replaced the module
    // keeps the context the old instance created, which has no latch.
    function preLatchRequestContext(dynamicUsageDetected = false) {
      const ctx: Partial<ReturnType<typeof createRequestContext>> = createRequestContext({
        headersContext: headersContext(),
        dynamicUsageDetected,
      });
      delete ctx.renderDynamicLatch;
      return ctx as ReturnType<typeof createRequestContext>;
    }

    it("shares the latch with an isolated child scope", async () => {
      await runWithRequestContext(preLatchRequestContext(), async () => {
        await runWithIsolatedDynamicUsage(() => markDynamicUsage());
        expect(isRenderDynamicLatched()).toBe(true);
      });
    });

    it("shares the latch with a connection probe", async () => {
      await runWithRequestContext(preLatchRequestContext(), async () => {
        await runWithConnectionProbe(() => markDynamicUsage());
        expect(isRenderDynamicLatched()).toBe(true);
      });
    });

    it("latches the parent of a connection probe that was already in flight", async () => {
      const parent = preLatchRequestContext();
      const listener = vi.fn();
      await runWithRequestContext(parent, async () => {
        onRenderDynamicLatched(listener);
      });
      // The probe scope the old instance cloned from the parent before the
      // parent had a latch, so the two never came to share one.
      const probe: NonNullable<typeof parent.connectionProbe> = {
        active: true,
        dynamicUsageTarget: parent,
        interrupted: false,
        interrupt() {},
        pending: new Promise<never>(() => {}),
      };
      const child: Partial<typeof parent> = { ...parent, connectionProbe: probe };
      delete child.renderDynamicLatch;

      await runWithRequestContext(child as typeof parent, async () => {
        markDynamicUsage();
      });
      expect(parent.dynamicUsageDetected).toBe(true);
      expect(listener).toHaveBeenCalledOnce();
      await runWithRequestContext(parent, async () => {
        expect(isRenderDynamicLatched()).toBe(true);
      });
    });

    it("starts the latch set when dynamic usage was already recorded", async () => {
      await runWithRequestContext(preLatchRequestContext(true), async () => {
        await runWithUnifiedStateMutation(
          (ctx) => {
            ctx.dynamicUsageDetected = false;
          },
          () => {
            expect(isRenderDynamicLatched()).toBe(true);
          },
        );
        expect(isRenderDynamicLatched()).toBe(true);
      });
    });

    it("shares the latch with any nested unified scope", async () => {
      await runWithRequestContext(preLatchRequestContext(), async () => {
        await runWithUnifiedStateMutation(
          () => {},
          () => markDynamicUsage(),
        );
        expect(isRenderDynamicLatched()).toBe(true);
      });
    });
  });

  describe("detached dynamic usage", () => {
    it("reports a probe's dynamic usage without marking the request", async () => {
      await runWithRequestContext(createRequestContext(), async () => {
        const outcome = await runWithDetachedDynamicUsage(() => markDynamicUsage());
        expect(outcome.dynamicDetected).toBe(true);
        expect(consumeDynamicUsage()).toBe(false);
        expect(isRenderDynamicLatched()).toBe(false);
      });
    });

    it("keeps a probe's fetch observations and cacheLife out of the request", async () => {
      await runWithRequestContext(createRequestContext(), async () => {
        await runWithDetachedDynamicUsage(() => {
          const probeContext = getRequestContext();
          probeContext.cacheableFetchUrls.add("https://api.example.test/cached");
          probeContext.currentRequestTags.push("probe-tag");
          probeContext.dynamicFetchUrls.add("https://api.example.test/dynamic");
          probeContext.requestScopedCacheLife = { revalidate: 1 };
        });

        const context = getRequestContext();
        expect([...context.cacheableFetchUrls]).toEqual([]);
        expect(context.currentRequestTags).toEqual([]);
        expect([...context.dynamicFetchUrls]).toEqual([]);
        expect(context.requestScopedCacheLife).toBeNull();
      });
    });

    it("returns the probe's cacheLife from scopes that reset the request slot", async () => {
      await runWithRequestContext(createRequestContext(), async () => {
        const outcome = await runWithDetachedDynamicUsage(async () => {
          await runWithUnifiedStateMutation(
            (context) => {
              context.requestScopedCacheLife = null;
            },
            () => cacheLife({ stale: 45, revalidate: 60, expire: 300 }),
          );
          // A background regeneration's claims stay out of the probe's.
          await runWithDetachedCacheObservations(async () => {
            cacheLife({ stale: 10, revalidate: 60, expire: 300 });
          });
        });

        expect(outcome.cacheLife?.stale).toBe(45);
        expect(getRequestContext().requestScopedCacheLife).toBeNull();
      });
    });

    describe("an unstable_cache background refresh", () => {
      // Serves every unstable_cache entry stale, so each call schedules a refresh.
      class StaleUnstableCacheHandler extends MemoryCacheHandler {
        override async get(key: string, ctx?: Record<string, unknown>) {
          if (!key.startsWith("unstable_cache:")) return super.get(key, ctx);
          return {
            cacheState: "stale" as const,
            lastModified: Date.now() - 2_000,
            value: {
              kind: "FETCH" as const,
              data: { body: JSON.stringify({ v: "stale" }), headers: {}, url: key },
              revalidate: 1,
              tags: [],
            },
          };
        }
      }

      const runScenario = async (scenario: (refreshes: Promise<unknown>[]) => Promise<void>) => {
        setCacheHandler(new StaleUnstableCacheHandler());
        try {
          const refreshes: Promise<unknown>[] = [];
          const context = createRequestContext({
            executionContext: { waitUntil: (promise) => refreshes.push(promise) },
            unstableCacheRevalidation: "background",
          });
          await runWithRequestContext(context, () => scenario(refreshes));
        } finally {
          setCacheHandler(new MemoryCacheHandler());
        }
      };

      // A refresh that reads a public cached function with a shorter stale time.
      const createStaleRead = (key: string) => {
        const readShortLived = registerCachedFunction(async () => {
          cacheLife({ stale: 10, revalidate: 60, expire: 300 });
          return "short";
        }, `test:${key}:short-lived`);
        return unstable_cache(
          async () => {
            // What a tagged fetch inside the refresh records.
            addCollectedRequestTags([`${key}:fetch-tag`]);
            return readShortLived();
          },
          [key],
          { revalidate: 1 },
        );
      };

      it("keeps its cacheLife out of the request", async () => {
        const getValue = createStaleRead("refresh-request");
        await runScenario(async (refreshes) => {
          expect(await getValue()).toBe("stale");
          await Promise.all(refreshes);

          expect(refreshes).toHaveLength(1);
          expect(getRequestContext().requestScopedCacheLife).toBeNull();
          expect(getCollectedFetchTags()).toEqual([]);
        });
      });

      it("keeps its cacheLife out of a probe and an enclosing cache", async () => {
        const getValue = createStaleRead("refresh-probe");
        await runScenario(async (refreshes) => {
          const readOuter = registerCachedFunction(async () => {
            cacheLife({ stale: 45, revalidate: 60, expire: 300 });
            const value = await getValue();
            // Let the refresh finish while the enclosing cache is still open.
            await Promise.all(refreshes);
            return value;
          }, "test:refresh-probe:outer");

          const outcome = await runWithDetachedDynamicUsage(() => readOuter());

          expect(outcome.result).toBe("stale");
          expect(refreshes).toHaveLength(1);
          expect(outcome.cacheLife?.stale).toBe(45);
        });
      });
    });

    it("lets the render rerun a cacheForRequest factory the probe called", async () => {
      await runWithRequestContext(createRequestContext(), async () => {
        const factory = vi.fn(() => {
          markDynamicUsage();
          return "session";
        });
        const getSession = cacheForRequest(factory);

        await runWithDetachedDynamicUsage(() => getSession());
        expect(getSession()).toBe("session");

        expect(factory).toHaveBeenCalledTimes(2);
        expect(consumeDynamicUsage()).toBe(true);
      });
    });
  });
});
