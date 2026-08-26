export const MAX_CACHEABILITY_MANIFEST_BYTES = 1024 * 1024;
export const MAX_CACHEABILITY_MANIFEST_ROUTES = 10_000;

export function cacheabilityManifestRouteLimitError(
  routeCount: number,
  limit = MAX_CACHEABILITY_MANIFEST_ROUTES,
): Error {
  return new Error(
    `Two-stage CDN warming produced ${routeCount} cacheable identities; the limit is ${limit}. Narrow prerender discovery or split the deployment before retrying.`,
  );
}

export function cacheabilityManifestByteLimitError(
  manifestBytes: number,
  limit = MAX_CACHEABILITY_MANIFEST_BYTES,
): Error {
  return new Error(
    `Two-stage CDN warming produced a ${manifestBytes}-byte cacheability manifest; the limit is ${limit} bytes. Narrow prerender discovery or split the deployment before retrying.`,
  );
}
