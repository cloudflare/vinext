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

  it("keeps fallback-shell cache entries out of the prerender filesystem", async () => {
    const prerenderDir = createTempDir();
    const buildHandler = new PrerenderDataCacheHandler(prerenderDir);
    const runtimeHandler = new MemoryCacheHandler();
    const key = "use-cache:test:speculative";

    setCacheHandler(buildHandler);
    const { result, state } = runAsFallbackShell(async () => {
      const handler = getCacheHandler();
      expect(await handler.get(key, { cacheKind: "use-cache", kind: "FETCH" })).toBeNull();
      await handler.set(key, fetchValue(key, "fallback-value"), {
        cacheKind: "use-cache",
        cacheControl: { revalidate: 900 },
        fetchCache: true,
      });
    });
    await result;
    expect(readPrerenderDataCacheEntries(prerenderDir)).toEqual([]);
    expect(fs.readdirSync(path.join(prerenderDir, PRERENDER_DATA_CACHE_DIR))).toEqual([]);
    expect([...state.resumeDataCache.values()]).toMatchObject([
      { context: { cacheKind: "use-cache" }, key },
    ]);
    await expect(seedPrerenderDataCache(prerenderDir, runtimeHandler)).resolves.toBe(0);
    await expect(runtimeHandler.get(key, { kind: "FETCH" })).resolves.toBeNull();
  });

  it("does not pass fallback-shell cache entries to custom handlers", async () => {
    const key = "use-cache:test:custom-speculative";
    const get = vi.fn(async () => null);
    const set = vi.fn(async () => {});
    const customHandler: CacheHandler = {
      get,
      set,
      revalidateTag: vi.fn(async () => {}),
    };
    setCacheHandler(customHandler);
    const { result, state } = runAsFallbackShell(async () => {
      const handler = getCacheHandler();
      expect(await handler.get(key, { cacheKind: "use-cache", kind: "FETCH" })).toBeNull();
      await handler.set(key, fetchValue(key, "fallback-value"), {
        cacheKind: "use-cache",
        fetchCache: true,
      });
    });
    await result;
    expect(get).toHaveBeenCalledOnce();
    expect(set).not.toHaveBeenCalled();
    expect([...state.resumeDataCache.values()]).toMatchObject([{ key }]);
  });

  it("does not publish cache entries from a discarded speculative render", async () => {
    const prerenderDir = createTempDir();
    const buildHandler = new PrerenderDataCacheHandler(prerenderDir);
    const runtimeHandler = new MemoryCacheHandler();
    const key = "use-cache:test:static-probe";
    await runAsSpeculativePrerender(() =>
      buildHandler.set(key, fetchValue(key, "static-value"), { fetchCache: true }),
    );

    expect(readPrerenderDataCacheEntries(prerenderDir)).toMatchObject([
      { context: { speculative: true }, key },
    ]);
    await expect(seedPrerenderDataCache(prerenderDir, runtimeHandler)).resolves.toBe(0);
    await expect(runtimeHandler.get(key, { kind: "FETCH" })).resolves.toBeNull();

    const set = vi.fn(async () => {});
    const customHandler: CacheHandler = {
      get: vi.fn(async () => null),
      set,
      revalidateTag: vi.fn(async () => {}),
    };
    await expect(seedPrerenderDataCache(prerenderDir, customHandler)).resolves.toBe(0);
    expect(set).not.toHaveBeenCalled();
  });

  it("does not add speculative request tags to a normal cache entry", async () => {
    const prerenderDir = createTempDir();
    const handler = new PrerenderDataCacheHandler(prerenderDir);
    const key = "use-cache:test:speculative-read-tags";
    await handler.set(
      key,
      { ...fetchValue(key, "normal"), tags: ["normal-value-tag"] },
      { fetchCache: true, tags: ["normal-context-tag"] },
    );

    await expect(
      runAsSpeculativePrerender(() =>
        handler.get(key, { kind: "FETCH", tags: ["speculative-read-tag"] }),
      ),
    ).resolves.toMatchObject({
      value: { tags: ["normal-value-tag"] },
    });
    expect(readPrerenderDataCacheEntries(prerenderDir)).toMatchObject([
      {
        context: { tags: ["normal-context-tag"] },
        value: { tags: ["normal-value-tag"] },
      },
    ]);
  });

  it.each(["normal-first", "speculative-first"] as const)(
    "does not merge speculative tags into a normal same-key %s persisted winner",
    async (order) => {
      const prerenderDir = createTempDir();
      const normalHandler = new PrerenderDataCacheHandler(prerenderDir);
      const speculativeHandler = new PrerenderDataCacheHandler(prerenderDir);
      const key = `use-cache:test:speculative-collision-${order}`;
      const writeNormal = () =>
        normalHandler.set(
          key,
          { ...fetchValue(key, "normal"), tags: ["normal-value-tag"] },
          { fetchCache: true, tags: ["normal-context-tag"] },
        );
      const writeSpeculative = () =>
        runAsSpeculativePrerender(() =>
          speculativeHandler.set(
            key,
            { ...fetchValue(key, "speculative"), tags: ["speculative-value-tag"] },
            { fetchCache: true, tags: ["speculative-context-tag"] },
          ),
        );

      if (order === "normal-first") {
        await writeNormal();
        await writeSpeculative();
      } else {
        await writeSpeculative();
        await writeNormal();
      }

      expect(readPrerenderDataCacheEntries(prerenderDir)).toMatchObject([
        {
          context: {
            tags: ["normal-value-tag", "normal-context-tag"],
            speculative: false,
          },
          value: {
            data: { body: "normal" },
            tags: ["normal-value-tag", "normal-context-tag"],
          },
        },
      ]);
    },
  );

  it("keeps a normal same-key value visible after a fallback-shell write in one worker", async () => {
    const prerenderDir = createTempDir();
    const buildHandler = new PrerenderDataCacheHandler(prerenderDir);
    const key = "use-cache:test:mixed-memory";
    await buildHandler.set(key, fetchValue(key, "normal-value"), { fetchCache: true });
    setCacheHandler(buildHandler);
    const { result } = runAsFallbackShell(() =>
      getCacheHandler().set(key, fetchValue(key, "fallback-value"), {
        cacheKind: "use-cache",
        fetchCache: true,
      }),
    );
    await result;

    await expect(buildHandler.get(key, { kind: "FETCH" })).resolves.toMatchObject({
      value: { kind: "FETCH", data: { body: "normal-value" } },
    });
  });

  it.each(["normal-first", "fallback-first"] as const)(
    "retains the normal persisted value across a %s same-key collision",
    async (order) => {
      const prerenderDir = createTempDir();
      const normalWorker = new PrerenderDataCacheHandler(prerenderDir);
      const fallbackWorker = new PrerenderDataCacheHandler(prerenderDir);
      const key = `use-cache:test:mixed-${order}`;
      const writeNormal = () =>
        normalWorker.set(key, fetchValue(key, "normal-value"), { fetchCache: true });
      const writeFallback = async () => {
        setCacheHandler(fallbackWorker);
        const { result } = runAsFallbackShell(() =>
          getCacheHandler().set(key, fetchValue(key, "fallback-value"), {
            cacheKind: "use-cache",
            fetchCache: true,
          }),
        );
        await result;
      };

      if (order === "normal-first") {
        await writeNormal();
        await writeFallback();
      } else {
        await writeFallback();
        await writeNormal();
      }

      expect(readPrerenderDataCacheEntries(prerenderDir)).toMatchObject([
        {
          key,
          value: { data: { body: "normal-value" } },
        },
      ]);
      const runtimeHandler = new MemoryCacheHandler();
      await expect(seedPrerenderDataCache(prerenderDir, runtimeHandler)).resolves.toBe(1);
      await expect(runtimeHandler.get(key)).resolves.toMatchObject({
        value: { data: { body: "normal-value" } },
      });
    },
  );

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
