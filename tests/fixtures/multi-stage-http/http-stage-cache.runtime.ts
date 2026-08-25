import type { CdnCacheAdapter } from "vinext/shims/cdn-cache";

const NO_STORE = "no-store";

const createHttpStageCacheAdapter = (): CdnCacheAdapter => ({
  ownsBackgroundRevalidation: false,
  async get() {
    return null;
  },
  async set() {},
  buildResponseHeaders({ cacheControl }) {
    if (!cacheControl || /\b(?:private|no-cache|no-store)\b/i.test(cacheControl)) {
      return { "Cache-Control": NO_STORE };
    }
    return {
      "Cache-Control": "public, max-age=0, must-revalidate",
      "CDN-Cache-Control": cacheControl,
    };
  },
  async revalidateTag() {},
});

export default createHttpStageCacheAdapter;
