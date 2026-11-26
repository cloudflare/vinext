import { ASSET_PREFIX_URL_DIR } from "./asset-prefix.js";

/**
 * URL directory, below `basePath`, that compiled service workers are served
 * from. The client build writes them to the same path, so `basePath` is part
 * of their on-disk location. Matches Next.js's `/_next/static/service-worker/`.
 */
export const SERVICE_WORKER_URL_DIR = `${ASSET_PREFIX_URL_DIR}/service-worker`;

/**
 * `Cache-Control` for a service worker script. Its URL is stable across builds,
 * so it is revalidated on every use rather than cached immutably. Matches
 * Next.js's router-server.
 */
export const SERVICE_WORKER_CACHE_CONTROL = "public, max-age=0, must-revalidate";

/**
 * The directory, relative to the client build directory and with a trailing
 * slash, that holds the service workers of an app with this `basePath`.
 */
export function serviceWorkerOutputDir(basePath: string): string {
  const baseDir = basePath.replace(/^\/+|\/+$/g, "");
  return `${baseDir ? `${baseDir}/` : ""}${SERVICE_WORKER_URL_DIR}/`;
}

/**
 * `Service-Worker-Allowed` for a service worker script. Workers register at
 * `basePath`, above their own directory, which browsers only allow when the
 * script response carries this header.
 */
export function serviceWorkerAllowedHeader(basePath: string): string {
  return basePath || "/";
}
