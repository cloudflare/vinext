/**
 * Code generation for the `virtual:vinext-cache-adapters` module, resolved by
 * the vinext vite plugin from the user's `cache` config ({@link VinextCacheConfig}).
 *
 * The generated module exports `registerConfiguredCacheAdapters(env)`, which the
 * server entries call on each request. It self-guards (adapters instantiate once
 * per isolate) and is a no-op when nothing is configured. Registration is
 * resilient: a factory that throws (e.g. a KV adapter on the Node.js server,
 * where the binding can't exist) is logged and skipped rather than failing every
 * request, so the same config can be registered from every runtime/router entry.
 *
 * Descriptor `options` are inlined into the generated module and forwarded to the
 * factory at runtime, so a config-time builder like `kvDataAdapter({ binding })`
 * never touches the Workers runtime — instantiation is deferred to the first
 * request.
 */

/**
 * A serializable pointer to a cache adapter module — the shape of each `cache`
 * slot in the vinext() plugin config. Produced by an adapter builder (e.g.
 * `kvDataAdapter(...)` from `vinext/cloudflare/cache/kv-data-adapter`) or written
 * by hand. `options` must be JSON-serializable: it is inlined into the generated
 * registration module and forwarded to the adapter factory at runtime.
 */
export type CacheAdapterDescriptor<O extends Record<string, unknown> = Record<string, unknown>> = {
  /**
   * Module specifier (or absolute path, e.g. from `require.resolve(...)`) whose
   * default export is a cache adapter factory.
   */
  adapter: string;
  /** JSON-serializable options forwarded to the factory at runtime. */
  options?: O;
};

/**
 * The `cache` option of the vinext() plugin: declaratively register cache
 * handlers instead of calling `setDataCacheHandler()` / `setCdnCacheAdapter()`
 * from a worker entry.
 */
export type VinextCacheConfig = {
  /** Page-level ISR serving strategy (CDN cache adapter). */
  cdn?: CacheAdapterDescriptor;
  /** Data cache (fetch / `"use cache"` / `unstable_cache`) handler. */
  data?: CacheAdapterDescriptor;
};

/** Public virtual module id imported by the server entries. */
export const VIRTUAL_CACHE_ADAPTERS = "virtual:vinext-cache-adapters";

/**
 * Serialize descriptor options into a JS expression for inlining. Plain JSON is
 * a valid JS literal; `undefined` when there are no options. Throws a clear
 * config-time error (not a runtime one) if options are not serializable.
 */
function inlineOptions(adapter: string, options: Record<string, unknown> | undefined): string {
  if (options === undefined) return "undefined";
  try {
    return JSON.stringify(options);
  } catch (cause) {
    throw new Error(`[vinext] cache adapter "${adapter}" options must be JSON-serializable.`, {
      cause,
    });
  }
}

/**
 * Generate the source of the `virtual:vinext-cache-adapters` module for the
 * given config. Always exports `registerConfiguredCacheAdapters(env)`.
 */
export function generateCacheAdaptersModule(cache?: VinextCacheConfig): string {
  const data = cache?.data;
  const cdn = cache?.cdn;

  // Nothing configured → a no-op so the unconditional import in the server
  // entries stays valid and tree-shakes to almost nothing.
  if (!data?.adapter && !cdn?.adapter) {
    return [
      "// vinext: no cache.cdn/cache.data adapter configured — registration is a no-op.",
      "export function registerConfiguredCacheAdapters() {}",
      "",
    ].join("\n");
  }

  const lines: string[] = [
    "// vinext: generated from the `cache` option in your vinext() plugin config.",
  ];

  if (data?.adapter) {
    lines.push(`import __vinextDataAdapterFactory from ${JSON.stringify(data.adapter)};`);
    lines.push(`import { setDataCacheHandler } from "vinext/shims/cache";`);
  }
  if (cdn?.adapter) {
    lines.push(`import __vinextCdnAdapterFactory from ${JSON.stringify(cdn.adapter)};`);
    lines.push(`import { setCdnCacheAdapter } from "vinext/shims/cdn-cache";`);
  }

  lines.push(
    "",
    "// A factory that throws (e.g. a missing binding on an incompatible runtime)",
    "// is logged and skipped so the default handler stays in place.",
    "let __vinextCacheAdaptersRegistered = false;",
    "",
    "export function registerConfiguredCacheAdapters(env) {",
    "  if (__vinextCacheAdaptersRegistered) return;",
    "  __vinextCacheAdaptersRegistered = true;",
  );
  if (data?.adapter) {
    lines.push(
      "  try {",
      `    setDataCacheHandler(__vinextDataAdapterFactory({ env, options: ${inlineOptions(
        data.adapter,
        data.options,
      )} }));`,
      "  } catch (error) {",
      '    console.warn("[vinext] failed to initialize the configured data cache adapter; ' +
        'using the default handler.", error);',
      "  }",
    );
  }
  if (cdn?.adapter) {
    lines.push(
      "  try {",
      `    setCdnCacheAdapter(__vinextCdnAdapterFactory({ env, options: ${inlineOptions(
        cdn.adapter,
        cdn.options,
      )} }));`,
      "  } catch (error) {",
      '    console.warn("[vinext] failed to initialize the configured CDN cache adapter; ' +
        'using the default adapter.", error);',
      "  }",
    );
  }
  lines.push("}", "");

  return lines.join("\n");
}
