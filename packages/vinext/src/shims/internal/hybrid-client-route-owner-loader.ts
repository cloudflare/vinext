import { loadChunk } from "../../client/chunk-load-recovery.js";
import {
  resolveDirectHybridClientRouteOwner,
  type HybridClientOwner,
} from "./hybrid-client-route-owner-direct.js";

type HybridClientRouteOwnerModule = typeof import("./hybrid-client-route-owner.js");

// Each module reads this define itself: an imported constant does not fold, so
// the bundler would keep owner-loading code in builds without client rewrites.
const HAS_CLIENT_REWRITES = process.env.__VINEXT_HAS_CLIENT_REWRITES !== "false";

let loadedModule: HybridClientRouteOwnerModule | null = null;
let pendingLoad: Promise<HybridClientRouteOwnerModule | null> | null = null;
let loadFailure: { error: unknown } | null = null;

const LOAD_FAILED_MESSAGE =
  "[vinext] Could not load the link routing script, so links will load full pages. The site was probably updated; reload the page.";

export function getLoadedHybridClientRouteOwner(): HybridClientRouteOwnerModule | null {
  return loadedModule;
}

/** The failure of the latest load attempt, or null when it succeeded or none has run. */
export function getHybridClientRouteOwnerLoadFailure(): { error: unknown } | null {
  return loadFailure;
}

/**
 * The owner of a URL for a navigation. Without client rewrites the direct
 * resolver is exact. With them, a module that is not loaded, or failed to
 * load, answers "document" so the server decides.
 */
export function resolveHybridClientRouteOwnerOrDocument(
  href: string,
  basePath: string,
): HybridClientOwner | null {
  if (!HAS_CLIENT_REWRITES) return resolveDirectHybridClientRouteOwner(href, basePath);
  return loadedModule ? loadedModule.resolveHybridClientRouteOwner(href, basePath) : "document";
}

/**
 * Resolves to null when the chunk cannot be loaded; callers then navigate by
 * document. Only builds with client rewrites need this chunk.
 */
export function loadHybridClientRouteOwner(): Promise<HybridClientRouteOwnerModule | null> {
  if (loadedModule) return Promise.resolve(loadedModule);

  pendingLoad ??= loadChunk(() => import("./hybrid-client-route-owner.js")).then(
    (module) => {
      loadedModule = module;
      loadFailure = null;
      return module;
    },
    (error: unknown) => {
      pendingLoad = null;
      if (!loadFailure) console.error(LOAD_FAILED_MESSAGE, error);
      loadFailure = { error };
      return null;
    },
  );
  return pendingLoad;
}
