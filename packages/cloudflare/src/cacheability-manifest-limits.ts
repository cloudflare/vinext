export const MAX_CACHEABILITY_MANIFEST_BYTES = 1024 * 1024;
export const MAX_CACHEABILITY_MANIFEST_ROUTES = 10_000;

export function cacheabilityManifestRouteLimitError(
  routeCount: number,
  limit = MAX_CACHEABILITY_MANIFEST_ROUTES,
): Error {
  return new Error(
    `Two-stage CDN warming produced ${routeCount} cacheable route patterns; the limit is ${limit}. Split the deployment before retrying.`,
  );
}

export function cacheabilityManifestByteLimitError(
  manifestBytes: number,
  limit = MAX_CACHEABILITY_MANIFEST_BYTES,
): Error {
  return new Error(
    `Two-stage CDN warming produced a ${manifestBytes}-byte route-pattern cacheability manifest; the limit is ${limit} bytes. Reduce the number or length of route patterns, or split the deployment before retrying.`,
  );
}
