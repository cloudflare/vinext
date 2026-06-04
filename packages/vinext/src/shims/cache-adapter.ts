/**
 * Config-driven cache adapter contract.
 *
 * vinext's data cache handler (`./cache.ts`) and CDN cache adapter
 * (`./cdn-cache.ts`) are normally registered imperatively from a worker entry
 * via `setDataCacheHandler()` / `setCdnCacheAdapter()`. The vite plugin can do
 * this wiring for you when you set the `cache` option in your `vinext()` config:
 *
 *   import { kvDataAdapter } from "vinext/cloudflare/cache/kv-data-adapter";
 *   import { cdnAdapter } from "vinext/cloudflare/cache/cdn-adapter";
 *
 *   vinext({
 *     cache: {
 *       cdn:  cdnAdapter(),
 *       data: kvDataAdapter({ binding: "MY_KV" }),
 *     },
 *   })
 *
 * Each slot is a {@link CacheAdapterDescriptor} — a *serializable* pointer to an
 * adapter module plus JSON options. The builders above (and a bare
 * `{ adapter: require.resolve("…") }`) produce one without touching the Workers
 * runtime, so nothing is instantiated at config / build / dev time. The plugin
 * generates a `virtual:vinext-cache-adapters` module that, on the first request,
 * imports each adapter module's **default export** (a factory matching the
 * types below) and calls it with the host `env` and your options — so adapters
 * that need a binding (e.g. a KV namespace) resolve it at runtime.
 *
 * `env` is stable across requests, so adapters are instantiated once per
 * isolate. Adapters that need the per-request `ExecutionContext` (for
 * `waitUntil`) read it lazily via `getRequestExecutionContext()`.
 */

import type { CacheHandler } from "./cache.js";
import type { CdnCacheAdapter } from "./cdn-cache.js";

/**
 * A serializable pointer to a cache adapter module. Produced by an adapter
 * builder (e.g. `kvDataAdapter(...)`) or written by hand. `options` must be
 * JSON-serializable — it is inlined into the generated registration module and
 * forwarded to the factory at runtime.
 */
export type CacheAdapterDescriptor<O extends Record<string, unknown> = Record<string, unknown>> = {
  /**
   * Module specifier (or absolute path, e.g. from `require.resolve(...)`) whose
   * default export is a cache adapter factory.
   */
  adapter: string;
  /** JSON-serializable options forwarded to the factory at runtime. */
  options?: O;
};

/**
 * Configure cache handlers declaratively from the vite plugin config instead of
 * calling `setDataCacheHandler()` / `setCdnCacheAdapter()` from a worker entry.
 */
export type VinextCacheConfig = {
  /** Page-level ISR serving strategy (CDN cache adapter). */
  cdn?: CacheAdapterDescriptor;
  /** Data cache (fetch / `"use cache"` / `unstable_cache`) handler. */
  data?: CacheAdapterDescriptor;
};

/** Context handed to a cache adapter factory at registration time. */
export type CacheAdapterContext<O extends Record<string, unknown> = Record<string, unknown>> = {
  /**
   * The host bindings object — Cloudflare Worker `env` (KV namespaces, R2
   * buckets, Durable Object stubs, vars, …). `undefined` when no bindings are
   * available (e.g. the Node.js dev/prod server), in which case adapters that
   * require a binding should throw a clear error.
   */
  env: Record<string, unknown> | undefined;
  /**
   * The JSON options from the adapter descriptor (e.g. `{ binding: "MY_KV" }`),
   * or `undefined` when none were supplied.
   */
  options: O | undefined;
};

/** Default export shape for a data cache adapter module. */
export type DataCacheAdapterFactory<O extends Record<string, unknown> = Record<string, unknown>> = (
  context: CacheAdapterContext<O>,
) => CacheHandler;

/** Default export shape for a CDN cache adapter module. */
export type CdnCacheAdapterFactory<O extends Record<string, unknown> = Record<string, unknown>> = (
  context: CacheAdapterContext<O>,
) => CdnCacheAdapter;
