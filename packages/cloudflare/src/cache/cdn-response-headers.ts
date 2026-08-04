import type { CdnResponseHeaders } from "vinext/shims/cdn-cache";

const NON_CACHEABLE_DIRECTIVE_RE = /\b(?:private|no-store|no-cache)\b/i;
const CACHEABLE_EDGE_DIRECTIVE_RE = /(?:^|,)\s*(?:s-maxage|max-age)\s*=/i;
const EDGE_POLICY_HEADERS = ["CDN-Cache-Control", "Cloudflare-CDN-Cache-Control"] as const;

/** Remove every response header whose cache semantics are owned by Cloudflare. */
export function clearCloudflareCdnResponseHeaders(cacheControl: string): CdnResponseHeaders {
  return {
    "Cache-Control": cacheControl,
    "CDN-Cache-Control": null,
    "Cloudflare-CDN-Cache-Control": null,
    "Cache-Tag": null,
  };
}

/** Interpret Cloudflare's edge policy before core applies a replacement policy. */
export function hasExplicitCloudflareNonCacheableResponsePolicy(headers: Headers): boolean {
  const edgePolicies = EDGE_POLICY_HEADERS.map((name) => headers.get(name));
  if (edgePolicies.some((value) => value && NON_CACHEABLE_DIRECTIVE_RE.test(value))) {
    return true;
  }

  const hasCacheableEdgePolicy = edgePolicies.some(
    (value) => value && CACHEABLE_EDGE_DIRECTIVE_RE.test(value),
  );
  const browserPolicy = headers.get("Cache-Control");
  return Boolean(
    !hasCacheableEdgePolicy && browserPolicy && NON_CACHEABLE_DIRECTIVE_RE.test(browserPolicy),
  );
}
