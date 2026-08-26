import { getRequestExecutionContext } from "./request-context.js";

export const CACHEABILITY_REQUEST_STATE = Symbol.for("vinext.cacheabilityRequestState");

type CacheabilityClassificationState = {
  mode?: "admit" | "admit-all" | "probe";
  route?: unknown;
};

function readClassificationState(): CacheabilityClassificationState | null {
  const context = getRequestExecutionContext();
  if (!context) return null;
  return (
    (Reflect.get(context, CACHEABILITY_REQUEST_STATE) as
      | CacheabilityClassificationState
      | undefined) ?? null
  );
}

/** True while a route response is being classified for whole-response CDN reuse. */
export function isRouteCacheabilityClassificationActive(): boolean {
  return readClassificationState()?.route !== undefined;
}

/** True only for the side-effect-free staged Worker probe pass. */
export function isStagedCacheabilityProbeActive(): boolean {
  const state = readClassificationState();
  return state?.mode === "probe" && state.route !== undefined;
}
