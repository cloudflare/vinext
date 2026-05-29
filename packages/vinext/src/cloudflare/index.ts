/**
 * vinext/cloudflare — Cloudflare Workers integration.
 *
 * Provides cache handlers and utilities for running vinext on Cloudflare Workers.
 *
 * Page-level ISR auto-switches to the edge-managed CDN cache adapter whenever
 * the request context exposes the Workers Cache (`ctx.cache`, enabled via
 * `[cache] enabled = true` in wrangler.jsonc). That selection happens in core
 * (see `getCdnCacheAdapter` in `vinext/shims/cdn-cache`) and needs no import or
 * registration. An explicit `setCdnCacheAdapter(...)` always takes precedence.
 */

export { KVCacheHandler } from "./kv-cache-handler.js";
export { CloudflareCdnCacheAdapter } from "./cloudflare-cdn-cache.js";
export { runTPR, type TPROptions, type TPRResult } from "./tpr.js";
