/**
 * Code generation for the `virtual:vinext-cache-adapters` module, resolved by
 * the vinext vite plugin from the user's `cache` config ({@link VinextCacheConfig}).
 *
 * The generated module exports `registerConfiguredCacheAdapters(env)`, which the
 * server entries call on each request. It self-guards (adapters instantiate once
 * per isolate) and clears adapters from an earlier hot-reloaded config when a
 * slot is no longer configured. Registration is resilient: a factory that throws
 * (e.g. a KV adapter on the Node.js server, where the binding can't exist) is
 * logged and skipped rather than failing every request, so the same config can be
 * registered from every runtime/router entry.
 *
 * Descriptor `options` are inlined into the generated module and forwarded to the
 * factory at runtime, so a config-time builder like `kvDataAdapter({ binding })`
 * never touches the Workers runtime — instantiation is deferred to the first
 * request.
 */
import { flattenPluginOptions } from "../utils/plugin-options.js";

/**
 * A serializable pointer to a cache adapter module — the shape of each `cache`
 * slot in the vinext() plugin config. Produced by an adapter builder (e.g.
 * `kvDataAdapter(...)` from `@vinext/cloudflare/cache/kv-data-adapter`) or written
 * by hand. `options` must be JSON-serializable: it is inlined into the generated
 * registration module and forwarded to the adapter factory at runtime.
 */
export type CdnCacheAdapterCapabilities = {
  /**
   * The shared cache stores and selects response variants using every request
   * header named by the response's `Vary` value, comparing values verbatim.
   *
   * When this guarantee is present, RSC requests can keep one stable URL and
   * let `Vary` own semantic request variants. Without it, vinext retains the
   * header digest in `_rsc` for caches that key only by URL.
   */
  responseVary?: "verbatim";
  /**
   * Additional response `Vary` fields that the adapter controls and its
   * deploy-time warmer reproduces. These fields are admitted when deciding
   * whether a prerendered response can be safely prewarmed.
   */
  controlledResponseVaryHeaders?: readonly string[];
};

export type CacheAdapterDescriptor<O extends Record<string, unknown> = Record<string, unknown>> = {
  /**
   * Module specifier (or absolute path, e.g. from `require.resolve(...)`) whose
   * default export is a cache adapter factory.
   */
  adapter: string;
  /** JSON-serializable options forwarded to the factory at runtime. */
  options?: O;
  /** Build-time cache semantics used by shared client/server protocol code. */
  capabilities?: CdnCacheAdapterCapabilities;
};

export type RscCacheKeyMode = "header-digest" | "response-vary";

function assertProtocolCapabilitiesHaveAdapter(cache?: VinextCacheConfig | null): void {
  const cdn = cache?.cdn;
  const affectsProtocol =
    cdn?.capabilities?.responseVary === "verbatim" ||
    (cdn?.capabilities?.controlledResponseVaryHeaders?.length ?? 0) > 0;
  if (affectsProtocol && (typeof cdn?.adapter !== "string" || cdn.adapter.trim() === "")) {
    throw new Error(
      "[vinext] cache.cdn capabilities that affect request identity require a configured adapter.",
    );
  }
}

export function resolveRscCacheKeyMode(cache?: VinextCacheConfig | null): RscCacheKeyMode {
  assertProtocolCapabilitiesHaveAdapter(cache);
  return cache?.cdn?.capabilities?.responseVary === "verbatim" ? "response-vary" : "header-digest";
}

const HTTP_FIELD_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

export function resolveControlledResponseVaryHeaders(cache?: VinextCacheConfig | null): string[] {
  assertProtocolCapabilitiesHaveAdapter(cache);
  const headers = cache?.cdn?.capabilities?.controlledResponseVaryHeaders;
  if (!headers) return [];

  const result: string[] = [];
  const seen = new Set<string>();
  for (const header of headers) {
    if (typeof header !== "string") continue;
    const normalized = header.trim();
    const key = normalized.toLowerCase();
    if (!HTTP_FIELD_NAME.test(normalized) || seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

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

// Custom metadata key attached to vinext's config plugin so deploy commands can
// inspect the normalized cache descriptors after loading the user's Vite config.
export const VINEXT_CACHE_CONFIG_PLUGIN_PROPERTY = "__vinextCacheConfig";

type VinextCacheConfigPlugin = {
  [VINEXT_CACHE_CONFIG_PLUGIN_PROPERTY]?: VinextCacheConfig | null;
};

type ViteConfigLoader = {
  loadConfigFromFile: typeof import("vite").loadConfigFromFile;
};

export async function findVinextCacheConfigInPlugins(
  plugins: import("vite").PluginOption[] | undefined,
): Promise<VinextCacheConfig | null> {
  const flattened = await flattenPluginOptions(plugins);

  for (const plugin of flattened) {
    if (!plugin || typeof plugin !== "object") continue;
    const cacheConfig = (plugin as VinextCacheConfigPlugin)[VINEXT_CACHE_CONFIG_PLUGIN_PROPERTY];
    if (cacheConfig) return cacheConfig;
  }

  return null;
}

export async function loadVinextCacheConfigFromViteConfig(
  vite: ViteConfigLoader,
  root: string,
): Promise<VinextCacheConfig | null> {
  const loaded = await vite.loadConfigFromFile(
    { command: "build", mode: "production" },
    undefined,
    root,
  );
  return await findVinextCacheConfigInPlugins(loaded?.config.plugins);
}

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
export function generateCacheAdaptersModule(cache?: VinextCacheConfig, hotReload = false): string {
  const data = cache?.data;
  const cdn = cache?.cdn;
  assertProtocolCapabilitiesHaveAdapter(cache);
  const cdnCapabilitiesAffectProtocol =
    cdn?.capabilities?.responseVary === "verbatim" ||
    resolveControlledResponseVaryHeaders(cache).length > 0;

  // Keep the unconfigured production path at its historical zero-cost shape.
  // Dev emits lifecycle state so removing an adapter from vite.config during
  // HMR can clear the previously registered global instance.
  if (!data?.adapter && !cdn?.adapter && !hotReload) {
    return [
      "// vinext: no cache.cdn/cache.data adapter configured — registration is a no-op.",
      "export function registerConfiguredCacheAdapters() {}",
      "",
    ].join("\n");
  }

  const lines: string[] = [
    "// vinext: generated from the `cache` option in your vinext() plugin config.",
  ];
  const dataOptions = data?.adapter ? inlineOptions(data.adapter, data.options) : "undefined";
  const cdnOptions = cdn?.adapter ? inlineOptions(cdn.adapter, cdn.options) : "undefined";
  const registrationId = JSON.stringify([
    data?.adapter ?? null,
    dataOptions,
    cdn?.adapter ?? null,
    cdnOptions,
  ]);

  if (data?.adapter) {
    lines.push(`import __vinextDataAdapterFactory from ${JSON.stringify(data.adapter)};`);
  }
  if (cdn?.adapter) {
    lines.push(`import __vinextCdnAdapterFactory from ${JSON.stringify(cdn.adapter)};`);
  }
  lines.push(
    `import { resetDataCacheHandler${data?.adapter ? ", setDataCacheHandler" : ""} } from "vinext/shims/cache-handler";`,
    `import { resetCdnCacheAdapter${cdn?.adapter ? ", setCdnCacheAdapter" : ""} } from "vinext/shims/cdn-cache";`,
  );

  lines.push(
    "",
    "// A factory that throws (e.g. a missing binding on an incompatible runtime)",
    "// is logged and skipped so the default handler stays in place.",
    "function __vinextFormatAdapterError(error) {",
    "  if (error instanceof Error && error.message) return error.message;",
    "  try {",
    "    return String(error);",
    "  } catch {",
    "    return '<unknown error>';",
    "  }",
    "}",
    "",
    "// Adapter ownership and HMR generation are shared across Vite environments.",
    'const __vinextCacheAdaptersRegistrationKey = Symbol.for("vinext.cacheAdaptersRegistrationState");',
    `const __vinextCacheAdaptersRegistrationId = ${JSON.stringify(registrationId)};`,
    "const __vinextCacheAdaptersGlobal = globalThis;",
    "const __vinextExistingCacheAdaptersState = __vinextCacheAdaptersGlobal[__vinextCacheAdaptersRegistrationKey];",
    "const __vinextCacheAdaptersState = __vinextExistingCacheAdaptersState?.version === 1",
    "  ? __vinextExistingCacheAdaptersState",
    "  : (__vinextCacheAdaptersGlobal[__vinextCacheAdaptersRegistrationKey] = {",
    "      version: 1, epoch: 0, registrationId: null, dataConfigured: false, cdnConfigured: false,",
    "    });",
    "const __vinextCacheAdaptersModuleEpoch = __vinextCacheAdaptersState.epoch;",
    "if (import.meta.hot) {",
    "  import.meta.hot.accept();",
    "  import.meta.hot.dispose(() => {",
    "    if (__vinextCacheAdaptersState.epoch === __vinextCacheAdaptersModuleEpoch) {",
    "      __vinextCacheAdaptersState.epoch += 1;",
    "      __vinextCacheAdaptersState.registrationId = null;",
    "    }",
    "  });",
    "}",
    "",
    "export function registerConfiguredCacheAdapters(env) {",
    "  if (typeof process !== 'undefined' && process.env?.__VINEXT_PRERENDER_PATH_DISCOVERY === '1') return;",
    "  if (__vinextCacheAdaptersModuleEpoch !== __vinextCacheAdaptersState.epoch) return;",
    "  if (__vinextCacheAdaptersState.registrationId === __vinextCacheAdaptersRegistrationId) return;",
    `  if (__vinextCacheAdaptersState.dataConfigured && ${data?.adapter ? "false" : "true"}) resetDataCacheHandler();`,
    `  if (__vinextCacheAdaptersState.cdnConfigured && ${cdn?.adapter ? "false" : "true"}) resetCdnCacheAdapter();`,
    "  let __vinextDataConfigured = false;",
    "  let __vinextCdnConfigured = false;",
  );
  if (data?.adapter) {
    lines.push(
      "  try {",
      `    setDataCacheHandler(__vinextDataAdapterFactory({ env, options: ${dataOptions} }));`,
      "    __vinextDataConfigured = true;",
      "  } catch (error) {",
      "    resetDataCacheHandler();",
      '    console.warn("[vinext] failed to initialize the configured data cache adapter; ' +
        'using the default handler.\\n" + __vinextFormatAdapterError(error));',
      "  }",
    );
  }
  if (cdn?.adapter) {
    lines.push(
      "  try {",
      `    setCdnCacheAdapter(__vinextCdnAdapterFactory({ env, options: ${cdnOptions} }));`,
      "    __vinextCdnConfigured = true;",
      "  } catch (error) {",
      "    resetCdnCacheAdapter();",
    );
    if (cdnCapabilitiesAffectProtocol) {
      lines.push(
        "    // Browser/server request identity was compiled against this adapter's",
        "    // declared capabilities. The generic adapter cannot safely replace it.",
        "    if (__vinextDataConfigured || __vinextCacheAdaptersState.dataConfigured) resetDataCacheHandler();",
        "    __vinextCacheAdaptersState.registrationId = null;",
        "    __vinextCacheAdaptersState.dataConfigured = false;",
        "    __vinextCacheAdaptersState.cdnConfigured = false;",
        '    throw new Error("[vinext] failed to initialize the configured CDN cache adapter; ' +
          'the declared cache capabilities require it.\\n" + __vinextFormatAdapterError(error), { cause: error });',
      );
    } else {
      lines.push(
        '    console.warn("[vinext] failed to initialize the configured CDN cache adapter; ' +
          'using the default adapter.\\n" + __vinextFormatAdapterError(error));',
      );
    }
    lines.push("  }");
  }
  lines.push(
    "  __vinextCacheAdaptersState.dataConfigured = __vinextDataConfigured;",
    "  __vinextCacheAdaptersState.cdnConfigured = __vinextCdnConfigured;",
    "  __vinextCacheAdaptersState.registrationId = __vinextCacheAdaptersRegistrationId;",
    "}",
    "",
  );

  return lines.join("\n");
}
