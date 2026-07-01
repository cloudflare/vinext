/**
 * Canonical image-optimization endpoint constants and predicate.
 *
 * Split out from `image-optimization.ts` so the cheap path facts can be
 * imported on hot request paths (e.g. the dev-server passthrough in
 * `index.ts`) without pulling in the full optimization handler, format
 * negotiation, and security-header machinery. `image-optimization.ts`
 * re-exports these so existing importers of `vinext/server/image-optimization`
 * keep working — this module is the single source of truth.
 */

/** The pathname that triggers image optimization (matches Next.js). */
export const IMAGE_OPTIMIZATION_PATH = "/_next/image";

/**
 * Vinext-prefixed alias for the image optimization endpoint. Accepted
 * alongside IMAGE_OPTIMIZATION_PATH so apps that wire image URLs to the
 * vinext-prefixed path continue to work; emit IMAGE_OPTIMIZATION_PATH
 * for any newly generated URLs.
 */
export const VINEXT_IMAGE_OPTIMIZATION_PATH = "/_vinext/image";

/** Returns true when `pathname` is either supported image optimization endpoint. */
export function isImageOptimizationPath(pathname: string): boolean {
  return pathname === IMAGE_OPTIMIZATION_PATH || pathname === VINEXT_IMAGE_OPTIMIZATION_PATH;
}
