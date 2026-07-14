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
 */

import { badRequestResponse, notFoundResponse } from "./http-error-responses.js";
import { stripBasePath } from "../utils/base-path.js";

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

/** Match Next.js's endpoint-level gate before redirects or parameter parsing. */
export function isImageOptimizationDisabled(imageConfig?: ImageConfig): boolean {
  return imageConfig?.unoptimized === true || (imageConfig?.loader ?? "default") !== "default";
}

/**
 * Image security configuration from next.config.js `images` section.
 * Controls SVG handling and security headers for the image endpoint.
 */
export type ImageConfig = {
  /** App basePath, used to identify build-owned static image assets. */
  basePath?: string;
  /** Allowed device widths. Defaults to Next.js device sizes. */
  deviceSizes?: number[];
  /** Allowed fixed-image widths. Defaults to Next.js image sizes. */
  imageSizes?: number[];
  /** Allowed output qualities. Defaults to Next.js 16's `[75]`. */
  qualities?: number[];
  /** Negotiated output formats. Defaults to Next.js 16's WebP-only list. */
  formats?: Array<"image/avif" | "image/webp">;
  /** Disable the Image Optimization API. Default: false. */
  unoptimized?: boolean;
  /** Built-in image loader. Only the default loader exposes the optimization API. */
  loader?: "default" | "custom" | "akamai" | "cloudinary" | "imgix";
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
  /** Maximum source response body size. Defaults to 50 MB. */
  maximumResponseBody?: number;
  /** Minimum optimized image cache lifetime in seconds. Defaults to 4 hours. */
  minimumCacheTTL?: number;
  /** Content-Disposition header value. Default: "attachment". */
  contentDispositionType?: "inline" | "attachment";
  /** Content-Security-Policy header value. Default: "script-src 'none'; frame-src 'none'; sandbox;" */
  contentSecurityPolicy?: string;
};

/**
 * Next.js default device sizes and image sizes.
 * These are the allowed widths for image optimization when no custom
 * config is provided. Matches Next.js defaults exactly.
 */
export const DEFAULT_DEVICE_SIZES = [640, 750, 828, 1080, 1200, 1920, 2048, 3840];
export const DEFAULT_IMAGE_SIZES = [32, 48, 64, 96, 128, 256, 384];
export const DEFAULT_IMAGE_QUALITIES = [75];
export const DEFAULT_IMAGE_FORMATS = ["image/webp"] as const;
const DEV_BLUR_MAX_WIDTH = 8;
const DEV_BLUR_QUALITY = 70;

export type ParseImageParamsOptions = {
  isDev?: boolean;
};

export function resolveDevImageRedirect(
  requestUrl: URL,
  allowedWidths: number[] = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES],
  allowedQualities: number[] = [...DEFAULT_IMAGE_QUALITIES],
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
  allowedQualities: number[] = [...DEFAULT_IMAGE_QUALITIES],
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
  if (!allowedQualities.includes(quality) && !isDevBlurQuality) {
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
    // Next rejects any local source whose decoded pathname contains the image
    // optimizer endpoint as a complete path segment. This covers basePath and
    // nested suffix forms such as `/docs/_next/image/again`, not just an exact
    // `/_next/image` source.
    const decodedPathname = decodeURIComponent(resolved.pathname).replaceAll("\\", "/");
    if (/\/(?:_next|_vinext)\/image(?:$|\/)/.test(decodedPathname)) return null;
  } catch {
    return null;
  }

  return { imageUrl: normalizedUrl, width, quality };
}

/**
 * Negotiate the best output format based on the Accept header.
 * Returns an IANA media type.
 */
type AcceptedMediaRange = {
  order: number;
  quality: number;
  subtype: string;
  type: string;
};

function parseAcceptedMediaRanges(acceptHeader: string): AcceptedMediaRange[] {
  const ranges: AcceptedMediaRange[] = [];
  for (const [order, raw] of acceptHeader.split(",").entries()) {
    const [mediaRange = "", ...parameters] = raw.trim().split(";");
    const [type, subtype] = mediaRange.trim().toLowerCase().split("/", 2);
    if (!type || !subtype) continue;
    let quality = 1;
    for (const parameter of parameters) {
      const [name, value] = parameter.trim().split("=", 2);
      if (name.toLowerCase() !== "q") continue;
      quality = Number.parseFloat(value ?? "");
      break;
    }
    ranges.push({
      order,
      quality: Number.isFinite(quality) && quality >= 0 && quality <= 1 ? quality : 0,
      subtype,
      type,
    });
  }
  return ranges;
}

function mediaRangePriority(
  mediaType: string,
  ranges: readonly AcceptedMediaRange[],
): { order: number; quality: number; specificity: number } {
  const [type, subtype] = mediaType.toLowerCase().split("/", 2);
  let selected = { order: Number.POSITIVE_INFINITY, quality: 0, specificity: -1 };
  for (const range of ranges) {
    if (range.type !== "*" && range.type !== type) continue;
    if (range.subtype !== "*" && range.subtype !== subtype) continue;
    const specificity = (range.type === type ? 2 : 0) + (range.subtype === subtype ? 1 : 0);
    if (
      specificity > selected.specificity ||
      (specificity === selected.specificity && range.quality > selected.quality) ||
      (specificity === selected.specificity &&
        range.quality === selected.quality &&
        range.order < selected.order)
    ) {
      selected = { order: range.order, quality: range.quality, specificity };
    }
  }
  return selected;
}

/** Match Next.js's `getSupportedMimeType(formats, Accept)` negotiation. */
export function negotiateImageFormat(
  acceptHeader: string | null,
  formats: readonly string[] = DEFAULT_IMAGE_FORMATS,
): string {
  if (!acceptHeader || formats.length === 0) return "";
  const ranges = parseAcceptedMediaRanges(acceptHeader);
  let selected = "";
  let selectedPriority = { order: Number.POSITIVE_INFINITY, quality: 0, specificity: -1 };
  for (const format of formats) {
    const priority = mediaRangePriority(format, ranges);
    if (priority.quality <= 0) continue;
    if (
      priority.quality > selectedPriority.quality ||
      (priority.quality === selectedPriority.quality &&
        priority.specificity > selectedPriority.specificity)
    ) {
      selected = format;
      selectedPriority = priority;
    }
  }
  // Next's wrapper rejects a wildcard-only match: the selected configured
  // format must also occur explicitly in the Accept header.
  return selected && acceptHeader.toLowerCase().includes(selected.toLowerCase()) ? selected : "";
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
  "image/jp2",
  "image/jxl",
  "image/heic",
  "image/x-icon",
  "image/x-icns",
  "image/vnd.microsoft.icon",
  "image/bmp",
  "image/tiff",
]);

/**
 * Check if a Content-Type header value is a safe image type.
 * Returns false for SVG (unless dangerouslyAllowSVG is true), HTML, or any non-image type.
 */
export function isSafeImageContentType(
  contentType: string | null,
  dangerouslyAllowSVG = false,
): boolean {
  if (!contentType) return false;
  // Extract the media type, ignoring parameters (e.g., charset)
  const mediaType = contentType.split(";")[0].trim().toLowerCase();
  if (SAFE_IMAGE_CONTENT_TYPES.has(mediaType)) return true;
  if (dangerouslyAllowSVG && mediaType === "image/svg+xml") return true;
  return false;
}

async function readImageSource(
  response: Response,
  maximumResponseBody: number,
  signal: AbortSignal,
): Promise<
  | { bytes: Uint8Array; response: Response; contentType: string | null; tooLarge: false }
  | { tooLarge: true }
  | null
> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const onAbort = () => void reader.cancel(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  const chunks: Uint8Array[] = [];
  let totalSize = 0;
  try {
    while (true) {
      if (signal.aborted) throw signal.reason;
      const { done, value } = await reader.read();
      if (done) break;
      totalSize += value.byteLength;
      if (totalSize > maximumResponseBody) {
        await reader.cancel();
        return { tooLarge: true };
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
  const bytes = new Uint8Array(totalSize);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const startsWith = (...signature: number[]) =>
    bytes.length >= signature.length && signature.every((byte, index) => bytes[index] === byte);
  const textPrefix = new TextDecoder()
    .decode(bytes.subarray(0, 256))
    .replace(/^\uFEFF/, "")
    .trimStart()
    .toLowerCase();
  let contentType: string | null = null;
  if (startsWith(0xff, 0xd8, 0xff)) contentType = "image/jpeg";
  else if (startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) contentType = "image/png";
  else if (startsWith(0x47, 0x49, 0x46, 0x38)) contentType = "image/gif";
  if (
    startsWith(0x52, 0x49, 0x46, 0x46) &&
    bytes.length >= 12 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  )
    contentType = "image/webp";
  else if (startsWith(0x00, 0x00, 0x00, 0x0c, 0x4a, 0x58, 0x4c, 0x20, 0x0d, 0x0a, 0x87, 0x0a))
    contentType = "image/jxl";
  else if (startsWith(0xff, 0x0a)) contentType = "image/jxl";
  else if (startsWith(0x00, 0x00, 0x00, 0x0c, 0x6a, 0x50, 0x20, 0x20, 0x0d, 0x0a, 0x87, 0x0a))
    contentType = "image/jp2";
  else if (
    bytes.length >= 12 &&
    bytes[4] === 0x66 &&
    bytes[5] === 0x74 &&
    bytes[6] === 0x79 &&
    bytes[7] === 0x70
  ) {
    const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
    if (brand === "avif" || brand === "avis") contentType = "image/avif";
    else if (brand === "heic") contentType = "image/heic";
  } else if (startsWith(0x00, 0x00, 0x01, 0x00)) contentType = "image/x-icon";
  else if (startsWith(0x69, 0x63, 0x6e, 0x73)) contentType = "image/x-icns";
  else if (startsWith(0x42, 0x4d)) contentType = "image/bmp";
  else if (startsWith(0x49, 0x49, 0x2a, 0x00) || startsWith(0x4d, 0x4d, 0x00, 0x2a))
    contentType = "image/tiff";
  else if (textPrefix.startsWith("<?xml") || textPrefix.startsWith("<svg"))
    contentType = "image/svg+xml";

  const headers = new Headers(response.headers);
  headers.set("ETag", await extractImageEtag(headers.get("ETag"), bytes));
  headers.set("Content-Length", String(bytes.byteLength));

  return {
    bytes,
    response: new Response(bytes, {
      status: response.status,
      statusText: response.statusText,
      headers,
    }),
    contentType,
    tooLarge: false,
  };
}

async function readTransformedImage(
  response: Response,
  maximumResponseBody: number,
  signal: AbortSignal,
): Promise<Uint8Array | null> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const onAbort = () => void reader.cancel(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  const chunks: Uint8Array[] = [];
  let totalSize = 0;
  try {
    while (true) {
      if (signal.aborted) throw signal.reason;
      const { done, value } = await reader.read();
      if (done) break;
      totalSize += value.byteLength;
      if (totalSize > maximumResponseBody) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
  const bytes = new Uint8Array(totalSize);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.buffer instanceof ArrayBuffer) {
    if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) return bytes.buffer;
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }
  return new Uint8Array(bytes).buffer;
}

async function getImageEtag(bytes: Uint8Array): Promise<string> {
  return toBase64Url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", exactArrayBuffer(bytes))),
  );
}

async function extractImageEtag(etag: string | null, bytes: Uint8Array): Promise<string> {
  return etag ? toBase64Url(new TextEncoder().encode(etag)) : getImageEtag(bytes);
}

function isFreshImageRequest(request: Request, etag: string): boolean {
  if (request.headers.get("Cache-Control")?.toLowerCase().includes("no-cache")) return false;
  const ifNoneMatch = request.headers.get("If-None-Match");
  if (!ifNoneMatch) return false;
  const normalize = (value: string) => value.trim().replace(/^W\//, "");
  return ifNoneMatch
    .split(",")
    .some((value) => value.trim() === "*" || normalize(value) === normalize(etag));
}

const IMAGE_EXTENSION_BY_CONTENT_TYPE: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/jp2": "jp2",
  "image/jxl": "jxl",
  "image/heic": "heic",
  "image/x-icon": "ico",
  "image/x-icns": "icns",
  "image/vnd.microsoft.icon": "ico",
  "image/bmp": "bmp",
  "image/tiff": "tiff",
  "image/svg+xml": "svg",
};

function getImageFilename(imageUrl: string, contentType: string | null): string {
  let pathname = imageUrl.split("?", 1)[0];
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    // Keep the encoded pathname. It is still safe after the normalization below.
  }
  const sourceBasename = pathname.split("/").pop() || "image";
  const sourceStem = sourceBasename.split(".", 1)[0] || "image";
  const sanitizedStem = Array.from(sourceStem.normalize("NFC"), (character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint < 0x20 || codePoint === 0x7f || character === "/" || character === "\\"
      ? "_"
      : character;
  })
    .join("")
    .slice(0, 200);
  const mediaType = contentType?.split(";", 1)[0].trim().toLowerCase();
  const extension = (mediaType && IMAGE_EXTENSION_BY_CONTENT_TYPE[mediaType]) || "bin";
  return `${sanitizedStem || "image"}.${extension}`;
}

function imageContentDisposition(
  imageUrl: string,
  contentType: string | null,
  dispositionType: "inline" | "attachment",
): string {
  const filename = getImageFilename(imageUrl, contentType);
  const fallback = filename
    .replace(/[^\x20-\x7e]/g, "?")
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"');
  const encoded = encodeURIComponent(filename).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  const extended = /[^\x20-\x7e]/.test(filename) ? `; filename*=UTF-8''${encoded}` : "";
  return `${dispositionType}; filename="${fallback}"${extended}`;
}

/**
 * Apply security headers to an image optimization response.
 * These headers are set on every response from the image endpoint,
 * regardless of whether the image was transformed or served as-is.
 * When an ImageConfig is provided, uses its values for CSP and Content-Disposition.
 */
function setImageSecurityHeaders(
  headers: Headers,
  imageUrl: string,
  contentType: string | null,
  config?: ImageConfig,
): void {
  headers.set(
    "Content-Security-Policy",
    config?.contentSecurityPolicy ?? IMAGE_CONTENT_SECURITY_POLICY,
  );
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set(
    "Content-Disposition",
    imageContentDisposition(
      imageUrl,
      contentType,
      config?.contentDispositionType === "inline" ? "inline" : "attachment",
    ),
  );
}

function createPassthroughImageResponse(
  source: Response,
  config?: ImageConfig,
  request?: Request,
  detectedContentType?: string,
  cacheControl?: string,
  imageUrl = "/image",
): Response {
  const headers = new Headers();
  const contentType = detectedContentType ?? source.headers.get("Content-Type");
  const etag = source.headers.get("ETag");
  if (etag) headers.set("ETag", etag);
  headers.set("Cache-Control", cacheControl ?? imageCacheControl(source, config));
  headers.set("Vary", "Accept");
  if (contentType) headers.set("Content-Type", contentType);
  const contentLength = source.headers.get("Content-Length");
  if (contentLength) headers.set("Content-Length", contentLength);
  setImageSecurityHeaders(headers, imageUrl, contentType, config);
  return new Response(request?.method === "HEAD" ? null : source.body, { status: 200, headers });
}

function imageCacheControl(source: Response, config?: ImageConfig): string {
  const directives = new Map(
    (source.headers.get("Cache-Control") ?? "")
      .split(",")
      .map((directive) => directive.trim().split("=", 2))
      .map(([key, value]) => [key.toLowerCase(), value]),
  );
  let upstreamMaxAge = directives.get("s-maxage") || directives.get("max-age") || "";
  if (upstreamMaxAge.startsWith('"') && upstreamMaxAge.endsWith('"')) {
    upstreamMaxAge = upstreamMaxAge.slice(1, -1);
  }
  const parsedMaxAge = Number.parseInt(upstreamMaxAge, 10);
  const maxAge = Math.max(
    config?.minimumCacheTTL ?? 14_400,
    Number.isNaN(parsedMaxAge) ? 0 : parsedMaxAge,
  );
  return `public, max-age=${maxAge}, must-revalidate`;
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
    options: { width: number; format: string; quality: number; signal: AbortSignal },
  ) => Promise<Response>;
  /** Stable identity for the runtime/app that owns cached image responses. */
  cacheOwner?: object;
  /** Schedule stale image regeneration without delaying the response. */
  waitUntil?: (promise: Promise<unknown>) => void;
};

/**
 * Build the request used to resolve a local image source through the app's
 * normal request pipeline. This uses a credential-free synthetic request,
 * preserving the optimizer request method except that HEAD is resolved as GET,
 * matching Next.js and preventing external rewrites from forwarding caller credentials.
 */
export function createInternalImageRequest(
  imageUrl: string,
  request: Request,
  basePath = "",
): Request | null {
  const sourceUrl = new URL(imageUrl, request.url);
  let sourcePathname: string;
  try {
    sourcePathname = decodeURIComponent(sourceUrl.pathname);
  } catch {
    return null;
  }
  const normalizedPathname = sourcePathname.replaceAll("\\", "/");
  const withoutBasePath = stripBasePath(normalizedPathname, basePath);
  if (/\/(?:_next|_vinext)\/image(?:$|\/)/.test(withoutBasePath)) return null;
  return new Request(sourceUrl, {
    method: !request.method || request.method === "HEAD" ? "GET" : request.method,
    signal: request.signal,
  });
}

type CachedImageResponse = {
  /** Immutable body backing shared by every response served from this entry. */
  body: Blob;
  headers: [string, string][];
  revalidateAfter: number;
};

type ImageResponseCache = {
  entries: Map<string, CachedImageResponse>;
  pending: Map<string, Promise<GeneratedImageResponse>>;
  generationQueue: Set<ImageGenerationWaiter>;
  activeGenerations: number;
  activeGenerationBytes: number;
  totalBodyBytes: number;
};

type ImageGenerationWaiter = {
  reject: (error: Error) => void;
  resolve: () => void;
  reservedBytes: number;
  timeout: ReturnType<typeof setTimeout>;
};

type BufferedImageResponse = {
  /** Immutable body backing shared by all waiters on one generation. */
  body: Blob | null;
  headers: [string, string][];
  status: number;
  statusText: string;
};

type GeneratedImageResponse = {
  entry: CachedImageResponse | null;
  response: BufferedImageResponse | null;
};

const IMAGE_RESPONSE_CACHES = new WeakMap<object, ImageResponseCache>();
// A Worker isolate has 128 MiB for its heap, WebAssembly, and every concurrent
// request. Keep the optional in-memory image cache deliberately small so one
// near-limit source/transform still has room to complete.
const MAX_IMAGE_RESPONSE_CACHE_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_RESPONSE_ENTRY_BYTES = 4 * 1024 * 1024;
const MAX_IMAGE_RESPONSE_CACHE_ENTRIES = 256;
const MAX_IMAGE_GENERATIONS = 2;
const MAX_QUEUED_IMAGE_GENERATIONS = 32;
const IMAGE_GENERATION_QUEUE_TIMEOUT_MS = 5_000;
const IMAGE_GENERATION_TIMEOUT_MS = 15_000;
// Reading, sniffing, hashing, transforming, and buffering can retain several
// views/copies of both source and output. Cap each body and reserve four times
// that limit before starting work. Together with the 8 MiB resident cache this
// keeps framework-owned image memory below a Worker's 128 MiB isolate limit.
const MAX_IMAGE_BODY_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_GENERATION_MEMORY_BYTES = 96 * 1024 * 1024;

class ImageGenerationQueueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageGenerationQueueError";
  }
}

class ImageGenerationTimeoutError extends Error {
  constructor() {
    super("Timed out while optimizing image");
    this.name = "ImageGenerationTimeoutError";
  }
}

function getImageResponseCache(owner: object): ImageResponseCache {
  let cache = IMAGE_RESPONSE_CACHES.get(owner);
  if (!cache) {
    cache = {
      entries: new Map(),
      pending: new Map(),
      generationQueue: new Set(),
      activeGenerations: 0,
      activeGenerationBytes: 0,
      totalBodyBytes: 0,
    };
    IMAGE_RESPONSE_CACHES.set(owner, cache);
  }
  return cache;
}

function readCachedImageResponse(
  cache: ImageResponseCache,
  cacheKey: string,
): CachedImageResponse | undefined {
  const entry = cache.entries.get(cacheKey);
  if (!entry) return undefined;
  cache.entries.delete(cacheKey);
  cache.entries.set(cacheKey, entry);
  return entry;
}

function writeCachedImageResponse(
  cache: ImageResponseCache,
  cacheKey: string,
  entry: CachedImageResponse,
): void {
  const previous = cache.entries.get(cacheKey);
  if (previous) {
    cache.totalBodyBytes -= previous.body.size;
    cache.entries.delete(cacheKey);
  }
  if (entry.body.size > MAX_IMAGE_RESPONSE_ENTRY_BYTES) return;
  while (
    cache.entries.size >= MAX_IMAGE_RESPONSE_CACHE_ENTRIES ||
    cache.totalBodyBytes + entry.body.size > MAX_IMAGE_RESPONSE_CACHE_BYTES
  ) {
    const oldestKey = cache.entries.keys().next().value;
    if (oldestKey === undefined) break;
    const oldest = cache.entries.get(oldestKey)!;
    cache.entries.delete(oldestKey);
    cache.totalBodyBytes -= oldest.body.size;
  }
  cache.entries.set(cacheKey, entry);
  cache.totalBodyBytes += entry.body.size;
}

function deleteCachedImageResponse(
  cache: ImageResponseCache,
  cacheKey: string,
  expected: CachedImageResponse,
): void {
  if (cache.entries.get(cacheKey) !== expected) return;
  cache.entries.delete(cacheKey);
  cache.totalBodyBytes -= expected.body.size;
}

function imageResponseCacheKey(
  request: Request,
  params: { imageUrl: string; quality: number; width: number },
  format: string,
  allowedWidths: readonly number[],
  imageConfig: ImageConfig | undefined,
): string {
  return JSON.stringify({
    version: 2,
    origin: new URL(request.url).origin,
    // GET and HEAD resolve the same representation. The caller controls
    // whether the returned response includes a body, so they must also share
    // cache entries and in-flight generation just as they do in Next.js.
    method: "GET",
    url: params.imageUrl,
    width: params.width,
    quality: params.quality,
    format,
    allowedWidths,
    config: {
      basePath: imageConfig?.basePath ?? "",
      contentDispositionType: imageConfig?.contentDispositionType ?? "attachment",
      contentSecurityPolicy: imageConfig?.contentSecurityPolicy ?? IMAGE_CONTENT_SECURITY_POLICY,
      dangerouslyAllowSVG: imageConfig?.dangerouslyAllowSVG === true,
      formats: imageConfig?.formats ?? DEFAULT_IMAGE_FORMATS,
      maximumResponseBody: imageConfig?.maximumResponseBody ?? 50_000_000,
      minimumCacheTTL: imageConfig?.minimumCacheTTL ?? 14_400,
      qualities: imageConfig?.qualities ?? DEFAULT_IMAGE_QUALITIES,
    },
  });
}

function imageResponseMaxAge(headers: Headers): number {
  for (const directive of (headers.get("Cache-Control") ?? "").split(",")) {
    const [name, value] = directive.trim().split("=", 2);
    if (name.toLowerCase() !== "max-age") continue;
    const seconds = Number.parseInt(value ?? "", 10);
    return Number.isFinite(seconds) && seconds >= 0 ? seconds : 0;
  }
  return 0;
}

function serveCachedImageResponse(
  request: Request,
  entry: CachedImageResponse,
  cacheStatus: "MISS" | "HIT" | "STALE",
): Response {
  const headers = new Headers(entry.headers);
  const etag = headers.get("ETag");
  if (etag && isFreshImageRequest(request, etag)) {
    const conditionalHeaders = new Headers();
    for (const name of ["Cache-Control", "ETag", "Vary"] as const) {
      const value = headers.get(name);
      if (value) conditionalHeaders.set(name, value);
    }
    return new Response(null, { status: 304, headers: conditionalHeaders });
  }
  headers.set("X-Nextjs-Cache", cacheStatus);
  return new Response(request.method === "HEAD" ? null : entry.body, {
    status: 200,
    headers,
  });
}

function serveBufferedImageResponse(request: Request, response: BufferedImageResponse): Response {
  const headers = new Headers(response.headers);
  if (response.status === 200) headers.set("X-Nextjs-Cache", "MISS");
  return new Response(request.method === "HEAD" || response.body === null ? null : response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

async function generateCachedImageResponse(
  request: Request,
  handlers: ImageHandlers,
  allowedWidths: number[] | undefined,
  imageConfig: ImageConfig | undefined,
  signal: AbortSignal,
): Promise<GeneratedImageResponse> {
  const renderRequest = new Request(request.url, {
    headers: request.headers,
    method: request.method === "HEAD" ? "GET" : request.method,
    signal,
  });
  const response = await renderImageOptimizationUncached(
    renderRequest,
    handlers,
    allowedWidths,
    imageConfig,
    signal,
  );
  const headers = [...response.headers.entries()] as [string, string][];
  const body = response.body ? await response.blob() : null;
  if (response.status === 200 && body !== null && body.size <= MAX_IMAGE_RESPONSE_ENTRY_BYTES) {
    return {
      entry: {
        body,
        headers,
        revalidateAfter: Date.now() + imageResponseMaxAge(response.headers) * 1000,
      },
      response: null,
    };
  }
  return {
    entry: null,
    response: {
      body,
      headers,
      status: response.status,
      statusText: response.statusText,
    },
  };
}

function effectiveImageBodyLimit(imageConfig: ImageConfig | undefined): number {
  const configured = imageConfig?.maximumResponseBody ?? 50_000_000;
  if (!Number.isFinite(configured) || configured < 0) return MAX_IMAGE_BODY_BYTES;
  return Math.min(configured, MAX_IMAGE_BODY_BYTES);
}

function imageGenerationReservation(imageConfig: ImageConfig | undefined): number {
  return Math.max(1, effectiveImageBodyLimit(imageConfig)) * 4;
}

function canStartImageGeneration(cache: ImageResponseCache, reservedBytes: number): boolean {
  return (
    cache.activeGenerations < MAX_IMAGE_GENERATIONS &&
    cache.activeGenerationBytes + reservedBytes <= MAX_IMAGE_GENERATION_MEMORY_BYTES
  );
}

function startQueuedImageGenerations(cache: ImageResponseCache): void {
  for (const waiter of cache.generationQueue) {
    if (!canStartImageGeneration(cache, waiter.reservedBytes)) continue;
    cache.generationQueue.delete(waiter);
    clearTimeout(waiter.timeout);
    cache.activeGenerations += 1;
    cache.activeGenerationBytes += waiter.reservedBytes;
    waiter.resolve();
    if (cache.activeGenerations >= MAX_IMAGE_GENERATIONS) return;
  }
}

async function runImageGeneration<T>(
  cache: ImageResponseCache,
  reservedBytes: number,
  generate: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (canStartImageGeneration(cache, reservedBytes)) {
    cache.activeGenerations += 1;
    cache.activeGenerationBytes += reservedBytes;
  } else {
    if (cache.generationQueue.size >= MAX_QUEUED_IMAGE_GENERATIONS) {
      throw new ImageGenerationQueueError("The image generation queue is full");
    }
    await new Promise<void>((resolve, reject) => {
      const waiter: ImageGenerationWaiter = {
        reject,
        resolve,
        reservedBytes,
        timeout: undefined as unknown as ReturnType<typeof setTimeout>,
      };
      const rejectWaiter = (error: Error) => {
        cache.generationQueue.delete(waiter);
        clearTimeout(waiter.timeout);
        reject(error);
      };
      waiter.timeout = setTimeout(
        () => rejectWaiter(new ImageGenerationQueueError("Timed out waiting to optimize image")),
        IMAGE_GENERATION_QUEUE_TIMEOUT_MS,
      );
      cache.generationQueue.add(waiter);
    });
  }

  const controller = new AbortController();
  const timeoutError = new ImageGenerationTimeoutError();
  const timeout = setTimeout(() => controller.abort(timeoutError), IMAGE_GENERATION_TIMEOUT_MS);
  const aborted = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener(
      "abort",
      () => reject(controller.signal.reason ?? timeoutError),
      { once: true },
    );
  });
  const generation = Promise.resolve().then(() => generate(controller.signal));
  const releaseReservation = () => {
    clearTimeout(timeout);
    cache.activeGenerations -= 1;
    cache.activeGenerationBytes -= reservedBytes;
    startQueuedImageGenerations(cache);
  };

  // A deadline ends the caller's wait and asks cooperative work to stop, but
  // it does not prove that an adapter actually stopped. Keep admission and
  // memory charged until the underlying promise settles so a transform that
  // ignores AbortSignal cannot run alongside replacement work outside the
  // configured bounds.
  void generation.then(releaseReservation, releaseReservation);
  return await Promise.race([generation, aborted]);
}

function awaitImageGeneration<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted)
    return Promise.reject(new DOMException("The request was aborted", "AbortError"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException("The request was aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function readUint32BigEndian(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset] * 0x1000000 +
    bytes[offset + 1] * 0x10000 +
    bytes[offset + 2] * 0x100 +
    bytes[offset + 3]
  );
}

function isAnimatedGif(bytes: Uint8Array): boolean {
  if (bytes.length < 13 || bytes[0] !== 0x47 || bytes[1] !== 0x49 || bytes[2] !== 0x46) {
    return false;
  }
  let offset = 13;
  if ((bytes[10] & 0x80) !== 0) offset += 3 * 2 ** ((bytes[10] & 0x07) + 1);
  let frames = 0;
  const skipSubBlocks = (start: number): number => {
    let cursor = start;
    while (cursor < bytes.length) {
      const size = bytes[cursor++];
      if (size === 0) return cursor;
      cursor += size;
    }
    return bytes.length;
  };
  while (offset < bytes.length && frames < 2) {
    if (bytes[offset] === 0x2c) {
      if (offset + 10 > bytes.length) return false;
      frames += 1;
      const packed = bytes[offset + 9];
      offset += 10;
      if ((packed & 0x80) !== 0) offset += 3 * 2 ** ((packed & 0x07) + 1);
      if (offset >= bytes.length) return false;
      offset = skipSubBlocks(offset + 1);
    } else if (bytes[offset] === 0x21) {
      if (offset + 2 > bytes.length) return false;
      offset = skipSubBlocks(offset + 2);
    } else if (bytes[offset] === 0x3b) {
      break;
    } else {
      return false;
    }
  }
  return frames > 1;
}

function isAnimatedPng(bytes: Uint8Array): boolean {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < signature.length || signature.some((byte, index) => bytes[index] !== byte)) {
    return false;
  }
  let hasAnimationControl = false;
  let hasImageData = false;
  let previousChunk = "";
  for (let offset = 8; offset + 12 <= bytes.length; ) {
    const length = readUint32BigEndian(bytes, offset);
    const chunkEnd = offset + 12 + length;
    if (!Number.isSafeInteger(chunkEnd) || chunkEnd > bytes.length) return false;
    const chunk = String.fromCharCode(
      bytes[offset + 4],
      bytes[offset + 5],
      bytes[offset + 6],
      bytes[offset + 7],
    );
    if (chunk === "acTL") hasAnimationControl = true;
    if (chunk === "IDAT") {
      if (!hasAnimationControl || (previousChunk !== "fcTL" && previousChunk !== "IDAT")) {
        return false;
      }
      hasImageData = true;
    }
    if (chunk === "fdAT") {
      if (!hasImageData || (previousChunk !== "fcTL" && previousChunk !== "fdAT")) return false;
      return true;
    }
    previousChunk = chunk;
    offset = chunkEnd;
  }
  return false;
}

function isAnimatedWebp(bytes: Uint8Array): boolean {
  if (
    bytes.length < 12 ||
    bytes[0] !== 0x52 ||
    bytes[1] !== 0x49 ||
    bytes[2] !== 0x46 ||
    bytes[3] !== 0x46 ||
    bytes[8] !== 0x57 ||
    bytes[9] !== 0x45 ||
    bytes[10] !== 0x42 ||
    bytes[11] !== 0x50
  ) {
    return false;
  }
  for (let index = 12; index + 3 < bytes.length; index++) {
    if (
      bytes[index] === 0x41 &&
      bytes[index + 1] === 0x4e &&
      bytes[index + 2] === 0x49 &&
      bytes[index + 3] === 0x4d
    ) {
      return true;
    }
  }
  return false;
}

function isAnimatedImage(bytes: Uint8Array, contentType: string): boolean {
  if (contentType === "image/gif") return isAnimatedGif(bytes);
  if (contentType === "image/png") return isAnimatedPng(bytes);
  if (contentType === "image/webp") return isAnimatedWebp(bytes);
  return false;
}

/**
 * Handle image optimization requests.
 *
 * Parses and validates the request, fetches the source image via the provided
 * handlers, optionally transforms it, and returns the response with appropriate
 * cache headers.
 */
async function renderImageOptimizationUncached(
  request: Request,
  handlers: ImageHandlers,
  allowedWidths?: number[],
  imageConfig?: ImageConfig,
  signal: AbortSignal = request.signal,
): Promise<Response> {
  const url = new URL(request.url);
  const params = parseImageParams(url, allowedWidths, imageConfig?.qualities);

  if (!params) {
    return badRequestResponse();
  }

  const { imageUrl, width, quality } = params;

  // Fetch source image
  const sourceResult = await readImageSource(
    await handlers.fetchAsset(imageUrl, request),
    effectiveImageBodyLimit(imageConfig),
    signal,
  );
  if (sourceResult?.tooLarge) {
    return new Response("The requested resource is too large.", { status: 413 });
  }
  if (!sourceResult) {
    return new Response("The requested resource isn't a valid image.", { status: 400 });
  }
  const { bytes: sourceBytes, response: source, contentType: sourceContentType } = sourceResult;
  const rawImageUrl = url.searchParams.get("url") ?? "";
  const sourceOwnershipPathname = rawImageUrl.split(/[?#]/, 1)[0];
  const configuredBasePath = (imageConfig?.basePath ?? "").replace(/\/$/, "");
  // Next.js recognizes both current and legacy build-owned media directories.
  // Classify ownership from the literal optimizer source rather than its
  // decoded routing pathname: encoded lookalikes may resolve to the same asset,
  // but they are not build-emitted immutable namespaces. Keep both paths
  // anchored to this app's basePath and require a segment boundary.
  // https://github.com/vercel/next.js/blob/canary/packages/next/src/server/image-optimizer.ts
  const staticMediaPaths = [
    `${configuredBasePath}/_next/static/media`,
    `${configuredBasePath}/_next/static/immutable/media`,
  ];
  const sourceIsStatic = staticMediaPaths.some(
    (path) => sourceOwnershipPathname === path || sourceOwnershipPathname.startsWith(`${path}/`),
  );
  if (!sourceContentType) {
    return new Response("The requested resource isn't a valid image.", { status: 400 });
  }

  // Block unsafe detected types (e.g., SVG which can contain embedded scripts).
  // SVG is only allowed when dangerouslyAllowSVG is explicitly enabled.
  if (!isSafeImageContentType(sourceContentType, imageConfig?.dangerouslyAllowSVG)) {
    return new Response("The requested resource is not an allowed image type", { status: 400 });
  }

  // Ported from Next.js: packages/next/src/server/image-optimizer.ts
  // Animated GIF, APNG, and WebP sources retain every frame and bypass the
  // configured transform backend.
  // https://github.com/vercel/next.js/blob/canary/packages/next/src/server/image-optimizer.ts
  if (isAnimatedImage(sourceBytes, sourceContentType)) {
    return createPassthroughImageResponse(
      source,
      imageConfig,
      request,
      sourceContentType,
      sourceIsStatic ? "public, max-age=315360000, immutable" : undefined,
      imageUrl,
    );
  }

  const bypassTypes = new Set([
    "image/svg+xml",
    "image/x-icon",
    "image/x-icns",
    "image/bmp",
    "image/jxl",
    "image/heic",
  ]);
  if (bypassTypes.has(sourceContentType)) {
    return createPassthroughImageResponse(
      source,
      imageConfig,
      request,
      sourceContentType,
      sourceIsStatic ? "public, max-age=315360000, immutable" : undefined,
      imageUrl,
    );
  }

  const negotiatedFormat = negotiateImageFormat(
    request.headers.get("Accept"),
    imageConfig?.formats ?? DEFAULT_IMAGE_FORMATS,
  );
  const format =
    negotiatedFormat ||
    (sourceContentType !== "image/webp" && sourceContentType !== "image/avif"
      ? sourceContentType
      : "image/jpeg");

  // Transform if handler provided, otherwise serve original
  let transformFailed = false;
  if (handlers.transformImage) {
    try {
      const transformed = await handlers.transformImage(source.body!, {
        width,
        format,
        quality,
        signal,
      });
      if (!transformed.ok || !transformed.body) {
        throw new Error(`Image transform returned ${transformed.status}`);
      }
      const transformedBytes = await readTransformedImage(
        transformed,
        effectiveImageBodyLimit(imageConfig),
        signal,
      );
      if (!transformedBytes) throw new Error("Image transform response exceeded the memory limit");
      const headers = new Headers();
      const transformedContentType = transformed.headers.get("Content-Type");
      const transformedEtag = await getImageEtag(transformedBytes);
      if (transformedContentType) headers.set("Content-Type", transformedContentType);
      headers.set("ETag", transformedEtag);
      headers.set(
        "Cache-Control",
        sourceIsStatic
          ? "public, max-age=315360000, immutable"
          : imageCacheControl(source, imageConfig),
      );
      headers.set("Vary", "Accept");
      // Verify the transformed response also has a safe Content-Type.
      // A malicious or buggy transform handler could return HTML.
      if (!isSafeImageContentType(headers.get("Content-Type"), imageConfig?.dangerouslyAllowSVG)) {
        headers.set("Content-Type", format);
      }

      headers.set("Content-Length", String(transformedBytes.byteLength));
      setImageSecurityHeaders(headers, imageUrl, headers.get("Content-Type"), imageConfig);
      return new Response(request.method === "HEAD" ? null : exactArrayBuffer(transformedBytes), {
        status: 200,
        headers,
      });
    } catch (e) {
      console.error("[vinext] Image optimization error:", e);
      transformFailed = true;
    }
  }

  // Fallback: serve original image with cache headers
  const fallbackSource = new Response(exactArrayBuffer(sourceBytes), {
    status: source.status,
    statusText: source.statusText,
    headers: source.headers,
  });
  return createPassthroughImageResponse(
    fallbackSource,
    imageConfig,
    request,
    sourceContentType,
    sourceIsStatic
      ? "public, max-age=315360000, immutable"
      : transformFailed
        ? `public, max-age=${imageConfig?.minimumCacheTTL ?? 14_400}, must-revalidate`
        : undefined,
    imageUrl,
  );
}

export async function handleImageOptimization(
  request: Request,
  handlers: ImageHandlers,
  allowedWidths: number[] = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES],
  imageConfig?: ImageConfig,
): Promise<Response> {
  // Next.js does not expose the Image Optimization API when global
  // unoptimized mode or a non-default loader is configured.
  // https://github.com/vercel/next.js/blob/canary/packages/next/src/server/next-server.ts
  if (isImageOptimizationDisabled(imageConfig)) {
    return notFoundResponse();
  }

  const requestUrl = new URL(request.url);
  const params = parseImageParams(
    requestUrl,
    allowedWidths,
    imageConfig?.qualities ?? [...DEFAULT_IMAGE_QUALITIES],
  );
  if (!params) return badRequestResponse();

  const method = request.method.toUpperCase();
  const negotiatedFormat = negotiateImageFormat(
    request.headers.get("Accept"),
    imageConfig?.formats ?? DEFAULT_IMAGE_FORMATS,
  );
  const owner = handlers.cacheOwner ?? handlers;
  const cache = getImageResponseCache(owner);
  const reservedBytes = imageGenerationReservation(imageConfig);

  // Next's optimizer is a GET/HEAD resource. Other methods may be observed by
  // middleware and remain uncached, but they still consume the same bounded
  // admission, byte budget, deadline, and cancellation-aware source path.
  if (method !== "GET" && method !== "HEAD") {
    const work = runImageGeneration(cache, reservedBytes, async (signal) => {
      const renderRequest = new Request(request.url, {
        headers: request.headers,
        method: request.method,
        signal,
      });
      return renderImageOptimizationUncached(
        renderRequest,
        handlers,
        allowedWidths,
        imageConfig,
        signal,
      );
    });
    try {
      return await awaitImageGeneration(work, request.signal);
    } catch (error) {
      if (
        error instanceof ImageGenerationQueueError ||
        error instanceof ImageGenerationTimeoutError
      ) {
        return new Response("Image optimizer is busy", {
          status: 503,
          headers: { "Retry-After": "1" },
        });
      }
      throw error;
    }
  }

  const cacheKey = imageResponseCacheKey(
    request,
    params,
    negotiatedFormat,
    allowedWidths,
    imageConfig,
  );
  const cached = readCachedImageResponse(cache, cacheKey);

  if (cached && cached.revalidateAfter > Date.now()) {
    return serveCachedImageResponse(request, cached, "HIT");
  }

  const regenerate = (): Promise<GeneratedImageResponse> => {
    const active = cache.pending.get(cacheKey);
    if (active) return active;
    const pending = runImageGeneration(cache, reservedBytes, (signal) =>
      generateCachedImageResponse(request, handlers, allowedWidths, imageConfig, signal),
    )
      .then((generated) => {
        if (generated.entry) {
          writeCachedImageResponse(cache, cacheKey, generated.entry);
        } else if (
          cached &&
          generated.response?.status === 200 &&
          generated.response.body !== null
        ) {
          // A successful response can be intentionally nonresident when it is
          // larger than the per-entry limit. Do not leave an older small entry
          // serving stale forever after that successful regeneration.
          deleteCachedImageResponse(cache, cacheKey, cached);
        }
        return generated;
      })
      .finally(() => cache.pending.delete(cacheKey));
    cache.pending.set(cacheKey, pending);
    return pending;
  };

  if (cached) {
    const regeneration = regenerate().catch((error) => {
      console.error("[vinext] Image cache regeneration error:", error);
      return { entry: null, response: null };
    });
    if (handlers.waitUntil) handlers.waitUntil(regeneration);
    else void regeneration;
    return serveCachedImageResponse(request, cached, "STALE");
  }

  let generated: GeneratedImageResponse;
  try {
    generated = await awaitImageGeneration(regenerate(), request.signal);
  } catch (error) {
    if (
      error instanceof ImageGenerationQueueError ||
      error instanceof ImageGenerationTimeoutError
    ) {
      return new Response("Image optimizer is busy", {
        status: 503,
        headers: { "Retry-After": "1" },
      });
    }
    throw error;
  }
  if (generated.entry) return serveCachedImageResponse(request, generated.entry, "MISS");
  return generated.response
    ? serveBufferedImageResponse(request, generated.response)
    : new Response("Unable to optimize image", { status: 500 });
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
    options: { width: number; format: string; quality: number; signal?: AbortSignal },
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
  cacheOptions?: {
    owner?: object;
    waitUntil?: (promise: Promise<unknown>) => void;
  },
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
      cacheOwner: cacheOptions?.owner ?? fetchAsset,
      waitUntil: cacheOptions?.waitUntil,
    },
    allowedWidths,
    imageConfig,
  );
}
