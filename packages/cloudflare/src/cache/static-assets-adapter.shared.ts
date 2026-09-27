import type { CacheControlMetadata } from "vinext/shims/cache-handler";

export const STATIC_ASSET_CACHE_PATH = "/_vinext/static-cache";

export type StaticAssetCacheMetadata = {
  kind: "html" | "rsc" | "route";
  lastModified: number;
  cacheControl?: CacheControlMetadata;
  headers?: Record<string, string | string[]>;
  status?: number;
};

export type StaticAssetCacheIndex = Record<string, StaticAssetCacheMetadata>;
