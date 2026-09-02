import type { CdnCacheAdapter } from "vinext/shims/cdn-cache";

const NO_STORE = "no-store";
const KNOWN_ROUTE_FALLBACK_KEY_SUFFIX = ":/en/ppr/[id]:html";
export const KNOWN_ROUTE_FALLBACK_MARKER = "HTTP_STAGE_WRONG_FALLBACK_SHELL";

const createHttpStageCacheAdapter = (): CdnCacheAdapter => ({
  ownsBackgroundRevalidation: false,
  async get(key) {
    if (
      process.env.VINEXT_HTTP_STAGE_FALLBACK_SHELL === "1" &&
      key.endsWith(KNOWN_ROUTE_FALLBACK_KEY_SUFFIX)
    ) {
      return {
        cacheControl: { revalidate: 60 },
        lastModified: Date.now(),
        value: {
          headers: undefined,
          html: `<html><body>${KNOWN_ROUTE_FALLBACK_MARKER}</body></html>`,
          kind: "APP_PAGE",
          postponed: undefined,
          rscData: undefined,
          status: undefined,
        },
      };
    }
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
