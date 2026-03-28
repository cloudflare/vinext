import { describe, it, expect, vi } from "vite-plus/test";
import {
  runWithRequestContext,
  runWithUnifiedStateMutation,
  createRequestContext,
} from "../packages/vinext/src/shims/unified-request-context";
import { cacheForRequest } from "../packages/vinext/src/shims/cache-for-request";

describe("cacheForRequest", () => {
  it("does not cache outside request scope", () => {
    const factory = vi.fn(() => ({ id: Math.random() }));
    const get = cacheForRequest(factory);

    const a = get();
    const b = get();

    expect(a).not.toBe(b);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("caches within the same request", () => {
    const factory = vi.fn(() => ({ id: Math.random() }));
    const get = cacheForRequest(factory);

    const ctx = createRequestContext();
    void runWithRequestContext(ctx, () => {
      const a = get();
      const b = get();
      expect(a).toBe(b);
      expect(factory).toHaveBeenCalledTimes(1);
    });
  });

  it("caches different factories separately", () => {
    const factoryA = vi.fn(() => "a");
    const factoryB = vi.fn(() => "b");
    const getA = cacheForRequest(factoryA);
    const getB = cacheForRequest(factoryB);

    const ctx = createRequestContext();
    void runWithRequestContext(ctx, () => {
      expect(getA()).toBe("a");
      expect(getB()).toBe("b");
      expect(factoryA).toHaveBeenCalledTimes(1);
      expect(factoryB).toHaveBeenCalledTimes(1);
    });
  });

  it("isolates between different requests", () => {
    let counter = 0;
    const factory = vi.fn(() => ++counter);
    const get = cacheForRequest(factory);

    const ctx1 = createRequestContext();
    const val1 = runWithRequestContext(ctx1, () => get());

    const ctx2 = createRequestContext();
    const val2 = runWithRequestContext(ctx2, () => get());

    expect(val1).toBe(1);
    expect(val2).toBe(2);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("shares cache across nested unified scopes", async () => {
    const factory = vi.fn(() => "cached");
    const get = cacheForRequest(factory);

    const ctx = createRequestContext();
    await runWithRequestContext(ctx, async () => {
      const outer = get();
      // Exercise the real nested scope path via runWithUnifiedStateMutation
      const inner = await runWithUnifiedStateMutation(
        (child) => {
          child.dynamicUsageDetected = true;
        },
        () => get(),
      );
      expect(outer).toBe("cached");
      expect(inner).toBe("cached");
      expect(factory).toHaveBeenCalledTimes(1);
    });
  });

  it("caches async Promise and clears on rejection", async () => {
    let callCount = 0;
    const factory = vi.fn(async () => {
      callCount++;
      if (callCount === 1) throw new Error("fail");
      return "success";
    });
    const get = cacheForRequest(factory);

    const ctx = createRequestContext();
    await runWithRequestContext(ctx, async () => {
      // First call: rejects
      await expect(get()).rejects.toThrow("fail");

      // Wait a tick for the .catch() to clear the cache
      await new Promise((r) => setTimeout(r, 0));

      // Second call: should retry (cache was cleared)
      const result = await get();
      expect(result).toBe("success");
      expect(factory).toHaveBeenCalledTimes(2);
    });
  });
});
