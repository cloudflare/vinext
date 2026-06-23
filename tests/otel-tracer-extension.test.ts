/**
 * Tests for extendTracerProviderForCacheComponents (otel-tracer-extension.ts).
 *
 * Mirrors Next.js's OTel tracer instrumentation:
 *  - packages/next/src/server/lib/router-utils/instrumentation-node-extensions.ts
 *
 * Tests are isolated from the full vinext plugin import graph so they run
 * without requiring optional build-time packages (image-size, magic-string, …).
 * Modules are reset via vi.resetModules() before each test so the module-level
 * WeakSet starts fresh.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

describe("extendTracerProviderForCacheComponents", () => {
  let extendTracerProviderForCacheComponents: typeof import("../packages/vinext/src/server/otel-tracer-extension.js").extendTracerProviderForCacheComponents;
  let workUnitAsyncStorage: typeof import("../packages/vinext/src/shims/internal/work-unit-async-storage.js").workUnitAsyncStorage;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import("../packages/vinext/src/server/otel-tracer-extension.js");
    extendTracerProviderForCacheComponents = mod.extendTracerProviderForCacheComponents;
    const wuMod = await import("../packages/vinext/src/shims/internal/work-unit-async-storage.js");
    workUnitAsyncStorage = wuMod.workUnitAsyncStorage;
  });

  afterEach(() => {
    // Restore any globalThis.require mock
    delete (globalThis as Record<string, unknown>).require;
  });

  function makeProvider() {
    // Cache tracers by name so repeated getTracer("test") calls return the
    // same object — this lets the wrappedTracers WeakSet do its job correctly.
    const tracerCache = new Map<string, ReturnType<typeof makeTracer>>();
    function makeTracer() {
      return {
        startSpan: vi.fn((_spanName: string) => ({ end: vi.fn() })),
        startActiveSpan: vi.fn(
          (_spanName: string, _optionsOrFn: unknown, fnOrUndefined?: unknown) => {
            const fn = typeof _optionsOrFn === "function" ? _optionsOrFn : fnOrUndefined;
            if (typeof fn === "function") return fn({ end: vi.fn() });
          },
        ),
      };
    }
    const provider = {
      getTracer: vi.fn((name: string) => {
        let tracer = tracerCache.get(name);
        if (!tracer) {
          tracer = makeTracer();
          tracerCache.set(name, tracer);
        }
        return tracer;
      }),
    };
    return { provider };
  }

  it("no-ops when globalThis.require is absent (ESM Worker environment)", () => {
    delete (globalThis as Record<string, unknown>).require;
    expect(() => extendTracerProviderForCacheComponents()).not.toThrow();
  });

  it("no-ops when @opentelemetry/api throws on require", () => {
    (globalThis as Record<string, unknown>).require = (_id: string) => {
      throw new Error("MODULE_NOT_FOUND");
    };
    expect(() => extendTracerProviderForCacheComponents()).not.toThrow();
  });

  it("startSpan: original is called once after wrapping", async () => {
    let callCount = 0;
    const provider = {
      getTracer: vi.fn((_name: string) => ({
        startSpan: vi.fn((..._args: unknown[]) => {
          callCount++;
          return { end: vi.fn() };
        }),
        startActiveSpan: vi.fn(),
      })),
    };

    (globalThis as Record<string, unknown>).require = (_id: string) => ({
      trace: { getTracerProvider: () => provider },
    });

    extendTracerProviderForCacheComponents();
    // The extension wraps getTracer, so call it after extending to get a wrapped tracer.
    const tracer = provider.getTracer("test");
    const store = { type: "prerender" as const, renderSignal: new AbortController().signal };

    await workUnitAsyncStorage.run(store, async () => {
      (tracer as { startSpan: (...a: unknown[]) => unknown }).startSpan("my-span");
    });

    // The original startSpan must have been called exactly once through the wrapper.
    expect(callCount).toBe(1);
  });

  it("startSpan: workUnitAsyncStorage has no active store inside the original call", async () => {
    let storeSeenInsideSpan: unknown = "not-yet";
    const { provider } = makeProvider();

    (globalThis as Record<string, unknown>).require = (_id: string) => ({
      trace: { getTracerProvider: () => provider },
    });

    // Capture the store seen by the original startSpan before extending
    const origGetTracer = provider.getTracer;
    provider.getTracer = vi.fn((...args: Parameters<typeof origGetTracer>) => {
      const tracer = origGetTracer(...args);
      const origStartSpan = tracer.startSpan;
      tracer.startSpan = vi.fn((...spanArgs: Parameters<typeof origStartSpan>) => {
        storeSeenInsideSpan = workUnitAsyncStorage.getStore();
        return origStartSpan(...spanArgs);
      });
      return tracer;
    });

    extendTracerProviderForCacheComponents();

    const tracer = provider.getTracer("test");
    const store = { type: "prerender" as const, renderSignal: new AbortController().signal };

    await workUnitAsyncStorage.run(store, async () => {
      (tracer as { startSpan: (...a: unknown[]) => unknown }).startSpan("my-span");
    });

    // The wrapper exits ALS before calling the original, so the original sees no store.
    expect(storeSeenInsideSpan).toBeUndefined();
  });

  it("startActiveSpan: re-enters workUnitAsyncStorage inside the callback", async () => {
    let storeInsideCallback: unknown = "not-yet";
    const { provider } = makeProvider();

    (globalThis as Record<string, unknown>).require = (_id: string) => ({
      trace: { getTracerProvider: () => provider },
    });

    extendTracerProviderForCacheComponents();
    const tracer = provider.getTracer("test");
    const store = { type: "request" as const };

    await workUnitAsyncStorage.run(store, async () => {
      (
        tracer as {
          startActiveSpan: (name: string, fn: (span: { end: () => void }) => void) => void;
        }
      ).startActiveSpan("my-span", (span: { end: () => void }) => {
        storeInsideCallback = workUnitAsyncStorage.getStore();
        span.end();
      });
    });

    // The callback should run with the original store re-entered.
    expect(storeInsideCallback).toBe(store);
  });

  it("startActiveSpan: forwards unchanged when no workUnitStore is active", () => {
    const { provider } = makeProvider();
    (globalThis as Record<string, unknown>).require = (_id: string) => ({
      trace: { getTracerProvider: () => provider },
    });

    extendTracerProviderForCacheComponents();
    const tracer = provider.getTracer("test");

    expect(() => {
      (
        tracer as {
          startActiveSpan: (name: string, fn: (span: { end: () => void }) => void) => void;
        }
      ).startActiveSpan("my-span", (span) => span.end());
    }).not.toThrow();
  });

  it("emits console.error when a 'use cache' function is passed to startActiveSpan", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { provider } = makeProvider();
    (globalThis as Record<string, unknown>).require = (_id: string) => ({
      trace: { getTracerProvider: () => provider },
    });

    extendTracerProviderForCacheComponents();
    const tracer = provider.getTracer("test");
    const store = { type: "request" as const };

    // Tag the function with the vinext "use cache" symbol to simulate a "use cache" wrapper.
    const USE_CACHE_SYMBOL = Symbol.for("vinext.useCacheFunction");
    const useCacheFn = Object.assign(async (_span: unknown) => {}, {
      [USE_CACHE_SYMBOL]: true,
    });

    await workUnitAsyncStorage.run(store, async () => {
      await (
        tracer as {
          startActiveSpan: (name: string, fn: (span: unknown) => Promise<void>) => Promise<void>;
        }
      ).startActiveSpan("my-span", useCacheFn);
    });

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("use cache"));
    consoleSpy.mockRestore();
  });

  it("does NOT warn for a regular (non-cached) function passed to startActiveSpan", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { provider } = makeProvider();
    (globalThis as Record<string, unknown>).require = (_id: string) => ({
      trace: { getTracerProvider: () => provider },
    });

    extendTracerProviderForCacheComponents();
    const tracer = provider.getTracer("test");
    const store = { type: "request" as const };

    await workUnitAsyncStorage.run(store, async () => {
      (
        tracer as {
          startActiveSpan: (name: string, fn: (span: { end: () => void }) => void) => void;
        }
      ).startActiveSpan("my-span", (span) => span.end());
    });

    expect(consoleSpy).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it("does not double-wrap the same provider", () => {
    const { provider } = makeProvider();
    (globalThis as Record<string, unknown>).require = (_id: string) => ({
      trace: { getTracerProvider: () => provider },
    });

    extendTracerProviderForCacheComponents();
    const firstGetTracer = provider.getTracer;

    // Call again — the same provider object should not be re-patched.
    extendTracerProviderForCacheComponents();

    expect(provider.getTracer).toBe(firstGetTracer);
  });

  it("wraps a new provider when the registered provider changes (WeakSet per-provider guard)", () => {
    const { provider: provider1 } = makeProvider();
    const { provider: provider2 } = makeProvider();
    let currentProvider = provider1;

    (globalThis as Record<string, unknown>).require = (_id: string) => ({
      trace: { getTracerProvider: () => currentProvider },
    });

    extendTracerProviderForCacheComponents();
    const wrapped1 = provider1.getTracer;

    // Simulate a provider swap and call again — the new provider should get wrapped.
    currentProvider = provider2;
    extendTracerProviderForCacheComponents();

    expect(provider2.getTracer).not.toBe(provider1.getTracer);
    expect(provider1.getTracer).toBe(wrapped1); // provider1 untouched on second call
  });

  it("does not double-wrap individual tracers returned by getTracer", () => {
    const { provider } = makeProvider();
    (globalThis as Record<string, unknown>).require = (_id: string) => ({
      trace: { getTracerProvider: () => provider },
    });

    extendTracerProviderForCacheComponents();
    const tracer1 = provider.getTracer("test");
    const startSpan1 = (tracer1 as { startSpan: unknown }).startSpan;

    // The mock returns the same tracer object for the same name.
    // The wrappedTracers WeakSet should prevent double-wrapping on second call.
    const tracer2 = provider.getTracer("test");
    expect((tracer2 as { startSpan: unknown }).startSpan).toBe(startSpan1);
  });
});
