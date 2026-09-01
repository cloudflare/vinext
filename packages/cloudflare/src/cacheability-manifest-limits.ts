export const MAX_CACHEABILITY_MANIFEST_BYTES = 2 * 1024 * 1024;

export function cacheabilityManifestByteLimitError(
  manifestBytes: number,
  limit = MAX_CACHEABILITY_MANIFEST_BYTES,
): Error {
  return new Error(
    `Two-stage CDN warming produced a ${manifestBytes}-byte route-pattern cacheability manifest; the limit is ${limit} bytes. Reduce the number or length of route patterns, or split the deployment before retrying.`,
  );
}
