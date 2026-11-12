import type { CacheControlMetadata } from "vinext/shims/cache-handler";

export const STATIC_ASSET_CACHE_PATH = "/_vinext/static-cache";

export type StaticAssetCacheMetadata = {
  kind: "html" | "rsc" | "route" | "pages" | "redirect" | "not-found";
  lastModified: number;
  cacheControl?: CacheControlMetadata;
  headers?: Record<string, string | string[]>;
  status?: number;
  /**
   * A fallback shell's resume data cache, packaged as `<id>.postponed` beside
   * its HTML so the index stays small.
   */
  postponed?: true;
};

export type StaticAssetCacheIndex = Record<string, StaticAssetCacheMetadata>;
