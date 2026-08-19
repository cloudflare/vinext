import type { RscCacheKeyMode } from "../cache/cache-adapters-virtual.js";

export type RscPrewarmClientImplementation = {
  canonicalizeFullRscRequestHeaders(headers: Headers, cacheKeyMode?: RscCacheKeyMode): boolean;
  getLoadedRscPrewarmEligibility(href: string, basePath?: string): boolean | null;
  isLoadedRscPrewarmEligibleHref(href: string, basePath?: string): boolean;
  isRscPrewarmEligibleHref(href: string, basePath?: string): Promise<boolean>;
  isRscPrewarmEligibleHrefForPrefetch(href: string, basePath?: string): Promise<boolean>;
  preloadRscPrewarmManifest(): Promise<ReadonlySet<string>>;
};

type RscPrewarmClientState = {
  implementation: RscPrewarmClientImplementation | null;
};

const RSC_PREWARM_CLIENT_STATE = Symbol.for("vinext.rscPrewarmClient");
const EMPTY_PATHS: ReadonlySet<string> = new Set();

function getState(): RscPrewarmClientState {
  const registry = globalThis as typeof globalThis & {
    [key: symbol]: RscPrewarmClientState | undefined;
  };
  return (registry[RSC_PREWARM_CLIENT_STATE] ??= { implementation: null });
}

function isResponseVaryRscCacheEnabled(): boolean {
  return (
    process.env.__VINEXT_RSC_CACHE_KEY_MODE === "response-vary" ||
    getState().implementation !== null
  );
}

export function registerRscPrewarmClientImplementation(
  implementation: RscPrewarmClientImplementation,
): () => void {
  const state = getState();
  state.implementation = implementation;
  return () => {
    if (state.implementation === implementation) state.implementation = null;
  };
}

/** Clear a previously registered implementation after a dev config reload. */
export function clearRscPrewarmClientImplementation(): void {
  getState().implementation = null;
}

export function canonicalizeFullRscRequestHeaders(
  headers: Headers,
  cacheKeyMode?: RscCacheKeyMode,
): boolean {
  if (!isResponseVaryRscCacheEnabled()) return false;
  return (
    getState().implementation?.canonicalizeFullRscRequestHeaders(headers, cacheKeyMode) ?? false
  );
}

export function preloadRscPrewarmManifest(): Promise<ReadonlySet<string>> {
  if (!isResponseVaryRscCacheEnabled()) return Promise.resolve(EMPTY_PATHS);
  return getState().implementation?.preloadRscPrewarmManifest() ?? Promise.resolve(EMPTY_PATHS);
}

export function getLoadedRscPrewarmEligibility(href: string, basePath = ""): boolean | null {
  if (!isResponseVaryRscCacheEnabled()) return false;
  const implementation = getState().implementation;
  return implementation ? implementation.getLoadedRscPrewarmEligibility(href, basePath) : false;
}

export function isLoadedRscPrewarmEligibleHref(href: string, basePath = ""): boolean {
  if (!isResponseVaryRscCacheEnabled()) return false;
  return getState().implementation?.isLoadedRscPrewarmEligibleHref(href, basePath) ?? false;
}

export function isRscPrewarmEligibleHref(href: string, basePath = ""): Promise<boolean> {
  if (!isResponseVaryRscCacheEnabled()) return Promise.resolve(false);
  return (
    getState().implementation?.isRscPrewarmEligibleHref(href, basePath) ?? Promise.resolve(false)
  );
}

export function isRscPrewarmEligibleHrefForPrefetch(href: string, basePath = ""): Promise<boolean> {
  if (!isResponseVaryRscCacheEnabled()) return Promise.resolve(false);
  return (
    getState().implementation?.isRscPrewarmEligibleHrefForPrefetch(href, basePath) ??
    Promise.resolve(false)
  );
}

/** Test-only reset for source-level module tests without a generated bootstrap. */
export function resetRscPrewarmClientImplementationForTesting(): void {
  clearRscPrewarmClientImplementation();
}
