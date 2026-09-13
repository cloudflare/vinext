import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const flightState = vi.hoisted(() => ({
  mode: "root" as "root" | "nested" | "success",
}));

vi.mock("@vitejs/plugin-rsc/react/rsc", () => {
  const serializationError = new Error("Flight serialization failed");

  return {
    renderToReadableStream(
      _value: unknown,
      options?: { onError?: (error: unknown) => string | undefined },
    ) {
      if (flightState.mode !== "success") options?.onError?.(serializationError);
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('0:E{"digest":""}\n'));
          controller.close();
        },
      });
    },
    async createFromReadableStream() {
      if (flightState.mode === "root") throw serializationError;
      if (flightState.mode === "success") return { value: "decoded" };
      const nested = Promise.reject(serializationError);
      void nested.catch(() => undefined);
      return { nested };
    },
    async encodeReply() {
      return "[]";
    },
    createTemporaryReferenceSet() {
      return new Set();
    },
    createClientTemporaryReferenceSet() {
      return new Set();
    },
    async decodeReply() {
      return [];
    },
  };
});

describe('callable "use cache" Flight serialization', () => {
  let restoreCacheHandler: (() => void) | undefined;

  beforeEach(async () => {
    const { getCacheHandler, setCacheHandler } =
      await import("../packages/vinext/src/shims/cache.js");
    const original = getCacheHandler();
    restoreCacheHandler = () => setCacheHandler(original);
    flightState.mode = "root";
  });

  afterEach(() => {
    restoreCacheHandler?.();
    restoreCacheHandler = undefined;
  });

  async function installRecordingCacheHandler() {
    const { setCacheHandler } = await import("../packages/vinext/src/shims/cache.js");
    const set = vi.fn(async () => undefined);
    setCacheHandler({
      async get() {
        return null;
      },
      set,
      async revalidateTag() {},
    });
    return set;
  }

  it("rejects a root-model serialization error without writing the Flight error row", async () => {
    const set = await installRecordingCacheHandler();
    const { registerCachedFunction } =
      await import("../packages/vinext/src/shims/cache-runtime.js");
    const cached = registerCachedFunction(
      async () => new Response("unsupported"),
      "test:root-serialization-error",
    );

    await expect(cached()).rejects.toThrow("Flight serialization failed");
    expect(set).not.toHaveBeenCalled();
  });

  it("returns the decoded Flight value and writes a successful cache entry", async () => {
    flightState.mode = "success";
    const set = await installRecordingCacheHandler();
    const { registerCachedFunction } =
      await import("../packages/vinext/src/shims/cache-runtime.js");
    const cached = registerCachedFunction(
      async () => ({ value: "original" }),
      "test:successful-serialization",
    );

    await expect(cached()).resolves.toEqual({ value: "decoded" });
    expect(set).toHaveBeenCalledOnce();
  });

  it("returns a decoded root with a nested rejection but does not cache the errored stream", async () => {
    flightState.mode = "nested";
    const set = await installRecordingCacheHandler();
    const { registerCachedFunction } =
      await import("../packages/vinext/src/shims/cache-runtime.js");
    const cached = registerCachedFunction(
      async () => ({ nested: Promise.resolve("unused") }),
      "test:nested-serialization-error",
    );

    const result = await cached();
    await expect(result.nested).rejects.toThrow("Flight serialization failed");
    expect(set).not.toHaveBeenCalled();
  });
});
