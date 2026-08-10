const USE_CACHE_FUNCTION_SYMBOL = Symbol.for("vinext.useCacheFunction");

export function markUseCacheFunction<T extends (...args: never[]) => unknown>(fn: T): T {
  Reflect.set(fn, USE_CACHE_FUNCTION_SYMBOL, true);
  return fn;
}

export function isUseCacheFunction(value: unknown): value is (...args: never[]) => unknown {
  return typeof value === "function" && Reflect.get(value, USE_CACHE_FUNCTION_SYMBOL) === true;
}
