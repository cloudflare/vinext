import { describe, expect, it, vi } from "vite-plus/test";
import { keepInitializationAlive } from "../packages/vinext/src/server/instrumentation-keepalive.js";
import { runWithExecutionContext } from "../packages/vinext/src/shims/request-context.js";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
}

describe("keepInitializationAlive", () => {
  it("hands the initialization promise to the request's waitUntil", () => {
    const waitUntil = vi.fn();
    const initialization = deferred();

    keepInitializationAlive(initialization.promise, { waitUntil });

    expect(waitUntil).toHaveBeenCalledOnce();
    expect(waitUntil.mock.calls[0]![0]).toBeInstanceOf(Promise);
  });

  it("keeps waitUntil pending until the initialization promise settles", async () => {
    const waitUntil = vi.fn();
    const initialization = deferred();
    keepInitializationAlive(initialization.promise, { waitUntil });
    const kept = waitUntil.mock.calls[0]![0] as Promise<unknown>;

    let settled = false;
    void kept.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    initialization.resolve();
    await kept;
    expect(settled).toBe(true);
  });

  it("does not report a rejected initialization as an unhandled rejection", async () => {
    const waitUntil = vi.fn();
    const initialization = deferred();
    keepInitializationAlive(initialization.promise, { waitUntil });

    initialization.reject(new Error("register failed"));

    // The waiting request still observes the rejection...
    await expect(initialization.promise).rejects.toThrow("register failed");
    // ...while waitUntil's own promise settles cleanly.
    await expect(waitUntil.mock.calls[0]![0]).resolves.toBeUndefined();
  });

  it("falls back to the current request execution context", () => {
    const waitUntil = vi.fn();
    const initialization = deferred();

    void runWithExecutionContext({ waitUntil }, () => {
      keepInitializationAlive(initialization.promise);
    });

    expect(waitUntil).toHaveBeenCalledOnce();
  });

  it("prefers an explicit context over the ambient request context", () => {
    const ambientWaitUntil = vi.fn();
    const explicitWaitUntil = vi.fn();
    const initialization = deferred();

    void runWithExecutionContext({ waitUntil: ambientWaitUntil }, () => {
      keepInitializationAlive(initialization.promise, { waitUntil: explicitWaitUntil });
    });

    expect(explicitWaitUntil).toHaveBeenCalledOnce();
    expect(ambientWaitUntil).not.toHaveBeenCalled();
  });

  it("no-ops for non-promises, missing contexts, and missing waitUntil", () => {
    const waitUntil = vi.fn();

    expect(() => keepInitializationAlive(undefined, { waitUntil })).not.toThrow();
    expect(() => keepInitializationAlive(null, { waitUntil })).not.toThrow();
    expect(() => keepInitializationAlive("not a promise", { waitUntil })).not.toThrow();
    expect(() => keepInitializationAlive(Promise.resolve(), undefined)).not.toThrow();
    expect(() => keepInitializationAlive(Promise.resolve(), {})).not.toThrow();

    expect(waitUntil).not.toHaveBeenCalled();
  });
});
