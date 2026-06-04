/**
 * Config-driven cache adapter contract.
 *
 * vinext's data cache handler (`./cache.ts`) and CDN cache adapter
 * (`./cdn-cache.ts`) are normally registered imperatively from a worker entry
 * via `setDataCacheHandler()` / `setCdnCacheAdapter()`. The vite plugin can do
 * this wiring for you when you point `cache.data.adapter` / `cache.cdn.adapter`
 * at an *adapter module* in your `vinext()` config:
 *
 *   vinext({
 *     cache: {
 *       cdn:  { adapter: require.resolve("vinext/cloudflare/cache/cdn-adapter") },
 *       data: { adapter: require.resolve("vinext/cloudflare/cache/kv-data-adapter") },
 *     },
 *   })
 *
 * An *adapter module* default-exports a **factory** matching one of the types
 * below. The factory is invoked once per worker isolate, on the first request,
 * with the host `env` (Cloudflare Worker bindings) so adapters that need a
 * binding — e.g. a KV namespace — can read it. Adapters that need the per-request
 * `ExecutionContext` (for `waitUntil`) read it lazily via
 * `getRequestExecutionContext()` instead of capturing it here, because `env` is
 * stable across requests but the execution context is not.
 */

import type { CacheHandler } from "./cache.js";
import type { CdnCacheAdapter } from "./cdn-cache.js";

/** Context handed to a cache adapter factory at registration time. */
export type CacheAdapterContext = {
  /**
   * The host bindings object — Cloudflare Worker `env` (KV namespaces, R2
   * buckets, Durable Object stubs, vars, …). `undefined` when no bindings are
   * available (e.g. the Node.js dev/prod server), in which case adapters that
   * require a binding should throw a clear error.
   */
  env: Record<string, unknown> | undefined;
};

/** Default export shape for a `cache.data.adapter` module. */
export type DataCacheAdapterFactory = (context: CacheAdapterContext) => CacheHandler;

/** Default export shape for a `cache.cdn.adapter` module. */
export type CdnCacheAdapterFactory = (context: CacheAdapterContext) => CdnCacheAdapter;
