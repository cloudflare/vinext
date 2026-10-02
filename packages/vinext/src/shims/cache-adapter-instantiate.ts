/**
 * Instantiate a declaratively configured cache adapter from its module's
 * default export. Both accepted shapes receive the same `{ env, options }`
 * argument, so a factory `(args) => adapter` and a class `new Adapter(args)`
 * are interchangeable.
 */
export type CacheAdapterFactoryArgs = { env: unknown; options: unknown };

const CLASS_SOURCE_RE = /^class[\s{]/;

export function instantiateCacheAdapter<T>(
  exported: unknown,
  args: CacheAdapterFactoryArgs,
  kind: "data" | "CDN",
): T {
  if (typeof exported !== "function") {
    throw new Error(
      `the ${kind} cache adapter module must have a default export that is a factory function or a class, got ${
        exported === null ? "null" : typeof exported
      }`,
    );
  }
  if (CLASS_SOURCE_RE.test(Function.prototype.toString.call(exported))) {
    return new (exported as new (args: CacheAdapterFactoryArgs) => T)(args);
  }
  return (exported as (args: CacheAdapterFactoryArgs) => T)(args);
}
