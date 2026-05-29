/**
 * Cloudflare CDN cache adapter.
 *
 * The edge-managed ISR adapter now lives in core as
 * {@link RequestContextCdnCacheAdapter}: it depends only on the generic
 * request-context cache surface (`ctx.cache`), not on anything
 * Cloudflare-specific, and core selects it automatically whenever that surface
 * is present — see `getCdnCacheAdapter` in `vinext/shims/cdn-cache`. No import
 * or registration is required for it to activate.
 *
 * This alias is kept as the Cloudflare-facing name and for backwards
 * compatibility with existing imports of `CloudflareCdnCacheAdapter`.
 */
export { RequestContextCdnCacheAdapter as CloudflareCdnCacheAdapter } from "vinext/shims/cdn-cache";
