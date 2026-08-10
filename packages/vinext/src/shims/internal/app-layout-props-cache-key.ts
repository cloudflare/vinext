import { isUseCacheFunction } from "./use-cache-function.js";

const APP_LAYOUT_MARKER = "$$isLayout";

/**
 * Mark framework-owned layout/template props for the cache runtime.
 *
 * The decision is based on the resolved component identity so cached
 * components remain detectable through import and re-export chains.
 */
export function prepareAppLayoutPropsForUseCache<T extends Record<string, unknown>>(
  component: unknown,
  props: T,
): T | (T & { $$isLayout: true }) {
  return isUseCacheFunction(component) ? { ...props, [APP_LAYOUT_MARKER]: true } : props;
}

export function isAppLayoutPropsForUseCache(value: unknown): value is Record<string, unknown> & {
  $$isLayout: true;
} {
  return (
    typeof value === "object" && value !== null && Reflect.get(value, APP_LAYOUT_MARKER) === true
  );
}

/**
 * Build the cache-key view of cached layout props while a PPR fallback shell
 * is being created or resumed. Only the params owned by the fallback segment
 * are provisional; known parent params still scope the cached layout.
 */
export function prepareAppLayoutPropsForFallbackCacheKey(
  props: Record<string, unknown> & { $$isLayout: true },
  fallbackParamNames: ReadonlySet<string>,
): Record<string, unknown> {
  const { $$isLayout: _marker, params, ...slots } = props;
  const knownParams: Record<string, unknown> = {};
  if (typeof params === "object" && params !== null) {
    for (const name of Object.keys(params)) {
      if (!fallbackParamNames.has(name)) {
        knownParams[name] = Reflect.get(params, name);
      }
    }
  }
  return { params: knownParams, ...slots };
}
