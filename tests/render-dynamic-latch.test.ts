import { describe, expect, it, vi } from "vite-plus/test";
import { createAppLayoutParamAccessTracker } from "../packages/vinext/src/server/app-layout-param-observation.js";
import {
  consumeDynamicUsage,
  headersContextFromRequest,
  isRenderDynamicLatched,
  markDynamicUsage,
  onRenderDynamicLatched,
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
});
