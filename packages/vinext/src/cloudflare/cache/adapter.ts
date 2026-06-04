/**
 * Cloudflare cache adapter contract.
 *
 * An adapter module default-exports a **factory** matching one of the types
 * below. The factory is invoked once per worker isolate, on the first request,
 * with the host `env` (Cloudflare Worker bindings) so adapters that need a
 * binding — e.g. a KV namespace — can read it, plus the JSON `options` from the
 * adapter descriptor (e.g. `{ binding: "MY_KV" }`).
 *
 * Adapters that need the per-request `ExecutionContext` (for `waitUntil`) read
 * it lazily via `getRequestExecutionContext()`, since the factory runs only once.
 */

import type { CacheHandler } from "vinext/shims/cache";
import type { CdnCacheAdapter } from "vinext/shims/cdn-cache";

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
