/**
 * Seed the memory cache from pre-rendered build output.
 *
 * Reads `vinext-prerender.json` and the corresponding HTML/RSC files from
 * `dist/server/prerendered-routes/`, then populates the active CacheHandler
 * so pre-rendered pages are served as cache HITs on the very first request
 * instead of triggering a full re-render.
 *
 * This is only useful for the MemoryCacheHandler (the default for Node.js
 * production). Persistent backends like KV already retain entries across
 * deploys and can be pre-populated via TPR or similar mechanisms.
 */

import fs from "node:fs";
import path from "node:path";
import { getCacheHandler, type CacheHandler, type CachedAppPageValue } from "../shims/cache.js";
import { isrCacheKey } from "./isr-cache.js";
import { getOutputPath, getRscOutputPath } from "../build/prerender.js";

// ─── Manifest types ───────────────────────────────────────────────────────────

interface PrerenderManifest {
  buildId: string;
  trailingSlash?: boolean;
  routes: PrerenderManifestRoute[];
}

interface PrerenderManifestRoute {
  route: string;
  status: string;
  revalidate?: number | false;
  path?: string;
  router?: "app" | "pages";
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Read pre-rendered routes from disk and seed the active CacheHandler.
 *
 * Call this during production server startup, before any requests are served.
 * If the manifest doesn't exist (no prerender phase was run), this is a no-op.
 *
 * @param serverDir - Path to `dist/server/` (where vinext-prerender.json lives)
 */
export async function seedMemoryCacheFromPrerender(serverDir: string): Promise<void> {
  const manifestPath = path.join(serverDir, "vinext-prerender.json");
  if (!fs.existsSync(manifestPath)) return;

  let manifest: PrerenderManifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  } catch {
    return;
  }

  const { buildId, routes } = manifest;
  if (!buildId || !Array.isArray(routes)) return;

  const trailingSlash = manifest.trailingSlash ?? false;
  const prerenderDir = path.join(serverDir, "prerendered-routes");
  const handler = getCacheHandler();

  for (const route of routes) {
    if (route.status !== "rendered") continue;
    if (route.router !== "app") continue;

    // Use concrete path for dynamic routes, route pattern for static
    const pathname = route.path ?? route.route;
    const revalidateCtx =
      typeof route.revalidate === "number" ? { revalidate: route.revalidate } : {};

    await seedAppRoute(handler, prerenderDir, pathname, buildId, trailingSlash, revalidateCtx);
  }
}

// ─── Internals ────────────────────────────────────────────────────────────────

async function seedAppRoute(
  handler: CacheHandler,
  prerenderDir: string,
  pathname: string,
  buildId: string,
  trailingSlash: boolean,
  ctx: Record<string, unknown>,
): Promise<void> {
  const htmlRelPath = getOutputPath(pathname, trailingSlash);
  const htmlFullPath = path.join(prerenderDir, htmlRelPath);
  if (!fs.existsSync(htmlFullPath)) return;

  const html = fs.readFileSync(htmlFullPath, "utf-8");
  const baseKey = isrCacheKey("app", pathname, buildId);

  // Seed HTML entry
  const htmlValue: CachedAppPageValue = {
    kind: "APP_PAGE",
    html,
    rscData: undefined,
    headers: undefined,
    postponed: undefined,
    status: undefined,
  };
  await handler.set(baseKey + ":html", htmlValue, ctx);

  // Seed RSC entry (if file exists)
  const rscRelPath = getRscOutputPath(pathname);
  const rscFullPath = path.join(prerenderDir, rscRelPath);
  if (!fs.existsSync(rscFullPath)) return;

  const rscBuffer = fs.readFileSync(rscFullPath);
  const rscValue: CachedAppPageValue = {
    kind: "APP_PAGE",
    html: "",
    rscData: rscBuffer.buffer.slice(
      rscBuffer.byteOffset,
      rscBuffer.byteOffset + rscBuffer.byteLength,
    ),
    headers: undefined,
    postponed: undefined,
    status: undefined,
  };
  await handler.set(baseKey + ":rsc", rscValue, ctx);
}
