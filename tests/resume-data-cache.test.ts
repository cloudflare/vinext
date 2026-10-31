import { describe, expect, it } from "vite-plus/test";
import {
  _runWithCacheState,
  _setResumeDataCacheCollector,
} from "../packages/vinext/src/shims/cache-request-state.js";
import {
  collectUseCacheResumeDataCacheEntry,
  createResumeDataCache,
} from "../packages/vinext/src/shims/resume-data-cache.js";

describe("resume data cache", () => {
  // Ported from Next.js: packages/next/src/server/use-cache/use-cache-wrapper.ts
  // (entries with `revalidate: 0` or an expire under DYNAMIC_EXPIRE are left out of a shell)
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

    expect([...collector.cache.keys()]).toEqual(["minutes", "at-dynamic-expire"]);
  });
});
