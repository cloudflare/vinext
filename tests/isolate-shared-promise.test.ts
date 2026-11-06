import { describe, expect, it, vi } from "vite-plus/test";
import { shareIsolatePromise } from "../packages/vinext/src/server/isolate-shared-promise.js";
import { runWithExecutionContext } from "../packages/vinext/src/shims/request-context.js";

describe("shareIsolatePromise", () => {
  it("registers the promise with the given context and returns it unchanged", async () => {
    const ctx = { waitUntil: vi.fn() };
    const shared = Promise.resolve("value");

    expect(shareIsolatePromise(shared, ctx)).toBe(shared);
    expect(ctx.waitUntil).toHaveBeenCalledOnce();
    await expect(ctx.waitUntil.mock.calls[0]![0]).resolves.toBeUndefined();
  });

  it("prefers the given context over the request in scope", () => {
    const ctx = { waitUntil: vi.fn() };
    const request = { waitUntil: vi.fn() };

    void runWithExecutionContext(request, () => shareIsolatePromise(Promise.resolve(), ctx));

    expect(ctx.waitUntil).toHaveBeenCalledOnce();
    expect(request.waitUntil).not.toHaveBeenCalled();
  });

  it("falls back to the request context when the given one has no waitUntil", () => {
    const request = { waitUntil: vi.fn() };

    void runWithExecutionContext(request, () => shareIsolatePromise(Promise.resolve(), {}));
    void runWithExecutionContext(request, () => shareIsolatePromise(Promise.resolve(), null));

    expect(request.waitUntil).toHaveBeenCalledTimes(2);
  });

  it("registers nothing outside a request", async () => {
    const shared = Promise.resolve("value");

    expect(shareIsolatePromise(shared)).toBe(shared);
    await expect(shared).resolves.toBe("value");
  });

  // The request's copy must not surface the shared promise's rejection again;
  // the callers that await it handle that.
  it("keeps a rejection out of the request's lifetime", async () => {
    const ctx = { waitUntil: vi.fn() };
    const shared = Promise.reject(new Error("failed"));

    await expect(shareIsolatePromise(shared, ctx)).rejects.toThrow("failed");
    await expect(ctx.waitUntil.mock.calls[0]![0]).resolves.toBeUndefined();
  });

  // Shims that are also bundled for the browser, such as next/dynamic, reach
  // the helper through this global on the server.
  it("publishes itself for shims that cannot import request state", () => {
    expect((globalThis as Record<symbol, unknown>)[Symbol.for("vinext.shareIsolatePromise")]).toBe(
      shareIsolatePromise,
    );
  });
});
