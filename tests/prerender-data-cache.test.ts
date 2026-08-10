import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  MemoryCacheHandler,
  getCacheHandler,
  setCacheHandler,
  type CacheHandler,
  type CachedFetchValue,
} from "../packages/vinext/src/shims/cache-handler.js";
import { registerCachedFunction } from "../packages/vinext/src/shims/cache-runtime.js";
import { consumeDynamicUsage } from "../packages/vinext/src/shims/headers.js";
import {
  closeAfterResponse,
  closeAfterResponseWithBody,
  createRequestContext,
  queueAfterCallback,
  runWithRequestContext,
} from "../packages/vinext/src/shims/unified-request-context.js";
import { unstable_cache } from "../packages/vinext/src/shims/cache.js";
import {
  headersContextFromRequest,
  runWithHeadersContext,
} from "../packages/vinext/src/shims/headers.js";
import { VINEXT_PRERENDER_SPECULATIVE_HEADER } from "../packages/vinext/src/server/headers.js";
import {
  PRERENDER_DATA_CACHE_DIR,
  PrerenderDataCacheHandler,
  createPrerenderDataCacheRuntimeHandler,
  readPrerenderDataCacheEntries,
  resetPrerenderDataCache,
  seedPrerenderDataCache,
} from "../packages/vinext/src/server/prerender-data-cache.js";
import {
  createPprFallbackShellState,
  runWithPprFallbackShellState,
} from "../packages/vinext/src/shims/ppr-fallback-shell.js";

const tempDirs: string[] = [];

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function createTempDir(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-prerender-data-cache-"));
  tempDirs.push(directory);
  return directory;
}

function fetchValue(key: string, body: string): CachedFetchValue {
  return {
    kind: "FETCH",
    data: { body, headers: {}, url: key },
    tags: ["resume-test"],
    revalidate: 900,
  };
}

function runAsFallbackShell<T>(fn: () => T): {
  result: T;
  state: ReturnType<typeof createPprFallbackShellState>;
} {
  const state = createPprFallbackShellState({
    fallbackParamNames: ["slug"],
    routePattern: "/[slug]",
  });
  return { result: runWithPprFallbackShellState(state, fn), state };
}

function runAsSpeculativePrerender<T>(fn: () => Promise<T>): Promise<T>;
function runAsSpeculativePrerender<T>(fn: () => T): T;
function runAsSpeculativePrerender<T>(fn: () => T | Promise<T>): T | Promise<T> {
  const request = new Request("http://localhost/about", {
    headers: { [VINEXT_PRERENDER_SPECULATIVE_HEADER]: "1" },
  });
  return runWithHeadersContext(headersContextFromRequest(request), fn);
}

afterEach(() => {
  vi.restoreAllMocks();
  setCacheHandler(new MemoryCacheHandler());
  for (const directory of tempDirs.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe("prerender data cache", () => {
  // Ported from Next.js: test/e2e/app-dir/resume-data-cache/resume-data-cache.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/resume-data-cache/resume-data-cache.test.ts
  it("shares a prerendered fetch entry with another render worker", async () => {
    const prerenderDir = createTempDir();
    const firstWorker = new PrerenderDataCacheHandler(prerenderDir);
    const secondWorker = new PrerenderDataCacheHandler(prerenderDir);
    const key = "use-cache:test:resume";

    await firstWorker.set(key, fetchValue(key, '"prerender-value"'), {
      cacheControl: { revalidate: 900 },
      fetchCache: true,
      tags: ["resume-test"],
    });

    const resumed = await secondWorker.get(key, { kind: "FETCH", softTags: [] });
    expect(resumed?.value).toMatchObject({
      kind: "FETCH",
      data: { body: '"prerender-value"' },
    });
  });

  it("seeds prerendered fetch entries into the runtime handler", async () => {
    const prerenderDir = createTempDir();
    const buildHandler = new PrerenderDataCacheHandler(prerenderDir);
    const runtimeHandler = new MemoryCacheHandler();
    const key = "fetch-cache:test:resume";

    await buildHandler.set(key, fetchValue(key, "runtime-resume-value"), {
      cacheControl: { expire: 3600, revalidate: 900 },
      fetchCache: true,
      tags: ["resume-test"],
    });

    await expect(seedPrerenderDataCache(prerenderDir, runtimeHandler)).resolves.toBe(1);
    const resumed = await runtimeHandler.get(key, { kind: "FETCH", softTags: [] });
    expect(resumed?.value).toMatchObject({
      kind: "FETCH",
      data: { body: "runtime-resume-value" },
    });
    expect(resumed?.cacheControl).toEqual({ expire: 3600, revalidate: 900 });
  });

  // Ported from Next.js: test/e2e/app-dir/use-cache-private/use-cache-private.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/use-cache-private/use-cache-private.test.ts
  it("does not seed public cache entries from a prerender discarded by a private cache", async () => {
    const prerenderDir = createTempDir();
    const buildHandler = new PrerenderDataCacheHandler(prerenderDir);
    const runtimeHandler = new MemoryCacheHandler();
    const requestContext = createRequestContext();
    const previousPrerender = process.env.VINEXT_PRERENDER;
    process.env.VINEXT_PRERENDER = "1";
    setCacheHandler(buildHandler);

    try {
      await runWithRequestContext(requestContext, async () => {
        const publicCached = registerCachedFunction(
          async () => "buildtime",
          "test:private-prerender-public",
        );
        const privateCached = registerCachedFunction(
          async () => "private",
          "test:private-prerender-private",
          "private",
        );

        await expect(publicCached()).resolves.toBe("buildtime");
        await expect(privateCached()).resolves.toBe("private");
        expect(consumeDynamicUsage()).toBe(true);
        expect(requestContext.prerenderDataCacheState.privateCacheUsed).toBe(true);

        // The App Router response finalizer records whether the completed
        // prerender produced a cacheable artifact before after() work drains.
        requestContext.prerenderDataCacheState.commit = false;
        await closeAfterResponse(requestContext);
      });

      await expect(seedPrerenderDataCache(prerenderDir, runtimeHandler)).resolves.toBe(0);
      await expect(
        runtimeHandler.get("use-cache:test:private-prerender-public"),
      ).resolves.toBeNull();
    } finally {
      if (previousPrerender === undefined) delete process.env.VINEXT_PRERENDER;
      else process.env.VINEXT_PRERENDER = previousPrerender;
    }
  });

  it("commits public cache entries from a cacheable prerender", async () => {
    const prerenderDir = createTempDir();
    const buildHandler = new PrerenderDataCacheHandler(prerenderDir);
    const runtimeHandler = new MemoryCacheHandler();
    const requestContext = createRequestContext();
    const previousPrerender = process.env.VINEXT_PRERENDER;
    process.env.VINEXT_PRERENDER = "1";
    setCacheHandler(buildHandler);

    try {
      await runWithRequestContext(requestContext, async () => {
        const publicCached = registerCachedFunction(
          async () => "buildtime",
          "test:cacheable-prerender-public",
        );
        await expect(publicCached()).resolves.toBe("buildtime");
        requestContext.prerenderDataCacheState.commit = true;
        await closeAfterResponse(requestContext);
      });

      await expect(seedPrerenderDataCache(prerenderDir, runtimeHandler)).resolves.toBe(1);
      await expect(
        runtimeHandler.get("use-cache:test:cacheable-prerender-public"),
      ).resolves.toMatchObject({ value: { kind: "FETCH", data: { body: '"buildtime"' } } });
    } finally {
      if (previousPrerender === undefined) delete process.env.VINEXT_PRERENDER;
      else process.env.VINEXT_PRERENDER = previousPrerender;
    }
  });

  it("retains an older committed value when a refresh prerender is discarded", async () => {
    const prerenderDir = createTempDir();
    const buildHandler = new PrerenderDataCacheHandler(prerenderDir);
    const runtimeHandler = new MemoryCacheHandler();
    const key = "use-cache:test:discarded-refresh";
    await buildHandler.set(key, fetchValue(key, '"committed"'));

    const requestContext = createRequestContext();
    const previousPrerender = process.env.VINEXT_PRERENDER;
    process.env.VINEXT_PRERENDER = "1";
    try {
      await runWithRequestContext(requestContext, async () => {
        await buildHandler.set(key, fetchValue(key, '"provisional"'));
        requestContext.prerenderDataCacheState.commit = false;
        await closeAfterResponse(requestContext);
      });

      await expect(seedPrerenderDataCache(prerenderDir, runtimeHandler)).resolves.toBe(1);
      await expect(runtimeHandler.get(key)).resolves.toMatchObject({
        value: { kind: "FETCH", data: { body: '"committed"' } },
      });
    } finally {
      if (previousPrerender === undefined) delete process.env.VINEXT_PRERENDER;
      else process.env.VINEXT_PRERENDER = previousPrerender;
    }
  });

  it("commits a provisional value consumed by another cacheable prerender worker", async () => {
    const prerenderDir = createTempDir();
    const producer = new PrerenderDataCacheHandler(prerenderDir);
    const consumer = new PrerenderDataCacheHandler(prerenderDir);
    const runtimeHandler = new MemoryCacheHandler();
    const key = "use-cache:test:cross-worker-commit";
    const producerContext = createRequestContext();
    const consumerContext = createRequestContext();
    const previousPrerender = process.env.VINEXT_PRERENDER;
    process.env.VINEXT_PRERENDER = "1";

    try {
      await runWithRequestContext(producerContext, () =>
        producer.set(key, fetchValue(key, '"shared"')),
      );
      await runWithRequestContext(consumerContext, async () => {
        await expect(consumer.get(key, { kind: "FETCH" })).resolves.toMatchObject({
          value: { kind: "FETCH", data: { body: '"shared"' } },
        });
        consumerContext.prerenderDataCacheState.commit = true;
        await closeAfterResponse(consumerContext);
      });
      producerContext.prerenderDataCacheState.commit = false;
      await closeAfterResponse(producerContext);

      await expect(seedPrerenderDataCache(prerenderDir, runtimeHandler)).resolves.toBe(1);
      await expect(runtimeHandler.get(key)).resolves.toMatchObject({
        value: { kind: "FETCH", data: { body: '"shared"' } },
      });
    } finally {
      if (previousPrerender === undefined) delete process.env.VINEXT_PRERENDER;
      else process.env.VINEXT_PRERENDER = previousPrerender;
    }
  });

  it("commits the exact provisional version after a newer provisional write arrives", async () => {
    const now = vi.spyOn(Date, "now");
    const prerenderDir = createTempDir();
    const firstWorker = new PrerenderDataCacheHandler(prerenderDir);
    const secondWorker = new PrerenderDataCacheHandler(prerenderDir);
    const thirdWorker = new PrerenderDataCacheHandler(prerenderDir);
    const runtimeHandler = new MemoryCacheHandler();
    const key = "use-cache:test:overlapping-provisional-versions";
    const secondContext = createRequestContext();
    const thirdContext = createRequestContext();
    const previousPrerender = process.env.VINEXT_PRERENDER;

    now.mockReturnValue(1_000);
    await firstWorker.set(key, fetchValue(key, '"v1"'));
    process.env.VINEXT_PRERENDER = "1";

    try {
      now.mockReturnValue(2_000);
      await runWithRequestContext(secondContext, () =>
        secondWorker.set(key, fetchValue(key, '"v2"')),
      );

      now.mockReturnValue(3_000);
      await runWithRequestContext(thirdContext, () =>
        thirdWorker.set(key, fetchValue(key, '"v3"')),
      );

      // The v2 request succeeds after v3 has become the newest provisional
      // value. It must advance the committed fallback to v2 without replacing
      // v3; discarding v3 should therefore seed v2, not stale v1 or unsafe v3.
      secondContext.prerenderDataCacheState.commit = true;
      await closeAfterResponse(secondContext);
      thirdContext.prerenderDataCacheState.commit = false;
      await closeAfterResponse(thirdContext);

      await expect(seedPrerenderDataCache(prerenderDir, runtimeHandler)).resolves.toBe(1);
      await expect(runtimeHandler.get(key)).resolves.toMatchObject({
        value: { kind: "FETCH", data: { body: '"v2"' } },
      });
    } finally {
      if (previousPrerender === undefined) delete process.env.VINEXT_PRERENDER;
      else process.env.VINEXT_PRERENDER = previousPrerender;
    }
  });

  it("does not transfer an older provisional write's owner to a newer version", async () => {
    const now = vi.spyOn(Date, "now");
    const prerenderDir = createTempDir();
    const olderWorker = new PrerenderDataCacheHandler(prerenderDir);
    const newerWorker = new PrerenderDataCacheHandler(prerenderDir);
    const consumer = new PrerenderDataCacheHandler(prerenderDir);
    const key = "use-cache:test:out-of-order-provisional-writes";
    const olderContext = createRequestContext();
    const newerContext = createRequestContext();
    const consumerContext = createRequestContext();
    const previousPrerender = process.env.VINEXT_PRERENDER;
    const olderMemory = Reflect.get(olderWorker, "memory") as MemoryCacheHandler;
    const originalGet = olderMemory.get.bind(olderMemory);
    let releaseOlderWrite!: () => void;
    const olderWriteGate = new Promise<void>((resolve) => {
      releaseOlderWrite = resolve;
    });
    let enteredOlderWrite!: () => void;
    const olderWriteEntered = new Promise<void>((resolve) => {
      enteredOlderWrite = resolve;
    });
    vi.spyOn(olderMemory, "get").mockImplementation(async (storedKey, context) => {
      enteredOlderWrite();
      await olderWriteGate;
      return originalGet(storedKey, context);
    });
    process.env.VINEXT_PRERENDER = "1";

    try {
      now.mockReturnValue(2_000);
      const olderWrite = runWithRequestContext(olderContext, () =>
        olderWorker.set(key, fetchValue(key, '"older"')),
      );
      await olderWriteEntered;

      now.mockReturnValue(3_000);
      await runWithRequestContext(newerContext, () =>
        newerWorker.set(key, fetchValue(key, '"newer"')),
      );

      // Finish the older write after the newer value has become current. Both
      // requests are discarded. The older request must not keep the newer
      // value alive under its owner, where a later worker could consume and
      // commit a value from a discarded prerender.
      releaseOlderWrite();
      await olderWrite;
      newerContext.prerenderDataCacheState.commit = false;
      await closeAfterResponse(newerContext);
      olderContext.prerenderDataCacheState.commit = false;
      await closeAfterResponse(olderContext);

      await runWithRequestContext(consumerContext, async () => {
        await expect(consumer.get(key, { kind: "FETCH" })).resolves.toBeNull();
        consumerContext.prerenderDataCacheState.commit = true;
        await closeAfterResponse(consumerContext);
      });

      const files = fs
        .readdirSync(path.join(prerenderDir, ".vinext-resume-data-cache"))
        .filter((file) => file.endsWith(".json"));
      expect(files).toEqual([]);
    } finally {
      releaseOlderWrite();
      await olderWriteGate;
      if (previousPrerender === undefined) delete process.env.VINEXT_PRERENDER;
      else process.env.VINEXT_PRERENDER = previousPrerender;
    }
  });

  it("distinguishes exact versions with different persisted cache policies", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const prerenderDir = createTempDir();
    const firstWorker = new PrerenderDataCacheHandler(prerenderDir);
    const secondWorker = new PrerenderDataCacheHandler(prerenderDir);
    const runtimeHandler = new MemoryCacheHandler();
    const key = "fetch-cache:test:policy-version";
    const requestContext = createRequestContext();
    const previousPrerender = process.env.VINEXT_PRERENDER;

    await firstWorker.set(key, fetchValue(key, '"same-data"'), {
      cacheControl: { expire: 3600, revalidate: 900, stale: 300 },
      fetchCache: true,
    });
    process.env.VINEXT_PRERENDER = "1";

    try {
      await runWithRequestContext(requestContext, () =>
        secondWorker.set(key, fetchValue(key, '"same-data"'), {
          cacheControl: { expire: 60, revalidate: 30, stale: 10 },
          fetchCache: true,
        }),
      );
      requestContext.prerenderDataCacheState.commit = true;
      await closeAfterResponse(requestContext);

      await expect(seedPrerenderDataCache(prerenderDir, runtimeHandler)).resolves.toBe(1);
      await expect(runtimeHandler.get(key)).resolves.toMatchObject({
        cacheControl: { expire: 60, revalidate: 900, stale: 10 },
      });
    } finally {
      now.mockRestore();
      if (previousPrerender === undefined) delete process.env.VINEXT_PRERENDER;
      else process.env.VINEXT_PRERENDER = previousPrerender;
    }
  });

  it("includes cache writes started by after callbacks before finalizing", async () => {
    const now = vi.spyOn(Date, "now");
    const prerenderDir = createTempDir();
    const buildHandler = new PrerenderDataCacheHandler(prerenderDir);
    const afterHandler = new PrerenderDataCacheHandler(prerenderDir);
    const runtimeHandler = new MemoryCacheHandler();
    const key = "fetch-cache:test:after-fill";
    const requestContext = createRequestContext();
    const previousPrerender = process.env.VINEXT_PRERENDER;
    process.env.VINEXT_PRERENDER = "1";

    try {
      await runWithRequestContext(requestContext, async () => {
        now.mockReturnValue(1_000);
        await buildHandler.set(key, fetchValue(key, '"render"'));
        queueAfterCallback(requestContext, async () => {
          now.mockReturnValue(2_000);
          await afterHandler.set(key, fetchValue(key, '"after"'));
        });
        requestContext.prerenderDataCacheState.commit = true;
        await closeAfterResponse(requestContext);
      });

      await expect(seedPrerenderDataCache(prerenderDir, runtimeHandler)).resolves.toBe(1);
      await expect(runtimeHandler.get(key)).resolves.toMatchObject({
        value: { kind: "FETCH", data: { body: '"after"' } },
      });
    } finally {
      if (previousPrerender === undefined) delete process.env.VINEXT_PRERENDER;
      else process.env.VINEXT_PRERENDER = previousPrerender;
    }
  });

  it("drains an unawaited fetch write before discarding its provisional entry", async () => {
    const prerenderDir = createTempDir();
    const buildHandler = new PrerenderDataCacheHandler(prerenderDir);
    const key = "fetch-cache:test:unawaited-write-close-race";
    const requestContext = createRequestContext();
    const previousPrerender = process.env.VINEXT_PRERENDER;
    const memory = Reflect.get(buildHandler, "memory") as MemoryCacheHandler;
    const originalSet = memory.set.bind(memory);
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let enteredWrite!: () => void;
    const writeEntered = new Promise<void>((resolve) => {
      enteredWrite = resolve;
    });
    vi.spyOn(memory, "set").mockImplementation(async (storedKey, value, context) => {
      if (storedKey === key) {
        enteredWrite();
        await writeGate;
      }
      return originalSet(storedKey, value, context);
    });
    process.env.VINEXT_PRERENDER = "1";

    try {
      await runWithRequestContext(requestContext, async () => {
        const write = buildHandler.set(key, fetchValue(key, '"discarded"'));
        await writeEntered;
        requestContext.prerenderDataCacheState.commit = false;

        let closeSettled = false;
        const close = closeAfterResponse(requestContext).then(() => {
          closeSettled = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(closeSettled).toBe(false);

        releaseWrite();
        await Promise.all([write, close]);
      });

      const files = fs
        .readdirSync(path.join(prerenderDir, ".vinext-resume-data-cache"))
        .filter((file) => file.endsWith(".json"));
      expect(files).toEqual([]);
    } finally {
      if (previousPrerender === undefined) delete process.env.VINEXT_PRERENDER;
      else process.env.VINEXT_PRERENDER = previousPrerender;
    }
  });

  it("drains a post-close fetch write through the execution context lifecycle", async () => {
    const prerenderDir = createTempDir();
    const buildHandler = new PrerenderDataCacheHandler(prerenderDir);
    const key = "fetch-cache:test:post-close-write";
    const waitUntilPromises: Promise<unknown>[] = [];
    const requestContext = createRequestContext({
      executionContext: {
        waitUntil(promise) {
          waitUntilPromises.push(promise);
        },
      },
    });
    const previousPrerender = process.env.VINEXT_PRERENDER;
    const memory = Reflect.get(buildHandler, "memory") as MemoryCacheHandler;
    const originalSet = memory.set.bind(memory);
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let enteredWrite!: () => void;
    const writeEntered = new Promise<void>((resolve) => {
      enteredWrite = resolve;
    });
    vi.spyOn(memory, "set").mockImplementation(async (storedKey, value, context) => {
      if (storedKey === key) {
        enteredWrite();
        await writeGate;
      }
      return originalSet(storedKey, value, context);
    });
    process.env.VINEXT_PRERENDER = "1";

    try {
      await runWithRequestContext(requestContext, async () => {
        requestContext.prerenderDataCacheState.commit = false;
        await closeAfterResponse(requestContext);

        const write = buildHandler.set(key, fetchValue(key, '"discarded"'));
        await writeEntered;
        expect(waitUntilPromises).toHaveLength(1);

        let lifecycleSettled = false;
        void waitUntilPromises[0].then(() => {
          lifecycleSettled = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(lifecycleSettled).toBe(false);

        releaseWrite();
        await write;
        await Promise.all(waitUntilPromises);
      });

      const files = fs
        .readdirSync(path.join(prerenderDir, ".vinext-resume-data-cache"))
        .filter((file) => file.endsWith(".json"));
      expect(files).toEqual([]);
    } finally {
      if (previousPrerender === undefined) delete process.env.VINEXT_PRERENDER;
      else process.env.VINEXT_PRERENDER = previousPrerender;
    }
  });

  it("retires discarded provisional versions instead of accumulating history", async () => {
    const now = vi.spyOn(Date, "now");
    const prerenderDir = createTempDir();
    const runtimeHandler = new MemoryCacheHandler();
    const key = "fetch-cache:test:discard-history";
    const previousPrerender = process.env.VINEXT_PRERENDER;

    now.mockReturnValue(1_000);
    await new PrerenderDataCacheHandler(prerenderDir).set(key, fetchValue(key, '"committed"'));
    process.env.VINEXT_PRERENDER = "1";

    try {
      for (let index = 2; index <= 8; index++) {
        const requestContext = createRequestContext();
        const handler = new PrerenderDataCacheHandler(prerenderDir);
        now.mockReturnValue(index * 1_000);
        await runWithRequestContext(requestContext, async () => {
          await handler.set(key, fetchValue(key, `"discard-${index}-a"`));
          now.mockReturnValue(index * 1_000 + 500);
          await handler.set(key, fetchValue(key, `"discard-${index}-b"`));
        });
        requestContext.prerenderDataCacheState.commit = false;
        await closeAfterResponse(requestContext);
      }

      const files = fs
        .readdirSync(path.join(prerenderDir, ".vinext-resume-data-cache"))
        .filter((file) => file.endsWith(".json"));
      expect(files).toHaveLength(1);
      const persisted = JSON.parse(
        fs.readFileSync(path.join(prerenderDir, ".vinext-resume-data-cache", files[0]), "utf8"),
      );
      expect(persisted).toMatchObject({ committed: true });
      expect(persisted.previousCommitted).toBeUndefined();
      expect(persisted.provisionalVersions).toBeUndefined();
      expect(persisted.owners).toBeUndefined();

      await expect(seedPrerenderDataCache(prerenderDir, runtimeHandler)).resolves.toBe(1);
      await expect(runtimeHandler.get(key)).resolves.toMatchObject({
        value: { kind: "FETCH", data: { body: '"committed"' } },
      });
    } finally {
      if (previousPrerender === undefined) delete process.env.VINEXT_PRERENDER;
      else process.env.VINEXT_PRERENDER = previousPrerender;
    }
  });

  // Next.js writes completed FETCH fills to both its prerender resume data
  // cache and CacheHandler inside IncrementalCache.set(), before the outer
  // response stream is consumed. A later body error therefore does not roll
  // that completed data-cache fill back.
  // https://github.com/vercel/next.js/blob/canary/packages/next/src/server/lib/incremental-cache/index.ts
  it("keeps a completed data-cache fill when the outer response body errors", async () => {
    const prerenderDir = createTempDir();
    const buildHandler = new PrerenderDataCacheHandler(prerenderDir);
    const runtimeHandler = new MemoryCacheHandler();
    const key = "fetch-cache:test:errored-response-body";
    const requestContext = createRequestContext();
    const previousPrerender = process.env.VINEXT_PRERENDER;
    process.env.VINEXT_PRERENDER = "1";

    try {
      await runWithRequestContext(requestContext, () =>
        buildHandler.set(key, fetchValue(key, '"completed"')),
      );
      requestContext.prerenderDataCacheState.commit = true;
      const response = closeAfterResponseWithBody(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error("body failed"));
            },
          }),
        ),
        requestContext,
      );
      await expect(response.arrayBuffer()).rejects.toThrow("body failed");
      await closeAfterResponse(requestContext);

      await expect(seedPrerenderDataCache(prerenderDir, runtimeHandler)).resolves.toBe(1);
      await expect(runtimeHandler.get(key)).resolves.toMatchObject({
        value: { kind: "FETCH", data: { body: '"completed"' } },
      });
    } finally {
      if (previousPrerender === undefined) delete process.env.VINEXT_PRERENDER;
      else process.env.VINEXT_PRERENDER = previousPrerender;
    }
  });

  it("preserves every tag observed for a shared fetch key", async () => {
    const prerenderDir = createTempDir();
    const firstWorker = new PrerenderDataCacheHandler(prerenderDir);
    const secondWorker = new PrerenderDataCacheHandler(prerenderDir);
    const runtimeHandler = new MemoryCacheHandler();
    const key = "fetch-cache:test:shared-tags";

    await firstWorker.set(
      key,
      { ...fetchValue(key, "shared-value"), tags: ["first-page"] },
      { fetchCache: true, tags: ["first-page"] },
    );
    await secondWorker.get(key, { kind: "FETCH", tags: ["second-page"] });

    await seedPrerenderDataCache(prerenderDir, runtimeHandler);
    const resumed = await runtimeHandler.get(key);
    expect(resumed?.value).toMatchObject({ tags: ["first-page", "second-page"] });
    await runtimeHandler.revalidateTag("second-page");
    expect(await runtimeHandler.get(key)).toBeNull();
  });

  it("does not let an older worker overwrite a newer persisted value", async () => {
    const now = vi.spyOn(Date, "now");
    const prerenderDir = createTempDir();
    const firstWorker = new PrerenderDataCacheHandler(prerenderDir);
    const staleWorker = new PrerenderDataCacheHandler(prerenderDir);
    const key = "fetch-cache:test:cross-worker-update";

    now.mockReturnValue(1_000);
    await firstWorker.set(key, fetchValue(key, "value-a"), { tags: ["tag-a"] });
    await staleWorker.get(key, { kind: "FETCH", tags: ["tag-a"] });

    now.mockReturnValue(2_000);
    await firstWorker.set(key, fetchValue(key, "value-b"), { tags: ["tag-a"] });
    await staleWorker.get(key, { kind: "FETCH", tags: ["tag-b"] });

    const runtimeHandler = new MemoryCacheHandler();
    await seedPrerenderDataCache(prerenderDir, runtimeHandler);
    await expect(runtimeHandler.get(key)).resolves.toMatchObject({
      lastModified: 2_000,
      value: {
        kind: "FETCH",
        data: { body: "value-b" },
        tags: ["resume-test", "tag-a", "tag-b"],
      },
    });
  });

  it("marks profiled tag revalidation stale before its expiry", async () => {
    const handler = new MemoryCacheHandler();
    const key = "fetch-cache:test:profiled-revalidation";

    await handler.set(key, fetchValue(key, "stale-value"), { tags: ["profiled"] });
    await handler.revalidateTag("profiled", { expire: 60 });

    expect(await handler.get(key)).toMatchObject({ cacheState: "stale" });
  });

  it("coordinates concurrent cache misses across prerender workers", async () => {
    const prerenderDir = createTempDir();
    const firstWorker = new PrerenderDataCacheHandler(prerenderDir);
    const secondWorker = new PrerenderDataCacheHandler(prerenderDir);
    const key = "fetch-cache:test:single-flight";

    await expect(firstWorker.get(key, { kind: "FETCH" })).resolves.toBeNull();
    let secondSettled = false;
    const secondRead = secondWorker.get(key, { kind: "FETCH" }).finally(() => {
      secondSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(secondSettled).toBe(false);

    await firstWorker.set(key, fetchValue(key, "shared-winner"), { fetchCache: true });
    await expect(secondRead).resolves.toMatchObject({
      value: { kind: "FETCH", data: { body: "shared-winner" } },
    });
  });

  it("coordinates foreground refreshes of stale entries across prerender workers", async () => {
    const now = vi.spyOn(Date, "now");
    const prerenderDir = createTempDir();
    const firstWorker = new PrerenderDataCacheHandler(prerenderDir);
    const secondWorker = new PrerenderDataCacheHandler(prerenderDir);
    const key = "fetch-cache:test:stale-single-flight";

    now.mockReturnValue(1_000);
    await firstWorker.set(key, { ...fetchValue(key, "stale"), revalidate: 1 });
    now.mockReturnValue(3_000);

    await expect(firstWorker.get(key, { kind: "FETCH" })).resolves.toBeNull();
    let secondSettled = false;
    const secondRead = secondWorker.get(key, { kind: "FETCH" }).finally(() => {
      secondSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(secondSettled).toBe(false);

    await firstWorker.set(key, { ...fetchValue(key, "fresh"), revalidate: 1 });
    await expect(secondRead).resolves.toMatchObject({
      value: { kind: "FETCH", data: { body: "fresh" } },
    });
  });

  it("releases an unstable_cache claim when its callback rejects", async () => {
    const prerenderDir = createTempDir();
    setCacheHandler(new PrerenderDataCacheHandler(prerenderDir));
    let calls = 0;
    const cached = unstable_cache(async () => {
      if (++calls === 1) throw new Error("first fill failed");
      return "recovered";
    }, ["prerender-rejection"]);

    await expect(cached()).rejects.toThrow("first fill failed");
    await expect(
      Promise.race([cached(), new Promise((resolve) => setTimeout(() => resolve("blocked"), 100))]),
    ).resolves.toBe("recovered");
  });

  it("preserves build timestamps and does not overwrite newer runtime data", async () => {
    const now = vi.spyOn(Date, "now");
    const prerenderDir = createTempDir();
    const buildHandler = new PrerenderDataCacheHandler(prerenderDir);
    const runtimeHandler = new MemoryCacheHandler();
    const key = "fetch-cache:test:timestamp";

    now.mockReturnValue(1_000);
    await buildHandler.set(key, fetchValue(key, "build-value"), { fetchCache: true });

    now.mockReturnValue(2_000);
    await runtimeHandler.set(key, fetchValue(key, "runtime-value"), { fetchCache: true });
    await expect(seedPrerenderDataCache(prerenderDir, runtimeHandler)).resolves.toBe(0);
    await expect(runtimeHandler.get(key)).resolves.toMatchObject({
      lastModified: 2_000,
      value: { kind: "FETCH", data: { body: "runtime-value" } },
    });

    const coldRuntime = new MemoryCacheHandler();
    await expect(seedPrerenderDataCache(prerenderDir, coldRuntime)).resolves.toBe(1);
    await expect(coldRuntime.get(key)).resolves.toMatchObject({ lastModified: 1_000 });
  });

  it("does not publish build snapshots to custom handlers without atomic seed support", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(4_000);
    const prerenderDir = createTempDir();
    const buildHandler = new PrerenderDataCacheHandler(prerenderDir);
    const key = "fetch-cache:test:custom-handler";
    await buildHandler.set(key, fetchValue(key, "custom-value"), { tags: ["custom-tag"] });

    const get = vi.fn(async () => null);
    const set = vi.fn(async () => {});
    const customHandler: CacheHandler = {
      get,
      set,
      revalidateTag: vi.fn(async () => {}),
    };
    await expect(seedPrerenderDataCache(prerenderDir, customHandler)).resolves.toBe(0);
    expect(get).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
    now.mockRestore();
  });

  it("exposes build snapshots through a read-through custom-handler overlay", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(4_000);
    const prerenderDir = createTempDir();
    const buildHandler = new PrerenderDataCacheHandler(prerenderDir);
    const key = "fetch-cache:test:custom-overlay";
    await buildHandler.set(key, fetchValue(key, "build-value"), { fetchCache: true });

    const shared = new MemoryCacheHandler();
    const set = vi.fn(shared.set.bind(shared));
    const releasePendingSet = vi.fn(async () => {});
    const customHandler: CacheHandler = {
      get: vi.fn(shared.get.bind(shared)),
      releasePendingSet,
      set,
      revalidateTag: shared.revalidateTag.bind(shared),
    };
    const runtimeHandler = await createPrerenderDataCacheRuntimeHandler(
      prerenderDir,
      customHandler,
    );

    await expect(runtimeHandler.get(key, { kind: "FETCH" })).resolves.toMatchObject({
      lastModified: 4_000,
      value: { data: { body: "build-value" } },
    });
    expect(set.mock.calls.some(([storedKey]) => storedKey === key)).toBe(false);
    await expect(runtimeHandler.get(key, { kind: "FETCH" })).resolves.toMatchObject({
      value: { data: { body: "build-value" } },
    });
    expect(releasePendingSet).toHaveBeenCalledTimes(2);
    expect(releasePendingSet).toHaveBeenLastCalledWith(key);
    now.mockRestore();
  });

  it("keeps an existing custom-handler runtime value ahead of the build snapshot", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(4_000);
    const prerenderDir = createTempDir();
    const buildHandler = new PrerenderDataCacheHandler(prerenderDir);
    const key = "fetch-cache:test:custom-runtime-freshness";
    await buildHandler.set(key, fetchValue(key, "build-value"), { fetchCache: true });

    const shared = new MemoryCacheHandler();
    now.mockReturnValue(5_000);
    await shared.set(key, fetchValue(key, "runtime-value"), { fetchCache: true });
    const customHandler: CacheHandler = {
      get: shared.get.bind(shared),
      set: shared.set.bind(shared),
      revalidateTag: shared.revalidateTag.bind(shared),
    };
    const runtimeHandler = await createPrerenderDataCacheRuntimeHandler(
      prerenderDir,
      customHandler,
    );

    await expect(runtimeHandler.get(key, { kind: "FETCH" })).resolves.toMatchObject({
      value: { data: { body: "runtime-value" } },
    });
    now.mockRestore();
  });

  it("does not expose a build snapshot across a concurrent custom runtime write", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(4_000);
    const prerenderDir = createTempDir();
    const buildHandler = new PrerenderDataCacheHandler(prerenderDir);
    const key = "fetch-cache:test:custom-runtime-race";
    await buildHandler.set(key, fetchValue(key, "build-value"), { fetchCache: true });

    const firstReadStarted = createDeferred();
    const releaseFirstRead = createDeferred();
    const releaseWrite = createDeferred();
    const shared = new MemoryCacheHandler();
    let reads = 0;
    const customHandler: CacheHandler = {
      async get(storedKey, context) {
        const captured = await shared.get(storedKey, context);
        if (storedKey === key && reads++ === 0) {
          firstReadStarted.resolve();
          await releaseFirstRead.promise;
        }
        return captured;
      },
      async set(storedKey, value, context) {
        if (storedKey === key) await releaseWrite.promise;
        await shared.set(storedKey, value, context);
      },
      revalidateTag: shared.revalidateTag.bind(shared),
    };
    const runtimeHandler = await createPrerenderDataCacheRuntimeHandler(
      prerenderDir,
      customHandler,
    );

    const read = runtimeHandler.get(key, { kind: "FETCH" });
    await firstReadStarted.promise;
    const write = runtimeHandler.set(key, fetchValue(key, "runtime-value"), { fetchCache: true });
    releaseFirstRead.resolve();
    await Promise.resolve();
    releaseWrite.resolve();

    await expect(write).resolves.toBeUndefined();
    await expect(read).resolves.toMatchObject({
      value: { data: { body: "runtime-value" } },
    });
    now.mockRestore();
  });

  it("invalidates the process-local snapshot with the configured custom handler", async () => {
    const prerenderDir = createTempDir();
    const buildHandler = new PrerenderDataCacheHandler(prerenderDir);
    const key = "fetch-cache:test:custom-cross-instance-invalidation";
    await buildHandler.set(key, fetchValue(key, "build-value"), {
      fetchCache: true,
      tags: ["resume-test"],
    });

    const custom = new MemoryCacheHandler();
    const legacyHandler: CacheHandler = {
      get: custom.get.bind(custom),
      set: custom.set.bind(custom),
      revalidateTag: custom.revalidateTag.bind(custom),
    };
    const runtime = await createPrerenderDataCacheRuntimeHandler(prerenderDir, legacyHandler);
    await expect(runtime.get(key, { kind: "FETCH" })).resolves.toMatchObject({
      value: { data: { body: "build-value" } },
    });

    await runtime.revalidateTag("resume-test");
    await expect(runtime.get(key, { kind: "FETCH" })).resolves.toBeNull();
  });

  it("checks newly requested fetch tags before serving a Memory cache hit", async () => {
    const handler = new MemoryCacheHandler();
    const key = "fetch-cache:test:requested-tag-invalidation";
    await handler.set(key, fetchValue(key, "old"), { tags: ["tag-a"] });
    await handler.revalidateTag("tag-b");

    await expect(handler.get(key, { kind: "FETCH", tags: ["tag-b"] })).resolves.toBeNull();
  });

  it("treats a same-millisecond refresh as newer than profiled invalidation", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const handler = new MemoryCacheHandler();
    const key = "fetch-cache:test:same-millisecond";

    await handler.set(key, fetchValue(key, "before"), { tags: ["same-ms"] });
    await handler.revalidateTag("same-ms", { expire: 60 });
    expect(await handler.get(key)).toMatchObject({ cacheState: "stale" });
    await handler.set(key, fetchValue(key, "after"), { tags: ["same-ms"] });
    expect((await handler.get(key))?.cacheState).toBeUndefined();

    now.mockReturnValue(62_000);
    await expect(handler.get(key)).resolves.toMatchObject({
      value: { kind: "FETCH", data: { body: "after" } },
    });
  });

  it("does not weaken a hard invalidation with a later profiled revalidation", async () => {
    const now = vi.spyOn(Date, "now");
    const handler = new MemoryCacheHandler();
    const key = "fetch-cache:test:hard-then-profiled";
    now.mockReturnValue(1_000);
    await handler.set(key, fetchValue(key, "old"), { tags: ["ordered"] });
    now.mockReturnValue(2_000);
    await handler.revalidateTag("ordered");
    now.mockReturnValue(3_000);
    await handler.revalidateTag("ordered", { expire: 60 });

    await expect(handler.get(key)).resolves.toBeNull();
  });

  it("clears retained prerender data before a new build", async () => {
    const prerenderDir = createTempDir();
    const handler = new PrerenderDataCacheHandler(prerenderDir);
    await handler.set("removed-key", fetchValue("removed-key", "old"));

    resetPrerenderDataCache(prerenderDir);

    await expect(seedPrerenderDataCache(prerenderDir, new MemoryCacheHandler())).resolves.toBe(0);
  });
});
