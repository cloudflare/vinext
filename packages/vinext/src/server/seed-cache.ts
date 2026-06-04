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
 *
 * Consistency model:
 * - The manifest is authoritative for which routes were pre-rendered and their
 *   revalidation config. The HTML/RSC files on disk are the source of truth
 *   for content. Both are produced by the same build and are immutable after
 *   the build completes.
 * - Cache keys include the buildId, so entries from a previous build are never
 *   matched by a new server process (new build = new buildId = new keys).
 * - Seeded entries are indistinguishable from entries created by the ISR
 *   render path: same cache value shape, same revalidate duration tracking,
 *   same cache key construction. The serving path does not know or care
 *   whether an entry was seeded or rendered.
 *
 * Concurrency model:
 * - This function runs at startup before the HTTP server begins accepting
 *   requests, so there are no concurrent readers during seeding. All I/O is
 *   synchronous (readFileSync) which is appropriate for a startup-only path
 *   that runs once before the event loop serves traffic.
 */

import fs from "node:fs";
import path from "node:path";
import type { CachedAppPageValue } from "vinext/shims/cache";
import { isrCacheKey, isrSetPrerenderedAppPage } from "./isr-cache.js";
import { buildAppPageCacheTags } from "./app-page-cache.js";
import { getOutputPath, getRscOutputPath } from "../utils/prerender-output-paths.js";
import { normalizePathnameForRouteMatch } from "../routing/utils.js";
import { normalizePath } from "./normalize-path.js";

// ─── Manifest types ───────────────────────────────────────────────────────────

type PrerenderManifest = {
  buildId: string;
  trailingSlash?: boolean;
  routes: PrerenderManifestRoute[];
};

type PrerenderManifestRoute = {
  route: string;
  status: string;
  revalidate?: number | false;
  expire?: number;
  path?: string;
  router?: "app" | "pages";
};

type PrerenderCacheSeedMetadata = {
  expireSeconds?: number;
  revalidateSeconds?: number;
  /**
   * Path-derived implicit tags (`/foo`, `_N_T_/foo`, `_N_T_/foo/page`, ...)
   * required for `revalidatePath()` to invalidate the seeded entry. See #1486.
   */
  tags?: string[];
};

type PrerenderCacheSeedOptions = {
  buildAppPageHtmlKey?: (pathname: string) => string;
  buildAppPageRscKey?: (pathname: string) => string;
  writeAppPageEntry?: (
    key: string,
    data: CachedAppPageValue,
    metadata: PrerenderCacheSeedMetadata,
  ) => Promise<void>;
};

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Read pre-rendered routes from disk and seed the active CacheHandler.
 *
 * Call this during production server startup, before any requests are served.
 * If the manifest doesn't exist (no prerender phase was run), this is a no-op.
 *
 * @param serverDir - Path to `dist/server/` (where vinext-prerender.json lives)
 * @returns The number of routes seeded (0 if no manifest or no renderable routes).
 */
export async function seedMemoryCacheFromPrerender(
  serverDir: string,
  options?: PrerenderCacheSeedOptions,
): Promise<number> {
  const manifestPath = path.join(serverDir, "vinext-prerender.json");
  if (!fs.existsSync(manifestPath)) return 0;

  let manifest: PrerenderManifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  } catch (err) {
    console.warn("[vinext] Failed to parse vinext-prerender.json, skipping cache seeding:", err);
    return 0;
  }

  const { buildId, routes } = manifest;
  if (!buildId || !Array.isArray(routes)) return 0;

  const trailingSlash = manifest.trailingSlash ?? false;
  const prerenderDir = path.join(serverDir, "prerendered-routes");
  const writeAppPageEntry = options?.writeAppPageEntry ?? createDefaultAppPageEntryWriter();
  let seeded = 0;

  for (const route of routes) {
    if (route.status !== "rendered") continue;
    if (route.router !== "app") continue;

    const artifactPathname = route.path ?? route.route;
    const cachePathname = normalizePrerenderCachePathname(artifactPathname);
    // Fallback keys support older generated entries that do not export their
    // runtime key builders. Current App Router entries inject buildAppPage*Key
    // so seeded keys match process.env.__VINEXT_BUILD_ID exactly.
    const baseKey = isrCacheKey("app", cachePathname, buildId);
    const htmlKey = options?.buildAppPageHtmlKey?.(cachePathname) ?? baseKey + ":html";
    const rscKey = options?.buildAppPageRscKey?.(cachePathname) ?? baseKey + ":rsc";
    const revalidateSeconds = typeof route.revalidate === "number" ? route.revalidate : undefined;
    const expireSeconds = typeof route.expire === "number" ? route.expire : undefined;

    // Path-derived implicit tags so revalidatePath()/revalidateTag() can
    // invalidate seeded entries. Without this the seeded entry has no tags
    // and tag-based invalidation can never reach it (#1486).
    const tags = buildAppPageCacheTags(cachePathname, []);

    if (
      await seedHtml(
        writeAppPageEntry,
        prerenderDir,
        htmlKey,
        artifactPathname,
        trailingSlash,
        revalidateSeconds,
        expireSeconds,
        tags,
      )
    ) {
      await seedRsc(
        writeAppPageEntry,
        prerenderDir,
        rscKey,
        artifactPathname,
        revalidateSeconds,
        expireSeconds,
        tags,
      );
      seeded++;
    }
  }

  return seeded;
}

// ─── Internals ────────────────────────────────────────────────────────────────

function normalizePrerenderCachePathname(pathname: string): string {
  return normalizePath(normalizePathnameForRouteMatch(pathname));
}

function createDefaultAppPageEntryWriter(): NonNullable<
  PrerenderCacheSeedOptions["writeAppPageEntry"]
> {
  return (key, data, metadata) => isrSetPrerenderedAppPage(key, data, metadata);
}

/**
 * Seed the HTML cache entry for a single route.
 * Returns true if the file existed and was seeded.
 */
async function seedHtml(
  writeAppPageEntry: NonNullable<PrerenderCacheSeedOptions["writeAppPageEntry"]>,
  prerenderDir: string,
  key: string,
  pathname: string,
  trailingSlash: boolean,
  revalidateSeconds: number | undefined,
  expireSeconds: number | undefined,
  tags: string[] | undefined,
): Promise<boolean> {
  const relPath = getOutputPath(pathname, trailingSlash);
  const fullPath = path.join(prerenderDir, relPath);
  if (!fs.existsSync(fullPath)) return false;

  const htmlValue: CachedAppPageValue = {
    kind: "APP_PAGE",
    html: fs.readFileSync(fullPath, "utf-8"),
    rscData: undefined,
    headers: undefined,
    postponed: undefined,
    status: undefined,
  };

  await writeAppPageEntry(key, htmlValue, { expireSeconds, revalidateSeconds, tags });

  return true;
}

/**
 * Seed the RSC cache entry for a single route.
 * No-op if the .rsc file doesn't exist on disk.
 */
async function seedRsc(
  writeAppPageEntry: NonNullable<PrerenderCacheSeedOptions["writeAppPageEntry"]>,
  prerenderDir: string,
  key: string,
  pathname: string,
  revalidateSeconds: number | undefined,
  expireSeconds: number | undefined,
  tags: string[] | undefined,
): Promise<void> {
  const relPath = getRscOutputPath(pathname);
  const fullPath = path.join(prerenderDir, relPath);
  if (!fs.existsSync(fullPath)) return;

  const rscBuffer = fs.readFileSync(fullPath);
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

  await writeAppPageEntry(key, rscValue, { expireSeconds, revalidateSeconds, tags });
}
