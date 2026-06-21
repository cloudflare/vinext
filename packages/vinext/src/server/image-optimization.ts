/**
 * Image optimization request handler.
 *
 * Handles `/_next/image?url=...&w=...&q=...` requests. In production
 * on Cloudflare Workers, uses the Images binding (`env.IMAGES`) to
 * resize and transcode on the fly. On other runtimes (Node.js dev/prod
 * server), serves the original file as a passthrough with appropriate
 * Cache-Control headers.
 *
 * Format negotiation: inspects the `Accept` header and selects from the
 * configured formats, which default to WebP like Next.js.
 *
 * Security: All image responses include Content-Security-Policy and
 * X-Content-Type-Options headers to prevent XSS via SVG or Content-Type
 * spoofing. SVG content is blocked by default (following Next.js behavior).
 * When `dangerouslyAllowSVG` is enabled in next.config.js, SVGs are served
 * as-is (no transformation) with security headers applied.
 */

import { badRequestResponse } from "./http-error-responses.js";
import {
  hasLocalMatch,
  hasRemoteMatch,
  isPrivateIp,
  type LocalPattern,
  type RemotePatternInput,
} from "vinext/shims/image-config";
import { isIP } from "node:net";

/** The pathname that triggers image optimization (matches Next.js). */
export const IMAGE_OPTIMIZATION_PATH = "/_next/image";

/** Returns true when `pathname` matches the configured image optimization endpoint. */
export function isImageOptimizationPath(
  pathname: string,
  configuredPath: string = IMAGE_OPTIMIZATION_PATH,
): boolean {
  if (pathname === configuredPath) return true;
  if (configuredPath.length > 1 && configuredPath.endsWith("/")) {
    return pathname === configuredPath.slice(0, -1);
  }
  return false;
}

/** Returns the configured optimizer path in the same basePath-stripped space as routing. */
export function imageOptimizationPathAfterBasePath(
  configuredPath: string = IMAGE_OPTIMIZATION_PATH,
  basePath: string,
): string {
  if (!basePath) return configuredPath;
  if (configuredPath === basePath) return "/";
  if (configuredPath.startsWith(`${basePath}/`)) return configuredPath.slice(basePath.length);
  return configuredPath;
}

/**
 * Image security configuration from next.config.js `images` section.
 * Controls SVG handling and security headers for the image endpoint.
 */
export type ImageConfig = {
  /** Configured optimizer URL path. */
  path?: string;
  /** Configured image loader. Only the default loader exposes the optimizer endpoint. */
  loader?: "default" | "imgix" | "cloudinary" | "akamai" | "custom";
  /** Allowed device widths. Defaults to Next.js device sizes. */
  deviceSizes?: number[];
  /** Allowed fixed-image widths. Defaults to Next.js image sizes. */
  imageSizes?: number[];
  /** Allowed output qualities. Defaults to [75]. */
  qualities?: number[];
  /** Preferred optimized output formats. Defaults to ["image/webp"]. */
  formats?: Array<"image/avif" | "image/webp">;
  /** Disable optimization globally for next/image rendering. */
  unoptimized?: boolean;
  /** Allowed local image URL patterns. Defaults to local paths without query strings. */
  localPatterns?: LocalPattern[];
  /** Allowed remote image URL patterns. */
  remotePatterns?: RemotePatternInput[];
  /** Legacy allowed remote image hostnames. */
  domains?: string[];
  /** Maximum remote redirects. Defaults to 3. */
  maximumRedirects?: number;
  /** Maximum remote response size in bytes. Defaults to 50 MB. */
  maximumResponseBody?: number;
  /** Minimum cache lifetime in seconds for mutable optimized sources. Defaults to 4 hours. */
  minimumCacheTTL?: number;
  /** Allow SVG through the image optimization endpoint. Default: false. */
  dangerouslyAllowSVG?: boolean;
  /**
   * Allow image optimization for hostnames that resolve to private IP addresses.
   * Default: false.
   *
   */
  dangerouslyAllowLocalIP?: boolean;
  /** Content-Disposition header value. Default: "attachment". */
  contentDispositionType?: "inline" | "attachment";
  /** Content-Security-Policy header value. Default: "script-src 'none'; frame-src 'none'; sandbox;" */
  contentSecurityPolicy?: string;
};

/** Returns whether the built-in image optimization endpoint should be exposed. */
export function isImageOptimizationEnabled(imageConfig?: ImageConfig): boolean {
  return imageConfig?.unoptimized !== true && (imageConfig?.loader ?? "default") === "default";
}

/**
 * Next.js default device sizes and image sizes.
 * These are the allowed widths for image optimization when no custom
 * config is provided. Matches Next.js defaults exactly.
 */
export const DEFAULT_DEVICE_SIZES = [640, 750, 828, 1080, 1200, 1920, 2048, 3840];
export const DEFAULT_IMAGE_SIZES = [32, 48, 64, 96, 128, 256, 384];
export const DEFAULT_IMAGE_QUALITIES = [75];
export const DEFAULT_IMAGE_FORMATS: Array<"image/avif" | "image/webp"> = ["image/webp"];
const DEV_BLUR_MAX_WIDTH = 8;
const DEV_BLUR_QUALITY = 70;

export type ParseImageParamsOptions = {
  isDev?: boolean;
  allowRemote?: boolean;
  localPatterns?: LocalPattern[];
};

export function parseRemoteImageUrl(value: string | null): URL | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username !== "" ||
      url.password !== ""
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

export function resolveDevImageRedirect(
  requestUrl: URL,
  allowedWidths: number[] = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES],
  allowedQualities: number[] = DEFAULT_IMAGE_QUALITIES,
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
  allowedQualities: number[] = DEFAULT_IMAGE_QUALITIES,
  options: ParseImageParamsOptions = {},
): { imageUrl: string; width: number; quality: number } | null {
  // Intentional hardening divergence from Next.js: reject duplicate and unknown
  // parameters so semantically identical transforms cannot occupy distinct
  // cache keys and amplify image transformation work.
  const allowedParamNames = new Set(["url", "w", "q", "dpl"]);
  for (const name of url.searchParams.keys()) {
    if (!allowedParamNames.has(name) || url.searchParams.getAll(name).length !== 1) return null;
  }
  const deploymentId = url.searchParams.get("dpl");
  if (deploymentId !== null && deploymentId.length === 0) return null;

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

  if (options.allowRemote) {
    const remoteUrl = parseRemoteImageUrl(imageUrl);
    if (remoteUrl) return { imageUrl: remoteUrl.href, width, quality };
  }

  // Prevent open redirect / SSRF — local sources must be path-relative URLs.
  // Normalize backslashes to forward slashes first: browsers and the URL
  // constructor treat /\evil.com as protocol-relative (//evil.com).
  const normalizedUrl = imageUrl.replaceAll("\\", "/");
  // The URL must start with "/" (but not "//") to be a valid relative path.
  // This blocks absolute URLs (http://, https://), protocol-relative (//),
  // backslash variants (/\), and exotic schemes (data:, javascript:, ftp:, etc.).
  if (!normalizedUrl.startsWith("/") || normalizedUrl.startsWith("//")) {
    return null;
  }
  if (!hasLocalMatch(options.localPatterns, normalizedUrl)) return null;
  // Double-check: after URL construction, the origin must not change.
  // This catches any remaining parser differentials.
  try {
    const base = "https://localhost";
    const resolved = new URL(normalizedUrl, base);
    if (resolved.origin !== base) {
      return null;
    }
  } catch {
    return null;
  }

  try {
    const pathname = decodeURIComponent(new URL(normalizedUrl, "https://localhost").pathname);
    if (/\/(?:_next|_vinext)\/image(?:$|\/)/.test(pathname)) return null;
  } catch {
    return null;
  }

  return { imageUrl: normalizedUrl, width, quality };
}

/**
 * Negotiate the best output format based on the Accept header.
 * Returns an IANA media type.
 */
export function negotiateImageFormat(
  acceptHeader: string | null,
  formats: readonly string[] = DEFAULT_IMAGE_FORMATS,
): string {
  if (!acceptHeader) return "";

  const accepted = acceptHeader.split(",").flatMap((entry, position) => {
    const [rawToken, ...parameters] = entry.trim().split(";");
    const token = rawToken.trim().toLowerCase();
    if (!token) return [];
    let quality = 1;
    for (const parameter of parameters) {
      const match = parameter.trim().match(/^q\s*=\s*(0(?:\.\d+)?|1(?:\.0+)?)$/i);
      if (match) quality = Number(match[1]);
    }
    return [{ token, quality, position }];
  });

  let selected = "";
  let selectedQuality = -1;
  for (const format of formats) {
    const normalizedFormat = format.toLowerCase();
    const exactMatches = accepted.filter(({ token }) => token === normalizedFormat);
    const typeMatches = accepted.filter(({ token }) => token === "image/*");
    const wildcardMatches = accepted.filter(({ token }) => token === "*/*");
    const match = (
      exactMatches.length > 0
        ? exactMatches
        : typeMatches.length > 0
          ? typeMatches
          : wildcardMatches
    ).sort((left, right) => right.quality - left.quality || left.position - right.position)[0];
    if (match && match.quality > 0 && match.quality > selectedQuality) {
      selected = format;
      selectedQuality = match.quality;
    }
  }
  return selected;
}

/**
 * Standard Cache-Control header for optimized images.
 * Optimized images are immutable because the URL encodes the transform params.
 */
export const STATIC_IMAGE_CACHE_CONTROL = "public, max-age=315360000, immutable";
export const DEFAULT_MINIMUM_CACHE_TTL = 14_400;

export function getImageMaxAge(cacheControl: string | null): number {
  if (!cacheControl) return 0;
  let maxAge = 0;
  const directives = cacheControl.split(",");
  for (const directive of directives) {
    const match = directive.trim().match(/^(s-maxage|max-age)\s*=\s*"?(\d+)"?$/i);
    if (!match) continue;
    const value = Number(match[2]);
    if (match[1].toLowerCase() === "s-maxage") return value;
    maxAge = value;
  }
  return maxAge;
}

export function getImageCacheControl(
  imageUrl: string,
  sourceCacheControl: string | null,
  minimumCacheTTL = DEFAULT_MINIMUM_CACHE_TTL,
  isDev = false,
): string {
  if (isDev) return "public, max-age=0, must-revalidate";
  if (imageUrl.startsWith("/") && imageUrl.includes("/_next/static/media/")) {
    return STATIC_IMAGE_CACHE_CONTROL;
  }
  const maxAge = Math.max(minimumCacheTTL, getImageMaxAge(sourceCacheControl));
  return `public, max-age=${maxAge}, must-revalidate`;
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
  "image/bmp",
  "image/tiff",
]);

const IMAGE_CONTENT_TYPE_EXTENSIONS = new Map([
  ["image/jpeg", "jpeg"],
  ["image/png", "png"],
  ["image/gif", "gif"],
  ["image/webp", "webp"],
  ["image/avif", "avif"],
  ["image/x-icon", "ico"],
  ["image/vnd.microsoft.icon", "ico"],
  ["image/bmp", "bmp"],
  ["image/tiff", "tiff"],
  ["image/svg+xml", "svg"],
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

/**
 * Apply security headers to an image optimization response.
 * These headers are set on every response from the image endpoint,
 * regardless of whether the image was transformed or served as-is.
 * When an ImageConfig is provided, uses its values for CSP and Content-Disposition.
 */
export function getImageContentDisposition(
  imageUrl: string,
  contentType: string | null,
  type: string,
) {
  let pathname: string;
  try {
    pathname = new URL(imageUrl, "https://localhost").pathname;
  } catch {
    pathname = imageUrl.split("?", 1)[0];
  }
  const encodedBasename = pathname.split("/").pop() || "image";
  let basename: string;
  try {
    basename = decodeURIComponent(encodedBasename);
  } catch {
    basename = encodedBasename;
  }
  const stem = basename.split(".", 1)[0] || "image";
  const mediaType = contentType?.split(";", 1)[0].trim().toLowerCase();
  const extension = (mediaType && IMAGE_CONTENT_TYPE_EXTENSIONS.get(mediaType)) || "bin";
  return formatContentDisposition(`${stem}.${extension}`, type);
}

function formatContentDisposition(filename: string, type: string): string {
  const fallback = filename.replace(/[^\x20-\x7e\xa0-\xff]/g, "?");
  const quotedFallback = fallback.replace(/([\\"])/g, "\\$1");
  const needsExtendedFilename = fallback !== filename || /%[0-9A-Fa-f]{2}/.test(filename);
  const extendedFilename = encodeURIComponent(filename).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );

  return `${type}; filename="${quotedFallback}"${needsExtendedFilename ? `; filename*=UTF-8''${extendedFilename}` : ""}`;
}

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
  const dispositionType = config?.contentDispositionType === "inline" ? "inline" : "attachment";
  headers.set(
    "Content-Disposition",
    getImageContentDisposition(imageUrl, contentType, dispositionType),
  );
}

function createPassthroughImageResponse(
  source: Response,
  imageUrl: string,
  config?: ImageConfig,
  isDev = false,
): Response {
  const isRemote = parseRemoteImageUrl(imageUrl) !== null;
  const headers = isRemote ? new Headers() : new Headers(source.headers);
  if (isRemote) {
    const contentType = source.headers.get("Content-Type");
    if (contentType) headers.set("Content-Type", contentType);
  }
  headers.set(
    "Cache-Control",
    getImageCacheControl(
      imageUrl,
      source.headers.get("Cache-Control"),
      config?.minimumCacheTTL,
      isDev,
    ),
  );
  headers.set("Vary", "Accept");
  setImageSecurityHeaders(headers, imageUrl, headers.get("Content-Type"), config);
  return new Response(source.body, { status: 200, headers });
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
  /** Optional fetch implementation bound to the already-validated addresses. */
  fetchRemote?: (url: URL, addresses: readonly string[], signal: AbortSignal) => Promise<Response>;
  /** Optional hostname resolver used by Node runtimes for private-IP checks. */
  resolveHostnames?: (hostname: string) => Promise<string[]>;
};

/** Copy the complete image configuration used by runtime optimizer adapters. */
export function createRuntimeImageConfig(config?: ImageConfig): ImageConfig | undefined {
  if (!config) return undefined;
  return {
    path: config.path,
    loader: config.loader,
    deviceSizes: config.deviceSizes,
    imageSizes: config.imageSizes,
    qualities: config.qualities,
    formats: config.formats,
    unoptimized: config.unoptimized,
    localPatterns: config.localPatterns,
    remotePatterns: config.remotePatterns,
    domains: config.domains,
    maximumRedirects: config.maximumRedirects,
    maximumResponseBody: config.maximumResponseBody,
    minimumCacheTTL: config.minimumCacheTTL,
    dangerouslyAllowSVG: config.dangerouslyAllowSVG,
    dangerouslyAllowLocalIP: config.dangerouslyAllowLocalIP,
    contentDispositionType: config.contentDispositionType,
    contentSecurityPolicy: config.contentSecurityPolicy,
  };
}

const DEFAULT_MAXIMUM_REDIRECTS = 3;
const DEFAULT_MAXIMUM_RESPONSE_BODY = 50_000_000;
const REMOTE_FETCH_TIMEOUT_MS = 7_000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function isLocalHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".internal")
  );
}

/**
 * Redirect configured remote image requests from Workers to their source URL.
 *
 * Workers cannot bind hostname validation to the subsequent outbound fetch, so
 * proxying remote images would leave a DNS-rebinding SSRF gap. Node runtimes can
 * continue to optimize remote images with their resolver-backed handler. Worker
 * deployments safely fall back to the original, unoptimized remote image.
 */
export function getWorkerRemoteImageRedirect(
  request: Request,
  allowedWidths?: number[],
  imageConfig: ImageConfig = {},
): Response | null {
  const requestUrl = new URL(request.url);
  const rawImageUrl = requestUrl.searchParams.get("url");
  if (!rawImageUrl) return null;

  const rawSourceUrl = parseRemoteImageUrl(rawImageUrl);
  if (!rawSourceUrl) return null;

  const params = parseImageParams(requestUrl, allowedWidths, imageConfig.qualities, {
    allowRemote: true,
  });
  if (!params) return badRequestResponse();

  const sourceUrl = parseRemoteImageUrl(params.imageUrl);
  if (!sourceUrl) return badRequestResponse();

  if (
    sourceUrl.username !== "" ||
    sourceUrl.password !== "" ||
    (!imageConfig.dangerouslyAllowLocalIP &&
      (isLocalHostname(sourceUrl.hostname) || isPrivateIp(sourceUrl.hostname))) ||
    !hasRemoteMatch(imageConfig.domains ?? [], imageConfig.remotePatterns ?? [], sourceUrl)
  ) {
    return badRequestResponse();
  }

  return new Response(null, {
    status: 307,
    headers: {
      "Cache-Control": "private, no-store",
      Location: sourceUrl.href,
    },
  });
}

async function validateRemoteTarget(
  url: URL,
  config: ImageConfig,
  resolveHostnames?: (hostname: string) => Promise<string[]>,
  requireRemoteMatch = false,
): Promise<string[] | null> {
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    (requireRemoteMatch && !hasRemoteMatch(config.domains ?? [], config.remotePatterns ?? [], url))
  ) {
    return null;
  }

  const hostname =
    url.hostname.startsWith("[") && url.hostname.endsWith("]")
      ? url.hostname.slice(1, -1)
      : url.hostname;
  if (!config.dangerouslyAllowLocalIP && isLocalHostname(hostname)) return null;
  if (isIP(hostname)) {
    if (!config.dangerouslyAllowLocalIP && isPrivateIp(hostname)) return null;
    return [hostname];
  }

  if (!resolveHostnames) return null;

  try {
    const addresses = await resolveHostnames(hostname);
    if (
      addresses.length === 0 ||
      (!config.dangerouslyAllowLocalIP && addresses.some(isPrivateIp))
    ) {
      return null;
    }
    return addresses;
  } catch {
    return null;
  }
}

async function readBoundedResponse(response: Response, maximumBytes: number): Promise<Response> {
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > maximumBytes) {
    await response.body?.cancel();
    return new Response("Remote image response is too large", { status: 413 });
  }
  if (!response.body) return new Response("Remote image response is empty", { status: 400 });

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalSize = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalSize += value.byteLength;
      if (totalSize > maximumBytes) {
        await reader.cancel();
        return new Response("Remote image response is too large", { status: 413 });
      }
      chunks.push(value);
    }
  } catch (error) {
    try {
      await reader.cancel(error);
    } catch {}
    return remoteFetchErrorResponse(error);
  }

  const body = new Uint8Array(totalSize);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Response(body, { status: response.status, headers: response.headers });
}

function remoteFetchErrorResponse(error: unknown): Response {
  const errorName =
    typeof error === "object" && error !== null && "name" in error ? error.name : undefined;
  const status = errorName === "AbortError" || errorName === "TimeoutError" ? 504 : 502;
  return new Response(
    status === 504 ? "Remote image request timed out" : "Remote image request failed",
    { status },
  );
}

async function fetchRemoteImage(
  sourceUrl: string,
  config: ImageConfig,
  handlers: ImageHandlers,
): Promise<Response> {
  const fetchRemote = handlers.fetchRemote;
  const maximumRedirects = config.maximumRedirects ?? DEFAULT_MAXIMUM_REDIRECTS;
  const maximumResponseBody = config.maximumResponseBody ?? DEFAULT_MAXIMUM_RESPONSE_BODY;
  let currentUrl = new URL(sourceUrl);

  for (let redirectCount = 0; ; redirectCount++) {
    const addresses = await validateRemoteTarget(
      currentUrl,
      config,
      handlers.resolveHostnames,
      redirectCount === 0,
    );
    if (!addresses || !fetchRemote) {
      return new Response("Remote image URL is not allowed", { status: 400 });
    }

    let response: Response;
    try {
      response = await fetchRemote(
        currentUrl,
        addresses,
        AbortSignal.timeout(REMOTE_FETCH_TIMEOUT_MS),
      );
    } catch (error) {
      return remoteFetchErrorResponse(error);
    }

    const location = response.headers.get("location");
    if (REDIRECT_STATUSES.has(response.status) && location) {
      await response.body?.cancel();
      if (redirectCount >= maximumRedirects) {
        return new Response("Remote image redirected too many times", { status: 508 });
      }
      try {
        currentUrl = new URL(location, currentUrl);
      } catch {
        return new Response("Remote image redirect is invalid", { status: 400 });
      }
      continue;
    }

    if (!response.ok) {
      await response.body?.cancel();
      return new Response("Remote image request failed", { status: response.status });
    }

    if (!isSafeImageContentType(response.headers.get("Content-Type"), config.dangerouslyAllowSVG)) {
      await response.body?.cancel();
      return new Response("The requested resource is not an allowed image type", { status: 400 });
    }

    return readBoundedResponse(response, maximumResponseBody);
  }
}

function fetchImageSource(
  imageUrl: string,
  request: Request,
  imageConfig: ImageConfig,
  handlers: ImageHandlers,
): Promise<Response> {
  return parseRemoteImageUrl(imageUrl)
    ? fetchRemoteImage(imageUrl, imageConfig, handlers)
    : handlers.fetchAsset(imageUrl, request);
}

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
  options: { isDev?: boolean } = {},
): Promise<Response> {
  const url = new URL(request.url);
  const params = parseImageParams(
    url,
    allowedWidths,
    imageConfig?.qualities ?? DEFAULT_IMAGE_QUALITIES,
    {
      allowRemote: true,
      localPatterns: imageConfig?.localPatterns,
    },
  );

  if (!params) {
    return badRequestResponse();
  }

  const { imageUrl, width, quality } = params;

  // Fetch source image
  const isRemote = parseRemoteImageUrl(imageUrl) !== null;
  const source = await fetchImageSource(imageUrl, request, imageConfig ?? {}, handlers);
  if (!source.ok || !source.body) {
    if (isRemote) return source;
    return new Response("Image not found", { status: 404 });
  }

  // Block unsafe Content-Types (e.g., SVG which can contain embedded scripts).
  // Check the source Content-Type before any processing. SVG is only allowed
  // when dangerouslyAllowSVG is explicitly enabled in next.config.js.
  const sourceContentType = source.headers.get("Content-Type");
  const responseCacheControl = getImageCacheControl(
    imageUrl,
    source.headers.get("Cache-Control"),
    imageConfig?.minimumCacheTTL,
    options.isDev ?? false,
  );
  if (!isSafeImageContentType(sourceContentType, imageConfig?.dangerouslyAllowSVG)) {
    await source.body.cancel();
    return new Response("The requested resource is not an allowed image type", { status: 400 });
  }

  // SVG passthrough: SVG is a vector format, so transformation (resize, format
  // conversion) provides no benefit. Serve as-is with security headers.
  // This matches Next.js behavior where SVG is a "bypass type".
  const sourceMediaType = sourceContentType?.split(";")[0].trim().toLowerCase();
  if (sourceMediaType === "image/svg+xml") {
    return createPassthroughImageResponse(source, imageUrl, imageConfig, options.isDev ?? false);
  }

  const format =
    negotiateImageFormat(request.headers.get("Accept"), imageConfig?.formats) ||
    sourceMediaType ||
    "image/jpeg";

  // Transform if handler provided, otherwise serve original
  if (handlers.transformImage) {
    try {
      const transformed = await handlers.transformImage(source.body, {
        width,
        format,
        quality,
      });
      const headers = new Headers(transformed.headers);
      headers.set("Cache-Control", responseCacheControl);
      headers.set("Vary", "Accept");

      // Verify the transformed response also has a safe Content-Type.
      // A malicious or buggy transform handler could return HTML.
      if (!isSafeImageContentType(headers.get("Content-Type"), imageConfig?.dangerouslyAllowSVG)) {
        headers.set("Content-Type", format);
      }
      setImageSecurityHeaders(headers, imageUrl, headers.get("Content-Type"), imageConfig);

      return new Response(transformed.body, { status: 200, headers });
    } catch (e) {
      console.error("[vinext] Image optimization error:", e);
    }
  }

  // Fallback: serve original image with cache headers
  try {
    return createPassthroughImageResponse(source, imageUrl, imageConfig, options.isDev ?? false);
  } catch (e) {
    console.error("[vinext] Image fallback error, refetching source image:", e);
    const refetchedSource = await fetchImageSource(imageUrl, request, imageConfig ?? {}, handlers);
    if (!refetchedSource.ok || !refetchedSource.body) {
      return new Response("Image not found", { status: 404 });
    }

    const refetchedContentType = refetchedSource.headers.get("Content-Type");
    if (!isSafeImageContentType(refetchedContentType, imageConfig?.dangerouslyAllowSVG)) {
      return new Response("The requested resource is not an allowed image type", { status: 400 });
    }

    return createPassthroughImageResponse(
      refetchedSource,
      imageUrl,
      imageConfig,
      options.isDev ?? false,
    );
  }
}
