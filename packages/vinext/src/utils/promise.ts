export function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return Boolean(
    value &&
    (typeof value === "object" || typeof value === "function") &&
    "then" in value &&
    typeof value.then === "function",
  );
}

/**
 * Apply `fn` to `value`, or to its resolution when it is a promise, keeping
 * synchronous values synchronous.
 */
export function mapMaybePromise<T, R>(value: T | Promise<T>, fn: (value: T) => R): R | Promise<R> {
  return value instanceof Promise ? value.then(fn) : fn(value);
}
