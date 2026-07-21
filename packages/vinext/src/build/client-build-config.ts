import type { UserConfig } from "vite";
import { toSlash } from "pathslash";

type ClientAssetFileNameInfo = {
  readonly name?: string;
  readonly names?: readonly string[];
  readonly originalFileName?: string;
  readonly originalFileNames?: readonly string[];
};

const ROUTE_OWNED_CLIENT_SHIMS = new Set([
  "compat-router",
  "dynamic",
  "dynamic-preload-chunks",
  "form",
  "image",
  "internal/hybrid-client-route-owner",
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
  const normalizedId = toSlash(id);
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
 * - The bundler's graph-based splitting already handles the common case
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
      if (pkg === "react-dom") {
        // The server renderer (Fizz: renderToString / renderToReadableStream /
        // renderToStaticMarkup, plus the prerender "static" APIs) is only needed
        // by client code that explicitly imports those APIs.
        // Keying the always-loaded "framework" chunk on the bare package name
        // ("react-dom") would otherwise drag react-dom/server.browser — and its
        // sizeable cjs implementation — into every page, even though most client
        // routes do not render to a string (an embedded Sanity Studio is one
        // example that does). Split those entrypoints into their own chunk
        // so the server renderer loads lazily, only on routes that use it,
        // instead of weighing down first paint on every page.
        // Windows ids carry backslashes, so slash-normalize before matching
        // the "react-dom/" separator (same convention as getPackageName).
        const slashedId = toSlash(id);
        const sub = slashedId.slice(slashedId.lastIndexOf("react-dom/") + "react-dom/".length);
        if (
          sub.startsWith("server.") ||
          sub.startsWith("static.") ||
          sub.startsWith("cjs/react-dom-server")
        ) {
          return "react-dom-server";
        }
        return "framework";
      }
      if (pkg === "react" || pkg === "scheduler") {
        return "framework";
      }
      // Let the bundler handle all other vendor code via its default
      // graph-based splitting. This produces a reasonable number of
      // shared chunks (typically 5-15) based on actual import patterns,
      // with good compression efficiency.
      return undefined;
    }

    // `shimsDir` is slash-normalized with a trailing slash; the bundler-provided
    // id can carry native backslashes on Windows, so slash it before matching.
    const slashedId = toSlash(id);
    if (slashedId.startsWith(shimsDir)) {
      if (preserveRouteBoundaries) {
        const relativeId = slashedId.slice(shimsDir.length).split("?", 1)[0] ?? "";
        const extensionIndex = relativeId.lastIndexOf(".");
        const shimName = extensionIndex === -1 ? relativeId : relativeId.slice(0, extensionIndex);
        if (ROUTE_OWNED_CLIENT_SHIMS.has(shimName)) return undefined;
      }
      return "vinext";
    }

    return undefined;
  };
}

export function createClientFileNameConfig(assetsDir: string) {
  const chunksDir = `${assetsDir}/chunks`;
  return {
    entryFileNames: `${chunksDir}/[name]-[hash].js`,
    chunkFileNames: `${chunksDir}/[name]-[hash].js`,
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

/**
 * Output config that isolates React (and the RSC flight runtime) into a
 * dedicated "framework" chunk in the RSC server build. See
 * {@link RSC_FRAMEWORK_CHUNK_TEST} for the motivation (issue #1549). Framework
 * modules that are only reachable through dynamic imports must stay out of the
 * eager framework chunk (issue #2073).
 */
export function createRscFrameworkChunkOutputConfig() {
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

/**
 * Returns Rolldown treeshake configuration for production client builds.
 *
 * The key optimization is moduleSideEffects: "no-external", which is supported
 * by Rolldown and provides the DCE benefits for barrel-exporting libraries. It
 * treats node_modules as side-effect-free while preserving side effects in
 * local code.
 */
export function getClientTreeshakeConfig() {
  return {
    moduleSideEffects: "no-external" as const,
  };
}

type VinextBuildConfig = NonNullable<UserConfig["build"]>;
type VinextBuildBundlerOptions = NonNullable<VinextBuildConfig["rolldownOptions"]>;

export function getBuildBundlerOptions(
  build: UserConfig["build"] | undefined,
): VinextBuildBundlerOptions | undefined {
  return build?.rolldownOptions;
}

export function withBuildBundlerOptions(
  bundlerOptions: VinextBuildBundlerOptions,
): Partial<VinextBuildConfig> {
  return { rolldownOptions: bundlerOptions };
}
