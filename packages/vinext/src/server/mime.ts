/**
 * Shared MIME type map for serving static files.
 *
 * Used by index.ts (Pages Router dev), app-dev-server.ts (generated RSC entry),
 * and prod-server.ts (production server). Centralised here to avoid drift.
 *
 * Keys are bare extensions (no leading dot). Use `mimeType()` for lookup.
 */
export const MIME_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css",
  js: "application/javascript",
  mjs: "application/javascript",
  cjs: "application/javascript",
  json: "application/json",
  txt: "text/plain",
  xml: "application/xml",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  eot: "application/vnd.ms-fontobject",
  pdf: "application/pdf",
  map: "application/json",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  wasm: "application/wasm",
};

/**
 * Look up a MIME type by bare extension (no leading dot).
 * Returns "application/octet-stream" for unknown extensions.
 */
export function mimeType(ext: string): string {
  return MIME_TYPES[ext] ?? "application/octet-stream";
}
