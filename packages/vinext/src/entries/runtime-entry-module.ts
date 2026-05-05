import fs from "node:fs";
import { fileURLToPath } from "node:url";

import type {
  NextHeader,
  NextI18nConfig,
  NextRedirect,
  NextRewrite,
} from "../config/next-config.js";

/**
 * Convert Windows-style backslash path separators to forward slashes.
 *
 * Generated entry modules embed absolute filesystem paths inside `import`
 * statements. On Windows the OS-native paths use `\` which is invalid in JS
 * module specifiers, so every entry generator normalizes paths through this
 * helper before stringifying them into the emitted code.
 */
export function normalizePathSeparators(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * Resolve a sibling module path relative to a caller's `import.meta.url`,
 * returning a forward-slash path safe for embedding in generated code.
 *
 * This is the single place that owns the
 * `fileURLToPath(new URL(rel, base))` + path-separator normalization idiom so
 * callers don't duplicate it.
 *
 * @param rel  - Relative path to the target module (e.g. `"../server/foo.js"`)
 * @param base - The caller's `import.meta.url`
 */
export function resolveEntryPath(rel: string, base: string): string {
  return normalizePathSeparators(fileURLToPath(new URL(rel, base)));
}

/**
 * Resolve a real runtime module for a virtual entry generator.
 *
 * During local development we want to point at source files (for example `.ts`),
 * while packed builds only contain emitted `.js` files in `dist/`. Probe the
 * common source/build extensions and fall back to the `.js` path that exists in
 * published packages.
 */
export function resolveRuntimeEntryModule(name: string): string {
  for (const ext of [".ts", ".js", ".mts", ".mjs"]) {
    const filePath = resolveEntryPath(`../server/${name}${ext}`, import.meta.url);
    if (fs.existsSync(filePath)) {
      return filePath;
    }
  }

  return resolveEntryPath(`../server/${name}.js`, import.meta.url);
}

/**
 * Subset of resolved Next config consumed by the entry-config serializers.
 *
 * Both Pages and App generators receive the same `ResolvedNextConfig` upstream
 * but only need a handful of routing/i18n/cache fields. Typing the helpers
 * against this minimal shape keeps `runtime-entry-module.ts` from depending on
 * the full `ResolvedNextConfig` import surface.
 */
type EntryConfigInput = {
  basePath?: string;
  trailingSlash?: boolean;
  redirects?: NextRedirect[];
  rewrites?: { beforeFiles: NextRewrite[]; afterFiles: NextRewrite[]; fallback: NextRewrite[] };
  headers?: NextHeader[];
  expireTime?: number;
  i18n?: NextI18nConfig | null;
  images?: {
    deviceSizes?: number[];
    imageSizes?: number[];
    dangerouslyAllowSVG?: boolean;
    contentDispositionType?: string;
    contentSecurityPolicy?: string;
  };
};

/**
 * Serialize the config bundle embedded in the Pages Router server entry.
 *
 * Returns two JSON literal strings ready to drop into the generated module:
 *   - `vinextConfigJson` — the full config snapshot exported as `vinextConfig`
 *     (basePath, trailingSlash, redirects/rewrites/headers, expireTime, i18n,
 *     images) so `prod-server.ts` can apply them without re-loading
 *     `next.config.js` at runtime.
 *   - `i18nConfigJson` — a narrower projection used directly by the SSR entry
 *     for locale detection (`null` when i18n is not configured).
 *
 * Centralizing this shape avoids duplicate `JSON.stringify` chains drifting
 * between entry generators.
 */
export function serializePagesConfig(nextConfig: EntryConfigInput | null | undefined): {
  vinextConfigJson: string;
  i18nConfigJson: string;
} {
  const i18nConfigJson = nextConfig?.i18n
    ? JSON.stringify({
        locales: nextConfig.i18n.locales,
        defaultLocale: nextConfig.i18n.defaultLocale,
        localeDetection: nextConfig.i18n.localeDetection,
        domains: nextConfig.i18n.domains,
      })
    : "null";

  const vinextConfigJson = JSON.stringify({
    basePath: nextConfig?.basePath ?? "",
    trailingSlash: nextConfig?.trailingSlash ?? false,
    redirects: nextConfig?.redirects ?? [],
    rewrites: nextConfig?.rewrites ?? { beforeFiles: [], afterFiles: [], fallback: [] },
    headers: nextConfig?.headers ?? [],
    expireTime: nextConfig?.expireTime,
    i18n: nextConfig?.i18n ?? null,
    images: {
      deviceSizes: nextConfig?.images?.deviceSizes,
      imageSizes: nextConfig?.images?.imageSizes,
      dangerouslyAllowSVG: nextConfig?.images?.dangerouslyAllowSVG,
      contentDispositionType: nextConfig?.images?.contentDispositionType,
      contentSecurityPolicy: nextConfig?.images?.contentSecurityPolicy,
    },
  });

  return { vinextConfigJson, i18nConfigJson };
}

/**
 * Serialize the per-field config literals embedded in the App Router RSC entry.
 *
 * Unlike Pages (which exports a single `vinextConfig` object), the RSC entry
 * embeds each field as its own top-level `const` so generated-code references
 * stay terse. This helper returns the JSON-stringified literal for each one,
 * applying the same defaults the RSC entry used inline before extraction.
 *
 * @param config       Resolved config slice (same shape Pages consumes).
 * @param defaultExpireTime  Fallback value for `expireTime`. The RSC entry uses
 *   `DEFAULT_EXPIRE_TIME = 31_536_000` from `app-rsc-entry.ts`; passing it in
 *   keeps the constant ownership unchanged.
 */
export function serializeAppConfig(
  config: EntryConfigInput | null | undefined,
  defaultExpireTime: number,
): {
  basePathJson: string;
  trailingSlashJson: string;
  i18nJson: string;
  redirectsJson: string;
  rewritesJson: string;
  headersJson: string;
  expireTimeJson: string;
} {
  return {
    basePathJson: JSON.stringify(config?.basePath ?? ""),
    trailingSlashJson: JSON.stringify(config?.trailingSlash ?? false),
    i18nJson: JSON.stringify(config?.i18n ?? null),
    redirectsJson: JSON.stringify(config?.redirects ?? []),
    rewritesJson: JSON.stringify(
      config?.rewrites ?? { beforeFiles: [], afterFiles: [], fallback: [] },
    ),
    headersJson: JSON.stringify(config?.headers ?? []),
    expireTimeJson: JSON.stringify(config?.expireTime ?? defaultExpireTime),
  };
}

/**
 * Generate the four ISR forwarder functions that wrap the shared `isr-cache`
 * helpers in a Pages/App server entry.
 *
 * The wrappers exist so the rest of the generated module can call short,
 * stable names (`isrGet`, `isrSet`, `isrCacheKey`,
 * `triggerBackgroundRegeneration`) regardless of how the underlying module
 * exposes them, and so the cache-key helper can close over the build ID
 * without every call site repeating it.
 *
 * Assumes the surrounding entry has already imported the `__shared*` symbols
 * from `isr-cache.js` (under those exact aliases) and declared a `buildId`
 * binding in scope.
 */
export function generateIsrWrapperCode(): string {
  return `function isrGet(key) {
  return __sharedIsrGet(key);
}
function isrSet(key, data, revalidateSeconds, tags, expireSeconds) {
  return __sharedIsrSet(key, data, revalidateSeconds, tags, expireSeconds);
}
function triggerBackgroundRegeneration(key, renderFn, errorContext) {
  return __sharedTriggerBackgroundRegeneration(key, renderFn, errorContext);
}
function isrCacheKey(router, pathname) {
  return __sharedIsrCacheKey(router, pathname, buildId || undefined);
}`;
}
