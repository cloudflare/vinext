/**
 * Image optimization request handler.
 *
 * Handles `/_vinext/image?url=...&w=...&q=...` requests. In production
 * on Cloudflare Workers, uses the Images binding (`env.IMAGES`) to
 * resize and transcode on the fly. On other runtimes (Node.js dev/prod
 * server), serves the original file as a passthrough with appropriate
 * Cache-Control headers.
 *
 * Format negotiation: inspects the `Accept` header and serves AVIF, WebP,
 * or JPEG depending on client support.
 */

/** The pathname that triggers image optimization. */
export const IMAGE_OPTIMIZATION_PATH = "/_vinext/image";

/**
 * Parse and validate image optimization query parameters.
 * Returns null if the request is malformed.
 */
export function parseImageParams(url: URL): { imageUrl: string; width: number; quality: number } | null {
  const imageUrl = url.searchParams.get("url");
  if (!imageUrl) return null;

  const w = parseInt(url.searchParams.get("w") || "0", 10);
  const q = parseInt(url.searchParams.get("q") || "75", 10);

  // Validate width (0 = no resize, otherwise must be positive)
  if (Number.isNaN(w) || w < 0) return null;
  // Validate quality (1-100)
  if (Number.isNaN(q) || q < 1 || q > 100) return null;

  // Prevent open redirect / SSRF — only allow path-relative URLs.
  // Use an allowlist approach: the URL must start with "/" (but not "//")
  // to be a valid relative path. This blocks absolute URLs (http://, https://),
  // protocol-relative (//), and exotic schemes (data:, javascript:, ftp:, etc.).
  if (!imageUrl.startsWith("/") || imageUrl.startsWith("//")) {
    return null;
  }

  return { imageUrl, width: w, quality: q };
}

/**
 * Negotiate the best output format based on the Accept header.
 * Returns an IANA media type.
 */
export function negotiateImageFormat(acceptHeader: string | null): string {
  if (!acceptHeader) return "image/jpeg";
  if (acceptHeader.includes("image/avif")) return "image/avif";
  if (acceptHeader.includes("image/webp")) return "image/webp";
  return "image/jpeg";
}

/**
 * Standard Cache-Control header for optimized images.
 * Optimized images are immutable because the URL encodes the transform params.
 */
export const IMAGE_CACHE_CONTROL = "public, max-age=31536000, immutable";
