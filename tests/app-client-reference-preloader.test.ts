import { describe, expect, it, vi } from "vite-plus/test";
import {
  createClientReferencePreloader,
  resolveRouteClientReferences,
} from "../packages/vinext/src/server/app-client-reference-preloader.js";
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

  it("returns one settled promise for a warm scoped preload", async () => {
    const preloader = createClientReferencePreloader({
      getReferences: () => ({ "comp-a": true, "comp-b": true }),
      getClientRequire: () => async () => {},
    });

    await preloader.preload(["comp-a", "comp-b"]);

    expect(preloader.preload(["comp-a", "comp-b"])).toBe(preloader.preload(["comp-b"]));
  });

  it("marks settled module promises the way React tracks thenables", async () => {
    const error = new Error("load failed");
    const loads: Record<string, Promise<unknown>> = {
      "comp-a": Promise.resolve("module-a"),
      "comp-b": Promise.reject(error),
    };
    const preloader = createClientReferencePreloader({
      getReferences: () => ({ "comp-a": true, "comp-b": true }),
      getClientRequire: () => (id) => loads[id]!,
    });

    await preloader.preload();

    expect(loads["comp-a"]).toMatchObject({ status: "fulfilled", value: "module-a" });
    expect(loads["comp-b"]).toMatchObject({ status: "rejected", reason: error });
  });

  it("starts streamed references in order without waiting for them", async () => {
    let finishStreamed!: () => void;
    const calls: string[] = [];
    const preloader = createClientReferencePreloader({
      getReferences: () => ({ "comp-a": true, "comp-b": true, "comp-c": true }),
      getClientRequire: () => (id) => {
        calls.push(id);
        return id === "comp-b"
          ? new Promise<void>((resolve) => (finishStreamed = resolve))
          : Promise.resolve();
      },
    });

    await preloader.preload(["comp-a", "comp-b", "comp-c"], new Set(["comp-b"]));

    expect(calls).toEqual(["comp-a", "comp-b", "comp-c"]);
    finishStreamed();
  });
});

describe("resolveRouteClientReferences", () => {
  const plan = {
    references: ["link", "nav", "chart", "search"],
    always: [0],
    files: [[1], [2, 1], [3]],
    routes: { "/": [0, 1] },
    routeless: [0, 2],
    async: [2],
    stylesheets: { "/": [2, 1] },
  };

  it("resolves a route's files and the references every render uses", () => {
    expect(resolveRouteClientReferences(plan, "/")).toEqual({
      references: ["link", "nav", "chart"],
      streamed: ["chart"],
      stylesheets: ["nav", "chart"],
    });
  });

  it("resolves the routeless files for a render without a route", () => {
    expect(resolveRouteClientReferences(plan, null)).toEqual({
      references: ["link", "nav", "search"],
      streamed: [],
      stylesheets: [],
    });
  });

  it("preloads everything without a plan, a route, or for an unknown pattern", () => {
    expect(resolveRouteClientReferences(null, "/")).toBeUndefined();
    expect(resolveRouteClientReferences(plan, undefined)).toBeUndefined();
    expect(resolveRouteClientReferences(plan, "/missing")).toBeUndefined();
    expect(resolveRouteClientReferences(plan, "constructor")).toBeUndefined();
  });
});
