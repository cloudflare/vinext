const APP_PAGE_PROPS_CACHE_KEY_MARKER = Symbol.for("vinext.appPagePropsCacheKeyMarker");
// Set by cache-runtime.ts on every wrapper returned by registerCachedFunction.
const USE_CACHE_FUNCTION_SYMBOL = Symbol.for("vinext.useCacheFunction");

/**
 * Enumerable page marker, matching Next.js's `$$isPage` prop. It must be an
 * ordinary string key: React's createElement drops symbol and non-enumerable
 * props before a server component is invoked.
 */
export const APP_PAGE_USE_CACHE_MARKER = "$$isPage";

export function markAppPagePropsForUseCache<T extends object>(props: T): T {
  Object.defineProperty(props, APP_PAGE_PROPS_CACHE_KEY_MARKER, {
    configurable: false,
    enumerable: false,
    value: true,
    writable: false,
  });
  return props;
}

export function isMarkedAppPagePropsObject(value: object): boolean {
  return Reflect.get(value, APP_PAGE_PROPS_CACHE_KEY_MARKER) === true;
}

/**
 * Add Next.js's `$$isPage` marker when `fn` is a `"use cache"` function
 * invoked as a page component or as a page's generateMetadata/generateViewport
 * (create-component-tree.tsx, resolve-metadata.ts `createSegmentProps`). The
 * cache wrapper reads and removes it, so page semantics follow the invocation
 * even when the cached function is defined in (or re-exported from) another
 * module.
 */
export function withUseCachePageMarker<T extends Record<string, unknown>>(
  fn: unknown,
  props: T,
): T {
  return typeof fn === "function" && Reflect.get(fn, USE_CACHE_FUNCTION_SYMBOL) === true
    ? { ...props, [APP_PAGE_USE_CACHE_MARKER]: true }
    : props;
}

export function hasUseCachePageMarker(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>)[APP_PAGE_USE_CACHE_MARKER] === true
  );
}
