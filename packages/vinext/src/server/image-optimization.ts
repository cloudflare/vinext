/**
 * Shared image optimization request handling.
 */

import {
  hasLocalMatch,
  hasRemoteMatch,
  imageConfigDefault,
  type ImageFormat,
  type LocalPattern,
  type RemotePattern,
} from "../shims/image-config.js";

export const IMAGE_OPTIMIZATION_PATH = "/_vinext/image";
export const DEFAULT_DEVICE_SIZES = imageConfigDefault.deviceSizes;
export const DEFAULT_IMAGE_SIZES = imageConfigDefault.imageSizes;
export const IMAGE_CONTENT_SECURITY_POLICY = imageConfigDefault.contentSecurityPolicy;

const ABSOLUTE_MAX_WIDTH = 3840;
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

export interface ImageConfig {
  path?: string;
  deviceSizes?: number[];
  imageSizes?: number[];
  domains?: string[];
  remotePatterns?: Array<URL | RemotePattern>;
  localPatterns?: LocalPattern[];
  qualities?: number[];
  formats?: ImageFormat[];
  minimumCacheTTL?: number;
  maximumRedirects?: number;
  maximumResponseBody?: number;
  dangerouslyAllowLocalIP?: boolean;
  dangerouslyAllowSVG?: boolean;
  contentDispositionType?: "inline" | "attachment";
  contentSecurityPolicy?: string;
}

export interface ImageHandlers {
  fetchAsset: (path: string, request: Request) => Promise<Response>;
  fetchExternalAsset?: (url: string, request: Request) => Promise<Response>;
  transformImage?: (
    body: ReadableStream,
    options: { width: number; format: string; quality: number },
  ) => Promise<Response>;
}

export function parseImageParams(
  url: URL,
  allowedWidths?: number[],
  allowedQualities?: number[],
): { imageUrl: string; width: number; quality: number; isRemote: boolean } | null {
  const imageUrl = url.searchParams.get("url");
  const widthValue = url.searchParams.get("w");
  const qualityValue = url.searchParams.get("q");
  if (!imageUrl || !widthValue || !qualityValue) return null;

  // Reject recursive optimization URLs (prevents infinite loops)
  try {
    const decodedUrl = decodeURIComponent(imageUrl);
    if (decodedUrl.includes("/_vinext/image")) return null;
  } catch {
    // If decoding fails, check the raw URL
    if (imageUrl.includes("/_vinext/image")) return null;
  }

  // Reject excessively long URLs (DoS prevention)
  if (imageUrl.length > 3072) return null;

  const width = parseInt(widthValue, 10);
  const quality = parseInt(qualityValue, 10);
  if (!Number.isInteger(width) || width < 1 || width > ABSOLUTE_MAX_WIDTH) return null;
  if (allowedWidths && !allowedWidths.includes(width)) return null;
  if (!Number.isInteger(quality) || quality < 1 || quality > 100) return null;
  if (allowedQualities && !allowedQualities.includes(quality)) return null;

  const normalized = imageUrl.replaceAll("\\", "/");
  if (normalized.startsWith("/")) {
    if (normalized.startsWith("//")) return null;
    try {
      const resolved = new URL(normalized, "https://localhost");
      if (resolved.origin !== "https://localhost") {
        return null;
      }
    } catch {
      return null;
    }
    return { imageUrl: normalized, width, quality, isRemote: false };
  }

  if (/^https?:\/\//i.test(normalized)) {
    try {
      const resolved = new URL(normalized);
      return { imageUrl: resolved.toString(), width, quality, isRemote: true };
    } catch {
      return null;
    }
  }

  return null;
}

export function negotiateImageFormat(
  acceptHeader: string | null,
  formats: ImageFormat[] = imageConfigDefault.formats,
): string {
  if (!acceptHeader) return "image/jpeg";
  for (const format of formats) {
    if (acceptHeader.includes(format)) {
      return format;
    }
  }
  return "image/jpeg";
}

/**
 * Parse upstream Cache-Control header to extract cache duration.
 * Prefers s-maxage over max-age. Returns 0 when no usable directive found.
 */
export function getMaxAge(header: string | null): number {
  if (!header) return 0;

  const directives = header.toLowerCase();

  // If no-store or no-cache, don't cache
  if (/(?:^|,)\s*(?:no-store|no-cache)\s*(?:,|$)/.test(directives)) {
    return 0;
  }

  // Prefer s-maxage over max-age
  const sMaxAgeMatch = directives.match(/s-maxage\s*=\s*"?(\d+)"?/);
  if (sMaxAgeMatch) {
    const val = parseInt(sMaxAgeMatch[1], 10);
    return Number.isFinite(val) ? val : 0;
  }

  const maxAgeMatch = directives.match(/max-age\s*=\s*"?(\d+)"?/);
  if (maxAgeMatch) {
    const val = parseInt(maxAgeMatch[1], 10);
    return Number.isFinite(val) ? val : 0;
  }

  return 0;
}

function getCacheControl(imageConfig?: ImageConfig, upstreamCacheControl?: string | null): string {
  const minimumTTL = imageConfig?.minimumCacheTTL ?? imageConfigDefault.minimumCacheTTL;
  const upstreamMaxAge = getMaxAge(upstreamCacheControl ?? null);
  const ttl = Math.max(upstreamMaxAge, minimumTTL);
  return `public, max-age=${ttl}, must-revalidate`;
}

function extensionFromContentType(contentType: string | null): string | null {
  if (!contentType) return null;
  const mediaType = contentType.split(";")[0].trim().toLowerCase();
  switch (mediaType) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    case "image/avif":
      return "avif";
    case "image/x-icon":
    case "image/vnd.microsoft.icon":
      return "ico";
    case "image/bmp":
      return "bmp";
    case "image/tiff":
      return "tiff";
    case "image/svg+xml":
      return "svg";
    default:
      return null;
  }
}

function toContentDispositionFilename(imageUrl: string, contentType: string | null): string {
  try {
    const pathname = /^https?:\/\//i.test(imageUrl) ? new URL(imageUrl).pathname : imageUrl;
    const basename = pathname.split("/").filter(Boolean).pop();
    const extension = extensionFromContentType(contentType);
    if (!basename || !extension) {
      return (basename || "image").replace(/["\\\r\n]/g, "_");
    }
    const [name] = basename.split(".", 1);
    return `${name || "image"}.${extension}`.replace(/["\\\r\n]/g, "_");
  } catch {
    return "image";
  }
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
  const disposition = config?.contentDispositionType ?? imageConfigDefault.contentDispositionType;
  headers.set(
    "Content-Disposition",
    `${disposition}; filename="${toContentDispositionFilename(imageUrl, contentType)}"`,
  );
}

function buildUpstreamRequestHeaders(request: Request): Headers {
  return new Headers({
    Accept: request.headers.get("Accept") ?? "*/*",
  });
}

export function isSafeImageContentType(
  contentType: string | null,
  dangerouslyAllowSVG = false,
): boolean {
  if (!contentType) return false;
  const mediaType = contentType.split(";")[0].trim().toLowerCase();
  if (SAFE_IMAGE_CONTENT_TYPES.has(mediaType)) return true;
  if (dangerouslyAllowSVG && mediaType === "image/svg+xml") return true;
  return false;
}

/**
 * Detect image content type from magic bytes.
 * Ported from Next.js: packages/next/src/server/image-optimizer/detect-content-type.ts
 */
export function detectContentType(buffer: ArrayBuffer): string | null {
  const view = new Uint8Array(buffer);
  if (view.length < 2) return null;

  // JPEG: FF D8
  if (view[0] === 0xff && view[1] === 0xd8) return "image/jpeg";

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    view.length >= 8 &&
    view[0] === 0x89 &&
    view[1] === 0x50 &&
    view[2] === 0x4e &&
    view[3] === 0x47 &&
    view[4] === 0x0d &&
    view[5] === 0x0a &&
    view[6] === 0x1a &&
    view[7] === 0x0a
  ) {
    return "image/png";
  }

  // GIF: 47 49 46
  if (view.length >= 3 && view[0] === 0x47 && view[1] === 0x49 && view[2] === 0x46) {
    return "image/gif";
  }

  // WebP: RIFF....WEBP
  if (
    view.length >= 12 &&
    view[0] === 0x52 &&
    view[1] === 0x49 &&
    view[2] === 0x46 &&
    view[3] === 0x46 &&
    view[8] === 0x57 &&
    view[9] === 0x45 &&
    view[10] === 0x42 &&
    view[11] === 0x50
  ) {
    return "image/webp";
  }

  // AVIF: ....ftypavif or ....ftypavis
  if (view.length >= 12) {
    const ftypSlice = String.fromCharCode(...view.slice(4, 12));
    if (ftypSlice === "ftypavif" || ftypSlice === "ftypavis") {
      return "image/avif";
    }
  }

  // HEIC: ....ftypheic or ....ftypheix or ....ftyphevc or ....ftyphevx or ....ftypmif1
  if (view.length >= 12) {
    const ftypSlice = String.fromCharCode(...view.slice(4, 12));
    if (
      ftypSlice === "ftypheic" ||
      ftypSlice === "ftypheix" ||
      ftypSlice === "ftyphevc" ||
      ftypSlice === "ftyphevx" ||
      ftypSlice === "ftypmif1"
    ) {
      return "image/heic";
    }
  }

  // JP2: ....ftypjp2 (JPEG 2000)
  if (view.length >= 11) {
    const ftypSlice = String.fromCharCode(...view.slice(4, 11));
    if (ftypSlice === "ftypjp2") {
      return "image/jp2";
    }
  }

  // ICO: 00 00 01 00
  if (
    view.length >= 4 &&
    view[0] === 0x00 &&
    view[1] === 0x00 &&
    view[2] === 0x01 &&
    view[3] === 0x00
  ) {
    return "image/x-icon";
  }

  // ICNS: 69 63 6E 73 (icns)
  if (
    view.length >= 4 &&
    view[0] === 0x69 &&
    view[1] === 0x63 &&
    view[2] === 0x6e &&
    view[3] === 0x73
  ) {
    return "image/icns";
  }

  // TIFF: 49 49 2A 00 (little-endian) or 4D 4D 00 2A (big-endian)
  if (view.length >= 4) {
    if (view[0] === 0x49 && view[1] === 0x49 && view[2] === 0x2a && view[3] === 0x00) {
      return "image/tiff";
    }
    if (view[0] === 0x4d && view[1] === 0x4d && view[2] === 0x00 && view[3] === 0x2a) {
      return "image/tiff";
    }
  }

  // BMP: 42 4D
  if (view[0] === 0x42 && view[1] === 0x4d) return "image/bmp";

  // JPEG XL: FF 0A or 00 00 00 0C 4A 58 4C 20 0D 0A 87 0A
  if (view[0] === 0xff && view[1] === 0x0a) return "image/jxl";
  if (
    view.length >= 12 &&
    view[0] === 0x00 &&
    view[1] === 0x00 &&
    view[2] === 0x00 &&
    view[3] === 0x0c &&
    view[4] === 0x4a &&
    view[5] === 0x58 &&
    view[6] === 0x4c &&
    view[7] === 0x20 &&
    view[8] === 0x0d &&
    view[9] === 0x0a &&
    view[10] === 0x87 &&
    view[11] === 0x0a
  ) {
    return "image/jxl";
  }

  // PDF: 25 50 44 46 (%PDF)
  if (
    view.length >= 4 &&
    view[0] === 0x25 &&
    view[1] === 0x50 &&
    view[2] === 0x44 &&
    view[3] === 0x46
  ) {
    return "application/pdf";
  }

  // SVG: check for <?xml or <svg (with optional leading whitespace)
  const text = new TextDecoder("utf-8", { fatal: false }).decode(view.slice(0, 1024));
  const trimmed = text.trimStart();
  if (trimmed.startsWith("<?xml") || trimmed.startsWith("<svg")) {
    return "image/svg+xml";
  }

  return null;
}

/**
 * Detect whether an image buffer contains animation.
 * Checks GIF for multiple image descriptors, WebP for ANIM chunk,
 * and PNG for acTL chunk (APNG).
 */
export function isAnimated(buffer: ArrayBuffer, contentType: string): boolean {
  const view = new Uint8Array(buffer);
  const mediaType = contentType.split(";")[0].trim().toLowerCase();

  if (mediaType === "image/gif") {
    // GIF: look for multiple image descriptor markers (0x2C)
    // A single-frame GIF has exactly one, animated has more
    let imageDescriptorCount = 0;
    for (let i = 0; i < view.length; i++) {
      if (view[i] === 0x2c) {
        imageDescriptorCount++;
        if (imageDescriptorCount > 1) return true;
      }
    }
    return false;
  }

  if (mediaType === "image/webp") {
    // WebP: look for ANIM chunk (animated WebP uses VP8X + ANIM)
    // Search for "ANIM" in the file
    for (let i = 0; i < view.length - 3; i++) {
      if (
        view[i] === 0x41 && // A
        view[i + 1] === 0x4e && // N
        view[i + 2] === 0x49 && // I
        view[i + 3] === 0x4d // M
      ) {
        return true;
      }
    }
    return false;
  }

  if (mediaType === "image/png") {
    // APNG: look for acTL chunk (animation control)
    for (let i = 0; i < view.length - 3; i++) {
      if (
        view[i] === 0x61 && // a
        view[i + 1] === 0x63 && // c
        view[i + 2] === 0x54 && // T
        view[i + 3] === 0x4c // L
      ) {
        return true;
      }
    }
    return false;
  }

  return false;
}

function stripIpv6Brackets(hostname: string): string {
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    return hostname.slice(1, -1);
  }
  return hostname;
}

/** @internal */
export function parseIpv4(hostname: string): [number, number, number, number] | null {
  const match = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return null;
  const octets = match.slice(1).map((part) => parseInt(part, 10));
  if (octets.some((octet) => Number.isNaN(octet) || octet < 0 || octet > 255)) {
    return null;
  }
  return octets as [number, number, number, number];
}

/** @internal */
export function isBlockedIpv4(octets: [number, number, number, number]): boolean {
  const [a, b] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

/** @internal */
export function parseIpv6(hostname: string): number[] | null {
  let normalized = stripIpv6Brackets(hostname).toLowerCase();
  if (!normalized.includes(":")) return null;

  const zoneIndex = normalized.indexOf("%");
  if (zoneIndex !== -1) {
    normalized = normalized.slice(0, zoneIndex);
  }

  if (normalized.indexOf("::") !== normalized.lastIndexOf("::")) {
    return null;
  }

  if (normalized.includes(".")) {
    const lastColon = normalized.lastIndexOf(":");
    if (lastColon === -1) return null;
    const ipv4 = parseIpv4(normalized.slice(lastColon + 1));
    if (!ipv4) return null;
    normalized =
      normalized.slice(0, lastColon) +
      ":" +
      ((ipv4[0] << 8) | ipv4[1]).toString(16) +
      ":" +
      ((ipv4[2] << 8) | ipv4[3]).toString(16);
  }

  const hasCompression = normalized.includes("::");
  const [left, right = ""] = normalized.split("::");
  const leftParts = left ? left.split(":") : [];
  const rightParts = hasCompression && right ? right.split(":") : [];
  const parsePart = (part: string): number | null =>
    /^[0-9a-f]{1,4}$/.test(part) ? parseInt(part, 16) : null;

  const parsedLeft = leftParts.map(parsePart);
  const parsedRight = rightParts.map(parsePart);
  if (parsedLeft.some((part) => part === null) || parsedRight.some((part) => part === null)) {
    return null;
  }

  if (!hasCompression) {
    return parsedLeft.length === 8 ? (parsedLeft as number[]) : null;
  }

  const missing = 8 - (parsedLeft.length + parsedRight.length);
  if (missing < 1) return null;
  return [...(parsedLeft as number[]), ...Array(missing).fill(0), ...(parsedRight as number[])];
}

/** @internal */
export function getIpv4MappedAddress(ipv6: number[]): string | null {
  if (!ipv6.slice(0, 5).every((part) => part === 0) || ipv6[5] !== 0xffff) {
    return null;
  }
  return `${ipv6[6] >> 8}.${ipv6[6] & 0xff}.${ipv6[7] >> 8}.${ipv6[7] & 0xff}`;
}

function streamFromArrayBuffer(buffer: ArrayBuffer): ReadableStream {
  const body = new Response(buffer.slice(0)).body;
  if (!body) {
    throw new Error("Failed to create response body");
  }
  return body;
}

/** @internal */
export function isBlockedLocalHost(hostname: string): boolean {
  const lower = stripIpv6Brackets(hostname).toLowerCase();
  if (lower === "localhost" || lower.endsWith(".localhost") || lower.endsWith(".local")) {
    return true;
  }
  const ipv4 = parseIpv4(lower);
  if (ipv4) {
    return isBlockedIpv4(ipv4);
  }

  const ipv6 = parseIpv6(lower);
  if (!ipv6) return false;

  if (ipv6.every((part) => part === 0)) return true;
  if (ipv6.slice(0, 7).every((part) => part === 0) && ipv6[7] === 1) return true;

  const mappedIpv4 = getIpv4MappedAddress(ipv6);
  if (mappedIpv4) {
    return isBlockedLocalHost(mappedIpv4);
  }

  return (ipv6[0] & 0xfe00) === 0xfc00 || (ipv6[0] & 0xffc0) === 0xfe80;
}

async function fetchRemoteImage(
  imageUrl: string,
  request: Request,
  imageConfig?: ImageConfig,
): Promise<Response> {
  const maxRedirects = imageConfig?.maximumRedirects ?? imageConfigDefault.maximumRedirects;
  const maxBody = imageConfig?.maximumResponseBody ?? imageConfigDefault.maximumResponseBody;
  const allowLocalIP = imageConfig?.dangerouslyAllowLocalIP ?? false;

  let currentUrl = imageUrl;
  try {
    for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount++) {
      const parsed = new URL(currentUrl);
      if (!allowLocalIP && isBlockedLocalHost(parsed.hostname)) {
        return new Response('"url" parameter is not allowed', { status: 400 });
      }

      const response = await fetch(currentUrl, {
        headers: buildUpstreamRequestHeaders(request),
        redirect: "manual",
        signal: AbortSignal.timeout(7_000),
      });

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (!location) {
          return new Response('"url" parameter is valid but upstream response is invalid', {
            status: 400,
          });
        }
        if (redirectCount === maxRedirects) {
          return new Response("Too many redirects", { status: 508 });
        }
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }

      if (!response.ok) {
        return new Response('"url" parameter is valid but upstream response is invalid', {
          status: 400,
        });
      }

      const body = await response.arrayBuffer();
      if (body.byteLength > maxBody) {
        return new Response('"url" parameter is valid but upstream response is invalid', {
          status: 413,
        });
      }

      return new Response(body, {
        status: 200,
        headers: response.headers,
      });
    }

    return new Response("Too many redirects", { status: 508 });
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      return new Response("Gateway Timeout", { status: 504 });
    }
    throw error;
  }
}

async function fetchSourceImage(
  params: { imageUrl: string; isRemote: boolean },
  request: Request,
  handlers: ImageHandlers,
  imageConfig?: ImageConfig,
): Promise<Response> {
  if (params.isRemote) {
    const remotePatterns = imageConfig?.remotePatterns ?? imageConfigDefault.remotePatterns;
    const domains = imageConfig?.domains ?? imageConfigDefault.domains;
    if (!hasRemoteMatch(domains, remotePatterns, new URL(params.imageUrl))) {
      return new Response('"url" parameter is not allowed', { status: 400 });
    }
    return handlers.fetchExternalAsset
      ? handlers.fetchExternalAsset(params.imageUrl, request)
      : fetchRemoteImage(params.imageUrl, request, imageConfig);
  }

  const localPatterns = imageConfig?.localPatterns ?? imageConfigDefault.localPatterns;
  if (!hasLocalMatch(localPatterns, params.imageUrl)) {
    return new Response('"url" parameter is not allowed', { status: 400 });
  }
  return handlers.fetchAsset(params.imageUrl, request);
}

export async function handleImageOptimization(
  request: Request,
  handlers: ImageHandlers,
  allowedWidths?: number[],
  imageConfig?: ImageConfig,
): Promise<Response> {
  const url = new URL(request.url);
  const params = parseImageParams(url, allowedWidths, imageConfig?.qualities);
  if (!params) {
    return new Response("Bad Request", { status: 400 });
  }

  const source = await fetchSourceImage(params, request, handlers, imageConfig);
  if (!source.ok || !source.body) {
    return source.ok ? new Response("Image not found", { status: 404 }) : source;
  }

  // Read body for magic-byte content-type detection
  const sourceBuffer = await source.arrayBuffer();
  const detectedContentType = detectContentType(sourceBuffer);
  const sourceContentType = detectedContentType ?? source.headers.get("Content-Type");
  if (!isSafeImageContentType(sourceContentType, imageConfig?.dangerouslyAllowSVG)) {
    return new Response("The requested resource is not an allowed image type", { status: 400 });
  }

  const upstreamCacheControl = source.headers.get("Cache-Control");

  const sourceMediaType = sourceContentType?.split(";")[0].trim().toLowerCase();
  if (sourceMediaType === "image/svg+xml") {
    const headers = new Headers(source.headers);
    headers.set("Cache-Control", getCacheControl(imageConfig, upstreamCacheControl));
    headers.set("Vary", "Accept");
    setImageSecurityHeaders(headers, params.imageUrl, sourceMediaType, imageConfig);
    return new Response(sourceBuffer.slice(0), { status: 200, headers });
  }

  // Skip optimization for animated images (would break animation)
  if (isAnimated(sourceBuffer, sourceContentType ?? "")) {
    const headers = new Headers(source.headers);
    headers.set("Cache-Control", getCacheControl(imageConfig, upstreamCacheControl));
    headers.set("Vary", "Accept");
    setImageSecurityHeaders(headers, params.imageUrl, sourceContentType, imageConfig);
    return new Response(sourceBuffer.slice(0), { status: 200, headers });
  }

  const outputFormat = negotiateImageFormat(request.headers.get("Accept"), imageConfig?.formats);
  if (handlers.transformImage) {
    const adjustedQuality =
      outputFormat === "image/avif" ? Math.max(params.quality - 20, 1) : params.quality;
    try {
      const transformed = await handlers.transformImage(streamFromArrayBuffer(sourceBuffer), {
        width: params.width,
        format: outputFormat,
        quality: adjustedQuality,
      });
      const headers = new Headers(transformed.headers);
      headers.set("Content-Type", outputFormat);
      headers.set("Cache-Control", getCacheControl(imageConfig, upstreamCacheControl));
      headers.set("Vary", "Accept");
      setImageSecurityHeaders(headers, params.imageUrl, outputFormat, imageConfig);
      return new Response(transformed.body, {
        status: transformed.status,
        headers,
      });
    } catch {
      const headers = new Headers(source.headers);
      headers.set("Cache-Control", getCacheControl(imageConfig, upstreamCacheControl));
      headers.set("Vary", "Accept");
      setImageSecurityHeaders(headers, params.imageUrl, sourceMediaType ?? null, imageConfig);
      return new Response(sourceBuffer.slice(0), { status: 200, headers });
    }
  }

  const headers = new Headers(source.headers);
  headers.set("Cache-Control", getCacheControl(imageConfig, upstreamCacheControl));
  headers.set("Vary", "Accept");
  setImageSecurityHeaders(headers, params.imageUrl, sourceMediaType ?? null, imageConfig);
  return new Response(sourceBuffer.slice(0), { status: 200, headers });
}
