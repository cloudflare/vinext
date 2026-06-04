/**
 * Runtime factory for the Cloudflare edge CDN cache adapter.
 *
 * This is the module the generated `virtual:vinext-cache-adapters` registration
 * imports (its default export). It runs on the Worker at request time and
 * returns a {@link CloudflareCdnCacheAdapter}, which serves page-level ISR from
 * the Cloudflare Workers Cache (edge-managed).
 *
 * Configure it from vite.config via the {@link cdnAdapter} builder in
 * `./cdn-adapter.ts` — that builder `require.resolve`s this file.
 */

import type { CdnCacheAdapterFactory } from "vinext/shims/cache-adapter";
import { CloudflareCdnCacheAdapter } from "../cloudflare-cdn-cache.js";

const createCloudflareCdnCacheAdapter: CdnCacheAdapterFactory = () =>
  new CloudflareCdnCacheAdapter();

export default createCloudflareCdnCacheAdapter;
