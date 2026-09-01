import type { CdnCacheAdapter } from "vinext/shims/cdn-cache";

const NO_STORE = "no-store";

const createHttpStageCacheAdapter = (): CdnCacheAdapter => ({
  ownsBackgroundRevalidation: false,
  async get() {
    return null;
  },
  async set() {},
  buildResponseHeaders({ cacheControl, tags }) {
    if (!cacheControl || /\b(?:private|no-cache|no-store)\b/i.test(cacheControl)) {
      return { "Cache-Control": NO_STORE };
    }
    return {
      "Cache-Control": "public, max-age=0, must-revalidate",
      "Cache-Tag": tags?.join(",") ?? null,
      "CDN-Cache-Control": cacheControl,
    };
  },
  async revalidateTag(tags) {
    const purge = Reflect.get(globalThis, Symbol.for("vinext.fixture.httpStageHostCachePurge"));
    if (typeof purge === "function") purge(Array.isArray(tags) ? tags : [tags]);
  },
});

export default createHttpStageCacheAdapter;
