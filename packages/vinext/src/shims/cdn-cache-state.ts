import type { CdnCacheAdapter } from "./cdn-cache.js";

const CDN_CACHE_ADAPTER_KEY = Symbol.for("vinext.cdnCacheAdapter");
const globals = globalThis as unknown as Record<PropertyKey, unknown>;

/** Register an adapter without loading the origin cache implementation. */
export function setCdnCacheAdapter(adapter: CdnCacheAdapter): void {
  globals[CDN_CACHE_ADAPTER_KEY] = adapter;
}

/**
 * Lazily keep the first declaratively configured adapter shared across
 * duplicated stage modules. Failed factories remain retryable so a later
 * entrypoint with the required runtime bindings can register successfully.
 */
export function registerCdnCacheAdapter(factory: () => CdnCacheAdapter): void {
  if (globals[CDN_CACHE_ADAPTER_KEY] !== undefined) return;
  const adapter = factory();
  // Preserve an imperative adapter installed re-entrantly by the factory.
  if (globals[CDN_CACHE_ADAPTER_KEY] === undefined) {
    globals[CDN_CACHE_ADAPTER_KEY] = adapter;
  }
}

/** Read only an explicitly registered adapter; defaults belong to cdn-cache. */
export function getExplicitCdnCacheAdapter(): CdnCacheAdapter | null {
  return (globals[CDN_CACHE_ADAPTER_KEY] as CdnCacheAdapter | undefined) ?? null;
}
