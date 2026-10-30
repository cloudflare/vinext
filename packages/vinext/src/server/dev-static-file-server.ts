/**
 * Host side of the plain Node `vinext dev` static-file signal bridge.
 *
 * See dev-static-file-signal.ts for the runner side. The response mirrors
 * Vite's dev public middleware (sirv in dev mode): weak size/mtime ETag,
 * `Cache-Control: no-cache`, mrmime content types with Vite's JavaScript
 * override, `server.headers`, conditional GETs, and single byte ranges.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import fsp from "node:fs/promises";
import type { OutgoingHttpHeaders } from "node:http";
import { Readable } from "node:stream";
import { lookup as lookupMimeType } from "mrmime";
import path from "pathslash";
import { matchesIfNoneMatch } from "./http-conditional.js";
import { ifRangeAllowsRange, parseByteRange, type ByteRange } from "./http-range.js";
import { notFoundResponse } from "./http-error-responses.js";
import {
  DEV_STATIC_FILE_SERVER_STORAGE_KEY,
  type DevStaticFileServer,
} from "./dev-static-file-signal.js";

export function getDevStaticFileServerStorage(): AsyncLocalStorage<DevStaticFileServer> {
  const globals = globalThis as unknown as Record<PropertyKey, unknown>;
  const existing = globals[DEV_STATIC_FILE_SERVER_STORAGE_KEY];
  if (existing instanceof AsyncLocalStorage) return existing;
  const storage = new AsyncLocalStorage<DevStaticFileServer>();
  globals[DEV_STATIC_FILE_SERVER_STORAGE_KEY] = storage;
  return storage;
}

// Vite serves public scripts, including TypeScript sources, as JavaScript.
const KNOWN_JAVASCRIPT_EXTENSION_RE = /\.(?:[tj]sx?|[cm][tj]s)$/;

function contentTypeForDevPublicFile(filePath: string): string | undefined {
  if (KNOWN_JAVASCRIPT_EXTENSION_RE.test(filePath)) return "text/javascript";
  const contentType = lookupMimeType(filePath);
  return contentType === "text/html" ? `${contentType};charset=utf-8` : contentType;
}

export async function serveDevPublicFile(
  publicDir: string,
  pathname: string,
  request: Request,
  configuredHeaders?: OutgoingHttpHeaders,
): Promise<Response> {
  // Public-file routes are URL-encoded; sirv decodes them once with decodeURI
  // and keeps the raw pathname when it is malformed.
  let filePathname = pathname;
  if (filePathname.includes("%")) {
    try {
      filePathname = decodeURI(filePathname);
    } catch {}
  }
  const root = path.resolve(publicDir);
  const filePath = path.resolve(root, `.${filePathname}`);
  const relativePath = path.relative(root, filePath);
  if (
    !relativePath ||
    relativePath === ".." ||
    relativePath.startsWith("../") ||
    path.isAbsolute(relativePath)
  ) {
    return notFoundResponse();
  }

  let stat: Awaited<ReturnType<typeof fsp.stat>>;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    return notFoundResponse();
  }
  if (!stat.isFile()) return notFoundResponse();

  const etag = `W/"${stat.size}-${stat.mtime.getTime()}"`;
  const headers = new Headers({
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-cache",
    ETag: etag,
    "Last-Modified": stat.mtime.toUTCString(),
  });
  const contentType = contentTypeForDevPublicFile(filePath);
  if (contentType) headers.set("Content-Type", contentType);
  // Vite applies `server.headers` after sirv's own headers.
  for (const [name, value] of Object.entries(configuredHeaders ?? {})) {
    if (value === undefined) continue;
    headers.delete(name);
    for (const item of Array.isArray(value) ? value : [value]) headers.append(name, String(item));
  }

  if (matchesIfNoneMatch(request.headers.get("if-none-match") ?? undefined, etag)) {
    return new Response(null, { status: 304, headers });
  }

  const range: ByteRange = ifRangeAllowsRange(
    request.headers.get("if-range") ?? undefined,
    etag,
    stat.mtimeMs,
  )
    ? parseByteRange(request.headers.get("range") ?? undefined, stat.size)
    : { kind: "ignore" };

  if (range.kind === "unsatisfiable") {
    headers.set("Content-Range", `bytes */${stat.size}`);
    return new Response(null, { status: 416, headers });
  }

  const start = range.kind === "range" ? range.start : 0;
  const end = range.kind === "range" ? range.end : stat.size - 1;
  headers.set("Content-Length", String(Math.max(0, end - start + 1)));
  if (range.kind === "range") {
    headers.set("Content-Range", `bytes ${start}-${end}/${stat.size}`);
  }

  // Match Vite/sirv: HEAD evaluates validators and ranges like GET, then omits the body.
  const body =
    request.method === "HEAD" || end < start
      ? null
      : (Readable.toWeb(fs.createReadStream(filePath, { start, end })) as ReadableStream);
  return new Response(body, { status: range.kind === "range" ? 206 : 200, headers });
}
