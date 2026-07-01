/**
 * Canonical Content-Type lookup for static assets, keyed by lowercase file
 * extension (with leading dot).
 *
 * Split out from `static-file-cache.ts` so consumers that only need the MIME
 * table — e.g. the font dev-serving middleware in `plugins/fonts.ts` — can
 * import it without pulling in the production static-file cache, its startup
 * directory walk, and Node fs/path dependencies. `static-file-cache.ts`
 * re-exports this so existing importers keep working; this module is the
 * single source of truth.
 */

/** Content-type lookup for static assets. */
export const CONTENT_TYPES: Record<string, string> = {
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".css": "text/css",
  ".html": "text/html",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".eot": "application/vnd.ms-fontobject",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".map": "application/json",
  ".rsc": "text/x-component",
};
