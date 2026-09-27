import { workersCacheCdnAdapter } from "./workers-cache-cdn-adapter.js";

export {
  DEFAULT_CDN_VERSION_METADATA_BINDING,
  type CdnAdapterOptions,
} from "./workers-cache-cdn-adapter.js";

/** @deprecated Use {@link workersCacheCdnAdapter} from `@vinext/cloudflare/cache/workers-cache-cdn-adapter` instead. */
export const cdnAdapter = workersCacheCdnAdapter;
