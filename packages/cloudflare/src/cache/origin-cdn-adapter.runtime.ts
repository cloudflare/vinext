/**
 * Cloudflare header ownership with origin-managed ISR storage.
 *
 * This adapter preserves the default vinext page-cache strategy while owning
 * Cloudflare-specific response header cleanup. Use the edge-managed
 * `cdnAdapter()` instead when Cloudflare's CDN should serve page-level ISR.
 */
import {
  DefaultCdnCacheAdapter,
  type CdnCacheAdapter,
  type CdnCacheableHeaderInput,
  type CdnResponseHeaders,
} from "vinext/shims/cdn-cache";
import {
  clearCloudflareCdnResponseHeaders,
  hasExplicitCloudflareNonCacheableResponsePolicy,
} from "./cdn-response-headers.js";

export class CloudflareOriginCdnCacheAdapter extends DefaultCdnCacheAdapter {
  override buildResponseHeaders(input: CdnCacheableHeaderInput): CdnResponseHeaders {
    const cacheControl = super.buildResponseHeaders(input)["Cache-Control"] ?? "";
    return clearCloudflareCdnResponseHeaders(cacheControl);
  }

  hasExplicitNonCacheableResponsePolicy(headers: Headers): boolean {
    return hasExplicitCloudflareNonCacheableResponsePolicy(headers);
  }
}

const createCloudflareOriginCdnCacheAdapter = (): CdnCacheAdapter =>
  new CloudflareOriginCdnCacheAdapter();

export default createCloudflareOriginCdnCacheAdapter;
