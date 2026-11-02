/**
 * Image optimization request handler.
 *
 * Handles `/_next/image?url=...&w=...&q=...` requests. In production
 * on Cloudflare Workers, uses the Images binding (`env.IMAGES`) to
 * resize and transcode on the fly. On other runtimes (Node.js dev/prod
 * server), serves the original file as a passthrough with appropriate
 * Cache-Control headers.
 *
 * Format negotiation: inspects the `Accept` header and serves AVIF, WebP,
 * or JPEG depending on client support.
 *
 * Security: All image responses include Content-Security-Policy and
 * X-Content-Type-Options headers to prevent XSS via SVG or Content-Type
 * spoofing. SVG content is blocked by default (following Next.js behavior).
 * When `dangerouslyAllowSVG` is enabled in next.config.js, SVGs are served
 * as-is (no transformation) with security headers applied.
 *
 * Like Next.js, formats it does not optimize (SVG, ICO, ICNS, BMP, JPEG XL,
 * HEIC) and animated images are served as-is too.
 */

import { isAnimatedImage } from "./image-animation.js";
import { hasLocalMatch, type LocalPattern } from "./image-local-patterns.js";
import { setCacheStateHeaders } from "./cache-headers.js";
import { badRequestResponse } from "./http-error-responses.js";
import { ASSET_PREFIX_URL_DIR } from "../utils/asset-prefix.js";

/** The pathname that triggers image optimization (matches Next.js). */
export const IMAGE_OPTIMIZATION_PATH = "/_next/image";

/**
 * Vinext-prefixed alias for the image optimization endpoint. Accepted
 * alongside IMAGE_OPTIMIZATION_PATH so apps that wire image URLs to the
 * vinext-prefixed path continue to work; emit IMAGE_OPTIMIZATION_PATH
 * for any newly generated URLs.
 */
export const VINEXT_IMAGE_OPTIMIZATION_PATH = "/_vinext/image";

/**
 * Returns true when `pathname` is either supported image optimization
 * endpoint.
 *
 * A single trailing slash is accepted (`/_next/image/`): with
 * `trailingSlash: true`, Next.js 308-redirects `/_next/image?url=...` to
 * `/_next/image/?url=...` and then serves the slashed form — its route
 * matching strips a trailing slash before matching internal paths (see
 * getItem in packages/next/src/server/lib/router-utils/filesystem.ts).
 * Rejecting the slashed form 404'd every dev-mode next/image request under
 * `trailingSlash: true`.
 */
export function isImageOptimizationPath(pathname: string): boolean {
  if (pathname.length > 1 && pathname.endsWith("/")) {
    pathname = pathname.slice(0, -1);
  }
  return pathname === IMAGE_OPTIMIZATION_PATH || pathname === VINEXT_IMAGE_OPTIMIZATION_PATH;
}

/**
 * Image security configuration from next.config.js `images` section.
 * Controls SVG handling and security headers for the image endpoint.
 */
export type ImageConfig = {
  /** Allowed device widths. Defaults to Next.js device sizes. */
  deviceSizes?: number[];
  /** Allowed fixed-image widths. Defaults to Next.js image sizes. */
  imageSizes?: number[];
  /**
   * Allowed output qualities. When set, only the listed qualities are
   * accepted, as in Next.js. When unset, any quality from 1-100 is accepted.
   *
   * Intentional divergence from Next.js 16, which defaults this to `[75]`:
   * vinext keeps the Next.js 14/15 behaviour for an unset list so apps that
   * adopt vinext from those versions and pass `quality={N}` keep working
   * instead of getting 400s. Apps opt into Next.js 16's strict list by
   * configuring `images.qualities`.
   */
  qualities?: number[];
  /**
   * Local sources the endpoint may serve, resolved like Next.js: an app list
   * gains the static-import pattern, and an unset list becomes
   * DEFAULT_LOCAL_PATTERNS when checked.
   */
  localPatterns?: LocalPattern[];
  /** Allow SVG through the image optimization endpoint. Default: false. */
  dangerouslyAllowSVG?: boolean;
  /**
   * Allow image optimization for hostnames that resolve to private IP addresses.
   * Default: false.
   *
   * Note: This field is currently reserved for future server-side remote-image
   * fetching. vinext's image optimization endpoint only serves local files, so
   * there is no active server-side SSRF vector — the flag is consumed client-side
   * via the image shim instead.
   */
  dangerouslyAllowLocalIP?: boolean;
  /** Content-Disposition header value. Default: "inline". */
  contentDispositionType?: "inline" | "attachment";
  /** Content-Security-Policy header value. Default: "script-src 'none'; frame-src 'none'; sandbox;" */
  contentSecurityPolicy?: string;
  /** Least max-age, in seconds, of an image served as-is. Default: 14400. */
  minimumCacheTTL?: number;
  /** Most bytes read of a source before answering 413. Default: 50000000. */
  maximumResponseBody?: number;
};

/**
 * Next.js default device sizes and image sizes.
 * These are the allowed widths for image optimization when no custom
 * config is provided. Matches Next.js defaults exactly.
 */
export const DEFAULT_DEVICE_SIZES = [640, 750, 828, 1080, 1200, 1920, 2048, 3840];
export const DEFAULT_IMAGE_SIZES = [32, 48, 64, 96, 128, 256, 384];
const DEV_BLUR_MAX_WIDTH = 8;
const DEV_BLUR_QUALITY = 70;

export type ParseImageParamsOptions = {
  isDev?: boolean;
  /** `images.localPatterns`; DEFAULT_LOCAL_PATTERNS when unset. */
  localPatterns?: LocalPattern[];
};

export function resolveDevImageRedirect(
  requestUrl: URL,
  allowedWidths: number[] = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES],
  allowedQualities?: number[],
  options: ParseImageParamsOptions = { isDev: true },
): string | null {
  const params = parseImageParams(requestUrl, allowedWidths, allowedQualities, options);
  if (!params) return null;
  if (
    params.imageUrl.startsWith("/@") ||
    params.imageUrl.startsWith("/__vite") ||
    params.imageUrl.startsWith("/node_modules")
  ) {
    return null;
  }
  const resolved = new URL(params.imageUrl, requestUrl.origin);
  if (resolved.origin !== requestUrl.origin) return null;
  return resolved.pathname + resolved.search;
}

const IMAGE_OPTIMIZATION_SIGNAL = Symbol.for("vinext.image-optimization-signal");

export type ImageOptimizationSignal = {
  /** next.config and middleware response headers to send with the image. */
  middlewareHeaders: Headers;
  /** The request headers after middleware's overrides, when it set any. */
  requestHeaders: Headers | null;
  /** The image query after middleware and rewrites. */
  search: string;
};

/**
 * Mark the App Router's image endpoint response once the request has passed
 * middleware and rewrites. A host that serves images itself (the Node
 * production server) replaces the response with the image; other hosts send
 * the response unchanged. The symbol carries the signal across the built RSC
 * module boundary, so response headers cannot forge it.
 */
export function markImageOptimizationSignal(
  response: Response,
  signal: ImageOptimizationSignal,
): Response {
  Object.defineProperty(response, IMAGE_OPTIMIZATION_SIGNAL, { value: signal });
  return response;
}

/** Return the signal of a framework-created image endpoint response. */
export function readImageOptimizationSignal(response: Response): ImageOptimizationSignal | null {
  const signal: unknown = Reflect.get(response, IMAGE_OPTIMIZATION_SIGNAL);
  if (typeof signal !== "object" || signal === null) return null;
  const { middlewareHeaders, requestHeaders, search } = signal as Partial<ImageOptimizationSignal>;
  return middlewareHeaders instanceof Headers &&
    (requestHeaders === null || requestHeaders instanceof Headers) &&
    typeof search === "string"
    ? { middlewareHeaders, requestHeaders, search }
    : null;
}

const IMAGE_OPTIMIZATION_SIGNAL_TRANSPORT_HEADER = "x-vinext-stage-image-optimization";

function isHeaderEntries(value: unknown): value is [string, string][] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        Array.isArray(entry) &&
        entry.length === 2 &&
        typeof entry[0] === "string" &&
        typeof entry[1] === "string",
    )
  );
}

/**
 * Carry a signal through the response-stage transport, which drops the
 * symbol. The signal rides in the body of the bodiless carrier, with the
 * carrier's status in the token-authenticated marker.
 */
export function serializeImageOptimizationSignalForTransport(
  response: Response,
  token: string,
): Response {
  const signal = readImageOptimizationSignal(response);
  if (signal === null) return response;
  const headers = new Headers(response.headers);
  headers.set(IMAGE_OPTIMIZATION_SIGNAL_TRANSPORT_HEADER, `${token}:${response.status}`);
  return new Response(
    JSON.stringify({
      middlewareHeaders: [...signal.middlewareHeaders],
      requestHeaders: signal.requestHeaders ? [...signal.requestHeaders] : null,
      search: signal.search,
    }),
    { headers },
  );
}

/** Restore and consume a signal returned by the trusted response-stage wrapper. */
export async function restoreImageOptimizationSignalFromTransport(
  response: Response,
  token: string,
): Promise<Response> {
  const marker = response.headers.get(IMAGE_OPTIMIZATION_SIGNAL_TRANSPORT_HEADER);
  // Non-standard responses such as Worker WebSocket upgrades cannot be
  // reconstructed, and can never carry the signal.
  if (marker === null || response.status < 200 || response.status > 599) return response;
  const headers = new Headers(response.headers);
  headers.delete(IMAGE_OPTIMIZATION_SIGNAL_TRANSPORT_HEADER);
  const prefix = `${token}:`;
  const status = marker.startsWith(prefix) ? Number(marker.slice(prefix.length)) : NaN;
  if (!Number.isInteger(status) || status < 200 || status > 599) {
    // An application value under the reserved name stays inert.
    const body =
      response.status === 204 || response.status === 205 || response.status === 304
        ? null
        : response.body;
    return new Response(body, {
      headers,
      status: response.status,
      statusText: response.statusText,
    });
  }
  // The token authenticates this body as the response stage's own output.
  const transported: unknown = JSON.parse(await response.text());
  const { middlewareHeaders, requestHeaders, search } = (transported ?? {}) as Record<
    string,
    unknown
  >;
  if (
    !isHeaderEntries(middlewareHeaders) ||
    (requestHeaders !== null && !isHeaderEntries(requestHeaders)) ||
    typeof search !== "string"
  ) {
    throw new Error("Invalid image optimization signal from the response stage");
  }
  return markImageOptimizationSignal(new Response(null, { headers, status }), {
    middlewareHeaders: new Headers(middlewareHeaders),
    requestHeaders: requestHeaders ? new Headers(requestHeaders) : null,
    search,
  });
}

/**
 * Whether a local source's pipeline status carries the file's bytes. A no-body
 * success such as 204 serves no file, which Next.js rejects as an invalid
 * image.
 */
export function isImageSourceBodyStatus(status: number): boolean {
  return status >= 200 && status < 300 && status !== 204 && status !== 205;
}

/**
 * Body Next.js answers, with a 400, for a local source that yields no image:
 * a missing file, or anything middleware or routing answers in its place.
 */
export const INVALID_IMAGE_SOURCE_MESSAGE = "The requested resource isn't a valid image.";

export function invalidImageSourceResponse(): Response {
  return new Response(INVALID_IMAGE_SOURCE_MESSAGE, { status: 400 });
}

const RECURSIVE_IMAGE_URL_RE = /\/_(?:next|vinext)\/image(?:$|\/)/;

/**
 * Next.js applies this when `images.localPatterns` is unset: every local path,
 * but no query string.
 */
export const DEFAULT_LOCAL_PATTERNS: LocalPattern[] = [{ pathname: "**", search: "" }];

/**
 * Parse and validate image optimization query parameters.
 * Returns null if the request is malformed.
 *
 * Ported from Next.js:
 * test/integration/image-optimizer/test/index.test.ts
 * https://github.com/vercel/next.js/blob/canary/test/integration/image-optimizer/test/index.test.ts
 */
export function parseImageParams(
  url: URL,
  allowedWidths: number[] = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES],
  allowedQualities?: number[],
  options: ParseImageParamsOptions = {},
): { imageUrl: string; width: number; quality: number } | null {
  // Intentional hardening divergence from Next.js: reject duplicate and unknown
  // parameters so semantically identical transforms cannot occupy distinct
  // cache keys and amplify image transformation work.
  const allowedParamNames = new Set(["url", "w", "q", "dpl"]);
  for (const name of url.searchParams.keys()) {
    if (!allowedParamNames.has(name) || url.searchParams.getAll(name).length !== 1) return null;
  }

  const imageUrl = url.searchParams.get("url");
  if (!imageUrl) return null;
  if (imageUrl.length > 3072) return null;

  const widthParam = url.searchParams.get("w");
  const qualityParam = url.searchParams.get("q");
  if (!widthParam || !/^[0-9]+$/.test(widthParam)) return null;
  if (!qualityParam || !/^[0-9]+$/.test(qualityParam)) return null;

  const width = Number.parseInt(widthParam, 10);
  const quality = Number.parseInt(qualityParam, 10);
  if (String(width) !== widthParam || String(quality) !== qualityParam) return null;

  const isDevBlurWidth = options.isDev && width <= DEV_BLUR_MAX_WIDTH;
  const isDevBlurQuality = options.isDev && quality === DEV_BLUR_QUALITY;
  if (width <= 0 || (!allowedWidths.includes(width) && !isDevBlurWidth)) return null;
  if (quality < 1 || quality > 100) return null;
  // Only enforce the quality allowlist when `images.qualities` is configured.
  // Deliberately generous when unset: Next.js 16 defaults the list to [75],
  // but vinext accepts any quality 1-100 like Next.js 14/15 so apps migrating
  // from those versions don't break (see ImageConfig.qualities).
  if (allowedQualities && !allowedQualities.includes(quality) && !isDevBlurQuality) {
    return null;
  }

  // Prevent open redirect / SSRF — only allow path-relative URLs.
  // Normalize backslashes to forward slashes first: browsers and the URL
  // constructor treat /\evil.com as protocol-relative (//evil.com).
  const normalizedUrl = imageUrl.replaceAll("\\", "/");
  // The URL must start with "/" (but not "//") to be a valid relative path.
  // This blocks absolute URLs (http://, https://), protocol-relative (//),
  // backslash variants (/\), and exotic schemes (data:, javascript:, ftp:, etc.).
  if (!normalizedUrl.startsWith("/") || normalizedUrl.startsWith("//")) {
    return null;
  }
  // Double-check: after URL construction, the origin must not change.
  // This catches any remaining parser differentials.
  try {
    const base = "https://localhost";
    const resolved = new URL(normalizedUrl, base);
    if (resolved.origin !== base) {
      return null;
    }
    // A dot segment can resolve to a protocol-relative pathname without
    // changing the origin ("/a/..//evil.com" -> "//evil.com"), which a host
    // would send as an off-site redirect.
    if (resolved.pathname.startsWith("//")) {
      return null;
    }
    // Hosts fetch a local source through the application, so a source that is
    // itself the image endpoint would recurse. Next.js rejects it the same way
    // (`"url" parameter cannot be recursive` in validateParams).
    if (RECURSIVE_IMAGE_URL_RE.test(decodeURIComponent(resolved.pathname))) {
      return null;
    }
    // Next.js then requires a match in `images.localPatterns` (`"url"
    // parameter is not allowed`). Dev skips it: Vite serves statically
    // imported images from their source paths, which no pattern names.
    if (
      !options.isDev &&
      !hasLocalMatch(options.localPatterns ?? DEFAULT_LOCAL_PATTERNS, resolved)
    ) {
      return null;
    }
  } catch {
    return null;
  }

  return { imageUrl: normalizedUrl, width, quality };
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

/** Next.js's default `images.minimumCacheTTL`, in seconds. */
const DEFAULT_MINIMUM_CACHE_TTL = 14400;

/**
 * Next.js's default `images.maximumResponseBody`: the most it reads of a
 * source before answering 413.
 */
const DEFAULT_MAXIMUM_RESPONSE_BODY = 50_000_000;

/**
 * Content-Security-Policy for image optimization responses.
 * Blocks script execution and framing to prevent XSS via SVG or other
 * active content that might be served through the image endpoint.
 * Matches Next.js default: script-src 'none'; frame-src 'none'; sandbox;
 */
export const IMAGE_CONTENT_SECURITY_POLICY = "script-src 'none'; frame-src 'none'; sandbox;";

/**
 * Allowlist of Content-Types that are safe to serve from the image endpoint.
 * SVG is intentionally excluded — it can contain embedded JavaScript and is
 * essentially an XML document, not a safe raster image format.
 */
const SAFE_IMAGE_CONTENT_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/x-icon",
  "image/vnd.microsoft.icon",
  "image/x-icns",
  "image/bmp",
  "image/tiff",
  "image/jxl",
  "image/heic",
]);

/**
 * Formats Next.js serves as-is instead of optimizing (`BYPASS_TYPES` in
 * packages/next/src/server/image-optimizer.ts), with ICO's registered name.
 */
const BYPASS_IMAGE_CONTENT_TYPES = new Set([
  "image/svg+xml",
  "image/x-icon",
  "image/vnd.microsoft.icon",
  "image/x-icns",
  "image/bmp",
  "image/jxl",
  "image/heic",
]);

/** Formats Next.js serves as-is when animated (`ANIMATABLE_TYPES`). */
const ANIMATABLE_IMAGE_CONTENT_TYPES = new Set(["image/webp", "image/png", "image/gif"]);

/** Next.js's 400 body for a source whose type it does not serve, such as SVG. */
export const IMAGE_TYPE_NOT_ALLOWED_MESSAGE =
  '"url" parameter is valid but image type is not allowed';

function imageTypeNotAllowedResponse(): Response {
  return new Response(IMAGE_TYPE_NOT_ALLOWED_MESSAGE, { status: 400 });
}

function imageMediaType(contentType: string | null): string {
  return contentType?.split(";")[0].trim().toLowerCase() ?? "";
}

/**
 * Check if a Content-Type header value is a safe image type.
 * Returns false for SVG (unless dangerouslyAllowSVG is true), HTML, or any non-image type.
 */
export function isSafeImageContentType(
  contentType: string | null,
  dangerouslyAllowSVG = false,
): boolean {
  // Extract the media type, ignoring parameters (e.g., charset)
  const mediaType = imageMediaType(contentType);
  if (SAFE_IMAGE_CONTENT_TYPES.has(mediaType)) return true;
  if (dangerouslyAllowSVG && mediaType === "image/svg+xml") return true;
  return false;
}

/**
 * Apply security headers to an image optimization response.
 * These headers are set on every response from the image endpoint,
 * regardless of whether the image was transformed or served as-is.
 * When an ImageConfig is provided, uses its values for CSP and Content-Disposition.
 */
function setImageSecurityHeaders(headers: Headers, config?: ImageConfig): void {
  headers.set(
    "Content-Security-Policy",
    config?.contentSecurityPolicy ?? IMAGE_CONTENT_SECURITY_POLICY,
  );
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set(
    "Content-Disposition",
    config?.contentDispositionType === "attachment" ? "attachment" : "inline",
  );
}

/**
 * Cache state for a successful image response, sent as both `X-Nextjs-Cache`
 * and `X-Vinext-Cache`.
 *
 * Next.js keeps optimized images in an image cache and labels each 200 with
 * where the bytes came from: `MISS` when the optimizer ran for this request,
 * `HIT` or `STALE` when the cache served them. vinext has no image cache on any
 * runtime, so every successful response is transformed (or passed through) from
 * the source for the request that receives it. Next.js behaves the same way
 * when its image cache is disabled (`images.maximumDiskCacheSize: 0`): every
 * 200 is a `MISS`. `HIT` and `STALE` need a cache of optimized images.
 *
 * Next.js sets the header after its ETag check, so a 304 and error responses
 * go out without it. Only full image responses carry either header here too.
 */
export const IMAGE_RESPONSE_CACHE_STATE = "MISS";

/** Headers shared by every successful image response, transformed or not. */
function setImageResponseHeaders(
  headers: Headers,
  cacheControl: string,
  config?: ImageConfig,
): void {
  headers.set("Cache-Control", cacheControl);
  headers.set("Vary", "Accept");
  setImageSecurityHeaders(headers, config);
  setCacheStateHeaders(headers, IMAGE_RESPONSE_CACHE_STATE);
}

/** The `s-maxage` or `max-age` of a Cache-Control value, like Next.js' getMaxAge. */
function cacheControlMaxAge(cacheControl: string | null): number {
  const directives = new Map<string, string | undefined>();
  for (const directive of cacheControl?.split(",") ?? []) {
    const [key, value] = directive.trim().split("=", 2);
    directives.set(key.toLowerCase(), value?.toLowerCase());
  }
  let age = directives.get("s-maxage") || directives.get("max-age") || "";
  if (age.startsWith('"') && age.endsWith('"')) age = age.slice(1, -1);
  const seconds = Number.parseInt(age, 10);
  return Number.isNaN(seconds) ? 0 : seconds;
}

/**
 * Next.js's Cache-Control for a source it serves as-is: a hashed build asset
 * stays immutable, and any other source is revalidated after the larger of
 * `images.minimumCacheTTL` and the source's own max-age. Next.js ignores the
 * source's max-age when it falls back after a failed transform, so that
 * fallback passes null.
 */
export function sourceImageCacheControl(
  imageUrl: string,
  upstreamCacheControl: string | null,
  config?: ImageConfig,
): string {
  const { pathname } = new URL(imageUrl, "http://localhost");
  if (pathname.includes(`/${ASSET_PREFIX_URL_DIR}/`)) return IMAGE_CACHE_CONTROL;
  const maxAge = Math.max(
    config?.minimumCacheTTL ?? DEFAULT_MINIMUM_CACHE_TTL,
    cacheControlMaxAge(upstreamCacheControl),
  );
  return `public, max-age=${maxAge}, must-revalidate`;
}

function createPassthroughImageResponse(
  source: Response,
  body: BodyInit | null,
  cacheControl: string,
  config?: ImageConfig,
): Response {
  const headers = new Headers(source.headers);
  setImageResponseHeaders(headers, cacheControl, config);
  return new Response(body, { status: 200, headers });
}

/** Next.js's 413 for a source larger than `images.maximumResponseBody`. */
function sourceTooLargeResponse(): Response {
  return new Response('"url" parameter is valid but internal response is invalid', {
    status: 413,
  });
}

/** Read a source body, or return null once it exceeds `limit` bytes. */
async function readBoundedBody(
  body: ReadableStream<Uint8Array>,
  declaredLength: string | null,
  limit: number,
): Promise<Uint8Array<ArrayBuffer> | null> {
  if (declaredLength !== null && Number(declaredLength) > limit) {
    await body.cancel();
    return null;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * Handlers for image optimization I/O operations.
 * Workers provide these callbacks to adapt their specific bindings.
 */
export type ImageHandlers = {
  /** Fetch the source image from storage (e.g., Cloudflare ASSETS binding). */
  fetchAsset: (path: string, request: Request) => Promise<Response>;
  /** Optional: Transform the image (resize, format, quality). */
  transformImage?: (
    body: ReadableStream,
    options: { width: number; format: string; quality: number },
  ) => Promise<Response>;
};

/**
 * Handle image optimization requests.
 *
 * Parses and validates the request, fetches the source image via the provided
 * handlers, optionally transforms it, and returns the response with appropriate
 * cache headers.
 */
export async function handleImageOptimization(
  request: Request,
  handlers: ImageHandlers,
  allowedWidths?: number[],
  imageConfig?: ImageConfig,
): Promise<Response> {
  const url = new URL(request.url);
  const params = parseImageParams(url, allowedWidths, imageConfig?.qualities, {
    localPatterns: imageConfig?.localPatterns,
  });

  if (!params) {
    return badRequestResponse();
  }

  const { imageUrl, width, quality } = params;

  // Fetch source image
  const source = await handlers.fetchAsset(imageUrl, request);
  if (!source.ok || !source.body) {
    return invalidImageSourceResponse();
  }

  // Negotiate output format from Accept header
  const format = negotiateImageFormat(request.headers.get("Accept"));

  // Block unsafe Content-Types (e.g., SVG which can contain embedded scripts).
  // Check the source Content-Type before any processing. SVG is only allowed
  // when dangerouslyAllowSVG is explicitly enabled in next.config.js.
  const sourceContentType = source.headers.get("Content-Type");
  if (!isSafeImageContentType(sourceContentType, imageConfig?.dangerouslyAllowSVG)) {
    return imageTypeNotAllowedResponse();
  }

  // Like Next.js, serve a format it does not optimize as-is, SVG included
  // once dangerouslyAllowSVG admitted it above.
  const sourceMediaType = imageMediaType(sourceContentType);
  const sourceCacheControl = sourceImageCacheControl(
    imageUrl,
    source.headers.get("Cache-Control"),
    imageConfig,
  );
  if (BYPASS_IMAGE_CONTENT_TYPES.has(sourceMediaType)) {
    const response = createPassthroughImageResponse(
      source,
      source.body,
      sourceCacheControl,
      imageConfig,
    );
    // Next.js labels an ICO by its detected type, `image/x-icon`, where
    // Workers static assets use the registered `image/vnd.microsoft.icon`.
    if (sourceMediaType === "image/vnd.microsoft.icon") {
      response.headers.set("Content-Type", "image/x-icon");
    }
    return response;
  }

  // Transform if handler provided, otherwise serve original
  let sourceBytes: Uint8Array<ArrayBuffer> | null = null;
  if (handlers.transformImage) {
    try {
      let body = source.body;
      // Next.js serves an animated image as-is rather than flattening it to
      // one frame, which takes reading the whole source, up to the size
      // Next.js reads at most.
      if (ANIMATABLE_IMAGE_CONTENT_TYPES.has(sourceMediaType)) {
        sourceBytes = await readBoundedBody(
          source.body,
          source.headers.get("Content-Length"),
          imageConfig?.maximumResponseBody ?? DEFAULT_MAXIMUM_RESPONSE_BODY,
        );
        if (sourceBytes === null) return sourceTooLargeResponse();
        if (isAnimatedImage(sourceBytes)) {
          return createPassthroughImageResponse(
            source,
            sourceBytes,
            sourceCacheControl,
            imageConfig,
          );
        }
        body = new Blob([sourceBytes]).stream();
      }
      const transformed = await handlers.transformImage(body, {
        width,
        format,
        quality,
      });
      const headers = new Headers(transformed.headers);
      setImageResponseHeaders(headers, IMAGE_CACHE_CONTROL, imageConfig);

      // Verify the transformed response also has a safe Content-Type.
      // A malicious or buggy transform handler could return HTML.
      if (!isSafeImageContentType(headers.get("Content-Type"), imageConfig?.dangerouslyAllowSVG)) {
        headers.set("Content-Type", format);
      }

      return new Response(transformed.body, { status: 200, headers });
    } catch (e) {
      console.error("[vinext] Image optimization error:", e);
    }
  }

  // Fallback: serve original image with cache headers. Without an optimizer
  // the source is served as-is; after a failed transform Next.js keeps it
  // for the minimum TTL only.
  const fallbackCacheControl = handlers.transformImage
    ? sourceImageCacheControl(imageUrl, null, imageConfig)
    : sourceCacheControl;
  try {
    return createPassthroughImageResponse(
      source,
      sourceBytes ?? source.body,
      fallbackCacheControl,
      imageConfig,
    );
  } catch (e) {
    console.error("[vinext] Image fallback error, refetching source image:", e);
    const refetchedSource = await handlers.fetchAsset(imageUrl, request);
    if (!refetchedSource.ok || !refetchedSource.body) {
      return invalidImageSourceResponse();
    }

    const refetchedContentType = refetchedSource.headers.get("Content-Type");
    if (!isSafeImageContentType(refetchedContentType, imageConfig?.dangerouslyAllowSVG)) {
      return imageTypeNotAllowedResponse();
    }

    return createPassthroughImageResponse(
      refetchedSource,
      refetchedSource.body,
      fallbackCacheControl,
      imageConfig,
    );
  }
}

// ---------------------------------------------------------------------------
// Configured image optimizer registry.
//
// The image optimizer is the pluggable transform backend (e.g. Cloudflare
// Images via `env.IMAGES`). It is configured declaratively through the
// `images` option on the `vinext()` plugin — see `image/image-adapters-virtual.ts`
// — and registered on the first request by the generated
// `virtual:vinext-image-adapters` module, which imports `setImageOptimizer`
// from here.
//
// The active optimizer is stored on `globalThis` via `Symbol.for` so a single
// registration is visible across the separate RSC and SSR Vite environments
// (they load distinct module instances), mirroring the data-cache handler
// resolution in `shims/cache.ts`. When no optimizer is registered (no adapter
// configured, or the adapter factory threw on a runtime without the required
// binding — e.g. Node.js / dev), image requests fall back to serving the
// original asset unoptimized.
// ---------------------------------------------------------------------------

/**
 * A server-side image optimizer: the transform backend that resizes/transcodes
 * a source image. Produced by an adapter factory (e.g. `imagesOptimizer()` from
 * `@vinext/cloudflare/images/images-optimizer`) and registered via
 * {@link setImageOptimizer}.
 */
export type ImageOptimizer = {
  /** Transform the source image (resize, format, quality). */
  transformImage: (
    body: ReadableStream,
    options: { width: number; format: string; quality: number },
  ) => Promise<Response>;
};

const _IMAGE_OPTIMIZER_KEY = Symbol.for("vinext.imageOptimizer");
const _gImageOptimizer = globalThis as unknown as Record<PropertyKey, ImageOptimizer | undefined>;

/**
 * Register the active image optimizer (transform backend). An explicit
 * registration always wins; passing `null` clears it (falling back to
 * unoptimized passthrough).
 *
 * Configure this declaratively via the `images.optimizer` option on the
 * `vinext()` plugin in your `vite.config.ts` rather than calling it directly.
 * On Cloudflare Workers:
 *
 * ```ts
 * import { vinext } from "vinext";
 * import { imagesOptimizer } from "@vinext/cloudflare/images/images-optimizer";
 *
 * export default defineConfig({
 *   plugins: [vinext({ images: { optimizer: imagesOptimizer() } })],
 * });
 * ```
 *
 * The plugin registers the optimizer across every runtime/router entry, so you
 * don't have to wire `env.IMAGES` into a custom worker entry. This setter
 * remains the internal registration target.
 */
export function setImageOptimizer(optimizer: ImageOptimizer | null): void {
  _gImageOptimizer[_IMAGE_OPTIMIZER_KEY] = optimizer ?? undefined;
}

/** Get the active image optimizer, or `null` when none is configured. */
export function getImageOptimizer(): ImageOptimizer | null {
  return _gImageOptimizer[_IMAGE_OPTIMIZER_KEY] ?? null;
}

/**
 * Handle an image optimization request using the configured optimizer (if any).
 *
 * This is the single entry point every runtime/router seam (App Router worker,
 * Pages worker, Node prod server) should call: it reads the registered
 * {@link ImageOptimizer} and wires its `transformImage` into
 * {@link handleImageOptimization}, with the caller supplying the runtime's
 * `fetchAsset` (e.g. the Cloudflare `ASSETS` binding, or filesystem reads on
 * Node). When no optimizer is registered, the request is served unoptimized
 * (passthrough) with the same security/cache headers.
 */
export function handleConfiguredImageOptimization(
  request: Request,
  fetchAsset: (path: string, request: Request) => Promise<Response>,
  allowedWidths?: number[],
  imageConfig?: ImageConfig,
): Promise<Response> {
  const optimizer = getImageOptimizer();
  return handleImageOptimization(
    request,
    {
      fetchAsset,
      // Wrap rather than detach the method so an optimizer implemented as a
      // class instance keeps its `this` binding.
      transformImage: optimizer
        ? (body, options) => optimizer.transformImage(body, options)
        : undefined,
    },
    allowedWidths,
    imageConfig,
  );
}
