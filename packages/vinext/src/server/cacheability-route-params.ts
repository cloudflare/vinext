import { markDynamicUsage, markRenderRequestApiUsage } from "vinext/shims/headers";
import {
  makeThenableParams,
  type ThenableParams,
  type ThenableParamsObserver,
} from "vinext/shims/thenable-params";
import { routeParamsRequireRuntime } from "./cacheability-request.js";

export function createCacheabilityPageParamsObserver(
  cacheComponents: boolean,
  fallbackRequiresRuntime = false,
): ThenableParamsObserver | undefined {
  return runtimeParamObserver(true, cacheComponents, fallbackRequiresRuntime);
}

function runtimeParamObserver(
  recordRenderUsage: boolean,
  cacheComponents: boolean,
  fallbackRequiresRuntime: boolean,
): ThenableParamsObserver | undefined {
  if (!cacheComponents) return undefined;
  if (!routeParamsRequireRuntime(fallbackRequiresRuntime)) return undefined;
  return {
    observeParamAccess() {
      markDynamicUsage();
      if (recordRenderUsage) markRenderRequestApiUsage("params");
    },
  };
}

export function makeCacheabilityAwarePageParams<T extends Record<string, unknown>>(
  params: T,
  cacheComponents: boolean,
  fallbackRequiresRuntime = false,
): ThenableParams<T> {
  return makeThenableParams(
    params,
    runtimeParamObserver(true, cacheComponents, fallbackRequiresRuntime),
  );
}

export function makeCacheabilityAwareRouteHandlerParams<T extends Record<string, unknown>>(
  params: T,
  cacheComponents: boolean,
  fallbackRequiresRuntime = false,
): ThenableParams<T> {
  return makeThenableParams(
    params,
    runtimeParamObserver(false, cacheComponents, fallbackRequiresRuntime),
  );
}
