import { describe, expect, it, vi } from "vite-plus/test";
import { createClientReferencePreloader } from "../packages/vinext/src/server/app-client-reference-preloader.js";
import { runWithExecutionContext } from "../packages/vinext/src/shims/request-context.js";

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolveDeferred: () => void = () => {
    throw new Error("deferred promise was not initialized");
  };
  const promise = new Promise<void>((resolve) => {
    resolveDeferred = () => resolve();
  });
  return { promise, resolve: resolveDeferred };
}

describe("app client reference preloader", () => {
  it("keeps the request that starts a shared preload alive until it settles", async () => {
    const preloadGate = createDeferred();
    const preloader = createClientReferencePreloader({
      getReferences: () => ({ "comp-a": true }),
      getClientRequire: () => () => preloadGate.promise,
    });
    const creator = { waitUntil: vi.fn() };
    const joiner = { waitUntil: vi.fn() };

    const first = runWithExecutionContext(creator, () => preloader.preload());
    const second = runWithExecutionContext(joiner, () => preloader.preload());
    const scoped = runWithExecutionContext(joiner, () => preloader.preload(["comp-a"]));

    // One registration for the per-reference import, one for the full set.
    expect(creator.waitUntil).toHaveBeenCalledTimes(2);
    expect(joiner.waitUntil).not.toHaveBeenCalled();
    preloadGate.resolve();
    await Promise.all([first, second, scoped]);
  });

  it("shares one in-flight preload across concurrent cold SSR calls", async () => {
    const refs = { "comp-a": true, "comp-b": true, "comp-c": true };
    const calls: string[] = [];
    const preloadGate = createDeferred();

    const preloader = createClientReferencePreloader({
      getReferences: () => refs,
      getClientRequire: () => async (id) => {
        calls.push(id);
        await preloadGate.promise;
      },
    });

    const first = preloader.preload();
    const second = preloader.preload();
    const third = preloader.preload();

    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(calls).toEqual(["comp-a", "comp-b", "comp-c"]);

    preloadGate.resolve();
    await Promise.all([first, second, third]);

    await preloader.preload();
    expect(calls).toEqual(["comp-a", "comp-b", "comp-c"]);
  });

  it("does not mark preload complete when references or client require are unavailable", async () => {
    const refs = { "comp-a": true };
    let currentRefs: Record<string, unknown> | undefined;
    let currentRequire: ((id: string) => Promise<unknown>) | undefined;
    const calls: string[] = [];

    const preloader = createClientReferencePreloader({
      getReferences: () => currentRefs,
      getClientRequire: () => currentRequire,
    });

    await preloader.preload();

    currentRefs = refs;
    await preloader.preload();

    currentRequire = async (id) => {
      calls.push(id);
    };
    await preloader.preload();

    expect(calls).toEqual(["comp-a"]);
  });

  it("dedupes overlapping scoped preload requests per reference id", async () => {
    const calls: string[] = [];
    const preloadGate = createDeferred();
    const preloader = createClientReferencePreloader({
      getReferences: () => ({ "comp-a": true, "comp-b": true, "comp-c": true }),
      getClientRequire: () => async (id) => {
        calls.push(id);
        await preloadGate.promise;
      },
    });

    const firstRoute = preloader.preload(["comp-a", "comp-b"]);
    const secondRoute = preloader.preload(["comp-b", "comp-c"]);

    expect(calls).toEqual(["comp-a", "comp-b", "comp-c"]);

    preloadGate.resolve();
    await Promise.all([firstRoute, secondRoute]);

    await preloader.preload(["comp-b"]);
    expect(calls).toEqual(["comp-a", "comp-b", "comp-c"]);
  });

  it("reports individual preload failures and completes the manifest pass", async () => {
    const reported: Array<{ id: string; error: unknown }> = [];
    const calls: string[] = [];
    const preloader = createClientReferencePreloader({
      getReferences: () => ({ "comp-a": true, "comp-b": true }),
      getClientRequire: () => async (id) => {
        calls.push(id);
        if (id === "comp-a") {
          throw new Error("load failed");
        }
      },
      onPreloadError: (id, error) => reported.push({ id, error }),
    });

    await preloader.preload();
    await preloader.preload();

    expect(calls).toEqual(["comp-a", "comp-b"]);
    expect(reported).toHaveLength(1);
    expect(reported[0]?.id).toBe("comp-a");
    expect(reported[0]?.error).toBeInstanceOf(Error);
  });
});
