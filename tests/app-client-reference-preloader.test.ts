import { afterEach, describe, expect, it } from "vitest";
import {
  annotateReactFlightThenable,
  installReactFlightClientReferenceRequire,
  preloadInitialClientReferencesFromRscStream,
} from "../packages/vinext/src/server/app-client-reference-loader.js";
import { createClientReferencePreloader } from "../packages/vinext/src/server/app-client-reference-preloader.js";

type ReactFlightThenable<T> = Promise<T> & {
  reason?: unknown;
  status?: "fulfilled" | "pending" | "rejected";
  value?: T;
};

function createDeferred<T = void>(): {
  promise: Promise<T>;
  reject: (reason: unknown) => void;
  resolve: (value: T) => void;
} {
  let rejectDeferred: (reason: unknown) => void = () => {
    throw new Error("deferred promise was not initialized");
  };
  let resolveDeferred: (value: T) => void = () => {
    throw new Error("deferred promise was not initialized");
  };
  const promise = new Promise<T>((resolve, reject) => {
    rejectDeferred = reject;
    resolveDeferred = resolve;
  });
  return { promise, reject: rejectDeferred, resolve: resolveDeferred };
}

function textStream(chunks: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

async function readStreamText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

describe("app client reference preloader", () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, "__vite_rsc_client_require__");
  });

  it("marks cold client reference promises as React Flight pending thenables", async () => {
    const deferred = createDeferred<{ ok: true }>();
    const tracked = annotateReactFlightThenable(deferred.promise);

    expect(tracked.status).toBe("pending");
    expect(tracked.reason).toBe(tracked);

    deferred.resolve({ ok: true });
    await expect(tracked).resolves.toEqual({ ok: true });
    expect(tracked.status).toBe("fulfilled");
    expect(tracked.value).toEqual({ ok: true });
    expect(tracked.reason).toBeUndefined();
  });

  it("preserves real client reference import failures for React Flight", async () => {
    const deferred = createDeferred<unknown>();
    const error = new Error("load failed");
    const tracked = annotateReactFlightThenable(deferred.promise);

    deferred.reject(error);

    await expect(tracked).rejects.toThrow("load failed");
    expect(tracked.status).toBe("rejected");
    expect(tracked.reason).toBe(error);
  });

  it("wraps the browser client reference require once", async () => {
    const calls: string[] = [];
    const deferred = createDeferred<{ name: string }>();
    globalThis.__vite_rsc_client_require__ = (id) => {
      calls.push(id);
      return deferred.promise;
    };

    installReactFlightClientReferenceRequire();
    installReactFlightClientReferenceRequire();

    const result = globalThis.__vite_rsc_client_require__("comp-a") as ReactFlightThenable<{
      name: string;
    }>;

    expect(calls).toEqual(["comp-a"]);
    expect(result).toBe(deferred.promise);
    expect(result.status).toBe("pending");
    expect(result.reason).toBe(result);

    deferred.resolve({ name: "A" });
    await expect(result).resolves.toEqual({ name: "A" });
    expect(result.status).toBe("fulfilled");
  });

  it("preloads initial RSC client reference rows without consuming the render stream", async () => {
    const calls: string[] = [];
    const first = createDeferred<void>();
    const second = createDeferred<void>();
    const sourceText =
      '0:{"children":"shell"}\n' +
      '2:I["comp-a",[],"default",1]\n' +
      '3:I["comp-b",[],"Widget",1]\n' +
      '4:["not a client reference"]\n';

    const { stream: renderStream, preloaded } = preloadInitialClientReferencesFromRscStream(
      textStream([sourceText]),
      {
        clientRequire(id) {
          calls.push(id);
          return id === "comp-a" ? first.promise : second.promise;
        },
      },
    );

    await expect.poll(() => calls).toEqual(["comp-a", "comp-b"]);

    first.resolve(undefined);
    second.resolve(undefined);

    await preloaded;
    expect(await readStreamText(renderStream)).toBe(sourceText);
  });

  it("returns the render stream and warms imports before the RSC stream tail settles", async () => {
    const calls: string[] = [];
    const aboveFold = createDeferred<void>();
    const belowFold = createDeferred<void>();
    const tail = createDeferred<void>();
    const encoder = new TextEncoder();

    // The above-the-fold row is available immediately; the tail row does not
    // arrive until `tail` resolves — modelling a slow Suspense boundary at the
    // end of a streamed App Router payload. Hydration must not be serialised
    // behind stream completion.
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('1:I["above-fold",[],"default",1]\n'));
        void tail.promise.then(() => {
          controller.enqueue(encoder.encode('2:I["below-fold",[],"default",1]\n'));
          controller.close();
        });
      },
    });

    const { stream, preloaded } = preloadInitialClientReferencesFromRscStream(source, {
      clientRequire(id) {
        calls.push(id);
        return id === "above-fold" ? aboveFold.promise : belowFold.promise;
      },
    });

    // The render branch yields the above-the-fold row without waiting for the
    // delayed tail. (Destructuring a stream synchronously also proves the call
    // no longer awaits full-stream consumption before returning.)
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    const firstChunk = await reader.read();
    expect(decoder.decode(firstChunk.value)).toContain("above-fold");

    // The warm-up has kicked off the above-the-fold import while the tail row is
    // still outstanding.
    await expect.poll(() => calls).toEqual(["above-fold"]);

    tail.resolve(undefined);
    aboveFold.resolve(undefined);
    belowFold.resolve(undefined);
    await expect.poll(() => calls).toEqual(["above-fold", "below-fold"]);

    const restChunk = await reader.read();
    expect(decoder.decode(restChunk.value)).toContain("below-fold");
    reader.releaseLock();
    await preloaded;
  });

  it("continues initial RSC hydration after client reference preload failures", async () => {
    const reported: Array<{ id: string; error: unknown }> = [];
    const error = new Error("load failed");

    const { stream: renderStream, preloaded } = preloadInitialClientReferencesFromRscStream(
      textStream(['1:I["comp-a",[],"default",1]\n']),
      {
        clientRequire() {
          return Promise.reject(error);
        },
        onPreloadError(id, preloadError) {
          reported.push({ id, error: preloadError });
        },
      },
    );

    await preloaded;
    expect(reported).toEqual([{ id: "comp-a", error }]);
    expect(await readStreamText(renderStream)).toBe('1:I["comp-a",[],"default",1]\n');
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

    preloadGate.resolve(undefined);
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

    preloadGate.resolve(undefined);
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
