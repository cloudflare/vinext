/**
 * Code generation for the `virtual:vinext-cache-adapters` module.
 *
 * The vinext vite plugin resolves this virtual module from the user's `cache`
 * config (see {@link VinextCacheConfig}). The generated module exports a single
 * `registerConfiguredCacheAdapters(env)` function that the server entries call
 * on each request (it self-guards so the adapters are instantiated only once
 * per isolate). When no cache adapters are configured the function is a no-op,
 * so the import is always safe regardless of config.
 *
 * The descriptor `options` (e.g. `{ binding: "MY_KV" }`) are inlined into the
 * generated module and forwarded to the adapter factory at runtime, so a
 * config-time builder like `kvDataAdapter({ binding })` never has to touch the
 * Workers runtime — instantiation is fully deferred to the first request.
 *
 * Keeping the codegen here (pure config in → string out) makes it unit-testable
 * without spinning up a full Vite build.
 */

import type { CacheAdapterDescriptor, VinextCacheConfig } from "vinext/shims/cache-adapter";

export type { CacheAdapterDescriptor, VinextCacheConfig };
/** @deprecated Use {@link CacheAdapterDescriptor}. */
export type VinextCacheAdapterConfig = CacheAdapterDescriptor;

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
    "// Adapters are instantiated once per isolate; `env` is stable across",
    "// requests, and adapters read the per-request ExecutionContext lazily.",
    "let __vinextCacheAdaptersRegistered = false;",
    "",
    "export function registerConfiguredCacheAdapters(env) {",
    "  if (__vinextCacheAdaptersRegistered) return;",
    "  __vinextCacheAdaptersRegistered = true;",
  );
  if (data?.adapter) {
    lines.push(
      `  setDataCacheHandler(__vinextDataAdapterFactory({ env, options: ${inlineOptions(
        data.adapter,
        data.options,
      )} }));`,
    );
  }
  if (cdn?.adapter) {
    lines.push(
      `  setCdnCacheAdapter(__vinextCdnAdapterFactory({ env, options: ${inlineOptions(
        cdn.adapter,
        cdn.options,
      )} }));`,
    );
  }
  lines.push("}", "");

  return lines.join("\n");
}
