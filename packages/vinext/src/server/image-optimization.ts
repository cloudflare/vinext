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
import {
  ImageSourceReader,
  ImageSourceTooLargeError,
  LimitedImageSource,
} from "./image-source-reader.js";
import { hasLocalMatch, type LocalPattern } from "./image-local-patterns.js";
import { setCacheStateHeaders } from "./cache-headers.js";
import { badRequestResponse } from "./http-error-responses.js";

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
  /**
   * Most bytes of a GIF, PNG or WebP source read for optimization before
   * answering 413. Default: 50000000.
   */
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

/** The most of a source the image endpoint reads before answering 413. */
export function imageSourceLimit(imageConfig: ImageConfig | undefined): number {
  return imageConfig?.maximumResponseBody ?? DEFAULT_MAXIMUM_RESPONSE_BODY;
}

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

/** An ISOBMFF `ftyp` box with the given major brand, as Next.js' `hasFtypBox`. */
type FtypBrand = { readonly ftypBrand: readonly [number, number, number, number] };

/**
 * Next.js's image signatures (`detectContentType` in
 * packages/next/src/server/image-optimizer/detect-content-type.ts); a null
 * byte matches any value.
 */
const IMAGE_SIGNATURES: ReadonlyArray<readonly [string, ReadonlyArray<number | null> | FtypBrand]> =
  [
    ["image/jpeg", [0xff, 0xd8, 0xff]],
    ["image/png", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
    ["image/gif", [0x47, 0x49, 0x46, 0x38]],
    ["image/webp", [0x52, 0x49, 0x46, 0x46, null, null, null, null, 0x57, 0x45, 0x42, 0x50]],
    ["image/svg+xml", [0x3c, 0x3f, 0x78, 0x6d, 0x6c]],
    ["image/svg+xml", [0x3c, 0x73, 0x76, 0x67]],
    ["image/avif", { ftypBrand: [0x61, 0x76, 0x69, 0x66] }],
    ["image/x-icon", [0x00, 0x00, 0x01, 0x00]],
    ["image/x-icns", [0x69, 0x63, 0x6e, 0x73]],
    ["image/tiff", [0x49, 0x49, 0x2a, 0x00]],
    ["image/bmp", [0x42, 0x4d]],
    ["image/jxl", [0xff, 0x0a]],
    ["image/jxl", [0x00, 0x00, 0x00, 0x0c, 0x4a, 0x58, 0x4c, 0x20, 0x0d, 0x0a, 0x87, 0x0a]],
    ["image/heic", { ftypBrand: [0x68, 0x65, 0x69, 0x63] }],
  ];

/** The bytes every signature fits in. */
const IMAGE_SIGNATURE_LENGTH = 12;

/**
 * The most of a source read to identify it: Next.js looks for an SVG root
 * element in the first 1000 bytes.
 */
export const IMAGE_DETECTION_LENGTH = 1000;

/**
 * Whether `text` has an SVG root element, as Next.js' image detector checks
 * with image-size's `/<svg\s([^>"']|"[^"]*"|'[^']*')*>/`. Its alternatives
 * start with distinct characters, so a single scan from each `<svg` matches
 * what the expression matches, without its backtracking.
 */
function hasSvgRootElement(text: string): boolean {
  for (let start = text.indexOf("<svg"); start !== -1; start = text.indexOf("<svg", start + 1)) {
    if (!/\s/.test(text.charAt(start + 4))) continue;
    for (let i = start + 5; i < text.length; i++) {
      const char = text[i];
      if (char === ">") return true;
      if (char === '"' || char === "'") {
        const end = text.indexOf(char, i + 1);
        if (end === -1) break;
        i = end;
      }
    }
  }
  return false;
}

/**
 * Whether `bytes`, the first of a source `length` bytes long, start with an
 * `ftyp` box of `brand`: a big-endian box size of at least 16 that the source
 * holds, then `ftyp` and the major brand. The size keeps text from matching
 * the brand at offset 4.
 */
function hasFtypBox(bytes: Uint8Array, brand: FtypBrand["ftypBrand"], length: number): boolean {
  const boxSize = ftypBoxSize(bytes, brand);
  return boxSize !== null && boxSize <= length;
}

/** The declared size of an `ftyp` box of `brand` that `bytes` start with, or null. */
function ftypBoxSize(bytes: Uint8Array, brand: FtypBrand["ftypBrand"]): number | null {
  if (bytes.byteLength < IMAGE_SIGNATURE_LENGTH) return null;
  const boxSize = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0);
  return boxSize >= 16 &&
    [0x66, 0x74, 0x79, 0x70].every((byte, i) => bytes[i + 4] === byte) &&
    brand.every((byte, i) => bytes[i + 8] === byte)
    ? boxSize
    : null;
}

/**
 * The image type Next.js detects from a source's first bytes, or null, given
 * the source's length.
 */
export function sniffImageContentType(
  bytes: Uint8Array,
  length: number = bytes.byteLength,
): string | null {
  for (const [type, signature] of IMAGE_SIGNATURES) {
    if (
      "ftypBrand" in signature
        ? hasFtypBox(bytes, signature.ftypBrand, length)
        : signature.every((byte, i) => byte === null || bytes[i] === byte)
    ) {
      return type;
    }
  }
  return null;
}

/**
 * How many of a source's first bytes detection reads, given the first
 * `IMAGE_SIGNATURE_LENGTH`: those for a signature, enough to know the source
 * holds a whole `ftyp` box, as Next.js checks it against the source it read
 * whole, and otherwise enough to find an SVG root element. Never more than
 * `maxLength`.
 */
function imageDetectionLength(bytes: Uint8Array, maxLength: number): number {
  for (const [, signature] of IMAGE_SIGNATURES) {
    if ("ftypBrand" in signature) {
      const boxSize = ftypBoxSize(bytes, signature.ftypBrand);
      if (boxSize !== null) return Math.min(boxSize, maxLength);
    } else if (signature.every((byte, i) => byte === null || bytes[i] === byte)) {
      return IMAGE_SIGNATURE_LENGTH;
    }
  }
  return Math.min(IMAGE_DETECTION_LENGTH, maxLength);
}

/**
 * Whether `bytes` are text markup: they start with `<` after a UTF-8 byte
 * order mark and whitespace, or with a UTF-16 byte order mark.
 */
function startsWithMarkup(bytes: Uint8Array): boolean {
  if ((bytes[0] === 0xfe && bytes[1] === 0xff) || (bytes[0] === 0xff && bytes[1] === 0xfe)) {
    return true;
  }
  let i = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  while (bytes[i] === 0x20 || bytes[i] === 0x09 || bytes[i] === 0x0a || bytes[i] === 0x0d) i++;
  return bytes[i] === 0x3c;
}

/**
 * The type of a source `length` bytes long from its first
 * `IMAGE_DETECTION_LENGTH` bytes, as Next.js types every source by its bytes
 * rather than its label, so an SVG is an SVG whatever its name or
 * Content-Type. Bytes that match no signature keep `label`, since Next.js
 * identifies formats these signatures don't, except markup, which is never
 * an image unless it is an SVG (null).
 */
export function detectImageContentType(
  bytes: Uint8Array,
  label: string | null,
  length: number = bytes.byteLength,
): string | null {
  const type = sniffImageContentType(bytes, length);
  if (type !== null) return type;
  if (hasSvgRootElement(new TextDecoder().decode(bytes.subarray(0, IMAGE_DETECTION_LENGTH)))) {
    return "image/svg+xml";
  }
  return startsWithMarkup(bytes) ? null : label;
}

/** The first `length` bytes of `chunks`, which hold at least that many. */
function concatBytes(chunks: Uint8Array[], length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    if (offset === length) break;
    const part = chunk.subarray(0, length - offset);
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}

/**
 * Type a source by its first bytes, replacing its Content-Type, as Next.js
 * types every source. Workers static assets have no type for some formats
 * Next.js serves, such as ICNS, and label any file by its name. Null, with
 * the source cancelled, once the bytes read pass `maxLength`.
 */
async function withDetectedImageContentType(
  source: Response,
  maxLength: number,
  refetch: () => Promise<Response>,
): Promise<Response | null> {
  if (!source.ok || !source.body) return source;
  const reader = source.body.getReader();
  // Replay the chunks read, copying only the bytes detection reads. Chunks
  // are held whole until they reach `IMAGE_DETECTION_LENGTH`, so a large first
  // chunk is held as it arrived. Past that, the chunks read to reach the end of
  // an `ftyp` box are only counted, so a large box costs the source a second
  // fetch rather than isolate memory.
  const head: Uint8Array[] = [];
  let heldLength = 0;
  let length = 0;
  let target = IMAGE_SIGNATURE_LENGTH;
  while (length < target) {
    const { done, value } = await reader.read();
    if (done) break;
    if (heldLength < IMAGE_DETECTION_LENGTH) {
      head.push(value);
      heldLength += value.byteLength;
    }
    length += value.byteLength;
    if (target === IMAGE_SIGNATURE_LENGTH && length >= target) {
      target = imageDetectionLength(concatBytes(head, IMAGE_SIGNATURE_LENGTH), maxLength);
    }
  }
  if (length > maxLength) {
    reader.cancel().catch(() => {});
    return null;
  }
  // Copy only what the SVG scan reads: a whole `ftyp` box needs only its length.
  const detected = concatBytes(head, Math.min(length, IMAGE_DETECTION_LENGTH));
  const type = detectImageContentType(detected, source.headers.get("Content-Type"), length);
  const typed = (response: Response, body: ReadableStream<Uint8Array>) => {
    const headers = new Headers(response.headers);
    if (type === null) headers.delete("Content-Type");
    else headers.set("Content-Type", type);
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
  if (heldLength === length) return typed(source, replayImageSource(head, reader));
  // Not all the bytes read are held to replay, so serve it fetched again. Only
  // an `ftyp` box larger than detection holds gets here.
  reader.cancel().catch(() => {});
  const refetched = await refetch();
  if (!refetched.ok || !refetched.body) return refetched;
  // The type found holds for the same first bytes and a source holding the
  // whole box, so a source whose first bytes changed between the fetches is
  // typed afresh, without a third fetch, and one that ends before the box
  // errors. `target` is the box size, however the first fetch was chunked.
  const refetchedReader = refetched.body.getReader();
  const refetchedHead: Uint8Array[] = [];
  let refetchedLength = 0;
  while (refetchedLength < heldLength) {
    const { done, value } = await refetchedReader.read();
    if (done) break;
    refetchedHead.push(value);
    refetchedLength += value.byteLength;
  }
  if (
    refetchedLength >= heldLength &&
    bytesEqual(concatBytes(refetchedHead, heldLength), concatBytes(head, heldLength))
  ) {
    return typed(
      refetched,
      replayImageSource(refetchedHead, refetchedReader, Math.min(target, length)),
    );
  }
  const body = replayImageSource(refetchedHead, refetchedReader);
  return withDetectedImageContentType(new Response(body, refetched), maxLength, async () =>
    Response.error(),
  );
}

/**
 * Stream `head`, then the rest of `reader`, reading the source only as the
 * stream is read, and erroring should it end before `minLength` bytes.
 */
function replayImageSource(
  head: Uint8Array[],
  reader: ReadableStreamDefaultReader<Uint8Array>,
  minLength = 0,
): ReadableStream<Uint8Array> {
  let length = 0;
  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        for (const chunk of head) {
          controller.enqueue(chunk);
          length += chunk.byteLength;
        }
      },
      async pull(controller) {
        const { done, value } = await reader.read();
        if (!done) {
          length += value.byteLength;
          controller.enqueue(value);
        } else if (length < minLength) {
          controller.error(new Error("The image source changed while it was fetched again."));
        } else {
          controller.close();
        }
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    },
    { highWaterMark: 0 },
  );
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.byteLength === b.byteLength && a.every((byte, i) => byte === b[i]);
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

const IMAGE_BUILD_ASSET = Symbol.for("vinext.imageBuildAsset");

/**
 * Mark a source the host fetched from its `_next/static` build output, which
 * is served immutably like Next.js' `isStatic` sources. A public file is never
 * marked, whatever its path.
 */
export function markImageBuildAsset(response: Response): Response {
  Reflect.set(response, IMAGE_BUILD_ASSET, true);
  return response;
}

function isImageBuildAsset(response: Response): boolean {
  return Reflect.get(response, IMAGE_BUILD_ASSET) === true;
}

/**
 * Next.js's Cache-Control for a source it serves as-is: a build asset stays
 * immutable, and any other source is revalidated after the larger of
 * `images.minimumCacheTTL` and the source's own max-age. Next.js ignores the
 * source's max-age when it falls back after a failed transform, so that
 * fallback passes null.
 */
export function sourceImageCacheControl(
  isBuildAsset: boolean,
  upstreamCacheControl: string | null,
  config?: ImageConfig,
): string {
  if (isBuildAsset) return IMAGE_CACHE_CONTROL;
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
  readLength: number | null = null,
): Response {
  const headers = new Headers(source.headers);
  setImageResponseHeaders(headers, cacheControl, config);
  // A source read whole is sent at the length read, whatever it declared.
  if (readLength !== null) headers.set("Content-Length", String(readLength));
  return new Response(body, { status: 200, headers });
}

/** Next.js's 413 message for a source larger than `images.maximumResponseBody`. */
export const IMAGE_SOURCE_TOO_LARGE_MESSAGE =
  '"url" parameter is valid but internal response is invalid';

/** Next.js's 413 for a source larger than `images.maximumResponseBody`. */
function sourceTooLargeResponse(): Response {
  return new Response(IMAGE_SOURCE_TOO_LARGE_MESSAGE, { status: 413 });
}

/** A source admitted to the image endpoint, typed by its bytes. */
type AdmittedImageSource = {
  source: Response;
  body: ReadableStream<Uint8Array>;
  contentType: string;
};

/**
 * Admit a fetched source as Next.js does, which reads it whole before typing
 * it: a 413 past the limit, then a 400 for one that is no image or of a type
 * not allowed. A rejected source is read on to the limit to tell the two
 * apart, counting its bytes without holding them. Like Next.js, the limit is
 * held to the bytes read, whatever length the source declares.
 */
async function admitImageSource(
  fetched: Response,
  limit: number,
  imageConfig: ImageConfig | undefined,
  refetch: () => Promise<Response>,
): Promise<AdmittedImageSource | Response> {
  const source = await withDetectedImageContentType(fetched, limit, refetch);
  if (source === null) return sourceTooLargeResponse();
  if (!source.ok || !source.body) return invalidImageSourceResponse();
  const body = source.body;
  // Block unsafe Content-Types (e.g., SVG which can contain embedded
  // scripts). SVG is only allowed when dangerouslyAllowSVG is enabled.
  const contentType = source.headers.get("Content-Type");
  if (
    contentType !== null &&
    isSafeImageContentType(contentType, imageConfig?.dangerouslyAllowSVG)
  ) {
    return { source, body, contentType };
  }
  const counted = new LimitedImageSource(body, limit);
  const reader = counted.body.getReader();
  try {
    while (!(await reader.read()).done);
  } catch {
    // Past the limit, or a source that failed to read.
  }
  if (counted.tooLarge) return sourceTooLargeResponse();
  return contentType === null ? invalidImageSourceResponse() : imageTypeNotAllowedResponse();
}

/**
 * Serve an admitted source as-is within the limit. One a read proved
 * `withinLimit` is streamed, erroring should it run past the limit; any other
 * is read to its end first, as Next.js reads every source whole, so it gets a
 * 413 rather than a response cut short, whatever length it declares. Only its
 * first bytes are held to replay, so a longer one is fetched again.
 */
async function servePassthroughWithinLimit(
  { source, body }: AdmittedImageSource,
  cacheControl: string,
  imageConfig: ImageConfig | undefined,
  limit: number,
  refetch: () => Promise<Response>,
  withinLimit = false,
): Promise<Response> {
  if (withinLimit) {
    const limited = new LimitedImageSource(body, limit).body;
    return createPassthroughImageResponse(source, limited, cacheControl, imageConfig);
  }
  const reader = new ImageSourceReader(body, limit);
  try {
    await reader.byte(limit);
  } catch (e) {
    if (reader.tooLarge) return sourceTooLargeResponse();
    throw e;
  }
  const held = reader.body();
  if (held) {
    const length = reader.completeLength;
    return createPassthroughImageResponse(source, held, cacheControl, imageConfig, length);
  }
  const refetched = await admitImageSource(await refetch(), limit, imageConfig, refetch);
  if (refetched instanceof Response) return refetched;
  return servePassthroughWithinLimit(refetched, cacheControl, imageConfig, limit, refetch, true);
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

  // Fetch the source image and admit it as Next.js does: the limit holds for
  // every type, ahead of the type check.
  const fetchedSource = await handlers.fetchAsset(imageUrl, request);
  const isBuildAsset = isImageBuildAsset(fetchedSource);
  const limit = imageSourceLimit(imageConfig);
  const refetch = () => handlers.fetchAsset(imageUrl, request);
  const admitted = await admitImageSource(fetchedSource, limit, imageConfig, refetch);
  if (admitted instanceof Response) return admitted;
  const { source, contentType: sourceContentType } = admitted;

  // Negotiate output format from Accept header
  const format = negotiateImageFormat(request.headers.get("Accept"));

  // Like Next.js, serve a format it does not optimize as-is, SVG included
  // once dangerouslyAllowSVG admitted it above.
  const sourceMediaType = imageMediaType(sourceContentType);
  const sourceCacheControl = sourceImageCacheControl(
    isBuildAsset,
    source.headers.get("Cache-Control"),
    imageConfig,
  );
  if (BYPASS_IMAGE_CONTENT_TYPES.has(sourceMediaType)) {
    const response = await servePassthroughWithinLimit(
      admitted,
      sourceCacheControl,
      imageConfig,
      limit,
      refetch,
    );
    // Next.js labels an ICO by its detected type, `image/x-icon`, where
    // Workers static assets use the registered `image/vnd.microsoft.icon`.
    // The response served may be a source fetched again, so its own type decides.
    if (
      response.ok &&
      imageMediaType(response.headers.get("Content-Type")) === "image/vnd.microsoft.icon"
    ) {
      response.headers.set("Content-Type", "image/x-icon");
    }
    return response;
  }

  // Transform if handler provided, otherwise serve original
  let reader: ImageSourceReader | null = null;
  // The optimizer reads a still source through this, within the limit too.
  let limitedSource: LimitedImageSource | null = null;
  if (handlers.transformImage) {
    try {
      let body: ReadableStream<Uint8Array>;
      // Next.js serves an animated image as-is rather than flattening it to
      // one frame, and answers 413 past the most it reads of a source.
      if (ANIMATABLE_IMAGE_CONTENT_TYPES.has(sourceMediaType)) {
        // Detect animation as the source streams in, then replay the bytes
        // read, or fetch the source again when too many were read to hold.
        reader = new ImageSourceReader(admitted.body, limit);
        const animated = await isAnimatedImage(reader);
        // Next.js reads the whole source before serving it as-is, so an
        // animated one gets a 413 rather than a response cut short.
        if (animated) {
          try {
            await reader.byte(limit);
          } catch (e) {
            if (reader.tooLarge) return sourceTooLargeResponse();
            throw e;
          }
          const held = reader.body();
          if (held) {
            const length = reader.completeLength;
            return createPassthroughImageResponse(
              source,
              held,
              sourceCacheControl,
              imageConfig,
              length,
            );
          }
          reader.cancel();
          const refetched = await admitImageSource(await refetch(), limit, imageConfig, refetch);
          if (refetched instanceof Response) return refetched;
          return servePassthroughWithinLimit(
            refetched,
            sourceCacheControl,
            imageConfig,
            limit,
            refetch,
            reader.readWhole,
          );
        }
        let sourceBody = reader.body();
        if (!sourceBody) {
          reader.cancel();
          const refetched = await refetch();
          if (!refetched.ok || !refetched.body) return invalidImageSourceResponse();
          reader = new ImageSourceReader(refetched.body, limit);
          sourceBody = reader.body()!;
        }
        body = sourceBody;
      } else {
        limitedSource = new LimitedImageSource(admitted.body, limit);
        body = limitedSource.body;
      }
      const transformed = await handlers.transformImage(body, {
        width,
        format,
        quality,
      });
      if (limitedSource?.tooLarge || reader?.tooLarge) {
        transformed.body?.cancel().catch(() => {});
        return sourceTooLargeResponse();
      }
      const headers = new Headers(transformed.headers);
      setImageResponseHeaders(headers, IMAGE_CACHE_CONTROL, imageConfig);

      // Verify the transformed response also has a safe Content-Type.
      // A malicious or buggy transform handler could return HTML.
      if (!isSafeImageContentType(headers.get("Content-Type"), imageConfig?.dangerouslyAllowSVG)) {
        headers.set("Content-Type", format);
      }

      return new Response(transformed.body, { status: 200, headers });
    } catch (e) {
      if (e instanceof ImageSourceTooLargeError || limitedSource?.tooLarge || reader?.tooLarge) {
        return sourceTooLargeResponse();
      }
      console.error("[vinext] Image optimization error:", e);
    }
  }

  // Fallback: serve original image with cache headers. Without an optimizer
  // the source is served as-is; after a failed transform Next.js keeps it
  // for the minimum TTL only.
  const fallbackCacheControl = handlers.transformImage
    ? sourceImageCacheControl(isBuildAsset, null, imageConfig)
    : sourceCacheControl;
  // A source the optimizer never read is served as it is.
  if (!handlers.transformImage || (limitedSource && !limitedSource.disturbed)) {
    return servePassthroughWithinLimit(admitted, fallbackCacheControl, imageConfig, limit, refetch);
  }
  // One it read whole replays.
  const readLength = reader?.completeLength ?? null;
  const replayed = readLength !== null ? reader?.body() : null;
  if (replayed) {
    return createPassthroughImageResponse(
      source,
      replayed,
      fallbackCacheControl,
      imageConfig,
      readLength,
    );
  }
  // Any other is fetched again, and streamed once a read proved it fits. That
  // proof is of the first fetch, so a source that grows past the limit between
  // the two fetches errors its body rather than getting a 413.
  reader?.cancel();
  // One the optimizer let go of is cancelled too, before it is fetched again.
  if (limitedSource && !limitedSource.body.locked) {
    limitedSource.body.cancel().catch(() => {});
  }
  const refetched = await admitImageSource(await refetch(), limit, imageConfig, refetch);
  if (refetched instanceof Response) return refetched;
  const withinLimit = limitedSource?.readWhole ?? reader?.readWhole ?? false;
  return servePassthroughWithinLimit(
    refetched,
    fallbackCacheControl,
    imageConfig,
    limit,
    refetch,
    withinLimit,
  );
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
  /**
   * Transform the source image (resize, format, quality). `body` errors past
   * `images.maximumResponseBody`. Read it whole before resolving, as Cloudflare
   * Images does, for a source past the limit to get a 413: the endpoint cannot
   * tell a body left unread from one streamed later into the response, which
   * can only error that response's body.
   */
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
