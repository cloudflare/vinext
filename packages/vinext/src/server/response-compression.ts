import { type IncomingMessage } from "node:http";
import { negotiateEncoding, type NegotiatedEncoding } from "./accept-encoding.js";

/**
 * Response compression rules for the Node production server, ported from the
 * `compression` middleware that `next start` installs for every response
 * unless `compress: false` (next/dist/compiled/compression, see
 * packages/next/src/server/lib/router-server.ts).
 */

// `compressible`'s content-type parsing: the media type before any parameters.
const EXTRACT_TYPE_REGEXP = /^\s*([^;\s]*)(?:;|\s|$)/;
const COMPRESSIBLE_TYPE_REGEXP = /^text\/|\+(?:json|text|xml)$/i;

/**
 * mime-db entries marked `compressible: true` that COMPRESSIBLE_TYPE_REGEXP
 * does not match, taken from the mime-db bundled with Next.js's compression
 * middleware. That mime-db marks no type `compressible: false` that the
 * regexp matches, so this set plus the regexp reproduces `compressible()`.
 */
const MIME_DB_COMPRESSIBLE_TYPES: ReadonlySet<string> = new Set([
  "application/dart",
  "application/ecmascript",
  "application/javascript",
  "application/json",
  "application/postscript",
  "application/raml+yaml",
  "application/rtf",
  "application/tar",
  "application/toml",
  "application/vnd.dart",
  "application/vnd.ms-fontobject",
  "application/vnd.ms-opentype",
  "application/wasm",
  "application/x-httpd-php",
  "application/x-javascript",
  "application/x-ns-proxy-autoconfig",
  "application/x-sh",
  "application/x-tar",
  "application/x-virtualbox-hdd",
  "application/x-virtualbox-ova",
  "application/x-virtualbox-ovf",
  "application/x-virtualbox-vbox",
  "application/x-virtualbox-vdi",
  "application/x-virtualbox-vhd",
  "application/x-virtualbox-vmdk",
  "application/x-www-form-urlencoded",
  "application/xml",
  "application/xml-dtd",
  "font/otf",
  "font/ttf",
  "image/bmp",
  "image/vnd.adobe.photoshop",
  "image/x-icon",
  "image/x-ms-bmp",
  "message/rfc822",
  "model/gltf-binary",
  "x-shader/x-fragment",
  "x-shader/x-vertex",
]);

/**
 * Whether a Content-Type is compressible, matching `compressible()`. This
 * covers `text/x-component` (RSC payloads) through the `text/` rule.
 */
export function isCompressibleContentType(contentType: string | null | undefined): boolean {
  if (!contentType) return false;
  const match = EXTRACT_TYPE_REGEXP.exec(contentType);
  const mime = match ? match[1].toLowerCase() : "";
  return MIME_DB_COMPRESSIBLE_TYPES.has(mime) || COMPRESSIBLE_TYPE_REGEXP.test(mime);
}

const NO_TRANSFORM_REGEXP = /(?:^|,)\s*?no-transform\s*?(?:,|$)/;

/** Whether a Cache-Control value forbids content codings (`no-transform`). */
export function hasNoTransform(cacheControl: string | null | undefined): boolean {
  return !!cacheControl && NO_TRANSFORM_REGEXP.test(cacheControl);
}

/** Responses whose known length is below this many bytes are sent uncompressed. */
export const COMPRESS_THRESHOLD = 1024;

export type ResponseCompressionHeaders = {
  contentType: string | null | undefined;
  cacheControl: string | null | undefined;
  contentEncoding: string | null | undefined;
  /**
   * Body length in bytes when it is known before the headers are written (a
   * Content-Length header, or a buffered or empty body). Undefined for
   * streamed bodies, which are compressed regardless of size.
   */
  contentLength: number | undefined;
};

export type ResponseCompression = {
  /** Whether the response must carry `Vary: Accept-Encoding`. */
  varyAcceptEncoding: boolean;
  /** The coding to apply. `identity` sends the body as is. */
  encoding: NegotiatedEncoding;
};

const NO_COMPRESSION: ResponseCompression = { varyAcceptEncoding: false, encoding: "identity" };

/**
 * Decide how to compress a response, in the middleware's order: the
 * Content-Type filter and `Cache-Control: no-transform` skip compression
 * without `Vary`; every other response gets `Vary: Accept-Encoding`, then is
 * sent uncompressed when it is under the size threshold, already encoded, or
 * a HEAD response, or when the client accepts no supported coding.
 *
 * Unlike the middleware, which offers only gzip and deflate, negotiation also
 * offers zstd and br (see negotiateEncoding).
 */
export function resolveResponseCompression(
  req: IncomingMessage,
  compress: boolean,
  headers: ResponseCompressionHeaders,
): ResponseCompression {
  if (!compress) return NO_COMPRESSION;
  if (!isCompressibleContentType(headers.contentType)) return NO_COMPRESSION;
  if (hasNoTransform(headers.cacheControl)) return NO_COMPRESSION;

  const identity: ResponseCompression = { varyAcceptEncoding: true, encoding: "identity" };
  if (headers.contentLength !== undefined && headers.contentLength < COMPRESS_THRESHOLD) {
    return identity;
  }
  if ((headers.contentEncoding || "identity") !== "identity") return identity;
  if (req.method === "HEAD") return identity;

  return { varyAcceptEncoding: true, encoding: negotiateEncoding(req) };
}

/** Parse a Content-Length header value the way the middleware compares it. */
export function parseContentLengthHeader(value: string | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined;
  const length = Number(value);
  return Number.isNaN(length) ? undefined : length;
}
