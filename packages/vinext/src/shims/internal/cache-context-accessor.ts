// The active "use cache" context, registered by cache-runtime.ts. Kept apart from
// cache-request-state.ts so root-params.ts can record root-param reads without
// loading the request cache state (and next/headers) into SSR.

import type { CacheLifeConfig } from "../cache-request-state.js";

type CacheContextLike = {
  tags: string[];
  lifeConfigs: CacheLifeConfig[];
  variant: string;
  readRootParamNames?: Set<string>;
  hasExplicitRevalidate: boolean;
  hasExplicitExpire: boolean;
  dynamicNestedCacheError: Error | undefined;
};

let getCacheContext: (() => CacheContextLike | null) | null = null;

export function _registerCacheContextAccessor(fn: () => CacheContextLike | null): void {
  getCacheContext = fn;
}

export function getRegisteredCacheContext(): CacheContextLike | null {
  return getCacheContext?.() ?? null;
}

/** Record a root-param dependency on the active public `"use cache"` scope. */
export function _recordUseCacheRootParamRead(name: string): void {
  const context = getRegisteredCacheContext();
  if (context && context.variant !== "private") {
    context.readRootParamNames?.add(name);
  }
}
