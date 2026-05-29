/**
 * vinext/cloudflare — Cloudflare Workers integration.
 *
 * Provides cache handlers and utilities for running vinext on Cloudflare Workers.
 *
 * Importing this module (which the generated ISR worker entry does for
 * `KVCacheHandler`) registers a CDN cache adapter detector: when the request
 * context exposes the Workers Cache (`ctx.cache`), page-level ISR automatically
 * switches to the edge-managed {@link CloudflareCdnCacheAdapter}. An explicit
 * `setCdnCacheAdapter(...)` call always takes precedence.
 */

import { registerCdnCacheAdapterDetector } from "vinext/shims/cdn-cache";
import { getRequestExecutionContext } from "vinext/shims/request-context";
import { CloudflareCdnCacheAdapter } from "./cloudflare-cdn-cache.js";

export { KVCacheHandler } from "./kv-cache-handler.js";
export { CloudflareCdnCacheAdapter } from "./cloudflare-cdn-cache.js";
export { runTPR, type TPROptions, type TPRResult } from "./tpr.js";

// Register the Workers-Cache auto-detector exactly once per isolate, even when
// this module is evaluated in multiple Vite environments (RSC + SSR). The guard
// lives on globalThis so the (also-global) detector list gets a single entry.
const _REGISTERED_KEY = Symbol.for("vinext.cloudflareCdnDetectorRegistered");
const _g = globalThis as unknown as Record<PropertyKey, unknown>;
if (!_g[_REGISTERED_KEY]) {
  _g[_REGISTERED_KEY] = true;
  let singleton: CloudflareCdnCacheAdapter | null = null;
  registerCdnCacheAdapterDetector(() => {
    // Only activate when the Workers Cache is present in the request context.
    if (!getRequestExecutionContext()?.cache) return null;
    return (singleton ??= new CloudflareCdnCacheAdapter());
  });
}
