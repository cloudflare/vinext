// The Cloudflare cache adapters now live in the @vinext/cloudflare package.
// Re-exported here for backward compatibility of the `vinext/cloudflare` entry.
export { KVCacheHandler } from "@vinext/cloudflare/cache/kv-data-adapter.runtime";
export { runTPR, type TPROptions, type TPRResult } from "./tpr.js";
