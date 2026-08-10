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
