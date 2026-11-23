import { describe, expect, it } from "vite-plus/test";
import {
  _runWithCacheState,
  _setResumeDataCacheCollector,
} from "../packages/vinext/src/shims/cache-request-state.js";
import {
  collectUseCacheResumeDataCacheEntry,
  createResumeDataCache,
  stringifyResumeDataCache,
} from "../packages/vinext/src/shims/resume-data-cache.js";

function storedUseCacheKeys(cache: ReturnType<typeof createResumeDataCache>): string[] {
  const value = stringifyResumeDataCache(cache);
  return value === null ? [] : Object.keys(JSON.parse(value).cache);
}

describe("resume data cache", () => {
  // Ported from Next.js: packages/next/src/server/resume-data-cache/cache-store.ts
  // (entries with `revalidate: 0` or an expire under MIN_PRERENDERABLE_EXPIRE are left out
  // of a shell's serialized resume data cache)
  it("leaves short-lived use cache entries out of a shell's resume data cache", async () => {
    const collector = createResumeDataCache();
    await _runWithCacheState(() => {
      _setResumeDataCacheCollector(collector);
      const collect = (key: string, revalidate: number, expire: number) =>
        collectUseCacheResumeDataCacheEntry(key, {
          body: "",
          cacheControl: { revalidate, expire },
          tags: [],
        });
      collect("dynamic", 0, 900);
      collect("seconds", 1, 60);
      collect("just-under", 60, 299);
      collect("minutes", 60, 3600);
      collect("at-dynamic-expire", 60, 300);
    });

    expect(storedUseCacheKeys(collector)).toEqual(["minutes", "at-dynamic-expire"]);
  });

  // Ported from Next.js: packages/next/src/server/resume-data-cache/cache-store.ts
  // (entries with a stale time under MIN_PREFETCHABLE_STALE are left out too)
  it("leaves soon-stale use cache entries out of a shell's resume data cache", async () => {
    const collector = createResumeDataCache();
    await _runWithCacheState(() => {
      _setResumeDataCacheCollector(collector);
      const collect = (key: string, stale: number | undefined) =>
        collectUseCacheResumeDataCacheEntry(key, {
          body: "",
          cacheControl: {
            revalidate: 900,
            expire: 3600,
            ...(stale === undefined ? {} : { stale }),
          },
          tags: [],
        });
      collect("no-stale", undefined);
      collect("soon-stale", 29);
      collect("at-prefetchable-stale", 30);
    });

    // The prerender's own renders still read every entry.
    expect([...collector.cache.keys()]).toEqual([
      "no-stale",
      "soon-stale",
      "at-prefetchable-stale",
    ]);
    expect(storedUseCacheKeys(collector)).toEqual(["no-stale", "at-prefetchable-stale"]);
  });
});
