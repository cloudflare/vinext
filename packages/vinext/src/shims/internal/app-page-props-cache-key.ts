const APP_PAGE_PROPS_CACHE_KEY_MARKER = Symbol.for("vinext.appPagePropsCacheKeyMarker");

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
