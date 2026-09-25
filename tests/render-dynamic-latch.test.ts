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
  runWithIsolatedDynamicUsage,
} from "../packages/vinext/src/shims/headers.js";
import {
  createRequestContext,
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
});
