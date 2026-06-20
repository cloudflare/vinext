import type { UserConfig } from "vite";

type ClientAssetFileNameInfo = {
  readonly name?: string;
  readonly names?: readonly string[];
  readonly originalFileName?: string;
  readonly originalFileNames?: readonly string[];
};

type RscFrameworkModuleInfo = {
  importers: string[];
  isEntry: boolean;
};

type RscFrameworkManualChunksMeta = {
  getModuleInfo(id: string): RscFrameworkModuleInfo | null;
};

const ROUTE_OWNED_CLIENT_SHIMS = new Set([
  "compat-router",
  "dynamic",
  "dynamic-preload-chunks",
  "form",
  "image",
  "layout-segment-context",
  "legacy-image",
  "link",
  "offline",
  "router",
  "script",
  "web-vitals",
]);

// Next.js emits CSS under `static/css/` and CSS url() dependencies (images,
// fonts, …) under `static/media/`, both with an 8-char content hash. Mirror
// that layout so migrated apps keep stable, Next-shaped asset URLs.
const NEXT_CLIENT_CSS_ASSET_FILE_NAMES = "css/[name].[hash:8][extname]";
const NEXT_CLIENT_STATIC_MEDIA_FILE_NAMES = "media/[name].[hash:8][extname]";

function joinAssetFileNamePattern(assetsDir: string, pattern: string): string {
  // Strip trailing slashes without a regex (avoids a needless ReDoS lint flag;
  // `assetsDir` is build-time config, but a plain loop is clearer and linear).
  let end = assetsDir.length;
  while (end > 0 && assetsDir[end - 1] === "/") end -= 1;
  const normalized = assetsDir.slice(0, end);
  return normalized ? `${normalized}/${pattern}` : pattern;
}

/**
 * Routes client assets into Next-compatible subtrees: `.css` sources go to
 * `<assetsDir>/css/`, everything else to `<assetsDir>/media/`. Returned as a
 * function so it can inspect every source-name candidate Rolldown records for
 * an asset (a single output asset can carry several `originalFileNames`).
 */
export function createClientAssetFileNames(assetsDir: string) {
  const cssAssetFileNames = joinAssetFileNamePattern(assetsDir, NEXT_CLIENT_CSS_ASSET_FILE_NAMES);
  const mediaAssetFileNames = joinAssetFileNamePattern(
    assetsDir,
    NEXT_CLIENT_STATIC_MEDIA_FILE_NAMES,
  );

  return function getClientAssetFileNames(assetInfo: ClientAssetFileNameInfo): string {
    const candidates = [
      ...(assetInfo.names ?? []),
      assetInfo.name,
      ...(assetInfo.originalFileNames ?? []),
      assetInfo.originalFileName,
    ];
    const isCss = candidates.some((name) => name?.toLowerCase().endsWith(".css"));
    return isCss ? cssAssetFileNames : mediaAssetFileNames;
  };
}

/**
 * Extract the npm package name from a module ID (file path).
 * Returns null if not in node_modules.
 *
 * Handles scoped packages (@org/pkg) and pnpm-style paths
 * (node_modules/.pnpm/pkg@ver/node_modules/pkg).
 */
function getPackageName(id: string): string | null {
  const normalizedId = id.replaceAll("\\", "/");
  const nmIdx = normalizedId.lastIndexOf("node_modules/");
  if (nmIdx === -1) return null;
  const rest = normalizedId.slice(nmIdx + "node_modules/".length);
  if (rest.startsWith("@")) {
    // Scoped package: @org/pkg
    const parts = rest.split("/");
    return parts.length >= 2 ? parts[0] + "/" + parts[1] : null;
  }
  return rest.split("/")[0] || null;
}

/**
 * Create a manualChunks function for client builds.
 *
 * Splits the client bundle into:
 * - "framework" — React, ReactDOM, and scheduler (loaded on every page)
 * - "vinext"    — shared vinext runtime shims
 *
 * Route-owned client shims and all other vendor code are left to the bundler's
 * graph-based chunking so they stay behind their client-reference boundaries.
 *
 * Why not split every npm package into its own chunk?
 * - Per-package splitting (`vendor-X`) creates 50-200+ chunks for a
 *   typical app, far exceeding the ~25-request sweet spot for HTTP/2.
 * - gzip/brotli compress small files poorly — each file restarts with
 *   an empty dictionary, losing ~5-15% total compressed size vs fewer
 *   larger chunks (Khan Academy measured +2.5% wire size with 10x
 *   more files containing less raw code).
 * - ES module evaluation has per-module overhead that compounds on
 *   mobile devices.
 * - No major Vite-based framework (Remix, SvelteKit, Astro, TanStack)
 *   uses per-package splitting. Next.js only isolates packages >160KB.
 * - Rollup's graph-based splitting already handles the common case
 *   well: shared dependencies between routes get their own chunks,
 *   and route-specific code stays in route chunks.
 */
export function createClientManualChunks(shimsDir: string, preserveRouteBoundaries = false) {
  return function clientManualChunks(id: string): string | undefined {
    // React framework — always loaded, shared across all pages.
    // Isolating React into its own chunk is the single highest-value
    // split: it's ~130KB compressed, loaded on every page, and its
    // content hash rarely changes between deploys.
    if (id.includes("node_modules")) {
      const pkg = getPackageName(id);
      if (!pkg) return undefined;
      if (pkg === "react" || pkg === "react-dom" || pkg === "scheduler") {
        return "framework";
      }
      // Let Rollup handle all other vendor code via its default
      // graph-based splitting. This produces a reasonable number of
      // shared chunks (typically 5-15) based on actual import patterns,
      // with good compression efficiency.
      return undefined;
    }

    if (id.startsWith(shimsDir)) {
      if (preserveRouteBoundaries) {
        const relativeId = id.slice(shimsDir.length).split("?", 1)[0] ?? "";
        const extensionIndex = relativeId.lastIndexOf(".");
        const shimName = extensionIndex === -1 ? relativeId : relativeId.slice(0, extensionIndex);
        if (ROUTE_OWNED_CLIENT_SHIMS.has(shimName)) return undefined;
      }
      return "vinext";
    }

    return undefined;
  };
}

/**
 * Rollup output config with manualChunks for client code-splitting.
 * Used by both CLI builds and multi-environment builds.
 *
 * experimentalMinChunkSize merges tiny shared chunks (< 10KB) back into
 * their importers. This reduces HTTP request count and improves gzip
 * compression efficiency — small files restart the compression dictionary,
 * adding ~5-15% wire overhead vs fewer larger chunks.
 */
export function createClientFileNameConfig(assetsDir: string) {
  const chunksDir = `${assetsDir}/chunks`;
  return {
    entryFileNames: `${chunksDir}/[name]-[hash].js`,
    chunkFileNames: `${chunksDir}/[name]-[hash].js`,
  };
}

export function createClientOutputConfig(
  clientManualChunks: (id: string) => string | undefined,
  assetsDir: string,
) {
  return {
    ...createClientFileNameConfig(assetsDir),
    assetFileNames: createClientAssetFileNames(assetsDir),
    manualChunks: clientManualChunks,
    experimentalMinChunkSize: 10_000,
  };
}

export function createClientCodeSplittingConfig(
  clientManualChunks: (id: string) => string | undefined,
) {
  return {
    minSize: 10_000,
    groups: [
      {
        name(moduleId: string) {
          return clientManualChunks(moduleId) ?? null;
        },
      },
    ],
  };
}

/**
 * Matches React framework packages (and the RSC flight runtime) inside
 * `node_modules`. Used to split them into a dedicated "framework" chunk in the
 * RSC server build.
 *
 * Why the RSC build needs this: without an explicit framework chunk, the
 * bundler colocates React into whichever chunk first reaches it — typically the
 * RSC entry chunk, which also carries the root layout's CSS. Modules that only
 * import React for runtime helpers (notably `app/global-not-found.tsx`, which
 * replaces the root layout for route-miss 404s) then import that entry chunk
 * and inherit the root layout's CSS in their `serverResources` metadata. The
 * 404 document ends up linking the layout's stylesheet last, so the layout's
 * rules win the cascade over global-not-found's — the bug tracked in
 * https://github.com/cloudflare/vinext/issues/1549.
 *
 * Splitting React into its own (CSS-free) chunk means global-not-found imports
 * the framework chunk instead of the layout-bearing entry chunk, so it no
 * longer inherits the root layout's CSS. The match list mirrors the client
 * build's `framework` chunk, plus `react-server-dom-webpack` for the RSC flight
 * runtime that the server environment bundles.
 *
 * Uses `[\\/]` rather than `/` for the path separator so it matches on Windows
 * too, per the rolldown `codeSplitting` docs.
 */
const FRAMEWORK_PACKAGES = ["react", "react-dom", "scheduler", "react-server-dom-webpack"] as const;

/**
 * Regex matching any {@link FRAMEWORK_PACKAGES} package inside `node_modules`.
 * Derived from the package list so the regex and {@link isRscFrameworkModule}
 * predicate can't drift.
 */
export const RSC_FRAMEWORK_CHUNK_TEST = new RegExp(
  `[\\\\/]node_modules[\\\\/](${FRAMEWORK_PACKAGES.join("|")})[\\\\/]`,
);

export function isRscFrameworkModule(id: string): boolean {
  if (!id.includes("node_modules")) return false;
  const pkg = getPackageName(id);
  return pkg !== null && (FRAMEWORK_PACKAGES as readonly string[]).includes(pkg);
}

function isStaticallyReachableFromEntry(
  id: string,
  meta: RscFrameworkManualChunksMeta,
  visited = new Set<string>(),
): boolean {
  if (visited.has(id)) return false;
  visited.add(id);

  const moduleInfo = meta.getModuleInfo(id);
  if (!moduleInfo) return false;
  if (moduleInfo.isEntry) return true;
  return moduleInfo.importers.some((importer) =>
    isStaticallyReachableFromEntry(importer, meta, visited),
  );
}

/**
 * Output config that isolates React (and the RSC flight runtime) into a
 * dedicated "framework" chunk in the RSC server build. Returns the bundler-
 * appropriate shape: rolldown's `codeSplitting` for Vite 8+, Rollup's
 * `manualChunks` for Vite 7. See {@link RSC_FRAMEWORK_CHUNK_TEST} for the
 * motivation (issue #1549). Framework modules that are only reachable through
 * dynamic imports must stay out of the eager framework chunk (issue #2073).
 */
export function createRscFrameworkChunkOutputConfig(viteMajorVersion: number) {
  if (viteMajorVersion >= 8) {
    return {
      codeSplitting: {
        groups: [
          {
            name: "framework",
            test: RSC_FRAMEWORK_CHUNK_TEST,
            // Split by the entries that use each module so lazy framework
            // imports cannot become eager Worker-startup dependencies (#2073).
            entriesAware: true,
          },
        ],
      },
    };
  }
  return {
    manualChunks(id: string, meta: RscFrameworkManualChunksMeta): string | undefined {
      return isRscFrameworkModule(id) && isStaticallyReachableFromEntry(id, meta)
        ? "framework"
        : undefined;
    },
  };
}

/**
 * Rollup treeshake configuration for production client builds.
 *
 * Uses the 'recommended' preset as a safe base, then overrides
 * moduleSideEffects to strip unused re-exports from npm packages.
 *
 * The 'no-external' value for moduleSideEffects means:
 * - Local project modules: preserve side effects (CSS imports, polyfills)
 * - node_modules packages: treat as side-effect-free unless exports are used
 *
 * This is the single highest-impact optimization for large barrel-exporting
 * libraries like mermaid, @mui/material, lucide-react, etc. These libraries
 * re-export hundreds of sub-modules through barrel files. Without this,
 * Rollup preserves every sub-module even when only a few exports are consumed.
 *
 * Why 'no-external' instead of false (global side-effect-free)?
 * - User code may rely on import-time side effects (e.g., `import './global.css'`)
 * - 'no-external' is safe for app code while still enabling aggressive DCE for deps
 *
 * Why not the 'smallest' preset?
 * - 'smallest' also sets propertyReadSideEffects: false and
 *   tryCatchDeoptimization: false, which can break specific libraries
 *   that rely on property access side effects or try/catch for feature detection
 * - 'recommended' + 'no-external' gives most of the benefit with less risk
 *
 * @deprecated Use getClientTreeshakeConfigForVite(viteMajorVersion) instead
 * for Vite version compatibility. Kept for backward compatibility.
 */
export const clientTreeshakeConfig = {
  preset: "recommended" as const,
  moduleSideEffects: "no-external" as const,
};

/**
 * Returns treeshake configuration appropriate for the Vite version.
 *
 * Rollup (Vite 7) supports presets like "recommended" which set multiple
 * treeshake options at once. Rolldown (Vite 8+) doesn't support presets,
 * so we only return moduleSideEffects for Vite 8+.
 *
 * The Rollup "recommended" preset sets:
 * - annotations: true (Rolldown default is also true)
 * - manualPureFunctions: [] (Rolldown default is also [])
 * - propertyReadSideEffects: true (Rolldown equivalent is 'always', the default)
 * - unknownGlobalSideEffects: false (Rolldown default is true — this is a known acceptable
 *   divergence. Slightly less aggressive DCE on unknown globals, acceptable for client bundles)
 * - correctVarValueBeforeDeclaration and tryCatchDeoptimization (Rolldown handles these differently)
 *
 * The key optimization is moduleSideEffects: "no-external", which is supported
 * by both bundlers and provides the DCE benefits for barrel-exporting libraries.
 * It treats node_modules as side-effect-free (enabling aggressive DCE) while
 * preserving side effects in local code.
 */
export function getClientTreeshakeConfigForVite(viteMajorVersion: number) {
  if (viteMajorVersion >= 8) {
    // Rolldown (Vite 8+) - no preset support, only specific options.
    // Rolldown's built-in defaults already cover what Rollup's 'recommended'
    // preset provides (annotations, correctContext, tryCatchDeoptimization).
    return {
      moduleSideEffects: "no-external" as const,
    };
  }
  // Rollup (Vite 7) - supports presets for convenient option grouping
  return {
    preset: "recommended" as const,
    moduleSideEffects: "no-external" as const,
  };
}

type VinextBuildConfig = NonNullable<UserConfig["build"]>;
type VinextBuildBundlerOptions = NonNullable<VinextBuildConfig["rolldownOptions"]>;
type VinextBuildConfigWithLegacy = VinextBuildConfig & {
  rollupOptions?: VinextBuildBundlerOptions;
};

export function getBuildBundlerOptions(
  build: UserConfig["build"] | undefined,
): VinextBuildBundlerOptions | undefined {
  const buildConfig = build as VinextBuildConfigWithLegacy | undefined;
  return buildConfig?.rolldownOptions ?? buildConfig?.rollupOptions;
}

export function withBuildBundlerOptions(
  viteMajorVersion: number,
  bundlerOptions: VinextBuildBundlerOptions,
): Partial<VinextBuildConfigWithLegacy> {
  return viteMajorVersion >= 8
    ? { rolldownOptions: bundlerOptions }
    : { rollupOptions: bundlerOptions };
}
