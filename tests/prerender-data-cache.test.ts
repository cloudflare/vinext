import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  MemoryCacheHandler,
  setCacheHandler,
  type CacheHandler,
  type CachedFetchValue,
} from "../packages/vinext/src/shims/cache-handler.js";
import { unstable_cache } from "../packages/vinext/src/shims/cache.js";
import {
  PrerenderDataCacheHandler,
  resetPrerenderDataCache,
  seedPrerenderDataCache,
} from "../packages/vinext/src/server/prerender-data-cache.js";

const tempDirs: string[] = [];

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

  it("falls back to set for custom handlers without timestamp-preserving seed support", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(4_000);
    const prerenderDir = createTempDir();
    const buildHandler = new PrerenderDataCacheHandler(prerenderDir);
    const key = "fetch-cache:test:custom-handler";
    await buildHandler.set(key, fetchValue(key, "custom-value"), { tags: ["custom-tag"] });

    const set = vi.fn(async () => {});
    const customHandler: CacheHandler = {
      get: vi.fn(async () => null),
      set,
      revalidateTag: vi.fn(async () => {}),
    };
    await expect(seedPrerenderDataCache(prerenderDir, customHandler)).resolves.toBe(1);
    expect(set).toHaveBeenCalledWith(
      key,
      expect.objectContaining({ kind: "FETCH" }),
      expect.objectContaining({ lastModified: 4_000, tags: ["custom-tag"] }),
    );
    now.mockRestore();
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
