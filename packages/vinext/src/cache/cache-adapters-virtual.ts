/**
 * Code generation for the `virtual:vinext-cache-adapters` module.
 *
 * The vinext vite plugin resolves this virtual module from the user's `cache`
 * config (see {@link VinextCacheConfig}). The generated module exports a single
 * `registerConfiguredCacheAdapters(env)` function that the server entries call
 * on each request (it self-guards so the adapters are instantiated only once
 * per isolate). When no cache adapters are configured the function is a no-op,
 * so the import is always safe regardless of config.
 *
 * Keeping the codegen here (pure string in → string out) makes it unit-testable
 * without spinning up a full Vite build.
 */

/** A single adapter slot — points at a module that default-exports a factory. */
export type VinextCacheAdapterConfig = {
  /**
   * Module specifier (or absolute path, e.g. from `require.resolve(...)`) whose
   * default export is a cache adapter factory. See `shims/cache-adapter.ts` for
   * the `DataCacheAdapterFactory` / `CdnCacheAdapterFactory` contract.
   */
  adapter: string;
};

/**
 * Configure cache handlers declaratively from the vite plugin config instead of
 * calling `setDataCacheHandler()` / `setCdnCacheAdapter()` from a worker entry.
 */
export type VinextCacheConfig = {
  /** Page-level ISR serving strategy (CDN cache adapter). */
  cdn?: VinextCacheAdapterConfig;
  /** Data cache (fetch / `"use cache"` / `unstable_cache`) handler. */
  data?: VinextCacheAdapterConfig;
};

/** Public virtual module id imported by the server entries. */
export const VIRTUAL_CACHE_ADAPTERS = "virtual:vinext-cache-adapters";

/**
 * Generate the source of the `virtual:vinext-cache-adapters` module for the
 * given config. Always exports `registerConfiguredCacheAdapters(env)`.
 */
export function generateCacheAdaptersModule(cache?: VinextCacheConfig): string {
  const dataAdapter = cache?.data?.adapter;
  const cdnAdapter = cache?.cdn?.adapter;

  // Nothing configured → a no-op so the unconditional import in the server
  // entries stays valid and tree-shakes to almost nothing.
  if (!dataAdapter && !cdnAdapter) {
    return [
      "// vinext: no cache.cdn/cache.data adapter configured — registration is a no-op.",
      "export function registerConfiguredCacheAdapters() {}",
      "",
    ].join("\n");
  }

  const lines: string[] = [
    "// vinext: generated from the `cache` option in your vinext() plugin config.",
  ];

  if (dataAdapter) {
    lines.push(`import __vinextDataAdapterFactory from ${JSON.stringify(dataAdapter)};`);
    lines.push(`import { setDataCacheHandler } from "vinext/shims/cache";`);
  }
  if (cdnAdapter) {
    lines.push(`import __vinextCdnAdapterFactory from ${JSON.stringify(cdnAdapter)};`);
    lines.push(`import { setCdnCacheAdapter } from "vinext/shims/cdn-cache";`);
  }

  lines.push(
    "",
    "// Adapters are instantiated once per isolate; `env` is stable across",
    "// requests, and adapters read the per-request ExecutionContext lazily.",
    "let __vinextCacheAdaptersRegistered = false;",
    "",
    "export function registerConfiguredCacheAdapters(env) {",
    "  if (__vinextCacheAdaptersRegistered) return;",
    "  __vinextCacheAdaptersRegistered = true;",
    "  const __context = { env };",
  );
  if (dataAdapter) {
    lines.push("  setDataCacheHandler(__vinextDataAdapterFactory(__context));");
  }
  if (cdnAdapter) {
    lines.push("  setCdnCacheAdapter(__vinextCdnAdapterFactory(__context));");
  }
  lines.push("}", "");

  return lines.join("\n");
}
