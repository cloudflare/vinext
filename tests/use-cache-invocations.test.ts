import { afterEach, describe, expect, it, vi } from "vitest";

import {
  configureMemoryCacheHandler,
  getDataCacheHandler,
  MemoryCacheHandler,
  setDataCacheHandler,
  type CacheHandlerValue,
  type IncrementalCacheValue,
} from "../packages/vinext/src/shims/cache-handler.js";
import {
  registerCachedFunction,
  type RegisterCachedFunctionOptions,
} from "../packages/vinext/src/shims/cache-runtime.js";
import { cacheTag, revalidateTag } from "../packages/vinext/src/shims/cache.js";
import {
  createRequestContext,
  runWithRequestContext,
} from "../packages/vinext/src/shims/unified-request-context.js";

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function nextTask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

class CountingCacheHandler extends MemoryCacheHandler {
  getCalls = 0;
  setCalls = 0;

  override async get(
    key: string,
    ctx?: Record<string, unknown>,
  ): Promise<CacheHandlerValue | null> {
    this.getCalls++;
    return super.get(key, ctx);
  }

  override async set(
    key: string,
    data: IncrementalCacheValue | null,
    ctx?: Record<string, unknown>,
  ): Promise<void> {
    this.setCalls++;
    return super.set(key, data, ctx);
  }
}

function registerPrivate<TArgs extends unknown[], TResult>(
  fn: (...args: TArgs) => Promise<TResult>,
  id: string,
  options?: RegisterCachedFunctionOptions,
): (...args: TArgs) => Promise<TResult> {
  return registerCachedFunction(fn, id, "private", options);
}

describe("use cache request-scoped invocations", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    setDataCacheHandler(new MemoryCacheHandler());
  });

  describe("pending invocations", () => {
    it("deduplicates concurrent private-cache calls by their serialized key", async () => {
      // Ported from Next.js: test/e2e/app-dir/use-cache/app/(dynamic)/private-dedup/page.tsx
      // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/use-cache/app/(dynamic)/private-dedup/page.tsx
      const started = createDeferred<void>();
      const release = createDeferred<void>();
      let executions = 0;
      const cached = registerPrivate(async ({ id }: { id: number }) => {
        executions++;
        started.resolve();
        await release.promise;
        return `${id}:${executions}`;
      }, "test:private-pending-dedupe");

      await runWithRequestContext(createRequestContext(), async () => {
        const first = cached({ id: 1 });
        await started.promise;
        const second = cached({ id: 1 });

        await nextTask();
        release.resolve();

        const [firstResult, secondResult] = await Promise.all([first, second]);
        expect(secondResult).toBe(firstResult);
      });

      expect(executions).toBe(1);
    });

    it("deduplicates the handler lookup and fill for concurrent public-cache calls", async () => {
      const handler = new CountingCacheHandler();
      setDataCacheHandler(handler);
      const started = createDeferred<void>();
      const release = createDeferred<void>();
      let executions = 0;
      const cached = registerCachedFunction(async ({ id }: { id: number }) => {
        executions++;
        started.resolve();
        await release.promise;
        return `${id}:${executions}`;
      }, "test:public-pending-dedupe");

      await runWithRequestContext(createRequestContext(), async () => {
        const first = cached({ id: 1 });
        await started.promise;
        const second = cached({ id: 1 });

        await nextTask();
        release.resolve();

        const [firstResult, secondResult] = await Promise.all([first, second]);
        expect(secondResult).toBe(firstResult);
      });

      expect(executions).toBe(1);
      expect(handler.getCalls).toBe(1);
      expect(handler.setCalls).toBe(1);
    });

    it("drops a rejected private pending invocation so the next call can retry", async () => {
      const started = createDeferred<void>();
      const release = createDeferred<void>();
      const failure = new Error("private cache fill failed");
      let shouldFail = true;
      let executions = 0;
      const cached = registerPrivate(async ({ id }: { id: number }) => {
        executions++;
        started.resolve();
        await release.promise;
        if (shouldFail) throw failure;
        return `${id}:${executions}`;
      }, "test:private-pending-retry");

      await runWithRequestContext(createRequestContext(), async () => {
        const first = cached({ id: 1 });
        await started.promise;
        const second = cached({ id: 1 });

        await nextTask();
        release.resolve();

        const failed = await Promise.allSettled([first, second]);
        expect(failed).toEqual([
          { status: "rejected", reason: failure },
          { status: "rejected", reason: failure },
        ]);
        expect(executions).toBe(1);

        shouldFail = false;
        await expect(cached({ id: 1 })).resolves.toBe("1:2");
        expect(executions).toBe(2);
      });
    });

    it("does not share private pending invocations across request contexts", async () => {
      let executions = 0;
      const cached = registerPrivate(async ({ id }: { id: number }) => {
        executions++;
        await nextTask();
        return `${id}:${executions}`;
      }, "test:private-pending-request-isolation");

      await Promise.all([
        runWithRequestContext(createRequestContext(), () => cached({ id: 1 })),
        runWithRequestContext(createRequestContext(), () => cached({ id: 1 })),
      ]);

      expect(executions).toBe(2);
    });
  });

  describe("completed invocations", () => {
    it("reuses a completed private-cache invocation for sequential calls", async () => {
      // Ported from Next.js: test/e2e/app-dir/use-cache/app/(dynamic)/private-dedup-sequential/page.tsx
      // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/use-cache/app/(dynamic)/private-dedup-sequential/page.tsx
      let executions = 0;
      const cached = registerPrivate(
        async ({ id }: { id: number }) => `${id}:${++executions}`,
        "test:private-completed-dedupe",
      );

      await runWithRequestContext(createRequestContext(), async () => {
        const first = await cached({ id: 1 });
        await nextTask();
        const second = await cached({ id: 1 });

        expect(second).toBe(first);
      });

      expect(executions).toBe(1);
    });

    it("reuses a completed remote-cache invocation without a second handler lookup", async () => {
      // Ported from Next.js: test/e2e/app-dir/use-cache-custom-handler/use-cache-custom-handler.test.ts
      // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/use-cache-custom-handler/use-cache-custom-handler.test.ts
      const handler = new CountingCacheHandler();
      setDataCacheHandler(handler);
      let executions = 0;
      const cached = registerCachedFunction(
        async ({ id }: { id: number }) => `${id}:${++executions}`,
        "test:remote-completed-dedupe",
        "remote",
      );

      await runWithRequestContext(createRequestContext(), async () => {
        const first = await cached({ id: 1 });
        await nextTask();
        const second = await cached({ id: 1 });

        expect(second).toBe(first);
      });

      expect(executions).toBe(1);
      expect(handler.getCalls).toBe(1);
      expect(handler.setCalls).toBe(1);
    });

    it("uses the built-in memory handler instead of retaining a completed invocation", async () => {
      configureMemoryCacheHandler();
      const handler = getDataCacheHandler();
      const getSpy = vi.spyOn(handler, "get");
      let executions = 0;
      const cached = registerCachedFunction(
        async ({ id }: { id: number }) => `${id}:${++executions}`,
        "test:built-in-completed-skip",
      );

      await runWithRequestContext(createRequestContext(), async () => {
        const first = await cached({ id: 1 });
        await nextTask();
        const second = await cached({ id: 1 });

        expect(second).toBe(first);
      });

      expect(executions).toBe(1);
      expect(getSpy).toHaveBeenCalledTimes(2);
    });

    it("does not reuse a completed remote-cache invocation after tag invalidation", async () => {
      const handler = new CountingCacheHandler();
      setDataCacheHandler(handler);
      let executions = 0;
      const cached = registerCachedFunction(
        async ({ id }: { id: number }) => {
          cacheTag("completed-invocation-tag");
          return `${id}:${++executions}`;
        },
        "test:remote-completed-invalidation",
        "remote",
      );

      await runWithRequestContext(createRequestContext(), async () => {
        await expect(cached({ id: 1 })).resolves.toBe("1:1");

        revalidateTag("completed-invocation-tag");
        await nextTask();

        await expect(cached({ id: 1 })).resolves.toBe("1:2");
      });

      expect(executions).toBe(2);
    });

    it("does not reuse completed private-cache invocations across requests", async () => {
      let executions = 0;
      const cached = registerPrivate(
        async ({ id }: { id: number }) => `${id}:${++executions}`,
        "test:private-completed-request-isolation",
      );

      const first = await runWithRequestContext(createRequestContext(), () => cached({ id: 1 }));
      const second = await runWithRequestContext(createRequestContext(), () => cached({ id: 1 }));

      expect(first).toBe("1:1");
      expect(second).toBe("1:2");
      expect(executions).toBe(2);
    });
  });
});
