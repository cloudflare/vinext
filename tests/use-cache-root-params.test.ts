import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@vitejs/plugin-rsc/react/rsc", () => {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  async function materialize(value: unknown): Promise<unknown> {
    if (Array.isArray(value)) return Promise.all(value.map(materialize));
    if (!value || typeof value !== "object") return value;

    const element = value as {
      type?: string | ((props: Record<string, unknown>) => unknown);
      props?: Record<string, unknown>;
    };
    if (typeof element.type === "function") {
      return materialize(await element.type(element.props ?? {}));
    }
    if (typeof element.type === "string") {
      return {
        type: element.type,
        children: await materialize(element.props?.children),
      };
    }
    return value;
  }

  async function readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return decoder.decode(bytes);
  }

  return {
    createClientTemporaryReferenceSet: () => ({}),
    createTemporaryReferenceSet: () => ({}),
    decodeReply: async (body: string) => JSON.parse(body),
    encodeReply: async (value: unknown) => JSON.stringify(value),
    renderToReadableStream: (value: unknown) =>
      new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(encoder.encode(JSON.stringify(await materialize(value))));
          controller.close();
        },
      }),
    createFromReadableStream: async (stream: ReadableStream<Uint8Array>) =>
      JSON.parse(await readStream(stream)),
  };
});

describe('"use cache" root-param entry generation', () => {
  beforeEach(async () => {
    const { setCacheHandler, MemoryCacheHandler } =
      await import("../packages/vinext/src/shims/cache.js");
    setCacheHandler(new MemoryCacheHandler());
    const knownRootParams = Reflect.get(
      globalThis,
      Symbol.for("vinext.cacheRuntime.knownRootParamsByFunctionId"),
    ) as Map<string, Set<string>> | undefined;
    knownRootParams?.clear();
  });

  // Ported from Next.js: test/e2e/app-dir/app-root-params-getters/use-cache.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app-root-params-getters/use-cache.test.ts
  it("tracks root params read by a returned lazy Server Component", async () => {
    const { registerCachedFunction } =
      await import("../packages/vinext/src/shims/cache-runtime.js");
    const { getRootParam, runWithRootParamsScope } =
      await import("../packages/vinext/src/shims/root-params.js");

    async function LazyChild() {
      return createElement("span", null, await getRootParam("lang"));
    }

    let calls = 0;
    const cached = registerCachedFunction(async () => {
      calls++;
      return createElement(LazyChild);
    }, "test:lazy-root-param-child");
    const invoke = (lang: string) => runWithRootParamsScope({ lang }, () => cached());

    await invoke("en");
    await invoke("fr");
    expect(calls).toBe(2);

    await expect(invoke("en")).resolves.toEqual({ type: "span", children: "en" });
    await expect(invoke("fr")).resolves.toEqual({ type: "span", children: "fr" });
    expect(calls).toBe(2);
  });

  it("retains the specific entry when the handler can hold only one entry", async () => {
    const { registerCachedFunction } =
      await import("../packages/vinext/src/shims/cache-runtime.js");
    const { setCacheHandler, MemoryCacheHandler } =
      await import("../packages/vinext/src/shims/cache.js");
    const { getRootParam, runWithRootParamsScope } =
      await import("../packages/vinext/src/shims/root-params.js");
    setCacheHandler(new MemoryCacheHandler({ cacheMaxMemorySize: 300 }));

    let calls = 0;
    const cached = registerCachedFunction(async () => {
      calls++;
      return getRootParam("lang");
    }, "test:bounded-root-param-cache");
    const invoke = () => runWithRootParamsScope({ lang: "en" }, () => cached());

    await expect(invoke()).resolves.toBe("en");
    await expect(invoke()).resolves.toBe("en");
    expect(calls).toBe(1);
  });
});
