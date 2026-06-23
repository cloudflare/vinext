import { describe, expect, it, vi } from "vite-plus/test";

// Simulate a browser/client bundle where `node:async_hooks` resolves to a stub
// that does NOT expose a usable `AsyncLocalStorage` constructor (e.g. Vite's
// `__vite-browser-external`). On such a runtime `new AsyncLocalStorage()` would
// throw `TypeError: AsyncLocalStorage is not a constructor` at module-eval time,
// crashing every client-reachable shim that calls `getOrCreateAls` on import.
vi.mock("node:async_hooks", () => ({
  AsyncLocalStorage: undefined,
}));

describe("getOrCreateAls — browser-safe fallback", () => {
  it("does not throw when AsyncLocalStorage is unavailable and returns a no-op store", async () => {
    const { getOrCreateAls } =
      await import("../packages/vinext/src/shims/internal/als-registry.js");

    let als: ReturnType<typeof getOrCreateAls<{ value: number }>> | undefined;
    expect(() => {
      als = getOrCreateAls<{ value: number }>("vinext.test.als.unavailable");
    }).not.toThrow();

    // The fallback mirrors Next.js' FakeAsyncLocalStorage: getStore() === undefined
    // so shims fall back to their non-ALS code path instead of crashing.
    expect(als).toBeDefined();
    expect(als!.getStore()).toBeUndefined();
  });

  it("keeps the global-dedupe behavior: same key returns the same instance", async () => {
    const { getOrCreateAls } =
      await import("../packages/vinext/src/shims/internal/als-registry.js");

    const a = getOrCreateAls("vinext.test.als.dedupe");
    const b = getOrCreateAls("vinext.test.als.dedupe");
    expect(a).toBe(b);
  });
});
