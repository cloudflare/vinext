import type { CdnCacheAdapter } from "./cdn-cache.js";

const CDN_CACHE_ADAPTER_KEY = Symbol.for("vinext.cdnCacheAdapter");
const globals = globalThis as unknown as Record<PropertyKey, unknown>;

/** Register an adapter without loading the origin cache implementation. */
export function setCdnCacheAdapter(adapter: CdnCacheAdapter): void {
  globals[CDN_CACHE_ADAPTER_KEY] = adapter;
}

/** Keep the first declaratively configured adapter shared across duplicated stage modules. */
export function registerCdnCacheAdapter(adapter: CdnCacheAdapter): void {
  if (globals[CDN_CACHE_ADAPTER_KEY] !== undefined) return;
  globals[CDN_CACHE_ADAPTER_KEY] = adapter;
}

/** Read only an explicitly registered adapter; defaults belong to cdn-cache. */
export function getExplicitCdnCacheAdapter(): CdnCacheAdapter | null {
  return (globals[CDN_CACHE_ADAPTER_KEY] as CdnCacheAdapter | undefined) ?? null;
}
