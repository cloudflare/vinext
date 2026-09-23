import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IncrementalCacheValue } from "../packages/vinext/src/shims/cache-handler.js";

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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function entryTags(
  data: IncrementalCacheValue | null,
  ctx: Record<string, unknown> | undefined,
): string[] {
  const fromData = data && "tags" in data && Array.isArray(data.tags) ? data.tags : [];
  const fromCtx = Array.isArray(ctx?.tags) ? (ctx.tags as string[]) : [];
  return [...(fromData as string[]), ...fromCtx];
}

describe('"use cache" nested invocation propagation', () => {
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
  // (the `use-cache-dedup` fixture)
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app-root-params-getters/use-cache.test.ts
  //
  // The fixture's cache handler holds the English inner write until both outer
  // entries reach `set()`. Two outer caches share one inner cache, and the inner
  // must hand its root-param dependency to both outer scopes as soon as it has
  // collected — a render that waited for the handler write instead would either
  // stall or key `outerTwo` without `lang`, letting the French request reuse the
  // English entry. Failing this test without the fix shows up as a timeout,
  // because the render never finishes while the inner write is held.
  it("propagates a nested invocation's root params while its write is pending", async () => {
    const { setCacheHandler, MemoryCacheHandler, cacheTag } =
      await import("../packages/vinext/src/shims/cache.js");
    const { registerCachedFunction } =
      await import("../packages/vinext/src/shims/cache-runtime.js");
    const { getRootParam, runWithRootParamsScope } =
      await import("../packages/vinext/src/shims/root-params.js");
    const { createRequestContext, runWithRequestContext } =
      await import("../packages/vinext/src/shims/unified-request-context.js");
    const knownRootParams = Reflect.get(
      globalThis,
      Symbol.for("vinext.cacheRuntime.knownRootParamsByFunctionId"),
    ) as Map<string, Set<string>>;

    const observedOuters = new Set<string>();
    const writtenKeys: string[] = [];
    const innerWriteHeld = deferred<void>();
    const bothOuterWritesSeen = deferred<void>();

    class DelayingHandler extends MemoryCacheHandler {
      override async set(
        key: string,
        data: IncrementalCacheValue | null,
        ctx?: Record<string, unknown>,
      ): Promise<void> {
        const tags = entryTags(data, ctx);
        writtenKeys.push(key);
        const isRedirect = tags.some((tag) => tag.startsWith("__vinext_use_cache_root_param__:"));
        const outer = tags.find((tag) => tag === "nested-outer-one" || tag === "nested-outer-two");
        if (outer !== undefined && !isRedirect) {
          observedOuters.add(outer);
          if (observedOuters.size === 2) bothOuterWritesSeen.resolve();
        }
        // Hold only the English inner value: a French request calls one outer.
        if (tags.includes("nested-language-en") && outer === undefined && !isRedirect) {
          await innerWriteHeld.promise;
        }
        return super.set(key, data, ctx);
      }
    }
    setCacheHandler(new DelayingHandler());

    let innerCalls = 0;
    const inner = registerCachedFunction(async () => {
      innerCalls++;
      const language = await getRootParam("lang");
      cacheTag("nested-inner", `nested-language-${String(language)}`);
      return language;
    }, "test:nested-propagation-inner");
    const outerOne = registerCachedFunction(async () => {
      cacheTag("nested-outer-one");
      return inner();
    }, "test:nested-propagation-outer-one");
    const outerTwo = registerCachedFunction(async () => {
      cacheTag("nested-outer-two");
      return inner();
    }, "test:nested-propagation-outer-two");

    const render = (lang: string, prime: boolean) => {
      const pendingWrites: Promise<unknown>[] = [];
      return {
        pendingWrites,
        result: runWithRequestContext(
          createRequestContext({
            executionContext: {
              waitUntil(promise: Promise<unknown>) {
                pendingWrites.push(promise);
              },
              passThroughOnException() {},
            },
          }),
          () =>
            runWithRootParamsScope({ lang }, async () => {
              const first = prime ? await outerOne() : null;
              return { first, second: await outerTwo() };
            }),
        ),
      };
    };

    const english = render("en", true);
    await expect(english.result).resolves.toEqual({ first: "en", second: "en" });
    // The second outer inherited the collected value instead of re-running the
    // inner cache while its write was still held.
    expect(innerCalls).toBe(1);

    // Both outer entries reached the handler before the inner write was released:
    // propagation happens at collection, not at persistence.
    await bothOuterWritesSeen.promise;
    expect(observedOuters.size).toBe(2);
    innerWriteHeld.resolve();
    await Promise.all(english.pendingWrites);
    // Each outer cache stored its value under the root params its inner cache
    // read, so a request with other root params cannot read it.
    const outerValueKeys = writtenKeys.filter(
      (key) =>
        (key.includes("outer-one") || key.includes("outer-two")) && key.includes("root-params"),
    );
    expect(outerValueKeys).toHaveLength(2);

    // A later request with different root params must not reuse the English entry.
    knownRootParams.clear();
    const french = render("fr", false);
    await expect(french.result).resolves.toEqual({ first: null, second: "fr" });
    await Promise.all(french.pendingWrites);
  }, 5000);
});
