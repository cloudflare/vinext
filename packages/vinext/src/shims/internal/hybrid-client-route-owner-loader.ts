import { loadChunk } from "../../client/chunk-load-recovery.js";

type HybridClientRouteOwnerModule = typeof import("./hybrid-client-route-owner.js");

let loadedModule: HybridClientRouteOwnerModule | null = null;
let pendingLoad: Promise<HybridClientRouteOwnerModule | null> | null = null;
let loadFailure: { error: unknown } | null = null;

const LOAD_FAILED_MESSAGE =
  "[vinext] Could not load the script that decides which router owns a link, so navigation will load full pages instead. This usually means the site was updated while this page was open; reloading the page fixes it.";

export function getLoadedHybridClientRouteOwner(): HybridClientRouteOwnerModule | null {
  return loadedModule;
}

/** The failure of the latest load attempt, or null when it succeeded or none has run. */
export function getHybridClientRouteOwnerLoadFailure(): { error: unknown } | null {
  return loadFailure;
}

/** Resolves to null when the chunk cannot be loaded; callers then navigate by document. */
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
      loadFailure = { error };
      console.error(LOAD_FAILED_MESSAGE, error);
      return null;
    },
  );
  return pendingLoad;
}
