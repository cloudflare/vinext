import path from "node:path";

/**
 * Public next/* module shims — maps import specifier to filename relative to shimsDir.
 * These are the user-facing modules that app code imports.
 */
export const PUBLIC_SHIMS: Record<string, string> = {
  "next/link": "link",
  "next/head": "head",
  "next/router": "router",
  "next/compat/router": "compat-router",
  "next/image": "image",
  "next/legacy/image": "legacy-image",
  "next/dynamic": "dynamic",
  "next/app": "app",
  "next/document": "document",
  "next/config": "config",
  "next/script": "script",
  "next/server": "server",
  "next/navigation": "navigation",
  "next/headers": "headers",
  "next/font/google": "font-google",
  "next/font/local": "font-local",
  "next/cache": "cache",
  "next/form": "form",
  "next/og": "og",
  "next/web-vitals": "web-vitals",
  "next/amp": "amp",
  "next/error": "error",
  "next/constants": "constants",
};

/**
 * Internal next/dist/* paths used by popular libraries.
 * Maps import specifier to filename relative to shimsDir.
 */
export const INTERNAL_SHIMS: Record<string, string> = {
  "next/dist/shared/lib/app-router-context.shared-runtime": "internal/app-router-context",
  "next/dist/shared/lib/app-router-context": "internal/app-router-context",
  "next/dist/shared/lib/router-context.shared-runtime": "internal/router-context",
  "next/dist/shared/lib/utils": "internal/utils",
  "next/dist/server/api-utils": "internal/api-utils",
  "next/dist/server/web/spec-extension/cookies": "internal/cookies",
  "next/dist/compiled/@edge-runtime/cookies": "internal/cookies",
  "next/dist/server/app-render/work-unit-async-storage.external":
    "internal/work-unit-async-storage",
  "next/dist/client/components/work-unit-async-storage.external":
    "internal/work-unit-async-storage",
  "next/dist/client/components/request-async-storage.external": "internal/work-unit-async-storage",
  "next/dist/client/components/request-async-storage": "internal/work-unit-async-storage",
  "next/dist/client/components/navigation": "navigation",
  "next/dist/server/config-shared": "internal/utils",
};

/**
 * Non-next-prefixed shim entries resolved from shimsDir.
 * Includes server-only/client-only markers and vinext internal modules.
 */
export const VINEXT_SHIMS_DIR_ENTRIES: Record<string, string> = {
  "server-only": "server-only",
  "client-only": "client-only",
  "vinext/error-boundary": "error-boundary",
  "vinext/layout-segment-context": "layout-segment-context",
  "vinext/metadata": "metadata",
  "vinext/fetch-cache": "fetch-cache",
  "vinext/cache-runtime": "cache-runtime",
  "vinext/navigation-state": "navigation-state",
  "vinext/router-state": "router-state",
  "vinext/head-state": "head-state",
};

/**
 * vinext server entries resolved from srcDir (NOT shimsDir).
 * These use path.resolve instead of path.join with shimsDir.
 */
export const VINEXT_SERVER_ENTRIES: Record<string, string> = {
  "vinext/instrumentation": "server/instrumentation",
  "vinext/html": "server/html",
};

/**
 * Build the complete shim alias map with absolute paths.
 *
 * @param shimsDir - Absolute path to the shims directory
 * @param srcDir - Absolute path to the src directory (for server entries)
 * @param userAliases - User-provided aliases from nextConfig (applied first, overridden by vinext)
 */
export function buildShimMap(
  shimsDir: string,
  srcDir: string,
  userAliases?: Record<string, string>,
): Record<string, string> {
  const map: Record<string, string> = { ...userAliases };

  // Public shims (shimsDir-based)
  for (const [key, value] of Object.entries(PUBLIC_SHIMS)) {
    map[key] = path.join(shimsDir, value);
  }

  // Internal shims (shimsDir-based)
  for (const [key, value] of Object.entries(INTERNAL_SHIMS)) {
    map[key] = path.join(shimsDir, value);
  }

  // Vinext shimsDir entries
  for (const [key, value] of Object.entries(VINEXT_SHIMS_DIR_ENTRIES)) {
    map[key] = path.join(shimsDir, value);
  }

  // Vinext server entries (srcDir-based)
  for (const [key, value] of Object.entries(VINEXT_SERVER_ENTRIES)) {
    map[key] = path.resolve(srcDir, value);
  }

  return map;
}
