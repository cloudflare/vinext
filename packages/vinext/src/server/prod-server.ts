/**
 * Production server for vinext.
 *
 * Serves the built output from `vinext build`. Handles:
 * - Static asset serving from client build output
 * - Pages Router: SSR rendering + API route handling
 * - App Router: RSC/SSR rendering, route handlers, server actions
 * - Zstd/Brotli/Gzip compression for text-based responses
 * - Streaming SSR for App Router
 *
 * Build output for Pages Router:
 * - dist/client/  — static assets (JS, CSS, images) + .vite/ssr-manifest.json
 * - dist/server/entry.js — SSR entry point (virtual:vinext-server-entry)
 *
 * Build output for App Router:
 * - dist/client/  — static assets (JS, CSS, images)
 * - dist/server/index.js — RSC entry (default export: handler(Request) → Response)
 * - dist/server/ssr/index.js — SSR entry (imported by RSC entry at runtime)
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable, pipeline } from "node:stream";
import { pathToFileURL } from "node:url";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { StaticFileCache, CONTENT_TYPES, etagFromFilenameHash } from "./static-file-cache.js";
import {
  isImageOptimizationPath,
  IMAGE_CONTENT_SECURITY_POLICY,
  parseImageParams,
  isSafeImageContentType,
  DEFAULT_DEVICE_SIZES,
  DEFAULT_IMAGE_SIZES,
  type ImageConfig,
} from "./image-optimization.js";
import { normalizePath } from "./normalize-path.js";
import { filterInternalHeaders, isOpenRedirectShaped } from "./request-pipeline.js";
import { notFoundResponse } from "./http-error-responses.js";
import {
  runPagesRequest,
  wrapMiddlewareWithBasePath,
  type PagesPipelineDeps,
  type PagesRenderOptions,
} from "./pages-request-pipeline.js";
import { mergeHeaders } from "./worker-utils.js";
import {
  isNextDataPathname,
  parseNextDataPathname,
  buildNextDataNotFoundResponse,
} from "./pages-data-route.js";
import { hasBasePath, stripBasePath } from "../utils/base-path.js";
import {
  ASSET_PREFIX_URL_DIR,
  assetPrefixPathname,
  isAbsoluteAssetPrefix,
} from "../utils/asset-prefix.js";
import { computeClientRuntimeMetadata } from "../utils/client-runtime-metadata.js";
import { normalizePathnameForRouteMatchStrict } from "../routing/utils.js";
import { isUnknownRecord } from "../utils/record.js";
import type { ExecutionContextLike } from "vinext/shims/request-context";
import { collectInlineCssManifest } from "../build/inline-css.js";
import { readPrerenderSecret } from "../build/server-manifest.js";
import {
  VINEXT_PRERENDER_ROUTE_PARAMS_HEADER,
  VINEXT_PRERENDER_SECRET_HEADER,
  VINEXT_STATIC_FILE_HEADER,
} from "./headers.js";
import {
  readTrustedPrerenderRouteParamsFromHeaders,
  serializePrerenderRouteParamsHeader,
} from "./prerender-route-params.js";
import { seedMemoryCacheFromPrerender as seedMemoryCacheFromPrerenderFallback } from "./seed-cache.js";
import { installSocketErrorBackstop } from "./socket-error-backstop.js";
import {
  trustProxy,
  trustedHosts,
  resolveRequestProtocol,
  resolveRequestHost as resolveHost,
} from "./proxy-trust.js";
import {
  negotiateEncoding,
  parseAcceptedEncodings,
  selectContentEncoding,
} from "./accept-encoding.js";

/**
 * mtime of the build each bare (query-less) server-entry URL was first
 * imported from in this process. Node's ESM cache pins a bare URL to that
 * build forever, so rebuilds to the same path must be detected and loaded
 * through a cache-busted URL instead.
 */
const bareServerEntryMtimes = new Map<string, number>();

/**
 * Import a built server entry module (App Router RSC entry or Pages Router
 * server entry) by absolute file path.
 *
 * The first import of a given path uses the plain file:// URL with NO query
 * string. This is load-bearing: code-split builds emit lazy chunks that
 * import the entry back by bare specifier (default Vite builds on both
 * supported majors — Rollup on Vite 7 and Rolldown on Vite 8 — hoist modules
 * shared between the entry's static graph and lazy route chunks into the
 * entry chunk, which the chunks then import as e.g. "../../index.js").
 * Node keys its ESM cache on the full URL including the query string, so if
 * the server imported the entry as `index.js?t=<mtime>`, a chunk's bare
 * back-import would evaluate the entire server bundle a second time and
 * module-level singletons (db pools, service registries) would silently
 * diverge between the two copies. See
 * https://github.com/cloudflare/vinext/issues/1923.
 *
 * A `?t=<mtime>` query string is appended only when the same path is
 * imported again after a rebuild (different mtime) — e.g. test suites that
 * rebuild a fixture to the same output path within one process — where the
 * bare URL's cache entry would return the stale previous build. Note this
 * rebuild branch trades the single-instance guarantee back: chunks that
 * import the entry by bare path still resolve to the FIRST build's cache
 * entry, so freshness and single-instance only hold together on the first
 * import of a path. Production processes import each entry path exactly
 * once and always get both.
 *
 * The entry is imported via its canonical real path: the bundler
 * canonicalizes module ids with fs.realpathSync.native, so chunks evaluate
 * under realpath-based URLs and their relative imports resolve to realpath
 * URLs too. Importing the entry through a symlinked path (macOS /var/...
 * tmpdirs, symlinked deploy directories) would otherwise create a second
 * instance keyed on the symlinked URL.
 *
 * Exported for direct unit testing of the URL choice.
 */
export function resolveServerEntryImportUrl(entryPath: string): string {
  // The catch only covers realpathSync.native failing on filesystems that
  // don't support it; it does not make a missing entry path "work" — that
  // still throws at the statSync below, same as before this helper existed.
  let canonicalEntryPath: string;
  try {
    canonicalEntryPath = fs.realpathSync.native(entryPath);
  } catch {
    canonicalEntryPath = entryPath;
  }
  const href = pathToFileURL(canonicalEntryPath).href;
  const mtime = fs.statSync(canonicalEntryPath).mtimeMs;
  const bareMtime = bareServerEntryMtimes.get(href);
  if (bareMtime === undefined || bareMtime === mtime) {
    bareServerEntryMtimes.set(href, mtime);
    return href;
  }
  return `${href}?t=${mtime}`;
}

// oxlint-disable-next-line typescript/no-explicit-any -- built entry modules are untyped, matching the previous inline `await import(...)`
export async function importServerEntryModule(entryPath: string): Promise<any> {
  return import(resolveServerEntryImportUrl(entryPath));
}

/** Convert a Node.js IncomingMessage into a ReadableStream for Web Request body. */
export function readNodeStream(req: IncomingMessage): ReadableStream<Uint8Array> {
  let cancelled = false;
  let cleanup = () => {};

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      cleanup = () => {
        req.off("data", onData);
        req.off("end", onEnd);
        req.off("error", onError);
      };
      const onData = (chunk: Buffer) => {
        if (cancelled) return;
        controller.enqueue(new Uint8Array(chunk));
        if ((controller.desiredSize ?? 0) <= 0) req.pause();
      };
      const onEnd = () => {
        cleanup();
        if (!cancelled) controller.close();
      };
      const onError = (error: Error) => {
        cleanup();
        if (!cancelled) controller.error(error);
      };

      req.on("data", onData);
      req.on("end", onEnd);
      req.on("error", onError);
      req.pause();
    },
    pull() {
      if (!cancelled) req.resume();
    },
    cancel() {
      cancelled = true;
      cleanup();
      req.resume();
    },
  });
  return stream;
}

export type ProdServerOptions = {
  /** Port to listen on */
  port?: number;
  /** Host to bind to */
  host?: string;
  /** Path to the build output directory */
  outDir?: string;
  /** Disable compression (default: false) */
  noCompression?: boolean;
  /**
   * Narrow startup context for callers that need a more precise log line.
   * Omitted for normal `vinext start` so the existing production-server output
   * remains stable.
   */
  purpose?: "prerender";
};

/** Content types that benefit from compression. */
const COMPRESSIBLE_TYPES = new Set([
  "text/html",
  "text/css",
  "text/plain",
  "text/xml",
  "text/javascript",
  "application/javascript",
  "application/json",
  "application/xml",
  "application/xhtml+xml",
  "application/rss+xml",
  "application/atom+xml",
  "image/svg+xml",
  "application/manifest+json",
  "application/wasm",
]);

/** Minimum size threshold for compression (in bytes). Below this, compression overhead isn't worth it. */
const COMPRESS_THRESHOLD = 1024;

/**
 * Create a compression stream for the given encoding.
 */
function createCompressor(
  encoding: "zstd" | "br" | "gzip" | "deflate",
  mode: "default" | "streaming" = "default",
): zlib.ZstdCompress | zlib.BrotliCompress | zlib.Gzip | zlib.Deflate {
  switch (encoding) {
    case "zstd":
      return zlib.createZstdCompress({
        ...(mode === "streaming" ? { flush: zlib.constants.ZSTD_e_flush } : {}),
        params: { [zlib.constants.ZSTD_c_compressionLevel]: 3 }, // Fast for on-the-fly
      });
    case "br":
      return zlib.createBrotliCompress({
        ...(mode === "streaming" ? { flush: zlib.constants.BROTLI_OPERATION_FLUSH } : {}),
        params: {
          [zlib.constants.BROTLI_PARAM_QUALITY]: 4, // Fast compression (1-11, 4 is a good balance)
        },
      });
    case "gzip":
      return zlib.createGzip({
        level: 6,
        ...(mode === "streaming" ? { flush: zlib.constants.Z_SYNC_FLUSH } : {}),
      }); // Default level, good balance
    case "deflate":
      return zlib.createDeflate({
        level: 6,
        ...(mode === "streaming" ? { flush: zlib.constants.Z_SYNC_FLUSH } : {}),
      });
  }
}

/**
 * Merge middleware headers and a Web Response's headers into a single
 * record suitable for Node.js `res.writeHead()`. Uses `getSetCookie()`
 * to preserve multiple Set-Cookie values instead of flattening them.
 */
function mergeResponseHeaders(
  middlewareHeaders: Record<string, string | string[]>,
  response: Response,
): Record<string, string | string[]> {
  const merged: Record<string, string | string[]> = { ...middlewareHeaders };

  // Copy all non-Set-Cookie headers from the response (response wins on conflict)
  // Headers.forEach() always yields lowercase keys
  response.headers.forEach((v, k) => {
    if (k === "set-cookie") return;
    merged[k] = v;
  });

  // Preserve multiple Set-Cookie headers using getSetCookie()
  const responseCookies = response.headers.getSetCookie?.() ?? [];
  if (responseCookies.length > 0) {
    const existing = merged["set-cookie"];
    const mwCookies = existing ? (Array.isArray(existing) ? existing : [existing]) : [];
    merged["set-cookie"] = [...mwCookies, ...responseCookies];
  }

  return merged;
}

function toWebHeaders(headersRecord: Record<string, string | string[]>): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(headersRecord)) {
    appendWebHeader(headers, key, value);
  }
  return headers;
}

function appendWebHeader(
  headers: Headers,
  key: string,
  value: string | string[] | undefined,
): void {
  if (value === undefined) return;
  // HTTP/2 requests expose RFC 7540 §8.1.2.1 pseudo-headers (`:method`,
  // `:authority`, `:path`, `:scheme`) on `req.headers`. WHATWG `Headers`
  // rejects any name containing `:`, so they must be dropped before building
  // a `Headers` object. See: https://github.com/cloudflare/vinext/issues/2013
  if (key.startsWith(":")) return;
  if (Array.isArray(value)) {
    for (const item of value) headers.append(key, item);
    return;
  }
  headers.set(key, value);
}

function nodeHeadersToWebHeaders(headersRecord: IncomingMessage["headers"]): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(headersRecord)) {
    appendWebHeader(headers, key, value);
  }
  return headers;
}

// `resolveRequestProtocol` is now imported from `./proxy-trust.js` so the
// same trust policy applies in api-handler.ts (dev edge API bridge).

const NO_BODY_RESPONSE_STATUSES = new Set([204, 205, 304]);

// Constant header-name sets for `omitHeadersCaseInsensitive`. Hoisted to module
// scope so the `.map().toLowerCase()` + `Set` allocation happens once at module
// load instead of per response. All entries must be lowercase; the static-file
// header constant is already `x-vinext-static-file`.
const OMIT_BODY_HEADERS: ReadonlySet<string> = new Set(["content-length", "content-type"]);
const OMIT_STATIC_RESPONSE_HEADERS: ReadonlySet<string> = new Set([
  VINEXT_STATIC_FILE_HEADER,
  "content-encoding",
  "content-length",
  "content-type",
]);

function omitHeadersCaseInsensitive(
  headersRecord: Record<string, string | string[]>,
  targets: ReadonlySet<string>,
): Record<string, string | string[]> {
  const filtered: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(headersRecord)) {
    if (targets.has(key.toLowerCase())) continue;
    filtered[key] = value;
  }
  return filtered;
}

function mergeVaryHeader(
  headers: Record<string, string | string[]>,
  value: string,
): Record<string, string | string[]> {
  const merged = { ...headers };
  const existingKey = Object.keys(merged).find((key) => key.toLowerCase() === "vary");
  if (!existingKey) {
    merged.Vary = value;
    return merged;
  }

  const rawVary = merged[existingKey];
  const existingVary = Array.isArray(rawVary) ? rawVary.join(", ") : rawVary;
  if (existingVary.trim().length === 0) {
    merged[existingKey] = value;
    return merged;
  }
  const values = existingVary.split(",").map((entry) => entry.trim().toLowerCase());
  if (!values.includes("*") && !values.includes(value.toLowerCase())) {
    merged[existingKey] = `${existingVary}, ${value}`;
  }
  return merged;
}

function matchesIfNoneMatchHeader(ifNoneMatch: string | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false;
  if (ifNoneMatch === "*") return true;
  return ifNoneMatch
    .split(",")
    .map((value) => value.trim())
    .some((value) => value === etag);
}

function installClientBuildManifestGlobals(
  clientDir: string,
  assetBase: string,
  assetPrefix: string,
): void {
  const metadata = computeClientRuntimeMetadata({ clientDir, assetBase, assetPrefix });
  globalThis.__VINEXT_LAZY_CHUNKS__ = metadata.lazyChunks;
  globalThis.__VINEXT_DYNAMIC_PRELOADS__ = metadata.dynamicPreloads;
}
function isNoBodyResponseStatus(status: number): boolean {
  return NO_BODY_RESPONSE_STATUSES.has(status);
}

function cancelResponseBody(response: Response): void {
  const body = response.body;
  if (!body || body.locked) return;
  void body.cancel().catch(() => {
    /* ignore cancellation failures on discarded bodies */
  });
}

type ResponseWithVinextStreamingMetadata = Response & {
  __vinextStreamedHtmlResponse?: boolean;
};

function isVinextStreamedHtmlResponse(response: Response): boolean {
  return (response as ResponseWithVinextStreamingMetadata).__vinextStreamedHtmlResponse === true;
}

function logProdServerStarted(host: string, port: number, purpose: ProdServerOptions["purpose"]) {
  const url = `http://${host}:${port}`;
  if (purpose === "prerender") {
    console.log(`[vinext] Production server for prerendering running at ${url}`);
    return;
  }

  console.log(`[vinext] Production server running at ${url}`);
}

/**
 * Merge middleware/config headers and an optional status override into a new
 * Web Response while preserving the original body stream when allowed.
 *
 * This is the canonical {@link mergeHeaders} (server/worker-utils.ts) with the
 * arguments in (headers, response) order. The request path now calls
 * `runPagesRequest`, which uses `mergeHeaders` directly; this wrapper is retained
 * only for its existing tests and any external callers, so there is a single
 * implementation to keep in sync. (deploy.ts still emits its own generated copy.)
 */
function mergeWebResponse(
  middlewareHeaders: Record<string, string | string[]>,
  response: Response,
  statusOverride?: number,
): Response {
  return mergeHeaders(response, middlewareHeaders, statusOverride);
}

/**
 * Send a compressed response if the content type is compressible and the
 * client supports compression. Otherwise send uncompressed.
 */
function sendCompressed(
  req: IncomingMessage,
  res: ServerResponse,
  body: string | Buffer,
  contentType: string,
  statusCode: number,
  extraHeaders: Record<string, string | string[]> = {},
  compress: boolean = true,
  statusText?: string,
): void {
  const buf = typeof body === "string" ? Buffer.from(body) : body;
  const baseType = contentType.split(";")[0].trim();
  const varyByEncoding = compress && COMPRESSIBLE_TYPES.has(baseType);
  const encoding = compress ? negotiateEncoding(req) : "identity";
  const headersWithoutBodyHeaders = omitHeadersCaseInsensitive(extraHeaders, OMIT_BODY_HEADERS);

  const writeHead = (
    headers: Record<string, string | string[]>,
    responseStatus = statusCode,
    responseStatusText = statusText,
  ) => {
    if (responseStatusText) {
      res.writeHead(responseStatus, responseStatusText, headers);
    } else {
      res.writeHead(responseStatus, headers);
    }
  };

  if (encoding !== "identity" && varyByEncoding && buf.length >= COMPRESS_THRESHOLD) {
    const compressor = createCompressor(encoding);
    writeHead(
      mergeVaryHeader(
        {
          ...headersWithoutBodyHeaders,
          "Content-Type": contentType,
          "Content-Encoding": encoding,
        },
        "Accept-Encoding",
      ),
    );
    compressor.end(buf);
    pipeline(compressor, res, () => {
      /* ignore pipeline errors on closed connections */
    });
  } else {
    const identityHeaders = {
      ...headersWithoutBodyHeaders,
      "Content-Type": contentType,
      "Content-Length": String(buf.length),
    };
    writeHead(
      varyByEncoding ? mergeVaryHeader(identityHeaders, "Accept-Encoding") : identityHeaders,
    );
    res.end(buf);
  }
}

/**
 * Try to serve a static file from the client build directory.
 *
 * When a `StaticFileCache` is provided, lookups are pure in-memory Map.get()
 * with zero filesystem calls. Precompressed .br/.gz/.zst variants (generated at
 * build time) are served directly — no per-request compression needed for
 * hashed assets.
 *
 * Without a cache, falls back to async filesystem probing (still non-blocking,
 * unlike the old sync existsSync/statSync approach).
 */
async function tryServeStatic(
  req: IncomingMessage,
  res: ServerResponse,
  clientDir: string,
  pathname: string,
  compress: boolean,
  cache?: StaticFileCache,
  extraHeaders?: Record<string, string | string[]>,
  statusCode?: number,
): Promise<boolean> {
  if (pathname === "/") return false;
  const responseStatus = statusCode ?? 200;
  const omitBody = isNoBodyResponseStatus(responseStatus);

  // ── Fast path: pre-computed headers, minimal per-request work ──
  // When a cache is provided, all path validation happened at startup.
  // The only per-request work: Map.get(), string compare, pipe.
  if (cache) {
    // Decode only when needed (hashed /assets/ URLs never have %)
    let lookupPath: string;
    if (pathname.includes("%")) {
      try {
        lookupPath = decodeURIComponent(pathname);
      } catch {
        return false;
      }
      // Block encoded .vite/ access (e.g. /%2Evite/manifest.json)
      if (lookupPath.startsWith("/.vite/") || lookupPath === "/.vite") return false;
    } else {
      // Fast: skip decode entirely for clean URLs
      if (pathname.startsWith("/.vite/") || pathname === "/.vite") return false;
      lookupPath = pathname;
    }

    const entry = cache.lookup(lookupPath);
    if (!entry) return false;

    // Pick the best precompressed variant: zstd → br → gzip → original.
    // Each variant has pre-computed headers — zero string building.
    // Encoding tokens are case-insensitive per RFC 9110, and we honor q=0
    // refusals via parseAcceptedEncodings (e.g. `gzip, br;q=0` won't pick br).
    // NOTE: compress=false skips precompressed variants too, not just on-the-fly
    // compression. This is correct for current callers (image optimization passes
    // compress=false, and images are never precompressed). If a future caller
    // needs precompressed variants without on-the-fly compression, split the flag.
    // NOTE: HAS_ZSTD is intentionally not checked here — we're serving a
    // pre-existing .zst file from disk, not calling zstdCompress() at runtime.
    // The HAS_ZSTD guard only matters for the slow-path's on-the-fly compression.
    const rawAe = compress ? req.headers["accept-encoding"] : undefined;
    const parsed = typeof rawAe === "string" ? parseAcceptedEncodings(rawAe) : undefined;
    const availableVariants: Array<"zstd" | "br" | "gzip"> = [
      ...(entry.zst ? (["zstd"] as const) : []),
      ...(entry.br ? (["br"] as const) : []),
      ...(entry.gz ? (["gzip"] as const) : []),
    ];
    const variesByEncoding = compress && availableVariants.length > 0;
    const selected = parsed ? selectContentEncoding(parsed, availableVariants) : "identity";
    const variant =
      selected === "zstd"
        ? entry.zst!
        : selected === "br"
          ? entry.br!
          : selected === "gzip"
            ? entry.gz!
            : entry.original;

    const ifNoneMatch = req.headers["if-none-match"];
    if (
      responseStatus === 200 &&
      typeof ifNoneMatch === "string" &&
      matchesIfNoneMatchHeader(ifNoneMatch, entry.etag)
    ) {
      const notModifiedHeaders = variesByEncoding
        ? mergeVaryHeader({ ...entry.notModifiedHeaders, ...extraHeaders }, "Accept-Encoding")
        : { ...entry.notModifiedHeaders, ...extraHeaders };
      if (selected !== "identity") notModifiedHeaders["Content-Encoding"] = selected;
      res.writeHead(304, notModifiedHeaders);
      res.end();
      return true;
    }

    const responseHeaders = { ...variant.headers, ...extraHeaders };
    res.writeHead(
      responseStatus,
      variesByEncoding ? mergeVaryHeader(responseHeaders, "Accept-Encoding") : responseHeaders,
    );

    if (omitBody || req.method === "HEAD") {
      res.end();
      return true;
    }

    // Small files: serve from in-memory buffer (no fd open/close overhead).
    // Large files: stream from disk to avoid holding them in the heap.
    if (variant.buffer) {
      res.end(variant.buffer);
    } else {
      pipeline(fs.createReadStream(variant.path), res, (err) => {
        if (err) {
          // Headers already sent — can't write a 500. Destroy the connection
          // so the client sees a reset instead of a truncated response.
          console.warn(`[vinext] Static file stream error for ${variant.path}:`, err.message);
          res.destroy(err);
        }
      });
    }
    return true;
  }

  // ── Slow path: async filesystem probe (no cache) ───────────────
  const resolvedClient = path.resolve(clientDir);
  let decodedPathname: string;
  try {
    decodedPathname = decodeURIComponent(pathname);
  } catch {
    return false;
  }
  if (decodedPathname.startsWith("/.vite/") || decodedPathname === "/.vite") return false;
  const staticFile = path.resolve(clientDir, "." + decodedPathname);
  if (!staticFile.startsWith(resolvedClient + path.sep) && staticFile !== resolvedClient) {
    return false;
  }

  const resolved = await resolveStaticFile(staticFile);
  if (!resolved) return false;

  const ext = path.extname(resolved.path);
  const ct = CONTENT_TYPES[ext] ?? "application/octet-stream";
  // Mirror the StaticFileCache's `isHashed` rule: assets under Vite's
  // `assetsDir` carry a content hash. `pathname` always has a leading `/`,
  // so a single `includes` covers both the root-level `/<ASSET_PREFIX_URL_DIR>/...`
  // case and any `/<prefix>/<ASSET_PREFIX_URL_DIR>/...` assetPrefix layout.
  const isHashed = pathname.includes(`/${ASSET_PREFIX_URL_DIR}/`);
  const cacheControl = isHashed ? "public, max-age=31536000, immutable" : "public, max-age=3600";
  // Use a filename-hash ETag for hashed assets (matches the fast-path cache
  // behaviour and survives deploys). Use resolved.path (not pathname) so that
  // ext and the hash extraction both come from the same file — they can diverge
  // after HTML fallback (e.g. /_next/static/widget-abc123 → widget-abc123.html).
  // Fall back to mtime for non-hashed files.
  const etag =
    (isHashed && etagFromFilenameHash(resolved.path, ext)) ||
    `W/"${resolved.size}-${Math.floor(resolved.mtimeMs / 1000)}"`;
  const baseType = ct.split(";")[0].trim();
  const isCompressible = compress && COMPRESSIBLE_TYPES.has(baseType);

  const baseHeaders: Record<string, string | string[]> = {
    "Content-Type": ct,
    "Cache-Control": cacheControl,
    ETag: etag,
    ...extraHeaders,
  };

  if (isCompressible) {
    const encoding = negotiateEncoding(req);
    const ifNoneMatch = req.headers["if-none-match"];
    if (
      responseStatus === 200 &&
      typeof ifNoneMatch === "string" &&
      matchesIfNoneMatchHeader(ifNoneMatch, etag)
    ) {
      const notModifiedHeaders = mergeVaryHeader(baseHeaders, "Accept-Encoding");
      if (encoding !== "identity") notModifiedHeaders["Content-Encoding"] = encoding;
      res.writeHead(304, notModifiedHeaders);
      res.end();
      return true;
    }
    if (encoding !== "identity") {
      // Content-Length omitted intentionally: compressed size isn't known
      // ahead of time, so Node.js uses chunked transfer encoding.
      res.writeHead(
        responseStatus,
        mergeVaryHeader({ ...baseHeaders, "Content-Encoding": encoding }, "Accept-Encoding"),
      );
      if (omitBody || req.method === "HEAD") {
        res.end();
        return true;
      }
      const compressor = createCompressor(encoding);
      pipeline(fs.createReadStream(resolved.path), compressor, res, (err) => {
        if (err) {
          // Headers already sent — can't write a 500. Destroy the connection
          // so the client sees a reset instead of a truncated response.
          console.warn(`[vinext] Static file stream error for ${resolved.path}:`, err.message);
          res.destroy(err);
        }
      });
      return true;
    }
  }

  const ifNoneMatch = req.headers["if-none-match"];
  if (
    responseStatus === 200 &&
    typeof ifNoneMatch === "string" &&
    matchesIfNoneMatchHeader(ifNoneMatch, etag)
  ) {
    res.writeHead(
      304,
      isCompressible ? mergeVaryHeader(baseHeaders, "Accept-Encoding") : baseHeaders,
    );
    res.end();
    return true;
  }

  const identityHeaders = {
    ...baseHeaders,
    "Content-Length": String(resolved.size),
  };
  res.writeHead(
    responseStatus,
    isCompressible ? mergeVaryHeader(identityHeaders, "Accept-Encoding") : identityHeaders,
  );
  if (omitBody || req.method === "HEAD") {
    res.end();
    return true;
  }
  pipeline(fs.createReadStream(resolved.path), res, (err) => {
    if (err) {
      // Headers already sent — can't write a 500. Destroy the connection
      // so the client sees a reset instead of a truncated response.
      console.warn(`[vinext] Static file stream error for ${resolved.path}:`, err.message);
      res.destroy(err);
    }
  });
  return true;
}

type ResolvedFile = {
  path: string;
  size: number;
  mtimeMs: number;
};

/**
 * Resolve the actual file to serve, trying extension-less HTML fallbacks.
 * Returns the resolved path + size + mtime, or null if not found.
 */
async function resolveStaticFile(staticFile: string): Promise<ResolvedFile | null> {
  const stat = await statIfFile(staticFile);
  if (stat) return { path: staticFile, size: stat.size, mtimeMs: stat.mtimeMs };

  const htmlFallback = staticFile + ".html";
  const htmlStat = await statIfFile(htmlFallback);
  if (htmlStat) return { path: htmlFallback, size: htmlStat.size, mtimeMs: htmlStat.mtimeMs };

  const indexFallback = path.join(staticFile, "index.html");
  const indexStat = await statIfFile(indexFallback);
  if (indexStat) return { path: indexFallback, size: indexStat.size, mtimeMs: indexStat.mtimeMs };

  return null;
}

async function statIfFile(filePath: string): Promise<{ size: number; mtimeMs: number } | null> {
  try {
    const stat = await fsp.stat(filePath);
    return stat.isFile() ? { size: stat.size, mtimeMs: stat.mtimeMs } : null;
  } catch {
    return null;
  }
}

// `resolveHost`, `trustedHosts`, and `trustProxy` are now imported from
// `./proxy-trust.js` so the same trust policy applies in api-handler.ts
// (the dev edge API bridge) and any future server code path that needs
// to gate `X-Forwarded-*` headers.

/**
 * Convert a Node.js IncomingMessage to a Web Request object.
 *
 * When `urlOverride` is provided, it is used as the path + query string
 * instead of `req.url`. This avoids redundant path normalization when the
 * caller has already decoded and normalized the pathname (e.g. the App
 * Router prod server normalizes before static-asset lookup, and can pass
 * the result here so the downstream RSC handler doesn't re-normalize).
 */
function nodeToWebRequest(
  req: IncomingMessage,
  urlOverride?: string,
  prerenderSecret?: string,
): Request {
  const proto = resolveRequestProtocol(req);
  const host = resolveHost(req, "localhost");
  const origin = `${proto}://${host}`;
  const url = new URL(urlOverride ?? req.url ?? "/", origin);

  const rawHeaders = nodeHeadersToWebHeaders(req.headers);
  const prerenderRouteParamsPayload = readTrustedPrerenderRouteParamsFromHeaders(
    rawHeaders,
    prerenderSecret,
  );
  // Strip internal headers that should not be honored from external requests.
  const headers = filterInternalHeaders(rawHeaders);
  const prerenderRouteParamsHeader = serializePrerenderRouteParamsHeader(
    prerenderRouteParamsPayload,
  );
  if (prerenderRouteParamsHeader !== null) {
    headers.set(VINEXT_PRERENDER_ROUTE_PARAMS_HEADER, prerenderRouteParamsHeader);
  }

  const method = req.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD";

  const init: RequestInit & { duplex?: string } = {
    method,
    headers,
  };

  if (hasBody) {
    init.body = readNodeStream(req);
    init.duplex = "half"; // Required for streaming request bodies
  }

  const request = new Request(url, init);
  return request;
}

/**
 * Stream a Web Response back to a Node.js ServerResponse.
 * Supports streaming compression for SSR responses.
 */
async function sendWebResponse(
  webResponse: Response,
  req: IncomingMessage,
  res: ServerResponse,
  compress: boolean,
): Promise<void> {
  const status = webResponse.status;
  const statusText = webResponse.statusText || undefined;
  const writeHead = (headers: Record<string, string | string[]>) => {
    if (statusText) {
      res.writeHead(status, statusText, headers);
    } else {
      res.writeHead(status, headers);
    }
  };

  // Collect headers, handling multi-value headers (e.g. Set-Cookie)
  const nodeHeaders: Record<string, string | string[]> = {};
  webResponse.headers.forEach((value, key) => {
    const existing = nodeHeaders[key];
    if (existing !== undefined) {
      nodeHeaders[key] = Array.isArray(existing) ? [...existing, value] : [existing, value];
    } else {
      nodeHeaders[key] = value;
    }
  });

  // Check if we should compress the response.
  // Skip if the upstream already compressed (avoid double-compression).
  const contentEncoding = webResponse.headers.get("content-encoding");
  const alreadyEncoded = contentEncoding !== null;
  if (!webResponse.body) {
    writeHead(nodeHeaders);
    res.end();
    return;
  }

  const contentType = webResponse.headers.get("content-type") ?? "";
  const baseType = contentType.split(";")[0].trim();
  const varyByEncoding = compress && !alreadyEncoded && COMPRESSIBLE_TYPES.has(baseType);
  const encoding = compress && !alreadyEncoded ? negotiateEncoding(req) : "identity";
  const shouldCompress = encoding !== "identity" && COMPRESSIBLE_TYPES.has(baseType);

  if (shouldCompress) {
    delete nodeHeaders["content-length"];
    delete nodeHeaders["Content-Length"];
    nodeHeaders["Content-Encoding"] = encoding!;
  }

  writeHead(varyByEncoding ? mergeVaryHeader(nodeHeaders, "Accept-Encoding") : nodeHeaders);

  // HEAD requests: send headers only, skip the body
  if (req.method === "HEAD") {
    cancelResponseBody(webResponse);
    res.end();
    return;
  }

  // Convert Web ReadableStream to Node.js Readable and pipe to response.
  // Readable.fromWeb() is available since Node.js 17.
  const nodeStream = Readable.fromWeb(webResponse.body as import("stream/web").ReadableStream);

  if (shouldCompress) {
    // Use streaming flush modes so progressive HTML remains decodable before the
    // full response completes.
    const compressor = createCompressor(encoding!, "streaming");
    pipeline(nodeStream, compressor, res, () => {
      /* ignore pipeline errors on closed connections */
    });
  } else {
    pipeline(nodeStream, res, () => {
      /* ignore pipeline errors on closed connections */
    });
  }
}

/**
 * Start the production server.
 *
 * Automatically detects whether the build is App Router (dist/server/index.js) or
 * Pages Router (dist/server/entry.js) and configures the appropriate handler.
 */
export async function startProdServer(options: ProdServerOptions = {}) {
  // Process-level peer-disconnect backstop. Idempotent via the
  // Symbol.for guard inside installSocketErrorBackstop, so this call
  // is a no-op when index.ts has already installed it. Kept here so
  // entry points that load prod-server without going through index.ts
  // (none today, but preserves Next.js's "install everywhere a Node
  // HTTP server runs" parity) still get the backstop. Prerender
  // bypass is fire-time via VINEXT_PRERENDER, not install-time.
  installSocketErrorBackstop();

  const {
    port = process.env.PORT ? parseInt(process.env.PORT) : 3000,
    host = "0.0.0.0",
    outDir = path.resolve("dist"),
    noCompression = false,
    purpose,
  } = options;

  const compress = !noCompression;
  // Always resolve outDir to absolute to ensure dynamic import() works
  const resolvedOutDir = path.resolve(outDir);
  const clientDir = path.join(resolvedOutDir, "client");

  // Detect build type
  const rscEntryPath = path.join(resolvedOutDir, "server", "index.js");
  const serverEntryPath = path.join(resolvedOutDir, "server", "entry.js");
  const isAppRouter = fs.existsSync(rscEntryPath);

  if (!isAppRouter && !fs.existsSync(serverEntryPath)) {
    console.error(`[vinext] No build output found in ${outDir}`);
    console.error("Run `vinext build` first.");
    process.exit(1);
  }

  if (isAppRouter) {
    return startAppRouterServer({ port, host, clientDir, rscEntryPath, compress, purpose });
  }

  return startPagesRouterServer({ port, host, clientDir, serverEntryPath, compress, purpose });
}

// ─── App Router Production Server ─────────────────────────────────────────────

type AppRouterServerOptions = {
  port: number;
  host: string;
  clientDir: string;
  rscEntryPath: string;
  compress: boolean;
  purpose?: ProdServerOptions["purpose"];
};

type WorkerAppRouterEntry = {
  fetch(request: Request, env?: unknown, ctx?: ExecutionContextLike): Promise<Response> | Response;
};

function createNodeExecutionContext(): ExecutionContextLike {
  return {
    waitUntil(promise: Promise<unknown>) {
      // Node doesn't provide a Workers lifecycle, but we still attach a
      // rejection handler so background waitUntil work doesn't surface as an
      // unhandled rejection when a Worker-style entry is used with vinext start.
      void Promise.resolve(promise).catch(() => {});
    },
    passThroughOnException() {},
  };
}

function resolveAppRouterHandler(entry: unknown): (request: Request) => Promise<Response> {
  if (typeof entry === "function") {
    return (request) => Promise.resolve(entry(request));
  }

  if (entry && typeof entry === "object" && "fetch" in entry) {
    const workerEntry = entry as WorkerAppRouterEntry;
    if (typeof workerEntry.fetch === "function") {
      return (request) =>
        Promise.resolve(workerEntry.fetch(request, undefined, createNodeExecutionContext()));
    }
  }

  console.error(
    "[vinext] App Router entry must export either a default handler function or a Worker-style default export with fetch()",
  );
  process.exit(1);
}

type AppRouterPrerenderSeeder = (serverDir: string) => Promise<number>;
type AppRouterPrerenderSeederExport = (serverDir: string) => unknown;

function isAppRouterPrerenderSeederExport(value: unknown): value is AppRouterPrerenderSeederExport {
  return typeof value === "function";
}

export function resolveAppRouterPrerenderSeeder(entryModule: unknown): AppRouterPrerenderSeeder {
  if (typeof entryModule !== "object" || entryModule === null) {
    return seedMemoryCacheFromPrerenderFallback;
  }

  const seedExport: unknown = Object.getOwnPropertyDescriptor(
    entryModule,
    "seedMemoryCacheFromPrerender",
  )?.value;
  if (!isAppRouterPrerenderSeederExport(seedExport)) {
    if (process.env.NEXT_PRIVATE_DEBUG_CACHE) {
      console.debug("[vinext] ISR: using fallback prerender cache seeder");
    }
    return seedMemoryCacheFromPrerenderFallback;
  }

  if (process.env.NEXT_PRIVATE_DEBUG_CACHE) {
    console.debug("[vinext] ISR: using App Router entry prerender cache seeder");
  }

  return async (serverDir) => {
    const result = await Promise.resolve(seedExport(serverDir));
    return typeof result === "number" ? result : 0;
  };
}

/**
 * Resolve a request pathname to a static-asset lookup path inside `clientDir`.
 *
 * Returns `null` when the request is not for a built asset, in which case
 * the caller should let the request fall through to the RSC handler.
 *
 * Three URL shapes are recognised:
 *
 *  - `/_next/static/...` — the default layout. Files land on disk at
 *    `dist/client/_next/static/...`, so the pathname maps 1:1. Also covers
 *    absolute-URL `assetPrefix` with no path component (same on-disk and
 *    URL shape).
 *  - `<assetPathPrefix>/_next/static/...` — when `assetPrefix` is a path
 *    prefix (e.g. `/custom-asset-prefix`). The on-disk layout is
 *    `dist/client/<prefix>/_next/static/...`, so the pathname maps 1:1.
 *  - `<absoluteURLPathname>/_next/static/...` — when `assetPrefix` is an
 *    absolute URL with a non-empty pathname (e.g. `https://cdn/sub`).
 *    Files are written to `dist/client/_next/static/...` but emitted URLs
 *    prepend the full URL. Requests do not normally arrive here — they go
 *    to the CDN — but we accept them so a same-origin reverse proxy can
 *    route through; the on-disk path is just `_next/static/...`.
 */
export function resolveAppRouterAssetPath(
  pathname: string,
  assetPathPrefix: string,
  assetPrefix: string,
): string | null {
  const nextStaticDir = `/${ASSET_PREFIX_URL_DIR}/`;

  if (assetPathPrefix) {
    // Path prefix (or absolute URL with a path component). Strip the prefix
    // and verify the rest lives under `_next/static/`.
    if (pathname === assetPathPrefix || pathname.startsWith(assetPathPrefix + "/")) {
      const rest = pathname.slice(assetPathPrefix.length) || "/";
      if (rest.startsWith(nextStaticDir)) {
        // For path-prefix assetPrefix: on-disk path mirrors the URL, so the
        // request path is already the lookup path.
        if (!isAbsoluteAssetPrefix(assetPrefix)) {
          return pathname;
        }
        // For absolute-URL assetPrefix with a path component: on-disk path
        // is just `_next/static/...` (no extra prefix dir on disk).
        return rest;
      }
    }
    return null;
  }

  // No `assetPrefix` (default layout), or absolute-URL `assetPrefix` with no
  // path component — both land files on disk at `dist/client/_next/static/...`
  // and emit URLs starting `/_next/static/...`.
  if (pathname.startsWith(nextStaticDir)) return pathname;

  return null;
}

type PagesClientEntryLookup = "any-client-entry" | "pages-client-entry";

function isSsrManifest(value: unknown): value is Record<string, string[]> {
  if (!isUnknownRecord(value)) return false;
  return Object.values(value).every(
    (files) =>
      Array.isArray(files) && files.every((file): file is string => typeof file === "string"),
  );
}

function readSsrManifest(clientDir: string): Record<string, string[]> {
  const manifestPath = path.join(clientDir, ".vite", "ssr-manifest.json");
  if (!fs.existsSync(manifestPath)) return {};

  // A malformed manifest degrades to "no SSR manifest" (modulepreload hints are
  // skipped) rather than aborting server startup — matching the previous
  // tolerant behavior. The build is the source of truth; a corrupt file here is
  // a build problem, not a reason to take the whole server down.
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  } catch (error) {
    console.warn(`[vinext] Ignoring unparseable SSR manifest at ${manifestPath}:`, error);
    return {};
  }

  if (!isSsrManifest(parsed)) {
    console.warn(`[vinext] Ignoring SSR manifest with unexpected shape at ${manifestPath}`);
    return {};
  }
  return parsed;
}

function installPagesClientAssetGlobals(options: {
  clientDir: string;
  assetPrefix: string;
  assetBase: string;
  clientEntryLookup: PagesClientEntryLookup;
}): Record<string, string[]> {
  const ssrManifest = readSsrManifest(options.clientDir);
  globalThis.__VINEXT_SSR_MANIFEST__ =
    Object.keys(ssrManifest).length > 0 ? ssrManifest : undefined;

  const metadata = computeClientRuntimeMetadata({
    clientDir: options.clientDir,
    assetBase: options.assetBase,
    assetPrefix: options.assetPrefix,
    includeClientEntry:
      options.clientEntryLookup === "pages-client-entry" ? "pages-client-entry" : true,
  });

  globalThis.__VINEXT_CLIENT_ENTRY__ = metadata.clientEntryFile;
  globalThis.__VINEXT_LAZY_CHUNKS__ = metadata.lazyChunks;
  globalThis.__VINEXT_DYNAMIC_PRELOADS__ = metadata.dynamicPreloads;

  return ssrManifest;
}

/**
 * Start the App Router production server.
 *
 * The App Router entry (dist/server/index.js) can export either:
 *   - a default handler function: handler(request: Request) → Promise<Response>
 *   - a Worker-style object: { fetch(request, env, ctx) → Promise<Response> }
 *
 * This handler already does everything: route matching, RSC rendering,
 * SSR HTML generation (via import("./ssr/index.js")), route handlers,
 * server actions, ISR caching, 404s, redirects, etc.
 *
 * The production server's job is simply to:
 * 1. Serve static assets from dist/client/
 * 2. Convert Node.js IncomingMessage → Web Request
 * 3. Call the RSC handler
 * 4. Stream the Web Response back (with optional compression)
 */
async function startAppRouterServer(options: AppRouterServerOptions) {
  const { port, host, clientDir, rscEntryPath, compress, purpose } = options;

  // Load image config written at build time by vinext:image-config plugin.
  // This provides SVG/security header settings for the image optimization endpoint.
  let imageConfig: ImageConfig | undefined;
  const imageConfigPath = path.join(path.dirname(rscEntryPath), "image-config.json");
  if (fs.existsSync(imageConfigPath)) {
    try {
      imageConfig = JSON.parse(fs.readFileSync(imageConfigPath, "utf-8"));
    } catch {
      /* ignore parse errors */
    }
  }

  // Load prerender secret written at build time by vinext:server-manifest plugin.
  // Used to authenticate internal /__vinext/prerender/* HTTP endpoints.
  const prerenderSecret = readPrerenderSecret(path.dirname(rscEntryPath));

  // Import the RSC handler. importServerEntryModule uses the bare file://
  // URL so lazy chunks that import the entry back resolve to the same module
  // instance, and only cache-busts when this function runs again after a
  // rebuild to the same path (e.g. across test describe blocks).
  const rscModule = await importServerEntryModule(rscEntryPath);
  const rscHandler = resolveAppRouterHandler(rscModule.default);

  // `assetPrefix` is embedded as a compile-time constant in the generated
  // RSC entry (see `entries/app-rsc-entry.ts`'s `export const __assetPrefix`),
  // mirroring how `__basePath` is inlined there and how the Pages Router
  // entry exposes `vinextConfig.assetPrefix`. Default to "" so older builds
  // (and the rare case where the entry doesn't re-export this constant)
  // continue to work with the historical asset layout.
  const appRouterAssetPrefix: string =
    typeof rscModule.__assetPrefix === "string" ? rscModule.__assetPrefix : "";
  const appRouterBasePath: string =
    typeof rscModule.__basePath === "string" ? rscModule.__basePath : "";
  const appRouterInlineCss = rscModule.__inlineCss === true;
  const appRouterHasPagesDir = rscModule.__hasPagesDir === true;
  globalThis.__VINEXT_INLINE_CSS__ = appRouterInlineCss
    ? collectInlineCssManifest(clientDir, appRouterAssetPrefix)
    : undefined;
  // Path portion of the assetPrefix to match incoming asset requests against
  // (empty when the prefix is an absolute URL with no path component, or when
  // no prefix is configured). The URL prefix the prod-server needs to strip
  // before locating files on disk includes this path plus `_next/static/`.
  const appAssetPathPrefix = assetPrefixPathname(appRouterAssetPrefix);
  const appAssetBase = appRouterBasePath ? `${appRouterBasePath}/` : "/";
  if (appRouterHasPagesDir) {
    installPagesClientAssetGlobals({
      clientDir,
      assetPrefix: appRouterAssetPrefix,
      assetBase: appAssetBase,
      clientEntryLookup: "pages-client-entry",
    });
  } else {
    installClientBuildManifestGlobals(clientDir, appAssetBase, appRouterAssetPrefix);
  }

  // Seed the memory cache with pre-rendered routes so the first request to
  // any pre-rendered page is a cache HIT instead of a full re-render.
  const seedPrerenderedRoutes = resolveAppRouterPrerenderSeeder(rscModule);
  const seededRoutes = await seedPrerenderedRoutes(path.dirname(rscEntryPath));
  if (seededRoutes > 0) {
    console.log(
      `[vinext] Seeded ${seededRoutes} pre-rendered route${seededRoutes !== 1 ? "s" : ""} into memory cache`,
    );
  }

  // Build the static file metadata cache at startup. Eliminates per-request
  // stat() calls — all lookups are pure in-memory Map.get(). Precompressed
  // .br/.gz/.zst variants (generated at build time) are detected automatically.
  const staticCache = await StaticFileCache.create(clientDir);

  const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const rawUrl = req.url ?? "/";
    const rawPathname = rawUrl.split("?")[0];

    // Guard against protocol-relative URL open redirect attacks.
    // Run BEFORE decoding so both literal (`//`, `/\`) and encoded (`%5C`, `%2F`)
    // variants are rejected — the encoded forms survive segment-wise decoding
    // below and would otherwise reach the trailing-slash redirect emitter.
    if (isOpenRedirectShaped(rawPathname)) {
      res.writeHead(404);
      res.end("This page could not be found");
      return;
    }

    // Normalize backslashes (browsers treat /\ as //), then decode and normalize path.
    const normalizedRawPathname = rawPathname.replaceAll("\\", "/");
    let pathname: string;
    try {
      pathname = normalizePath(normalizePathnameForRouteMatchStrict(normalizedRawPathname));
    } catch {
      // Malformed percent-encoding (e.g. /%E0%A4%A) — return 400 instead of crashing.
      res.writeHead(400);
      res.end("Bad Request");
      return;
    }

    // Internal prerender endpoint — only reachable with the correct build-time secret.
    // Used by the prerender phase to fetch generateStaticParams results via HTTP.
    // We authenticate the request here and then forward to the RSC handler so that
    // the handler's in-process generateStaticParamsMap (not a named module export)
    // is used. This is required for Cloudflare Workers builds where the named export
    // is not preserved in the bundle output format.
    if (
      pathname === "/__vinext/prerender/static-params" ||
      pathname === "/__vinext/prerender/pages-static-paths"
    ) {
      const secret = req.headers[VINEXT_PRERENDER_SECRET_HEADER];
      if (!prerenderSecret || secret !== prerenderSecret) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
      }
      // Forward to RSC handler — the endpoint is implemented there and has
      // access to the in-process map. VINEXT_PRERENDER=1 must be set (it is,
      // since this server is only started during the prerender phase).
      // Fall through to the RSC handler below.
    }

    // Serve hashed build assets (Vite output in /_next/static/) directly.
    // Public directory files fall through to the RSC handler, which runs
    // middleware before serving them.
    //
    // The on-disk layout under `dist/client` mirrors the URL path:
    //   - default                 → `_next/static/...`
    //   - path-prefix assetPrefix → `<prefix>/_next/static/...`
    //   - absolute-URL prefix     → `_next/static/...`
    // Cloudflare's ASSETS binding serves these directly in Workers; this
    // branch is the Node fallback.
    //
    // Asset-shaped requests that don't find a file return a plain-text 404
    // instead of falling through to the RSC handler (which would render
    // the full HTML 404 page). Matches Next.js's behaviour in
    // packages/next/src/server/lib/router-server.ts.
    {
      const assetLookupPath = resolveAppRouterAssetPath(
        pathname,
        appAssetPathPrefix,
        appRouterAssetPrefix,
      );
      if (assetLookupPath) {
        if (await tryServeStatic(req, res, clientDir, assetLookupPath, compress, staticCache)) {
          return;
        }
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not Found");
        return;
      }
    }

    // Image optimization passthrough (Node.js prod server has no Images binding;
    // serves the original file with cache headers and security headers)
    if (isImageOptimizationPath(pathname)) {
      const parsedUrl = new URL(rawUrl, "http://localhost");
      const allowedWidths = [
        ...(imageConfig?.deviceSizes ?? DEFAULT_DEVICE_SIZES),
        ...(imageConfig?.imageSizes ?? DEFAULT_IMAGE_SIZES),
      ];
      const params = parseImageParams(parsedUrl, allowedWidths, imageConfig?.qualities);
      if (!params) {
        res.writeHead(400);
        res.end("Bad Request");
        return;
      }
      // Block SVG and other unsafe content types by checking the file extension.
      // SVG is only allowed when dangerouslyAllowSVG is enabled in next.config.js.
      const ext = path.extname(params.imageUrl).toLowerCase();
      const ct = CONTENT_TYPES[ext] ?? "application/octet-stream";
      if (!isSafeImageContentType(ct, imageConfig?.dangerouslyAllowSVG)) {
        res.writeHead(400);
        res.end("The requested resource is not an allowed image type");
        return;
      }
      // Serve the original image with CSP and security headers
      const imageSecurityHeaders: Record<string, string> = {
        "Content-Security-Policy":
          imageConfig?.contentSecurityPolicy ?? IMAGE_CONTENT_SECURITY_POLICY,
        "X-Content-Type-Options": "nosniff",
        "Content-Disposition":
          imageConfig?.contentDispositionType === "attachment" ? "attachment" : "inline",
      };
      if (
        await tryServeStatic(
          req,
          res,
          clientDir,
          params.imageUrl,
          false,
          staticCache,
          imageSecurityHeaders,
        )
      ) {
        return;
      }
      res.writeHead(404);
      res.end("Image not found");
      return;
    }

    try {
      // Build the normalized URL (pathname + original query string) so the
      // RSC handler receives an already-canonical path and doesn't need to
      // re-normalize. This deduplicates the normalizePath work done above.
      const qs = rawUrl.includes("?") ? rawUrl.slice(rawUrl.indexOf("?")) : "";
      const normalizedUrl = pathname + qs;

      // Convert Node.js request to Web Request and call the RSC handler
      const request = nodeToWebRequest(req, normalizedUrl, prerenderSecret);
      const response = await rscHandler(request);

      const staticFileSignal = response.headers.get(VINEXT_STATIC_FILE_HEADER);
      if (staticFileSignal) {
        let staticFilePath = "/";
        try {
          staticFilePath = decodeURIComponent(staticFileSignal);
        } catch {
          staticFilePath = staticFileSignal;
        }

        const staticResponseHeaders = omitHeadersCaseInsensitive(
          mergeResponseHeaders({}, response),
          OMIT_STATIC_RESPONSE_HEADERS,
        );

        const served = await tryServeStatic(
          req,
          res,
          clientDir,
          staticFilePath,
          compress,
          staticCache,
          staticResponseHeaders,
          response.status,
        );
        cancelResponseBody(response);
        if (served) {
          return;
        }
        await sendWebResponse(
          notFoundResponse({ headers: toWebHeaders(staticResponseHeaders) }),
          req,
          res,
          compress,
        );
        return;
      }

      // Stream the Web Response back to the Node.js response
      await sendWebResponse(response, req, res, compress);
    } catch (e) {
      console.error("[vinext] Server error:", e);
      if (!res.headersSent) {
        res.writeHead(500);
        res.end("Internal Server Error");
      }
    }
  };

  const server = createServer((req, res) => {
    void handleRequest(req, res);
  });

  await new Promise<void>((resolve) => {
    server.listen(port, host, () => {
      const addr = server.address();
      const actualPort = typeof addr === "object" && addr ? addr.port : port;
      logProdServerStarted(host, actualPort, purpose);
      resolve();
    });
  });

  const addr = server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : port;
  return { server, port: actualPort };
}

// ─── Pages Router Production Server ───────────────────────────────────────────

type PagesRouterServerOptions = {
  port: number;
  host: string;
  clientDir: string;
  serverEntryPath: string;
  compress: boolean;
  purpose?: ProdServerOptions["purpose"];
};

type PagesServerEntryPageRoute = {
  pattern: string;
  module?: {
    getStaticPaths?: (opts: { locales: string[]; defaultLocale: string }) => Promise<unknown>;
  };
};

function isPagesServerEntryPageRoute(value: unknown): value is PagesServerEntryPageRoute {
  if (!value || typeof value !== "object" || !("pattern" in value)) return false;
  if (typeof value.pattern !== "string") return false;

  if (!("module" in value) || value.module === undefined) return true;
  const pageModule = value.module;
  if (!pageModule || typeof pageModule !== "object") return false;

  return !("getStaticPaths" in pageModule) || typeof pageModule.getStaticPaths === "function";
}

function readPagesServerEntryPageRoutes(value: unknown): PagesServerEntryPageRoute[] | undefined {
  return Array.isArray(value) && value.every(isPagesServerEntryPageRoute) ? value : undefined;
}

/**
 * Start the Pages Router production server.
 *
 * Uses the server entry (dist/server/entry.js) which exports:
 * - renderPage(request, url, manifest, ctx?, middlewareHeaders?) — SSR rendering (Web Request → Response)
 * - handleApiRoute(request, url, ctx?) — API route handling (ctx optional; pass for ctx.waitUntil() on Workers)
 * - runMiddleware(request, ctx?) — middleware execution (ctx optional; pass for ctx.waitUntil() on Workers)
 * - vinextConfig — embedded next.config.js settings
 */
async function startPagesRouterServer(options: PagesRouterServerOptions) {
  const { port, host, clientDir, serverEntryPath, compress, purpose } = options;

  // Import the server entry module. importServerEntryModule uses the bare
  // file:// URL so lazy chunks that import the entry back resolve to the same
  // module instance, and only cache-busts when this function runs again after
  // a rebuild to the same output path.
  const serverEntry = await importServerEntryModule(serverEntryPath);
  const {
    renderPage,
    handleApiRoute: handleApi,
    runMiddleware,
    vinextConfig,
    buildId: pagesBuildId,
  } = serverEntry;
  const matchPageRoute =
    typeof serverEntry.matchPageRoute === "function" ? serverEntry.matchPageRoute : undefined;
  const pageRoutes = readPagesServerEntryPageRoutes(serverEntry.pageRoutes);

  // Load prerender secret written at build time by vinext:server-manifest plugin.
  // Used to authenticate internal /__vinext/prerender/* HTTP endpoints.
  const prerenderSecret = readPrerenderSecret(path.dirname(serverEntryPath));

  // Extract config values (embedded at build time in the server entry)
  const basePath: string = vinextConfig?.basePath ?? "";
  const assetPrefix: string = vinextConfig?.assetPrefix ?? "";
  // Path component of `assetPrefix` against which incoming requests are
  // matched (empty when absent or when the prefix is an absolute URL with
  // no path component).
  const pagesAssetPathPrefix = assetPrefixPathname(assetPrefix);
  const assetBase = basePath ? `${basePath}/` : "/";
  const trailingSlash: boolean = vinextConfig?.trailingSlash ?? false;
  const i18nConfig = vinextConfig?.i18n ?? null;
  const configRedirects = vinextConfig?.redirects ?? [];
  const configRewrites = vinextConfig?.rewrites ?? {
    beforeFiles: [],
    afterFiles: [],
    fallback: [],
  };
  const configHeaders = vinextConfig?.headers ?? [];
  // Compute allowed image widths from config (union of deviceSizes + imageSizes)
  const allowedImageWidths: number[] = [
    ...(vinextConfig?.images?.deviceSizes ?? DEFAULT_DEVICE_SIZES),
    ...(vinextConfig?.images?.imageSizes ?? DEFAULT_IMAGE_SIZES),
  ];
  // Extract image security config for SVG handling and security headers
  const pagesImageConfig: ImageConfig | undefined = vinextConfig?.images
    ? {
        dangerouslyAllowSVG: vinextConfig.images.dangerouslyAllowSVG,
        dangerouslyAllowLocalIP: vinextConfig.images.dangerouslyAllowLocalIP,
        qualities: vinextConfig.images.qualities,
        contentDispositionType: vinextConfig.images.contentDispositionType,
        contentSecurityPolicy: vinextConfig.images.contentSecurityPolicy,
      }
    : undefined;

  // Load client asset metadata used by the Pages renderer. Prerendered HTML is
  // rendered through this Node server too, so it needs the same globals that
  // Cloudflare builds inject into the Worker entry at build time.
  const ssrManifest = installPagesClientAssetGlobals({
    clientDir,
    assetPrefix,
    assetBase,
    clientEntryLookup: "any-client-entry",
  });

  // Build the static file metadata cache at startup (same as App Router).
  const staticCache = await StaticFileCache.create(clientDir);

  const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const rawUrl = req.url ?? "/";
    const rawPagesPathnameBeforeNormalize = rawUrl.split("?")[0];

    // Guard against protocol-relative URL open redirect attacks.
    // Run BEFORE decoding so both literal (`//`, `/\`) and encoded (`%5C`, `%2F`)
    // variants are rejected — the encoded forms survive segment-wise decoding
    // below and would otherwise reach the trailing-slash redirect emitter.
    if (isOpenRedirectShaped(rawPagesPathnameBeforeNormalize)) {
      res.writeHead(404);
      res.end("This page could not be found");
      return;
    }

    // Normalize backslashes (browsers treat /\ as //), then decode and normalize path.
    // Rebuild `url` from the decoded pathname + original query string so all
    // downstream consumers (resolvedUrl, resolvedPathname, config matchers)
    // always work with the decoded, canonical path.
    const rawPagesPathname = rawPagesPathnameBeforeNormalize.replaceAll("\\", "/");
    const rawQs = rawUrl.includes("?") ? rawUrl.slice(rawUrl.indexOf("?")) : "";
    let pathname: string;
    try {
      pathname = normalizePath(normalizePathnameForRouteMatchStrict(rawPagesPathname));
    } catch {
      // Malformed percent-encoding (e.g. /%E0%A4%A) — return 400 instead of crashing.
      res.writeHead(400);
      res.end("Bad Request");
      return;
    }
    let url = pathname + rawQs;

    // Internal prerender endpoint — only reachable with the correct build-time secret.
    // Used by the prerender phase to fetch getStaticPaths results via HTTP.
    if (pathname === "/__vinext/prerender/pages-static-paths") {
      const secret = req.headers[VINEXT_PRERENDER_SECRET_HEADER];
      if (!prerenderSecret || secret !== prerenderSecret) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
      }
      const parsedUrl = new URL(rawUrl, "http://localhost");
      const pattern = parsedUrl.searchParams.get("pattern") ?? "";
      const localesRaw = parsedUrl.searchParams.get("locales");
      const locales: string[] = localesRaw ? JSON.parse(localesRaw) : [];
      const defaultLocale = parsedUrl.searchParams.get("defaultLocale") ?? "";
      const route = pageRoutes?.find((r) => r.pattern === pattern);
      const fn = route?.module?.getStaticPaths;
      if (typeof fn !== "function") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("null");
        return;
      }
      try {
        const result = await fn({ locales, defaultLocale });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(500);
        res.end((e as Error).message);
      }
      return;
    }

    // ── 1. Hashed build assets ─────────────────────────────────────
    // Serve Vite build output (hashed JS/CSS bundles in /_next/static/)
    // before middleware. These are always public and don't need protection.
    // Public directory files (e.g. /favicon.ico, /robots.txt) are served
    // after middleware (step 5b) so middleware can intercept them.
    //
    // On disk the layout under `dist/client` mirrors the URL:
    //   - default                 → `_next/static/...`
    //   - path-prefix assetPrefix → `<prefix>/_next/static/...`
    //   - absolute-URL prefix     → `_next/static/...`
    // (see `resolveAppRouterAssetPath` for the full table).
    //
    // Match the App Router's behaviour (above) and use the UN-stripped
    // `pathname` here, not `staticLookupPath`. Emitted asset URLs already
    // carry the assetPrefix verbatim (which equals `basePath` when the
    // Next.js parity fallback fires — packages/next/src/server/config.ts:528-531),
    // so stripping `basePath` first would make `resolveAppRouterAssetPath`'s
    // path-prefix branch miss the match and return null → 404.
    // `staticLookupPath` is still computed because non-asset paths below
    // (image-optimization, SSR routing) match against the basePath-stripped form.
    //
    // Asset-shaped requests that don't find a file return a plain-text 404
    // instead of falling through to the SSR/render handler (which would
    // render the full HTML 404 page). Matches Next.js's behaviour in
    // packages/next/src/server/lib/router-server.ts.
    const staticLookupPath = stripBasePath(pathname, basePath);
    const pagesAssetLookup = resolveAppRouterAssetPath(pathname, pagesAssetPathPrefix, assetPrefix);
    if (pagesAssetLookup) {
      if (await tryServeStatic(req, res, clientDir, pagesAssetLookup, compress, staticCache)) {
        return;
      }
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not Found");
      return;
    }

    // ── Image optimization passthrough ──────────────────────────────
    if (isImageOptimizationPath(pathname) || isImageOptimizationPath(staticLookupPath)) {
      const parsedUrl = new URL(rawUrl, "http://localhost");
      const params = parseImageParams(parsedUrl, allowedImageWidths, pagesImageConfig?.qualities);
      if (!params) {
        res.writeHead(400);
        res.end("Bad Request");
        return;
      }
      // Block SVG and other unsafe content types.
      // SVG is only allowed when dangerouslyAllowSVG is enabled.
      const ext = path.extname(params.imageUrl).toLowerCase();
      const ct = CONTENT_TYPES[ext] ?? "application/octet-stream";
      if (!isSafeImageContentType(ct, pagesImageConfig?.dangerouslyAllowSVG)) {
        res.writeHead(400);
        res.end("The requested resource is not an allowed image type");
        return;
      }
      const imageSecurityHeaders: Record<string, string> = {
        "Content-Security-Policy":
          pagesImageConfig?.contentSecurityPolicy ?? IMAGE_CONTENT_SECURITY_POLICY,
        "X-Content-Type-Options": "nosniff",
        "Content-Disposition":
          pagesImageConfig?.contentDispositionType === "attachment" ? "attachment" : "inline",
      };
      if (
        await tryServeStatic(
          req,
          res,
          clientDir,
          params.imageUrl,
          false,
          staticCache,
          imageSecurityHeaders,
        )
      ) {
        return;
      }
      res.writeHead(404);
      res.end("Image not found");
      return;
    }

    try {
      // ── 2. Strip basePath ─────────────────────────────────────────
      // Track whether the original request was under basePath. This drives
      // the basePath gating of rewrites/redirects/headers below — Next.js
      // only applies default rules to requests inside basePath, and only
      // applies `basePath: false` rules to requests outside it.
      const hadBasePath = !basePath || hasBasePath(pathname, basePath);
      {
        const stripped = stripBasePath(pathname, basePath);
        if (stripped !== pathname) {
          const qs = url.includes("?") ? url.slice(url.indexOf("?")) : "";
          url = stripped + qs;
          pathname = stripped;
        }
      }
      // ── 3b. `_next/data` normalization ────────────────────────────
      // Pages Router client-side navigations fetch
      // `/_next/data/<buildId>/<page>.json`. The page path must be normalized
      // BEFORE middleware runs so middleware sees `/page`, matching Next.js
      // (see `handleNextDataRequest` in base-server.ts). If the buildId in the
      // URL does not match this server's buildId we return a JSON 404 right
      // here — stale clients can fall back to a hard navigation without
      // accidentally triggering middleware/SSR on a bogus path.
      let isDataReq = false;
      const originalRenderUrl = url;
      if (isNextDataPathname(pathname)) {
        const dataMatch = pagesBuildId ? parseNextDataPathname(pathname, pagesBuildId) : null;
        if (!dataMatch) {
          // Wrong buildId (or malformed) — surface a JSON 404 so the client
          // hard-navigates instead of silently rendering an empty page.
          const notFound = buildNextDataNotFoundResponse();
          await sendWebResponse(notFound, req, res, compress);
          return;
        }
        isDataReq = true;
        const qs = url.includes("?") ? url.slice(url.indexOf("?")) : "";
        url = dataMatch.pagePathname + qs;
        pathname = dataMatch.pagePathname;
      }

      // Convert Node.js req to Web Request for the server entry
      const protocol = resolveRequestProtocol(req);
      const hostHeader = resolveHost(req, `${host}:${port}`);
      const rawReqHeaders = nodeHeadersToWebHeaders(req.headers);
      // Only a successfully parsed `/_next/data/...json` URL is a data
      // request. The inbound x-nextjs-data header is internal and must not let
      // callers opt normal URLs into the data redirect protocol.
      const isDataRequest = isDataReq;
      // Strip internal headers from inbound requests before any handler or
      // middleware sees them.
      const reqHeaders = filterInternalHeaders(rawReqHeaders);
      const method = req.method ?? "GET";
      const hasBody = method !== "GET" && method !== "HEAD";
      const webRequest = new Request(`${protocol}://${hostHeader}${url}`, {
        method,
        headers: reqHeaders,
        body: hasBody ? readNodeStream(req) : undefined,
        // @ts-expect-error — duplex needed for streaming request bodies
        duplex: hasBody ? "half" : undefined,
      });

      // ── Delegate steps 3–11 to the shared Pages Router pipeline ──
      const deps: PagesPipelineDeps = {
        basePath,
        trailingSlash,
        i18nConfig,
        configRedirects,
        configRewrites,
        configHeaders,
        hadBasePath,
        isDataReq,
        isDataRequest,
        ctx: undefined, // Node has no ExecutionContext
        // Raw query from req.url so redirect Locations aren't re-encoded by URL parsing.
        rawSearch: rawQs,
        matchPageRoute: matchPageRoute ?? null,
        // Pass the original (pre-basePath-stripping) URL to middleware so that
        // request.nextUrl.basePath reflects whether the URL actually had the
        // basePath prefix (see wrapMiddlewareWithBasePath).
        runMiddleware:
          typeof runMiddleware === "function"
            ? wrapMiddlewareWithBasePath(runMiddleware, basePath, hadBasePath)
            : null,
        renderPage:
          typeof renderPage === "function"
            ? (
                request: Request,
                resolvedUrl: string,
                options?: PagesRenderOptions,
                stagedHeaders?: Headers,
              ) =>
                renderPage(request, resolvedUrl, ssrManifest, undefined, stagedHeaders, {
                  ...options,
                  originalUrl: originalRenderUrl,
                })
            : null,
        handleApi:
          typeof handleApi === "function"
            ? (request: Request, apiUrl: string) =>
                handleApi(request, apiUrl, createNodeExecutionContext())
            : null,
        // ── 5b. Serve public-directory static files (post-middleware) ──
        // Public files (favicon.ico, robots.txt, anything under public/) are served
        // after middleware so middleware can intercept or redirect them, and before
        // rewrites so a real public file wins over a fallback rewrite. Build assets
        // (/_next/static/*) were already served above. Middleware response headers
        // (including next.config headers staged by the pipeline) are passed through so
        // Set-Cookie / security headers from middleware are included in the response.
        serveFilesystemRoute: async (requestPathname, stagedHeaders, phase) => {
          if (
            (req.method !== "GET" && req.method !== "HEAD") ||
            requestPathname === "/" ||
            requestPathname === "/api" ||
            requestPathname.startsWith("/api/") ||
            (phase === "direct" && requestPathname.startsWith(`/${ASSET_PREFIX_URL_DIR}/`))
          ) {
            return false;
          }
          return tryServeStatic(
            req,
            res,
            clientDir,
            requestPathname,
            compress,
            staticCache,
            stagedHeaders,
          );
        },
      };

      const result = await runPagesRequest(webRequest, deps);

      if (result.type === "handled") {
        // serveFilesystemRoute already wrote the response to `res`.
        return;
      }

      if (result.type === "response") {
        const { response } = result;
        const shouldStream = isVinextStreamedHtmlResponse(response);
        // Passthrough responses (middleware short-circuits, external proxies, redirects)
        // carry no defaultContentType — send them verbatim without injecting a
        // Content-Type, matching the pre-refactor behavior. Only buffered render/api
        // responses below apply a Content-Type fallback.
        if (shouldStream || !response.body || result.defaultContentType === undefined) {
          await sendWebResponse(response, req, res, compress);
          return;
        }

        const responseBody = Buffer.from(await response.arrayBuffer());
        // render → text/html, api → application/octet-stream (set by the pipeline).
        const ct = response.headers.get("content-type") ?? result.defaultContentType;
        const responseHeaders: Record<string, string | string[]> = {};
        response.headers.forEach((v, k) => {
          if (k === "set-cookie") return;
          responseHeaders[k] = v;
        });
        const setCookies = response.headers.getSetCookie?.() ?? [];
        if (setCookies.length > 0) responseHeaders["set-cookie"] = setCookies;
        const finalStatusText = response.statusText || undefined;

        sendCompressed(
          req,
          res,
          responseBody,
          ct,
          response.status,
          responseHeaders,
          compress,
          finalStatusText,
        );
        return;
      }

      // type "render", "api", "next" should not happen when we supply all callbacks,
      // but guard anyway to keep the adapter correct if callbacks are absent.
      res.writeHead(404);
      res.end("This page could not be found");
    } catch (e) {
      console.error("[vinext] Server error:", e);
      if (!res.headersSent) {
        res.writeHead(500);
        res.end("Internal Server Error");
      }
    }
  };

  const server = createServer((req, res) => {
    void handleRequest(req, res);
  });

  await new Promise<void>((resolve) => {
    server.listen(port, host, () => {
      const addr = server.address();
      const actualPort = typeof addr === "object" && addr ? addr.port : port;
      logProdServerStarted(host, actualPort, purpose);
      resolve();
    });
  });

  const addr = server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : port;
  return { server, port: actualPort };
}

// Export helpers for testing
export {
  sendCompressed,
  sendWebResponse,
  negotiateEncoding,
  COMPRESSIBLE_TYPES,
  COMPRESS_THRESHOLD,
  resolveHost,
  trustedHosts,
  trustProxy,
  nodeToWebRequest,
  mergeResponseHeaders,
  mergeWebResponse,
  tryServeStatic,
};
