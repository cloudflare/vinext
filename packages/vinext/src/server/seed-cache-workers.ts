/**
 * Workers-side lazy cache seeding from pre-rendered assets.
 *
 * On Cloudflare Workers, pre-rendered HTML/RSC files are deployed as static
 * assets in `dist/client/__prerender/`. This module fetches them via the
 * assets binding on first request for each route and populates the
 * MemoryCacheHandler so subsequent requests are cache HITs.
 *
 * Seeding is lazy (per-route, on-demand) because:
 * - Workers isolates are ephemeral and not guaranteed to serve all routes
 * - The 128MB memory limit makes eager seeding of all routes wasteful
 * - Concurrent requests to the same cold route are deduped
 *
 * Consistency model:
 * - The manifest and prerendered files are deployed as static assets
 *   alongside the worker bundle. They are immutable for the lifetime of
 *   a deployment. A new deployment produces new assets, and old isolates
 *   are eventually terminated — no cross-deploy staleness is possible.
 * - Cache keys include buildId, so even if an old isolate briefly coexists
 *   with a new deployment, the keys never collide.
 * - Seeded entries are indistinguishable from entries created by the ISR
 *   render path: same cache value shape, same revalidate duration tracking,
 *   same cache key construction.
 *
 * Concurrency model:
 * - A single Workers isolate can process concurrent requests. The manifest
 *   load is deduplicated via a cached promise (loadedPromise). Two
 *   concurrent calls to loadManifest both await the same promise — no
 *   double-fetch is possible because the assignment to loadedPromise
 *   happens synchronously before the first await.
 * - Per-route seeding is deduplicated via seedInFlight. Between the
 *   getCacheHandler().get() check (async, yields) and the seedInFlight.get()
 *   check (sync, no yield), no other microtask can interleave. If two
 *   requests both pass the cache check, the first creates the in-flight
 *   promise and the second joins it.
 */

import { getCacheHandler } from "../shims/cache.js";
import { isrCacheKey, setRevalidateDuration } from "./isr-cache.js";
import { getOutputPath, getRscOutputPath } from "../build/prerender.js";
import {
  type PrerenderManifest,
  type PrerenderManifestRoute,
  revalidateCtx,
  makeHtmlCacheValue,
  makeRscCacheValue,
} from "./seed-cache-shared.js";

/** Loaded manifest + pre-built route lookup. Returned as a unit so they can't desync. */
interface LoadedManifest {
  manifest: PrerenderManifest;
  lookup: Map<string, PrerenderManifestRoute>;
}

// ─── Module-scope state (persists for the life of the isolate) ───────────────

/** Cached manifest — loaded once per isolate via the first seedRouteFromAssets call. */
let loadedPromise: Promise<LoadedManifest | null> | null = null;

/** In-flight seeding promises — deduplicates concurrent cold hits for the same route. */
const seedInFlight = new Map<string, Promise<void>>();

// ─── Public API ──────────────────────────────────────────────────────────────

/** Asset fetcher signature — wraps `env.ASSETS.fetch()` for testability. */
export type AssetFetcher = (assetPath: string) => Promise<Response>;

/**
 * Lazily seed the MemoryCacheHandler for a single route from pre-rendered assets.
 *
 * Call this in the Worker's fetch handler before delegating to the RSC handler.
 * If the route has pre-rendered data and isn't already cached, the HTML/RSC
 * files are fetched from the assets binding and inserted into the cache.
 *
 * @param pathname - The request pathname (e.g. "/about")
 * @param fetchAsset - Function that fetches from the assets binding
 */
export async function seedRouteFromAssets(
  pathname: string,
  fetchAsset: AssetFetcher,
): Promise<void> {
  try {
    const loaded = await loadManifest(fetchAsset);
    if (!loaded) return;

    const route = loaded.lookup.get(pathname);
    if (!route) return;

    const baseKey = isrCacheKey("app", pathname, loaded.manifest.buildId);
    const htmlKey = baseKey + ":html";

    // Already in cache — nothing to do
    const existing = await getCacheHandler().get(htmlKey);
    if (existing) return;

    // Dedup concurrent cold hits — between the await above and this sync check,
    // no other microtask can interleave, so at most one caller creates the promise.
    const inflight = seedInFlight.get(htmlKey);
    if (inflight) {
      await inflight;
      return;
    }

    const revalidateSeconds = typeof route.revalidate === "number" ? route.revalidate : undefined;
    const promise = doSeedRoute(loaded.manifest, pathname, baseKey, revalidateSeconds, fetchAsset)
      .catch(() => {}) // seeding is best-effort — never propagate to joiners
      .finally(() => seedInFlight.delete(htmlKey));

    seedInFlight.set(htmlKey, promise);
    await promise;
  } catch {
    // Catches errors from loadManifest, getCacheHandler().get(), or any
    // unexpected throw before doSeedRoute. Never crash the request.
  }
}

/**
 * Reset module-scope state. Only for use in tests.
 * @internal
 */
export function _resetForTesting(): void {
  loadedPromise = null;
  seedInFlight.clear();
}

// ─── Internals ───────────────────────────────────────────────────────────────

async function loadManifest(fetchAsset: AssetFetcher): Promise<LoadedManifest | null> {
  if (!loadedPromise) {
    // Assignment is synchronous — concurrent callers that arrive before the
    // first await will see loadedPromise !== null and join the same promise.
    loadedPromise = (async () => {
      try {
        const res = await fetchAsset("/__prerender/vinext-prerender.json");
        if (!res.ok) return null;
        const manifest: PrerenderManifest = await res.json();
        if (!manifest.buildId || !Array.isArray(manifest.routes)) return null;

        const lookup = new Map<string, PrerenderManifestRoute>();
        for (const route of manifest.routes) {
          if (route.status !== "rendered") continue;
          if (route.router !== "app") continue;
          lookup.set(route.path ?? route.route, route);
        }

        return { manifest, lookup };
      } catch {
        // Transient failure (network error, timeout) — allow retry on next request.
        // Permanent failures (!res.ok, invalid JSON structure) return null above
        // without resetting, since those indicate a malformed deployment.
        loadedPromise = null;
        return null;
      }
    })();
  }
  return loadedPromise;
}

async function doSeedRoute(
  manifest: PrerenderManifest,
  pathname: string,
  baseKey: string,
  revalidateSeconds: number | undefined,
  fetchAsset: AssetFetcher,
): Promise<void> {
  const trailingSlash = manifest.trailingSlash ?? false;
  const handler = getCacheHandler();
  const ctx = revalidateCtx(revalidateSeconds);

  // Fetch and seed HTML
  const htmlRelPath = getOutputPath(pathname, trailingSlash);
  const htmlRes = await fetchAsset(`/__prerender/${htmlRelPath}`);
  if (!htmlRes.ok) return;

  const htmlKey = baseKey + ":html";
  await handler.set(htmlKey, makeHtmlCacheValue(await htmlRes.text()), ctx);
  if (revalidateSeconds !== undefined) {
    setRevalidateDuration(htmlKey, revalidateSeconds);
  }

  // Fetch and seed RSC (optional)
  const rscRelPath = getRscOutputPath(pathname);
  const rscRes = await fetchAsset(`/__prerender/${rscRelPath}`);
  if (!rscRes.ok) return;

  const rscKey = baseKey + ":rsc";
  await handler.set(rscKey, makeRscCacheValue(await rscRes.arrayBuffer()), ctx);
  if (revalidateSeconds !== undefined) {
    setRevalidateDuration(rscKey, revalidateSeconds);
  }
}
