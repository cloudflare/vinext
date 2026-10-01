const APP_PAGE_PROPS_CACHE_KEY_MARKER = Symbol.for("vinext.appPagePropsCacheKeyMarker");
// Set by cache-runtime.ts on every wrapper returned by registerCachedFunction.
const USE_CACHE_FUNCTION_SYMBOL = Symbol.for("vinext.useCacheFunction");
const SERVER_REFERENCE_TAG = Symbol.for("react.server.reference");
/**
 * Server reference ids of transformed cache functions end in the export name
 * the use-cache transform assigns (`secureExportName` in
 * plugins/use-cache-callable.ts): `$$vinext_cache_` plus an HMAC-SHA256 hex
 * digest. `"use server"` actions keep their own export names.
 */
const USE_CACHE_SERVER_REFERENCE_ID_RE = /#\$\$vinext_cache_[0-9a-f]{64}$/;

/**
 * Enumerable page marker, matching Next.js's `$$isPage` prop. It must be an
 * ordinary string key: React's createElement drops symbol and non-enumerable
 * props before a server component is invoked.
 */
export const APP_PAGE_USE_CACHE_MARKER = "$$isPage";
const APP_LAYOUT_USE_CACHE_MARKER = "$$isLayout";
// The enumerable marker survives React.createElement, while its private value
// retains a parallel slot with the same name until the cache wrapper admits it.
const layoutMarkerSlots = new WeakMap<object, [] | [unknown]>();

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
 * Whether `fn` is a transformed `"use cache"` function, including a bound
 * one. Like Next.js's `isUseCacheFunction`, this survives `.bind()`: React's
 * server-reference `bind` copies `$$typeof`/`$$id` to the bound function but
 * not vinext's own marker symbol.
 */
export function isUseCacheFunctionReference(fn: unknown): boolean {
  if (typeof fn !== "function") return false;
  if (Reflect.get(fn, USE_CACHE_FUNCTION_SYMBOL) === true) return true;
  const reference = fn as { $$typeof?: unknown; $$id?: unknown };
  return (
    reference.$$typeof === SERVER_REFERENCE_TAG &&
    typeof reference.$$id === "string" &&
    USE_CACHE_SERVER_REFERENCE_ID_RE.test(reference.$$id)
  );
}

/**
 * Add Next.js's `$$isPage` marker when `fn` is a `"use cache"` function
 * invoked as a page component or as a page's generateMetadata/generateViewport
 * (create-component-tree.tsx, resolve-metadata.ts `createSegmentProps`). The
 * cache wrapper reads and removes it, so page semantics follow the invocation
 * even when the cached function is defined in (or re-exported from) another
 * module, or bound.
 */
export function withUseCachePageMarker<T extends Record<string, unknown>>(
  fn: unknown,
  props: T,
): T {
  return isUseCacheFunctionReference(fn) ? { ...props, [APP_PAGE_USE_CACHE_MARKER]: true } : props;
}

/** Layout components and their metadata resolvers retain framework params too. */
export function withUseCacheLayoutMarker<T extends Record<string, unknown>>(
  fn: unknown,
  props: T,
): T {
  if (!isUseCacheFunctionReference(fn)) return props;
  const markedProps = { ...props };
  if (getLayoutMarkerSlot(markedProps[APP_LAYOUT_USE_CACHE_MARKER])) return props;
  const marker = {};
  layoutMarkerSlots.set(
    marker,
    Object.hasOwn(markedProps, APP_LAYOUT_USE_CACHE_MARKER)
      ? [markedProps[APP_LAYOUT_USE_CACHE_MARKER]]
      : [],
  );
  return Object.assign(markedProps, { [APP_LAYOUT_USE_CACHE_MARKER]: marker });
}

/**
 * Whether `value` is page props carrying the `$$isPage` marker. Only plain
 * objects qualify: the framework always passes a plain props object, and
 * reading the marker through a thenable params/searchParams proxy would be
 * observed as a param access.
 */
export function hasUseCachePageMarker(value: unknown): value is Record<string, unknown> {
  return (
    hasUseCacheSegmentMarker(value, APP_PAGE_USE_CACHE_MARKER) &&
    !getLayoutMarkerSlot(value[APP_LAYOUT_USE_CACHE_MARKER])
  );
}

export function hasUseCacheLayoutMarker(value: unknown): value is Record<string, unknown> {
  return hasUseCacheSegmentMarker(value, APP_LAYOUT_USE_CACHE_MARKER);
}

/** Remove only this invocation's marker before Flight keys and decodes props. */
export function withoutUseCacheSegmentMarker(
  props: Record<string, unknown>,
  isPage: boolean,
): Record<string, unknown> {
  const marker = isPage ? APP_PAGE_USE_CACHE_MARKER : APP_LAYOUT_USE_CACHE_MARKER;
  const originalSlot = isPage ? undefined : getLayoutMarkerSlot(props[marker]);
  if (isPage ? props[marker] !== true : originalSlot === undefined) return props;
  const segmentProps = { ...props };
  if (originalSlot?.length) segmentProps[marker] = originalSlot[0];
  else delete segmentProps[marker];
  // Keep the page probe's non-enumerable marker, which the spread drops.
  return isMarkedAppPagePropsObject(props)
    ? markAppPagePropsForUseCache(segmentProps)
    : segmentProps;
}

function getLayoutMarkerSlot(value: unknown): [] | [unknown] | undefined {
  return value !== null && typeof value === "object" ? layoutMarkerSlots.get(value) : undefined;
}

function hasUseCacheSegmentMarker(
  value: unknown,
  marker: string,
): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return (
    (prototype === Object.prototype || prototype === null) &&
    (marker === APP_LAYOUT_USE_CACHE_MARKER
      ? getLayoutMarkerSlot((value as Record<string, unknown>)[marker]) !== undefined
      : (value as Record<string, unknown>)[marker] === true)
  );
}
