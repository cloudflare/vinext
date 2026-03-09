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

function getCacheControl(imageConfig?: ImageConfig): string {
  const ttl = imageConfig?.minimumCacheTTL ?? imageConfigDefault.minimumCacheTTL;
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

function stripIpv6Brackets(hostname: string): string {
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    return hostname.slice(1, -1);
  }
  return hostname;
}

function parseIpv4(hostname: string): [number, number, number, number] | null {
  const match = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return null;
  const octets = match.slice(1).map((part) => parseInt(part, 10));
  if (octets.some((octet) => Number.isNaN(octet) || octet < 0 || octet > 255)) {
    return null;
  }
  return octets as [number, number, number, number];
}

function isBlockedIpv4(octets: [number, number, number, number]): boolean {
  const [a, b] = octets;
  return (
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

function parseIpv6(hostname: string): number[] | null {
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

function getIpv4MappedAddress(ipv6: number[]): string | null {
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

function isBlockedLocalHost(hostname: string): boolean {
  const lower = stripIpv6Brackets(hostname).toLowerCase();
  if (lower === "localhost" || lower.endsWith(".localhost") || lower.endsWith(".local")) {
    return true;
  }
  if (lower === "0.0.0.0") {
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
  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount++) {
    const parsed = new URL(currentUrl);
    if (!allowLocalIP && isBlockedLocalHost(parsed.hostname)) {
      return new Response('"url" parameter is not allowed', { status: 400 });
    }

    const response = await fetch(currentUrl, {
      headers: buildUpstreamRequestHeaders(request),
      redirect: "manual",
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

  const sourceContentType = source.headers.get("Content-Type");
  if (!isSafeImageContentType(sourceContentType, imageConfig?.dangerouslyAllowSVG)) {
    return new Response("The requested resource is not an allowed image type", { status: 400 });
  }

  const sourceMediaType = sourceContentType?.split(";")[0].trim().toLowerCase();
  if (sourceMediaType === "image/svg+xml") {
    const headers = new Headers(source.headers);
    headers.set("Cache-Control", getCacheControl(imageConfig));
    headers.set("Vary", "Accept");
    setImageSecurityHeaders(headers, params.imageUrl, sourceMediaType, imageConfig);
    return new Response(source.body, { status: 200, headers });
  }

  const outputFormat = negotiateImageFormat(request.headers.get("Accept"), imageConfig?.formats);
  if (handlers.transformImage) {
    const sourceBuffer = await source.arrayBuffer();
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
      headers.set("Cache-Control", getCacheControl(imageConfig));
      headers.set("Vary", "Accept");
      setImageSecurityHeaders(headers, params.imageUrl, outputFormat, imageConfig);
      return new Response(transformed.body, {
        status: transformed.status,
        headers,
      });
    } catch {
      const headers = new Headers(source.headers);
      headers.set("Cache-Control", getCacheControl(imageConfig));
      headers.set("Vary", "Accept");
      setImageSecurityHeaders(headers, params.imageUrl, sourceMediaType ?? null, imageConfig);
      return new Response(sourceBuffer.slice(0), { status: 200, headers });
    }
  }

  const headers = new Headers(source.headers);
  headers.set("Cache-Control", getCacheControl(imageConfig));
  headers.set("Vary", "Accept");
  setImageSecurityHeaders(headers, params.imageUrl, sourceMediaType ?? null, imageConfig);
  return new Response(source.body, { status: 200, headers });
}
