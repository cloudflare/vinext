import type { Plugin, PluginOption, UserConfig, ViteDevServer } from "vite";
import { loadEnv, parseAst } from "vite";
import {
  pagesRouter,
  apiRouter,
  invalidateRouteCache,
  matchRoute,
} from "./routing/pages-router.js";
import { generateServerEntry as _generateServerEntry } from "./entries/pages-server-entry.js";
import { generateClientEntry as _generateClientEntry } from "./entries/pages-client-entry.js";
import { appRouter, invalidateAppRouteCache } from "./routing/app-router.js";
import type { NitroRouteRuleConfig } from "./build/nitro-route-rules.js";
import { createValidFileMatcher } from "./routing/file-matcher.js";
import { createSSRHandler } from "./server/dev-server.js";
import { handleApiRoute } from "./server/api-handler.js";
import { createDirectRunner } from "./server/dev-module-runner.js";
import { generateRscEntry } from "./entries/app-rsc-entry.js";
import { generateSsrEntry } from "./entries/app-ssr-entry.js";
import { generateBrowserEntry } from "./entries/app-browser-entry.js";
import { normalizePathnameForRouteMatchStrict } from "./routing/utils.js";
import {
  findNextConfigPath,
  loadNextConfig,
  resolveNextConfigInput,
  resolveNextConfig,
  type NextConfig,
  type NextConfigInput,
  type ResolvedNextConfig,
  type NextRedirect,
  type NextRewrite,
  type NextHeader,
} from "./config/next-config.js";

import { findMiddlewareFile, runMiddleware } from "./server/middleware.js";
import { logRequest, now } from "./server/request-log.js";
import { normalizePath } from "./server/normalize-path.js";
import {
  findInstrumentationClientFile,
  findInstrumentationFile,
  runInstrumentation,
} from "./server/instrumentation.js";
import { PHASE_PRODUCTION_BUILD, PHASE_DEVELOPMENT_SERVER } from "./shims/constants.js";
import { precompressAssets } from "./build/precompress.js";
import { validateDevRequest } from "./server/dev-origin-check.js";
import {
  isExternalUrl,
  proxyExternalRequest,
  matchHeaders,
  matchRedirect,
  matchRewrite,
  requestContextFromRequest,
  sanitizeDestination,
  type RequestContext,
} from "./config/config-matchers.js";
import { scanMetadataFiles } from "./server/metadata-routes.js";
import { buildRequestHeadersFromMiddlewareResponse } from "./server/middleware-request-headers.js";
import { detectPackageManager } from "./utils/project.js";
import {
  manifestFileWithBase,
  manifestFilesWithBase,
  normalizeManifestFile,
} from "./utils/manifest-paths.js";
import { hasBasePath } from "./utils/base-path.js";
import { asyncHooksStubPlugin } from "./plugins/async-hooks-stub.js";
import { clientReferenceDedupPlugin } from "./plugins/client-reference-dedup.js";
import { createInstrumentationClientTransformPlugin } from "./plugins/instrumentation-client.js";
import { createOptimizeImportsPlugin } from "./plugins/optimize-imports.js";
import { fixUseServerClosureCollisionPlugin } from "./plugins/fix-use-server-closure-collision.js";
import { createOgInlineFetchAssetsPlugin, ogAssetsPlugin } from "./plugins/og-assets.js";
import { createServerExternalsManifestPlugin } from "./plugins/server-externals-manifest.js";
import {
  VIRTUAL_GOOGLE_FONTS,
  RESOLVED_VIRTUAL_GOOGLE_FONTS,
  parseStaticObjectLiteral,
  generateGoogleFontsVirtualModule,
  createGoogleFontsPlugin,
  createLocalFontsPlugin,
  _findBalancedObject,
  _findCallEnd,
} from "./plugins/fonts.js";
import { hasWranglerConfig, formatMissingCloudflarePluginError } from "./deploy.js";
import { computeLazyChunks } from "./utils/lazy-chunks.js";
import tsconfigPaths from "vite-tsconfig-paths";
import type { Options as VitePluginReactOptions } from "@vitejs/plugin-react";
import MagicString from "magic-string";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import fs from "node:fs";
import { randomBytes } from "node:crypto";
import commonjs from "vite-plugin-commonjs";

type ASTNode = ReturnType<typeof parseAst>["body"][number]["parent"];

const __dirname = import.meta.dirname;
type VitePluginReactModule = typeof import("@vitejs/plugin-react");

function resolveOptionalDependency(projectRoot: string, specifier: string): string | null {
  try {
    const projectRequire = createRequire(path.join(projectRoot, "package.json"));
    return projectRequire.resolve(specifier);
  } catch {}

  try {
    const selfRequire = createRequire(import.meta.url);
    return selfRequire.resolve(specifier);
  } catch {}

  return null;
}

function resolveShimModulePath(shimsDir: string, moduleName: string): string {
  // Source checkouts only ship TypeScript shims, while built packages only ship
  // JavaScript. Check .ts first to avoid an extra stat in development.
  const candidates = [".ts", ".js"];
  for (const ext of candidates) {
    const candidate = path.join(shimsDir, `${moduleName}${ext}`);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return path.join(shimsDir, `${moduleName}.js`);
}

function toRelativeFileEntry(root: string, absPath: string): string {
  return path.relative(root, absPath).split(path.sep).join("/");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

const TSCONFIG_FILES = ["tsconfig.json", "jsconfig.json"];

function resolveTsconfigPathCandidate(candidate: string): string | null {
  const candidates = candidate.endsWith(".json")
    ? [candidate]
    : [candidate, `${candidate}.json`, path.join(candidate, "tsconfig.json")];

  for (const item of candidates) {
    if (fs.existsSync(item) && fs.statSync(item).isFile()) {
      return item;
    }
  }

  return null;
}

function resolveTsconfigExtends(configPath: string, specifier: string): string | null {
  const fromDir = path.dirname(configPath);
  if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("\\")) {
    return resolveTsconfigPathCandidate(path.resolve(fromDir, specifier));
  }

  const requireFromConfig = createRequire(configPath);
  const candidates = [specifier, `${specifier}.json`, path.join(specifier, "tsconfig.json")];

  for (const item of candidates) {
    try {
      return requireFromConfig.resolve(item);
    } catch {}
  }

  return null;
}

function materializeTsconfigPathAliases(
  pathsConfig: Record<string, unknown>,
  baseUrl: string,
  projectRoot: string,
): Record<string, string> {
  const aliases: Record<string, string> = {};

  for (const [find, rawTargets] of Object.entries(pathsConfig)) {
    const target = Array.isArray(rawTargets)
      ? rawTargets.find((value): value is string => typeof value === "string")
      : typeof rawTargets === "string"
        ? rawTargets
        : null;
    if (!target) continue;

    if (find.includes("*") || target.includes("*")) {
      if (!find.endsWith("/*") || !target.endsWith("/*")) continue;
      if (find.indexOf("*") !== find.length - 1 || target.indexOf("*") !== target.length - 1) {
        continue;
      }

      const aliasKey = find.slice(0, -2);
      const targetDir = target.slice(0, -2);
      if (!aliasKey || !targetDir) continue;

      aliases[aliasKey] = toViteAliasReplacement(path.resolve(baseUrl, targetDir), projectRoot);
      continue;
    }

    aliases[find] = toViteAliasReplacement(path.resolve(baseUrl, target), projectRoot);
  }

  return aliases;
}

function toViteAliasReplacement(absolutePath: string, projectRoot: string): string {
  const normalizedPath = absolutePath.replace(/\\/g, "/");
  const rootCandidates = new Set<string>([projectRoot]);
  const realRoot = tryRealpathSync(projectRoot);
  if (realRoot) rootCandidates.add(realRoot);

  const pathCandidates = new Set<string>([absolutePath]);
  const realPath = tryRealpathSync(absolutePath);
  if (realPath) pathCandidates.add(realPath);

  for (const rootCandidate of rootCandidates) {
    for (const pathCandidate of pathCandidates) {
      if (pathCandidate === rootCandidate) {
        return normalizedPath;
      }
      const relativeId = relativeWithinRoot(rootCandidate, pathCandidate);
      if (relativeId) return "/" + relativeId;
    }
  }

  return normalizedPath;
}

function loadTsconfigPathAliases(
  configPath: string,
  projectRoot: string,
  seen = new Set<string>(),
): Record<string, string> {
  const normalizedPath = tryRealpathSync(configPath) ?? configPath;
  if (seen.has(normalizedPath)) return {};
  seen.add(normalizedPath);

  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = parseStaticObjectLiteral(fs.readFileSync(normalizedPath, "utf-8"));
  } catch {
    return {};
  }
  if (!parsed) return {};

  let aliases: Record<string, string> = {};
  if (typeof parsed.extends === "string") {
    const extendedPath = resolveTsconfigExtends(normalizedPath, parsed.extends);
    if (extendedPath) {
      aliases = loadTsconfigPathAliases(extendedPath, projectRoot, seen);
    }
  }

  const compilerOptions = isRecord(parsed.compilerOptions) ? parsed.compilerOptions : null;
  const pathsConfig =
    compilerOptions && isRecord(compilerOptions.paths) ? compilerOptions.paths : null;
  if (!pathsConfig) return aliases;

  const baseUrl =
    compilerOptions && typeof compilerOptions.baseUrl === "string" ? compilerOptions.baseUrl : ".";
  const resolvedBaseUrl = path.resolve(path.dirname(normalizedPath), baseUrl);

  return {
    ...aliases,
    ...materializeTsconfigPathAliases(pathsConfig, resolvedBaseUrl, projectRoot),
  };
}

/**
 * Detect Vite major version at runtime by resolving from cwd.
 * The plugin may be installed in a workspace root with Vite 7 but used
 * by a project that has Vite 8 — so we resolve from cwd, not from
 * the plugin's own location.
 */
function getViteMajorVersion(): number {
  try {
    const require = createRequire(path.join(process.cwd(), "package.json"));
    const vitePkg = require("vite/package.json");

    const viteMajor = parseInt(vitePkg?.version, 10);
    if (vitePkg?.name === "vite" && Number.isFinite(viteMajor)) {
      return viteMajor;
    }

    const bundledViteMajor = parseInt(vitePkg?.bundledVersions?.vite, 10);
    if (Number.isFinite(bundledViteMajor)) {
      return bundledViteMajor;
    }

    // npm aliases like `vite: npm:@voidzero-dev/vite-plus-core@...` expose the
    // aliased package.json, whose own version is not Vite's version.
    console.warn(
      `[vinext] Could not determine Vite major version from ${vitePkg?.name ?? "vite/package.json"}; assuming Vite 7`,
    );
    return 7;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[vinext] Failed to resolve vite/package.json (${message}); assuming Vite 7`);
    return 7;
  }
}

type UserResolveConfigWithTsconfigPaths = NonNullable<UserConfig["resolve"]> & {
  tsconfigPaths?: boolean;
};

/**
 * PostCSS config file names to search for, in priority order.
 * Matches the same search order as postcss-load-config / lilconfig.
 */
const POSTCSS_CONFIG_FILES = [
  "postcss.config.js",
  "postcss.config.cjs",
  "postcss.config.mjs",
  "postcss.config.ts",
  "postcss.config.cts",
  "postcss.config.mts",
  ".postcssrc",
  ".postcssrc.js",
  ".postcssrc.cjs",
  ".postcssrc.mjs",
  ".postcssrc.ts",
  ".postcssrc.cts",
  ".postcssrc.mts",
  ".postcssrc.json",
  ".postcssrc.yaml",
  ".postcssrc.yml",
];

/**
 * Module-level cache for resolvePostcssStringPlugins — avoids re-scanning per Vite environment.
 * Stores the Promise itself so concurrent calls (RSC/SSR/Client config() hooks firing in
 * parallel) all await the same in-flight scan rather than each starting their own.
 */
const _postcssCache = new Map<string, Promise<{ plugins: unknown[] } | undefined>>();
// Cache materialized tsconfig/jsconfig aliases so Vite's glob and dynamic-import
// transforms can see them via resolve.alias without re-reading config files per env.
const _tsconfigAliasCache = new Map<string, Record<string, string>>();

function resolveTsconfigAliases(projectRoot: string): Record<string, string> {
  if (_tsconfigAliasCache.has(projectRoot)) {
    return _tsconfigAliasCache.get(projectRoot)!;
  }

  let aliases: Record<string, string> = {};
  for (const name of TSCONFIG_FILES) {
    const candidate = path.join(projectRoot, name);
    if (!fs.existsSync(candidate)) continue;
    aliases = loadTsconfigPathAliases(candidate, projectRoot);
    break;
  }

  _tsconfigAliasCache.set(projectRoot, aliases);
  return aliases;
}

/**
 * Resolve PostCSS string plugin names in a project's PostCSS config.
 *
 * Next.js (via postcss-load-config) resolves string plugin names in the
 * object form `{ plugins: { "pkg-name": opts } }` but NOT in the array form
 * `{ plugins: ["pkg-name"] }`. Since many Next.js projects use the array
 * form (particularly with Tailwind CSS v4), we detect this case and resolve
 * the string names to actual plugin functions so Vite can use them.
 *
 * Returns the resolved PostCSS config object to inject into Vite's
 * `css.postcss`, or `undefined` if no resolution is needed.
 */
function resolvePostcssStringPlugins(
  projectRoot: string,
): Promise<{ plugins: unknown[] } | undefined> {
  if (_postcssCache.has(projectRoot)) return _postcssCache.get(projectRoot)!;

  const promise = _resolvePostcssStringPluginsUncached(projectRoot);
  _postcssCache.set(projectRoot, promise);
  return promise;
}

async function _resolvePostcssStringPluginsUncached(
  projectRoot: string,
): Promise<{ plugins: unknown[] } | undefined> {
  // Find the PostCSS config file
  let configPath: string | null = null;
  for (const name of POSTCSS_CONFIG_FILES) {
    const candidate = path.join(projectRoot, name);
    if (fs.existsSync(candidate)) {
      configPath = candidate;
      break;
    }
  }
  if (!configPath) {
    return undefined;
  }

  // Load the config file
  // oxlint-disable-next-line typescript/no-explicit-any
  let config: any;
  try {
    if (
      configPath.endsWith(".json") ||
      configPath.endsWith(".yaml") ||
      configPath.endsWith(".yml")
    ) {
      // JSON/YAML configs use object form — postcss-load-config handles these fine
      return undefined;
    }
    // For .postcssrc without extension, check if it's JSON
    if (configPath.endsWith(".postcssrc")) {
      const content = fs.readFileSync(configPath, "utf-8").trim();
      if (content.startsWith("{")) {
        // JSON format — postcss-load-config handles object form
        return undefined;
      }
    }
    const mod = await import(pathToFileURL(configPath).href);
    config = mod.default ?? mod;
  } catch {
    // If we can't load the config, let Vite/postcss-load-config handle it
    return undefined;
  }

  // Only process array-form plugins that contain string entries
  // (either bare strings or tuple form ["plugin-name", { options }])
  if (!config || !Array.isArray(config.plugins)) {
    return undefined;
  }
  const hasStringPlugins = config.plugins.some(
    (p: unknown) => typeof p === "string" || (Array.isArray(p) && typeof p[0] === "string"),
  );
  if (!hasStringPlugins) {
    return undefined;
  }

  // Resolve string plugin names to actual plugin functions
  const req = createRequire(path.join(projectRoot, "package.json"));
  const resolved = await Promise.all(
    config.plugins.filter(Boolean).map(async (plugin: unknown) => {
      if (typeof plugin === "string") {
        const resolved = req.resolve(plugin);
        const mod = await import(pathToFileURL(resolved).href);
        const fn = mod.default ?? mod;
        // If the export is a function, call it to get the plugin instance
        return typeof fn === "function" ? fn() : fn;
      }
      // Array tuple form: ["plugin-name", { options }]
      if (Array.isArray(plugin) && typeof plugin[0] === "string") {
        const [name, options] = plugin;
        const resolved = req.resolve(name);
        const mod = await import(pathToFileURL(resolved).href);
        const fn = mod.default ?? mod;
        return typeof fn === "function" ? fn(options) : fn;
      }
      // Already a function or plugin object — pass through
      return plugin;
    }),
  );

  return { plugins: resolved };
}

// Virtual module IDs for Pages Router production build
const VIRTUAL_SERVER_ENTRY = "virtual:vinext-server-entry";
const RESOLVED_SERVER_ENTRY = "\0" + VIRTUAL_SERVER_ENTRY;
const VIRTUAL_CLIENT_ENTRY = "virtual:vinext-client-entry";
const RESOLVED_CLIENT_ENTRY = "\0" + VIRTUAL_CLIENT_ENTRY;

// Virtual module IDs for App Router entries
const VIRTUAL_RSC_ENTRY = "virtual:vinext-rsc-entry";
const RESOLVED_RSC_ENTRY = "\0" + VIRTUAL_RSC_ENTRY;
const VIRTUAL_APP_SSR_ENTRY = "virtual:vinext-app-ssr-entry";
const RESOLVED_APP_SSR_ENTRY = "\0" + VIRTUAL_APP_SSR_ENTRY;
const VIRTUAL_APP_BROWSER_ENTRY = "virtual:vinext-app-browser-entry";
const RESOLVED_APP_BROWSER_ENTRY = "\0" + VIRTUAL_APP_BROWSER_ENTRY;
/** Image file extensions handled by the vinext:image-imports plugin.
 *  Shared between the Rolldown hook filter and the transform handler regex. */
const IMAGE_EXTS = "png|jpe?g|gif|webp|avif|svg|ico|bmp|tiff?";

/**
 * Extract the npm package name from a module ID (file path).
 * Returns null if not in node_modules.
 *
 * Handles scoped packages (@org/pkg) and pnpm-style paths
 * (node_modules/.pnpm/pkg@ver/node_modules/pkg).
 */
function getPackageName(id: string): string | null {
  const nmIdx = id.lastIndexOf("node_modules/");
  if (nmIdx === -1) return null;
  const rest = id.slice(nmIdx + "node_modules/".length);
  if (rest.startsWith("@")) {
    // Scoped package: @org/pkg
    const parts = rest.split("/");
    return parts.length >= 2 ? parts[0] + "/" + parts[1] : null;
  }
  return rest.split("/")[0] || null;
}

/** Absolute path to vinext's shims directory, used by clientManualChunks. */
const _shimsDir = path.resolve(__dirname, "shims") + "/";
const _fontGoogleShimPath = resolveShimModulePath(_shimsDir, "font-google");

/**
 * manualChunks function for client builds.
 *
 * Splits the client bundle into:
 * - "framework" — React, ReactDOM, and scheduler (loaded on every page)
 * - "vinext"    — vinext shims (router, head, link, etc.)
 *
 * All other vendor code is left to Rollup's default chunk-splitting
 * algorithm. Rollup automatically deduplicates shared modules into
 * common chunks based on the import graph — no manual intervention
 * needed.
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
function clientManualChunks(id: string): string | undefined {
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

  // vinext shims — small runtime, shared across all pages.
  // Use the absolute shims directory path to avoid matching user files
  // that happen to have "/shims/" in their path.
  if (id.startsWith(_shimsDir)) {
    return "vinext";
  }

  return undefined;
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
const clientOutputConfig = {
  manualChunks: clientManualChunks,
  experimentalMinChunkSize: 10_000,
};

const clientCodeSplittingConfig = {
  minSize: 10_000,
  groups: [
    {
      name(moduleId: string) {
        return clientManualChunks(moduleId) ?? null;
      },
    },
  ],
};

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
const clientTreeshakeConfig = {
  preset: "recommended" as const,
  moduleSideEffects: "no-external" as const,
};

type VinextBuildConfig = NonNullable<UserConfig["build"]>;
type VinextBuildBundlerOptions = NonNullable<VinextBuildConfig["rolldownOptions"]>;
type VinextBuildConfigWithLegacy = VinextBuildConfig & {
  rollupOptions?: VinextBuildBundlerOptions;
};

function getBuildBundlerOptions(
  build: UserConfig["build"] | undefined,
): VinextBuildBundlerOptions | undefined {
  const buildConfig = build as VinextBuildConfigWithLegacy | undefined;
  return buildConfig?.rolldownOptions ?? buildConfig?.rollupOptions;
}

function withBuildBundlerOptions(
  viteMajorVersion: number,
  bundlerOptions: VinextBuildBundlerOptions,
): Partial<VinextBuildConfigWithLegacy> {
  return viteMajorVersion >= 8
    ? { rolldownOptions: bundlerOptions }
    : { rollupOptions: bundlerOptions };
}

function getClientOutputConfigForVite(viteMajorVersion: number) {
  return viteMajorVersion >= 8
    ? {
        codeSplitting: clientCodeSplittingConfig,
      }
    : clientOutputConfig;
}

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
function getClientTreeshakeConfigForVite(viteMajorVersion: number) {
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

type BundleBackfillChunk = {
  type: "chunk";
  fileName: string;
  imports?: string[];
  modules?: Record<string, unknown>;
  viteMetadata?: {
    importedCss?: Set<string>;
    importedAssets?: Set<string>;
  };
};

function tryRealpathSync(candidate: string): string | null {
  try {
    return fs.realpathSync.native(candidate);
  } catch {
    return null;
  }
}

function isWindowsAbsolutePath(candidate: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(candidate) || candidate.startsWith("\\\\");
}

function relativeWithinRoot(root: string, moduleId: string): string | null {
  const useWindowsPath = isWindowsAbsolutePath(root) || isWindowsAbsolutePath(moduleId);
  const relativeId = (
    useWindowsPath ? path.win32.relative(root, moduleId) : path.relative(root, moduleId)
  ).replace(/\\/g, "/");
  // path.relative(root, root) returns "", which is not a usable manifest key and should be
  // treated the same as "outside root" for this helper.
  if (!relativeId || relativeId === ".." || relativeId.startsWith("../")) return null;
  return relativeId;
}

function normalizeManifestModuleId(moduleId: string, root: string): string {
  const normalizedId = moduleId.replace(/\\/g, "/");
  if (normalizedId.startsWith("\0")) return normalizedId;
  if (normalizedId.startsWith("node_modules/") || normalizedId.includes("/node_modules/")) {
    return normalizedId;
  }

  if (!isWindowsAbsolutePath(moduleId) && !path.isAbsolute(moduleId)) {
    if (!normalizedId.startsWith(".") && !normalizedId.includes("../")) {
      // Preserve bare specifiers like "pages/counter.tsx". These are already
      // stable manifest keys and resolving them against root would rewrite them
      // into filesystem paths that no longer match the bundle/module graph.
      return normalizedId;
    }
  }

  const rootCandidates = new Set<string>([root]);
  const realRoot = tryRealpathSync(root);
  if (realRoot) rootCandidates.add(realRoot);

  const moduleCandidates = new Set<string>();
  if (isWindowsAbsolutePath(moduleId) || path.isAbsolute(moduleId)) {
    moduleCandidates.add(moduleId);
  } else {
    moduleCandidates.add(path.resolve(root, moduleId));
  }

  for (const candidate of moduleCandidates) {
    const realCandidate = tryRealpathSync(candidate);
    // Set iteration stays live as entries are appended, so this also checks the
    // realpath variant without needing a second pass or an intermediate array.
    if (realCandidate) moduleCandidates.add(realCandidate);
  }

  for (const rootCandidate of rootCandidates) {
    for (const moduleCandidate of moduleCandidates) {
      const relativeId = relativeWithinRoot(rootCandidate, moduleCandidate);
      if (relativeId) return relativeId;
    }
  }

  return normalizedId;
}

function augmentSsrManifestFromBundle(
  ssrManifest: Record<string, string[]>,
  bundle: Record<string, BundleBackfillChunk | { type: string }>,
  root: string,
  base = "/",
): Record<string, string[]> {
  const nextManifest = {} as Record<string, Set<string>>;

  for (const [key, files] of Object.entries(ssrManifest)) {
    const normalizedKey = normalizeManifestModuleId(key, root);
    if (!nextManifest[normalizedKey]) nextManifest[normalizedKey] = new Set<string>();
    for (const file of files) {
      nextManifest[normalizedKey].add(normalizeManifestFile(file));
    }
  }

  for (const item of Object.values(bundle)) {
    if (item.type !== "chunk") continue;
    const chunk = item as BundleBackfillChunk;

    const files = new Set<string>();
    files.add(manifestFileWithBase(chunk.fileName, base));
    for (const importedFile of chunk.imports ?? []) {
      files.add(manifestFileWithBase(importedFile, base));
    }
    for (const cssFile of chunk.viteMetadata?.importedCss ?? []) {
      files.add(manifestFileWithBase(cssFile, base));
    }
    for (const assetFile of chunk.viteMetadata?.importedAssets ?? []) {
      files.add(manifestFileWithBase(assetFile, base));
    }

    for (const moduleId of Object.keys(chunk.modules ?? {})) {
      const key = normalizeManifestModuleId(moduleId, root);
      if (key.startsWith("node_modules/") || key.includes("/node_modules/")) continue;
      if (key.startsWith("\0")) continue;
      if (!nextManifest[key]) nextManifest[key] = new Set<string>();
      for (const file of files) {
        nextManifest[key].add(file);
      }
    }
  }

  return Object.fromEntries(
    Object.entries(nextManifest).map(([key, files]) => [key, [...files]]),
  ) as Record<string, string[]>;
}

export type VinextOptions = {
  /**
   * Base directory containing the app/ and pages/ directories.
   * Can be an absolute path or a path relative to the Vite root.
   *
   * By default, vinext auto-detects: checks for app/ and pages/ at the
   * project root first, then falls back to src/app/ and src/pages/.
   */
  appDir?: string;
  /**
   * Force-disable App Router detection even when an app/ directory exists.
   * Only the Pages Router pipeline will be active.
   * Intended for testing and tools that need to build only the Pages Router
   * bundle from a hybrid (app + pages) project.
   * @default false
   */
  disableAppRouter?: boolean;
  /**
   * Override the output directory for the RSC server bundle.
   * Absolute paths are used as-is; relative paths are resolved from the
   * Vite root. Defaults to "dist/server".
   * Intended for tests that need to build multiple fixtures in parallel
   * without clobbering each other's output.
   */
  rscOutDir?: string;
  /**
   * Override the output directory for the SSR bundle.
   * Defaults to "dist/server/ssr".
   */
  ssrOutDir?: string;
  /**
   * Override the output directory for the client bundle.
   * Defaults to Vite's default (dist/client or dist).
   */
  clientOutDir?: string;
  /**
   * Inline Next.js config for projects that want to configure vinext from
   * vite.config without a separate next.config file.
   *
   * When provided, vinext skips loading next.config.* from disk and uses this
   * value instead. Supports both object-form and function-form config.
   */
  nextConfig?: NextConfigInput;
  /**
   * Auto-register @vitejs/plugin-rsc when an app/ directory is detected.
   * Set to `false` to disable auto-registration (e.g. if you configure
   * @vitejs/plugin-rsc manually with custom options).
   * @default true
   */
  rsc?: boolean;
  /**
   * Options passed to @vitejs/plugin-react (React Fast Refresh + JSX transform).
   * Enabled by default. Set to `false` to disable (e.g. if you configure
   * @vitejs/plugin-react manually in your vite.config.ts), or pass an options
   * object to customize the Babel transform.
   * @default true
   */
  react?: VitePluginReactOptions | boolean;
  /**
   * Enable build-time precompression of static assets (.br, .gz, .zst).
   *
   * When enabled, hashed assets in the client build are precompressed at
   * build time so the production server can serve them without on-the-fly
   * compression overhead.
   *
   * Disabled by default. Not useful when deploying to edge platforms
   * (Cloudflare Workers, Nitro) that handle compression at the CDN layer.
   *
   * Can also be enabled via the `--precompress` CLI flag or by setting the
   * `VINEXT_PRECOMPRESS=1` environment variable (useful for CI pipelines
   * that need to enable precompression without modifying vite.config.ts).
   * @default false
   */
  precompress?: boolean;
  /**
   * Experimental vinext-only feature flags.
   */
  experimental?: {
    /**
     * Dedup client references emitted from RSC proxy modules in dev.
     * Disabled by default until the behavior is better proven across
     * ecosystem apps.
     * @default false
     */
    clientReferenceDedup?: boolean;
  };
};

type NitroSetupContext = {
  options: {
    dev?: boolean;
    routeRules?: Record<string, NitroRouteRuleConfig>;
  };
  logger?: {
    warn?: (message: string) => void;
  };
};

export default function vinext(options: VinextOptions = {}): PluginOption[] {
  const viteMajorVersion = getViteMajorVersion();
  let root: string;
  let pagesDir: string;
  let appDir: string;
  let hasAppDir = false;
  let hasPagesDir = false;
  let nextConfig: ResolvedNextConfig;
  let fileMatcher: ReturnType<typeof createValidFileMatcher>;
  let middlewarePath: string | null = null;
  let instrumentationPath: string | null = null;
  let instrumentationClientPath: string | null = null;
  let hasCloudflarePlugin = false;
  let warnedInlineNextConfigOverride = false;
  let hasNitroPlugin = false;

  // Resolve shim paths - works both from source (.ts) and built (.js)
  const shimsDir = path.resolve(__dirname, "shims");

  // Shim alias map — populated in config(), used by resolveId() for .js variants
  let nextShimMap: Record<string, string> = {};

  /**
   * Generate the virtual SSR server entry module.
   * This is the entry point for `vite build --ssr`.
   */
  async function generateServerEntry(): Promise<string> {
    return _generateServerEntry(
      pagesDir,
      nextConfig,
      fileMatcher,
      middlewarePath,
      instrumentationPath,
    );
  }

  /**
   * Generate the virtual client hydration entry module.
   * This is the entry point for `vite build` (client bundle).
   *
   * It maps route patterns to dynamic imports of page modules so Vite
   * code-splits each page into its own chunk. At runtime it reads
   * __NEXT_DATA__ to determine which page to hydrate.
   */
  async function generateClientEntry(): Promise<string> {
    return _generateClientEntry(pagesDir, nextConfig, fileMatcher);
  }

  // Auto-register @vitejs/plugin-rsc when App Router is detected.
  // Check eagerly at call time using the same heuristic as config().
  // Must mirror the full detection logic: check {base}/app then {base}/src/app.
  const autoRsc = options.rsc !== false;
  const earlyBaseDir = options.appDir ?? process.cwd();
  const earlyAppDirExists =
    !options.disableAppRouter &&
    (fs.existsSync(path.join(earlyBaseDir, "app")) ||
      fs.existsSync(path.join(earlyBaseDir, "src", "app")));

  // IMPORTANT: Resolve @vitejs/plugin-rsc subpath imports from the user's
  // project root, not from vinext's own package location. When vinext is
  // installed via symlink (npm file: deps, pnpm workspace:*), a bare
  // import() resolves from vinext's realpath, which can find a different
  // copy of the RSC plugin (and transitively a different copy of vite).
  // This causes instanceof RunnableDevEnvironment checks to fail at
  // runtime because the Vite server and the RSC plugin end up with
  // different class identities. Resolving from the project root ensures a
  // single shared vite instance.
  //
  // Pre-resolve both the main plugin and the /transforms subpath eagerly
  // so all import() calls in this module use consistent resolution.
  let resolvedReactPath: string | null = null;
  let resolvedRscPath: string | null = null;
  let resolvedRscTransformsPath: string | null = null;
  // Prefer the user's project graph so vinext shares the app's Vite/plugin
  // instances. In source/workspace development, test fixtures may not declare
  // peer deps explicitly, so fall back to vinext's own install location.
  resolvedReactPath = resolveOptionalDependency(earlyBaseDir, "@vitejs/plugin-react");
  resolvedRscPath = resolveOptionalDependency(earlyBaseDir, "@vitejs/plugin-rsc");
  resolvedRscTransformsPath = resolveOptionalDependency(
    earlyBaseDir,
    "@vitejs/plugin-rsc/transforms",
  );

  // If app/ exists and auto-RSC is enabled, create a lazy Promise that
  // resolves to the configured RSC plugin array. Vite's asyncFlatten
  // will resolve this before processing the plugin list.
  let rscPluginPromise: Promise<Plugin[]> | null = null;
  if (earlyAppDirExists && autoRsc) {
    if (!resolvedRscPath) {
      throw new Error(
        "vinext: App Router detected but @vitejs/plugin-rsc is not installed.\n" +
          "Run: " +
          detectPackageManager(process.cwd()) +
          " @vitejs/plugin-rsc",
      );
    }
    const rscImport = import(pathToFileURL(resolvedRscPath).href);
    rscPluginPromise = rscImport
      .then((mod) => {
        const rsc = mod.default;
        return rsc({
          entries: {
            rsc: VIRTUAL_RSC_ENTRY,
            ssr: VIRTUAL_APP_SSR_ENTRY,
            client: VIRTUAL_APP_BROWSER_ENTRY,
          },
        });
      })
      .catch((cause) => {
        throw new Error("vinext: Failed to load @vitejs/plugin-rsc.", { cause });
      });
  }

  const reactOptions = options.react && options.react !== true ? options.react : undefined;

  let reactPluginPromise: Promise<PluginOption[]> | null = null;
  if (options.react !== false) {
    if (!resolvedReactPath) {
      throw new Error(
        "vinext: @vitejs/plugin-react is not installed.\n" +
          "Run: " +
          detectPackageManager(process.cwd()) +
          " @vitejs/plugin-react",
      );
    }
    const reactImport = import(pathToFileURL(resolvedReactPath).href);
    reactPluginPromise = reactImport
      .then((mod) => (mod as VitePluginReactModule).default(reactOptions))
      .catch((cause) => {
        throw new Error("vinext: Failed to load @vitejs/plugin-react.", { cause });
      });
  }

  const imageImportDimCache = new Map<string, { width: number; height: number }>();

  // Shared state for the MDX proxy plugin. We auto-inject @mdx-js/rollup when
  // MDX is detected in app/pages during config(), and lazily on first plain
  // .mdx transform for MDX that only enters the graph via import.meta.glob.
  let mdxDelegate: Plugin | null = null;
  // Cached across calls — only the first invocation's `reason` affects logging.
  // This is correct because config() always runs before transform() in the same build.
  let mdxDelegatePromise: Promise<Plugin | null> | null = null;
  let hasUserMdxPlugin = false;
  let warnedMissingMdxPlugin = false;

  async function ensureMdxDelegate(reason: "detected" | "on-demand"): Promise<Plugin | null> {
    // Reuse the auto-injected delegate once it has been created.
    // If the user registered their own MDX plugin and `mdxDelegate` is still null,
    // return null here so transform() falls through without handling the file and
    // the user's plugin can process the .mdx module later in the pipeline.
    // Note: hasUserMdxPlugin is set during config(), which runs before transform().
    if (mdxDelegate || hasUserMdxPlugin) return mdxDelegate;
    if (!mdxDelegatePromise) {
      mdxDelegatePromise = (async () => {
        try {
          const mdxRollup = await import("@mdx-js/rollup");
          const mdxFactory = (mdxRollup.default ?? mdxRollup) as (
            options: Record<string, unknown>,
          ) => Plugin;
          const mdxOpts: Record<string, unknown> = {};
          if (nextConfig.mdx) {
            if (nextConfig.mdx.remarkPlugins) mdxOpts.remarkPlugins = nextConfig.mdx.remarkPlugins;
            if (nextConfig.mdx.rehypePlugins) mdxOpts.rehypePlugins = nextConfig.mdx.rehypePlugins;
            if (nextConfig.mdx.recmaPlugins) mdxOpts.recmaPlugins = nextConfig.mdx.recmaPlugins;
          }
          const delegate = mdxFactory(mdxOpts);
          mdxDelegate = delegate;
          if (reason === "detected") {
            if (nextConfig.mdx) {
              console.log(
                "[vinext] Auto-injected @mdx-js/rollup with remark/rehype plugins from next.config",
              );
            } else {
              console.log("[vinext] Auto-injected @mdx-js/rollup for MDX support");
            }
          } else {
            console.log("[vinext] Auto-injected @mdx-js/rollup for on-demand MDX support");
          }
          return delegate;
        } catch {
          // Only warn during "detected" path (MDX files in app/pages at config time).
          // For "on-demand" (MDX encountered during transform), the error thrown
          // in transform() is more actionable and immediate. Avoid double messaging.
          if (reason === "detected" && !warnedMissingMdxPlugin) {
            warnedMissingMdxPlugin = true;
            console.warn(
              "[vinext] MDX files detected but @mdx-js/rollup is not installed. " +
                "Install it with: " +
                detectPackageManager(process.cwd()) +
                " @mdx-js/rollup",
            );
          }
          return null;
        }
      })();
    }
    return mdxDelegatePromise;
  }

  const plugins: PluginOption[] = [
    // Resolve tsconfig paths/baseUrl aliases so real-world Next.js repos
    // that use @/*, #/*, or baseUrl imports work out of the box.
    // Vite 8+ supports this natively via resolve.tsconfigPaths.
    ...(viteMajorVersion >= 8 ? [] : [tsconfigPaths()]),
    // React Fast Refresh + JSX transform for client components.
    reactPluginPromise,
    // Transform CJS require()/module.exports to ESM before other plugins
    // analyze imports (RSC directive scanning, shim resolution, etc.)
    commonjs(),
    // Fix 'use server' closure variable collision with local declarations.
    // See packages/vinext/src/plugins/fix-use-server-closure-collision.ts for details.
    fixUseServerClosureCollisionPlugin,
    {
      name: "vinext:config",
      enforce: "pre",

      async config(config, env) {
        root = config.root ?? process.cwd();
        const userResolve = config.resolve as UserResolveConfigWithTsconfigPaths | undefined;
        const shouldEnableNativeTsconfigPaths =
          viteMajorVersion >= 8 && userResolve?.tsconfigPaths === undefined;
        const tsconfigPathAliases = resolveTsconfigAliases(root);

        // Load .env files into process.env before anything else.
        // Next.js loads .env files before evaluating next.config.js, so
        // env vars are available in config, server-side code, and as
        // NEXT_PUBLIC_* defines for the client bundle.
        // Pass '' as prefix to load ALL vars, not just VITE_-prefixed ones.
        const mode = env?.mode ?? "development";
        const envDir = config.envDir ?? root;
        const dotenvVars = loadEnv(mode, envDir, "");
        for (const [key, value] of Object.entries(dotenvVars)) {
          if (process.env[key] === undefined) {
            process.env[key] = value;
          }
        }
        // Align NODE_ENV with Next.js semantics: build -> production, serve -> development.
        // Next.js unconditionally forces NODE_ENV during build/dev, so we do the same.
        let resolvedNodeEnv: string;
        if (mode === "test") {
          resolvedNodeEnv = "test";
        } else if (env?.command === "build") {
          resolvedNodeEnv = "production";
        } else {
          resolvedNodeEnv = "development";
        }
        if (process.env.NODE_ENV !== resolvedNodeEnv) {
          process.env.NODE_ENV = resolvedNodeEnv;
        }

        // Resolve the base directory for app/pages detection.
        // If appDir is provided, resolve it (supports both relative and absolute paths).
        // If not provided, auto-detect: check root first, then src/ subdirectory.
        let baseDir: string;
        if (options.appDir) {
          baseDir = path.isAbsolute(options.appDir)
            ? options.appDir
            : path.resolve(root, options.appDir);
        } else {
          // Auto-detect: prefer root-level app/ and pages/, fall back to src/
          const hasRootApp = fs.existsSync(path.join(root, "app"));
          const hasRootPages = fs.existsSync(path.join(root, "pages"));
          const hasSrcApp = fs.existsSync(path.join(root, "src", "app"));
          const hasSrcPages = fs.existsSync(path.join(root, "src", "pages"));

          if (hasRootApp || hasRootPages) {
            baseDir = root;
          } else if (hasSrcApp || hasSrcPages) {
            baseDir = path.join(root, "src");
          } else {
            baseDir = root;
          }
        }

        pagesDir = path.join(baseDir, "pages");
        appDir = path.join(baseDir, "app");
        hasPagesDir = fs.existsSync(pagesDir);
        hasAppDir = !options.disableAppRouter && fs.existsSync(appDir);

        // Load next.config.js if present (always from project root, not src/),
        // unless vinext({ nextConfig }) explicitly overrides it.
        // Guard: resolve nextConfig only once per plugin instance. In Vite's
        // multi-environment build the config hook fires once per environment;
        // without this guard, resolveNextConfig() → resolveBuildId() generates
        // a fresh random UUID each time, causing different buildId values to be
        // baked into the RSC, SSR, and client bundles.
        // Note: fileMatcher, instrumentationPath, etc. are intentionally set
        // outside this guard — they are cheap and deterministic, and keeping
        // them here ensures they reflect the final resolved root on every call.
        if (!nextConfig) {
          const phase =
            env?.command === "build" ? PHASE_PRODUCTION_BUILD : PHASE_DEVELOPMENT_SERVER;
          let rawConfig: NextConfig | null;
          if (options.nextConfig) {
            const diskConfigPath = findNextConfigPath(root);
            if (diskConfigPath && !warnedInlineNextConfigOverride) {
              warnedInlineNextConfigOverride = true;
              console.warn(
                `[vinext] vinext({ nextConfig }) overrides ${path.basename(diskConfigPath)}. Remove one of the config sources to avoid drift.`,
              );
            }
            rawConfig = await resolveNextConfigInput(options.nextConfig, phase);
          } else {
            rawConfig = await loadNextConfig(root, phase);
          }
          nextConfig = await resolveNextConfig(rawConfig, root);
        }
        fileMatcher = createValidFileMatcher(nextConfig.pageExtensions);
        instrumentationPath = findInstrumentationFile(root, fileMatcher);
        instrumentationClientPath = findInstrumentationClientFile(root, fileMatcher);
        middlewarePath = findMiddlewareFile(root, fileMatcher);

        // Merge env from next.config.js with NEXT_PUBLIC_* env vars
        const defines = getNextPublicEnvDefines();
        if (
          !config.define ||
          typeof config.define !== "object" ||
          !("process.env.NODE_ENV" in config.define)
        ) {
          defines["process.env.NODE_ENV"] = JSON.stringify(resolvedNodeEnv);
        }
        for (const [key, value] of Object.entries(nextConfig.env)) {
          // Skip NODE_ENV from next.config.js env — Next.js ignores it too,
          // and it would silently override the value we just set above.
          if (key === "NODE_ENV") continue;
          defines[`process.env.${key}`] = JSON.stringify(value);
        }
        // Expose basePath to client-side code
        defines["process.env.__NEXT_ROUTER_BASEPATH"] = JSON.stringify(nextConfig.basePath);
        // Expose image remote patterns for validation in next/image shim
        defines["process.env.__VINEXT_IMAGE_REMOTE_PATTERNS"] = JSON.stringify(
          JSON.stringify(nextConfig.images?.remotePatterns ?? []),
        );
        defines["process.env.__VINEXT_IMAGE_DOMAINS"] = JSON.stringify(
          JSON.stringify(nextConfig.images?.domains ?? []),
        );
        // Expose allowed image widths (union of deviceSizes + imageSizes) for
        // server-side validation. Matches Next.js behavior: only configured
        // sizes are accepted by the image optimization endpoint.
        {
          const deviceSizes = nextConfig.images?.deviceSizes ?? [
            640, 750, 828, 1080, 1200, 1920, 2048, 3840,
          ];
          const imageSizes = nextConfig.images?.imageSizes ?? [16, 32, 48, 64, 96, 128, 256, 384];
          defines["process.env.__VINEXT_IMAGE_DEVICE_SIZES"] = JSON.stringify(
            JSON.stringify(deviceSizes),
          );
          defines["process.env.__VINEXT_IMAGE_SIZES"] = JSON.stringify(JSON.stringify(imageSizes));
        }
        // Expose dangerouslyAllowSVG flag for the image shim's auto-skip logic.
        // When false (default), .svg sources bypass the optimization endpoint.
        defines["process.env.__VINEXT_IMAGE_DANGEROUSLY_ALLOW_SVG"] = JSON.stringify(
          String(nextConfig.images?.dangerouslyAllowSVG ?? false),
        );
        // Draft mode secret — generated once at build time so the
        // __prerender_bypass cookie is consistent across all server
        // instances (e.g. multiple Cloudflare Workers isolates).
        defines["process.env.__VINEXT_DRAFT_SECRET"] = JSON.stringify(crypto.randomUUID());
        // Build ID — resolved from next.config generateBuildId() or random UUID.
        // Exposed so server entries and the next/server shim can inject it.
        // Also used to namespace ISR cache keys so old cached entries from a
        // previous deploy are never served by the new one.
        defines["process.env.__VINEXT_BUILD_ID"] = JSON.stringify(nextConfig.buildId);

        // Build the shim alias map. Exact `.js` variants are included for the
        // public Next entrypoints that are file-backed in `next/package.json`.
        // Some libraries (for example `nuqs`) import `next/navigation.js`
        // directly; aliasing the `.js` form ensures optimizeDeps pre-bundles
        // vinext's shim instead of real Next.
        nextShimMap = Object.fromEntries(
          Object.entries({
            "next/link": path.join(shimsDir, "link"),
            "next/head": path.join(shimsDir, "head"),
            "next/router": path.join(shimsDir, "router"),
            "next/compat/router": path.join(shimsDir, "compat-router"),
            "next/image": path.join(shimsDir, "image"),
            "next/legacy/image": path.join(shimsDir, "legacy-image"),
            "next/dynamic": path.join(shimsDir, "dynamic"),
            "next/app": path.join(shimsDir, "app"),
            "next/document": path.join(shimsDir, "document"),
            "next/config": path.join(shimsDir, "config"),
            "next/script": path.join(shimsDir, "script"),
            "next/server": path.join(shimsDir, "server"),
            "next/navigation": path.join(shimsDir, "navigation"),
            "next/headers": path.join(shimsDir, "headers"),
            "next/font/google": path.join(shimsDir, "font-google"),
            "next/font/local": path.join(shimsDir, "font-local"),
            "next/cache": path.join(shimsDir, "cache"),
            "next/form": path.join(shimsDir, "form"),
            "next/og": path.join(shimsDir, "og"),
            "next/web-vitals": path.join(shimsDir, "web-vitals"),
            "next/amp": path.join(shimsDir, "amp"),
            "next/error": path.join(shimsDir, "error"),
            "next/constants": path.join(shimsDir, "constants"),
            // Internal next/dist/* paths used by popular libraries
            // (next-intl, @clerk/nextjs, @sentry/nextjs, next-nprogress-bar, etc.)
            "next/dist/shared/lib/app-router-context.shared-runtime": path.join(
              shimsDir,
              "internal",
              "app-router-context",
            ),
            "next/dist/shared/lib/app-router-context": path.join(
              shimsDir,
              "internal",
              "app-router-context",
            ),
            "next/dist/shared/lib/router-context.shared-runtime": path.join(
              shimsDir,
              "internal",
              "router-context",
            ),
            "next/dist/shared/lib/utils": path.join(shimsDir, "internal", "utils"),
            "next/dist/server/api-utils": path.join(shimsDir, "internal", "api-utils"),
            "next/dist/server/web/spec-extension/cookies": path.join(
              shimsDir,
              "internal",
              "cookies",
            ),
            "next/dist/compiled/@edge-runtime/cookies": path.join(shimsDir, "internal", "cookies"),
            "next/dist/server/app-render/work-unit-async-storage.external": path.join(
              shimsDir,
              "internal",
              "work-unit-async-storage",
            ),
            "next/dist/client/components/work-unit-async-storage.external": path.join(
              shimsDir,
              "internal",
              "work-unit-async-storage",
            ),
            "next/dist/client/components/request-async-storage.external": path.join(
              shimsDir,
              "internal",
              "work-unit-async-storage",
            ),
            "next/dist/client/components/request-async-storage": path.join(
              shimsDir,
              "internal",
              "work-unit-async-storage",
            ),
            // Re-export public modules for internal path imports
            "next/dist/client/components/navigation": path.join(shimsDir, "navigation"),
            "next/dist/server/config-shared": path.join(shimsDir, "internal", "utils"),
            // server-only / client-only marker packages
            "server-only": path.join(shimsDir, "server-only"),
            "client-only": path.join(shimsDir, "client-only"),
            "vinext/error-boundary": path.join(shimsDir, "error-boundary"),
            "vinext/layout-segment-context": path.join(shimsDir, "layout-segment-context"),
            "vinext/metadata": path.join(shimsDir, "metadata"),
            "vinext/fetch-cache": path.join(shimsDir, "fetch-cache"),
            "vinext/cache-runtime": path.join(shimsDir, "cache-runtime"),
            "vinext/navigation-state": path.join(shimsDir, "navigation-state"),
            "vinext/unified-request-context": path.join(shimsDir, "unified-request-context"),
            "vinext/router-state": path.join(shimsDir, "router-state"),
            "vinext/head-state": path.join(shimsDir, "head-state"),
            "vinext/i18n-state": path.join(shimsDir, "i18n-state"),
            "vinext/i18n-context": path.join(shimsDir, "i18n-context"),
            "vinext/cache": path.resolve(__dirname, "cache"),
            "vinext/instrumentation": path.resolve(__dirname, "server", "instrumentation"),
            "vinext/instrumentation-client": path.resolve(
              __dirname,
              "client",
              "instrumentation-client",
            ),
            "vinext/html": path.resolve(__dirname, "server", "html"),
            "private-next-instrumentation-client":
              instrumentationClientPath ?? path.resolve(__dirname, "client", "empty-module"),
          }).flatMap(([k, v]) =>
            k.startsWith("next/")
              ? [
                  [k, v],
                  [`${k}.js`, v],
                ]
              : [[k, v]],
          ),
        );

        // Detect if Cloudflare's vite plugin is present — if so, skip
        // SSR externals (Workers bundle everything, can't have Node.js externals).
        const pluginsFlat: unknown[] = [];
        function flattenPlugins(arr: unknown[]) {
          for (const p of arr) {
            if (Array.isArray(p)) flattenPlugins(p);
            else if (p) pluginsFlat.push(p);
          }
        }
        flattenPlugins((config.plugins as unknown[]) ?? []);
        hasCloudflarePlugin = pluginsFlat.some(
          (p: unknown) =>
            p &&
            typeof p === "object" &&
            "name" in p &&
            typeof p.name === "string" &&
            (p.name === "vite-plugin-cloudflare" || p.name.startsWith("vite-plugin-cloudflare:")),
        );
        hasNitroPlugin = pluginsFlat.some(
          (p: unknown) =>
            p &&
            typeof p === "object" &&
            "name" in p &&
            typeof p.name === "string" &&
            (p.name === "nitro" || p.name.startsWith("nitro:")),
        );

        // Resolve PostCSS string plugin names that Vite can't handle.
        // Next.js projects commonly use array-form plugins like
        // `plugins: ["@tailwindcss/postcss"]` which postcss-load-config
        // doesn't resolve (only object-form keys are resolved). We detect
        // this and resolve the strings to actual plugin functions, then
        // inject via css.postcss so Vite uses the resolved plugins.
        // Only do this if the user hasn't already set css.postcss inline.
        // oxlint-disable-next-line typescript/no-explicit-any
        let postcssOverride: { plugins: any[] } | undefined;
        if (!config.css?.postcss || typeof config.css.postcss === "string") {
          postcssOverride = await resolvePostcssStringPlugins(root);
        }

        // Auto-inject @mdx-js/rollup when MDX files exist and no MDX plugin is
        // already configured. Applies remark/rehype plugins from next.config.
        hasUserMdxPlugin = pluginsFlat.some(
          (p: unknown) =>
            p &&
            typeof p === "object" &&
            "name" in p &&
            typeof p.name === "string" &&
            (p.name === "@mdx-js/rollup" || p.name === "mdx"),
        );
        if (
          !hasUserMdxPlugin &&
          hasMdxFiles(root, hasAppDir ? appDir : null, hasPagesDir ? pagesDir : null)
        ) {
          await ensureMdxDelegate("detected");
        }

        // Detect if this is a standalone SSR build (set by `vite build --ssr`
        // or `build.ssr` in config). SSR builds must NOT use manualChunks
        // because they use inlineDynamicImports which is incompatible.
        const isSSR = !!config.build?.ssr;
        // Detect if this is a multi-environment build (App Router or Cloudflare).
        // In multi-env builds, manualChunks must only be set per-environment
        // (on the client env), not globally — otherwise it leaks into RSC/SSR
        // environments where it can cause asset resolution issues.
        const isMultiEnv = hasAppDir || hasCloudflarePlugin || hasNitroPlugin;

        const viteConfig: UserConfig = {
          // Disable Vite's default HTML serving - we handle all routing
          appType: "custom",
          build: {
            ...withBuildBundlerOptions(viteMajorVersion, {
              // Suppress "Module level directives cause errors when bundled"
              // warnings for "use client" / "use server" directives. Our shims
              // and third-party libraries legitimately use these directives;
              // they are handled by the RSC plugin and are harmless in the
              // final bundle. We preserve any user-supplied onwarn so custom
              // warning handling is not lost.
              onwarn: (() => {
                const userOnwarn = getBuildBundlerOptions(config.build)?.onwarn;
                return (warning, defaultHandler) => {
                  if (
                    warning.code === "MODULE_LEVEL_DIRECTIVE" &&
                    (warning.message?.includes('"use client"') ||
                      warning.message?.includes('"use server"'))
                  ) {
                    return;
                  }
                  // Dynamic route pages that don't export generateStaticParams
                  // produce IMPORT_IS_UNDEFINED warnings because the virtual RSC
                  // entry unconditionally references mod?.generateStaticParams for
                  // every dynamic route. The ?. guards the access safely at runtime;
                  // suppress the build-time noise.
                  if (
                    warning.code === "IMPORT_IS_UNDEFINED" &&
                    warning.message?.includes("generateStaticParams")
                  ) {
                    return;
                  }
                  if (userOnwarn) {
                    userOnwarn(warning, defaultHandler);
                  } else {
                    defaultHandler(warning);
                  }
                };
              })(),
              // Enable aggressive tree-shaking for client builds.
              // See getClientTreeshakeConfigForVite JSDoc for rationale.
              // Only apply globally for standalone client builds (Pages Router
              // CLI). For multi-environment builds (App Router, Cloudflare),
              // treeshake is set per-environment on the client env below to
              // avoid leaking into RSC/SSR environments where
              // moduleSideEffects: 'no-external' could drop server packages
              // that rely on module-level side effects.
              ...(!isSSR && !isMultiEnv
                ? { treeshake: getClientTreeshakeConfigForVite(viteMajorVersion) }
                : {}),
              // Code-split client bundles: separate framework (React/ReactDOM),
              // vinext runtime (shims), and vendor packages into their own
              // chunks so pages only load the JS they need.
              // Only apply globally for standalone client builds (CLI Pages
              // Router). For multi-environment builds (App Router, Cloudflare),
              // manualChunks is set per-environment on the client env below
              // to avoid leaking into RSC/SSR environments.
              ...(!isSSR && !isMultiEnv
                ? { output: getClientOutputConfigForVite(viteMajorVersion) }
                : {}),
            }),
          },
          // Let OPTIONS requests pass through Vite's CORS middleware to our
          // route handlers so they can set the Allow header and run user-defined
          // OPTIONS handlers. Without this, Vite's CORS middleware responds to
          // OPTIONS with a 204 before the request reaches vinext's handler.
          // Keep Vite's default restrictive origin policy by explicitly
          // setting it. Without the `origin` field, `preflightContinue: true`
          // would override Vite's default and allow any origin.
          server: {
            cors: {
              preflightContinue: true,
              origin: /^https?:\/\/(?:(?:[^:]+\.)?localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/,
            },
          },
          // Configure SSR transform behaviour for Node targets.
          // - `external`: React packages are loaded natively by Node (CJS)
          //   rather than through Vite's ESM evaluator.
          // - `noExternal: true`: force everything else through Vite's
          //   transform pipeline so non-JS imports (CSS, images) from
          //   node_modules don't hit Node's native ESM loader.
          //   Any user-provided `ssr.noExternal` is intentionally superseded
          //   by this setting; only `ssr.external` entries escape Vite's transform.
          // Skip when targeting bundled runtimes (Cloudflare/Nitro bundle everything).
          // This also resolves extensionless-import issues in packages like
          // `validator` (see #189) by routing them through Vite's resolver.
          ...(hasCloudflarePlugin || hasNitroPlugin
            ? {}
            : {
                ssr: {
                  external: ["react", "react-dom", "react-dom/server"],
                  noExternal: true,
                },
              }),
          resolve: {
            // Materialize simple tsconfig/jsconfig path aliases into resolve.alias
            // so Vite can transform import.meta.glob("@/...") and import(`@/...`).
            alias: { ...tsconfigPathAliases, ...nextConfig.aliases, ...nextShimMap },
            // Dedupe React packages to prevent dual-instance errors.
            // When vinext is linked (npm link / bun link) or any dependency
            // brings its own React copy, multiple React instances can load,
            // causing cryptic "Invalid hook call" errors. This is a no-op
            // when only one copy exists.
            dedupe: ["react", "react-dom", "react/jsx-runtime", "react/jsx-dev-runtime"],
            ...(shouldEnableNativeTsconfigPaths ? { tsconfigPaths: true } : {}),
          },
          // NOTE: top-level optimizeDeps is now set below (after capturing
          // incoming values from earlier plugins) so both Pages Router and
          // App Router builds merge correctly.
          // Enable JSX in .tsx/.jsx files
          // Vite 7 uses `esbuild` for transforms, Vite 8+ uses `oxc`
          ...(viteMajorVersion >= 8
            ? { oxc: { jsx: { runtime: "automatic" } } }
            : { esbuild: { jsx: "automatic" } }),
          // Define env vars for client bundle
          define: defines,
          // Set base path if configured
          ...(nextConfig.basePath ? { base: nextConfig.basePath + "/" } : {}),
          // Inject resolved PostCSS plugins if string names were found
          ...(postcssOverride ? { css: { postcss: postcssOverride } } : {}),
        };

        // Collect user-provided ssr.external so we can propagate it into
        // both the RSC and SSR environment configs. Vite's `ssr.*` config
        // only applies to the default `ssr` environment, not custom ones
        // like `rsc`. Native addon packages (e.g. better-sqlite3) listed
        // in ssr.external must be externalized from ALL server environments.
        // Vite's SSROptions.external is `string[] | true`; handle both forms.
        //
        // Also merge in `serverExternalPackages` from next.config (and the
        // legacy `experimental.serverComponentsExternalPackages` alias). These
        // are packages that Next.js intentionally skips bundling and loads
        // natively — e.g. packages that import Node-specific entry points via
        // conditional exports (like `file-type` which exports `fileTypeFromFile`
        // only from its `node` condition, not from the universal `default` one).
        // Without externalizing them, Vite's optimizer picks the wrong export
        // condition and the build fails with MISSING_EXPORT errors.
        const nextServerExternal: string[] = nextConfig?.serverExternalPackages ?? [];
        const userSsrExternal: string[] | true = Array.isArray(config.ssr?.external)
          ? [...config.ssr.external, ...nextServerExternal]
          : config.ssr?.external === true
            ? true
            : nextServerExternal;

        // Capture top-level optimizeDeps populated by earlier plugins
        // (e.g. @lingui/vite-plugin) so we merge rather than overwrite.
        // Moved above the hasAppDir branch so both Pages Router and App
        // Router code paths can use these values.
        const incomingExclude: string[] =
          (config.optimizeDeps?.exclude as string[] | undefined) ?? [];
        const incomingInclude: string[] =
          (config.optimizeDeps?.include as string[] | undefined) ?? [];

        // Merge incoming excludes into the top-level optimizeDeps so
        // Pages Router builds (which don't set per-environment configs)
        // also preserve entries from earlier plugins.
        viteConfig.optimizeDeps = {
          exclude: [...new Set([...incomingExclude, "vinext", "@vercel/og"])],
          ...(incomingInclude.length > 0 ? { include: incomingInclude } : {}),
        };
        const pagesOptimizeEntries = !hasAppDir
          ? [
              ...(hasPagesDir
                ? [toRelativeFileEntry(root, pagesDir) + "/**/*.{tsx,ts,jsx,js}"]
                : []),
              ...[instrumentationPath, instrumentationClientPath].flatMap((entry) =>
                entry ? [toRelativeFileEntry(root, entry)] : [],
              ),
            ]
          : [];

        // If app/ directory exists, configure RSC environments
        if (hasAppDir) {
          // Compute optimizeDeps.entries so Vite discovers server-side
          // dependencies at startup instead of on first request. Without
          // this, deps imported in rsc/ssr environments are found lazily,
          // causing re-optimisation cascades and runtime errors (e.g.
          // "Invalid hook call" from duplicate React instances).
          // The entries must be relative to the project root.
          const relAppDir = path.relative(root, appDir);
          const appEntries = [`${relAppDir}/**/*.{tsx,ts,jsx,js}`];
          const explicitInstrumentationEntries = [
            instrumentationPath,
            instrumentationClientPath,
          ].flatMap((entry) => (entry ? [toRelativeFileEntry(root, entry)] : []));
          const optimizeEntries = [...new Set([...appEntries, ...explicitInstrumentationEntries])];

          viteConfig.environments = {
            rsc: {
              ...(hasCloudflarePlugin || hasNitroPlugin
                ? {}
                : {
                    resolve: {
                      // Externalize native/heavy packages so the RSC environment
                      // loads them natively via Node rather than through Vite's
                      // ESM module evaluator (which can't handle native addons).
                      // Note: Do NOT externalize react/react-dom here — they must
                      // be bundled with the "react-server" condition for RSC.
                      // Skip when targeting bundled runtimes (Cloudflare/Nitro).
                      external:
                        userSsrExternal === true
                          ? true
                          : ["satori", "@resvg/resvg-js", "yoga-wasm-web", ...userSsrExternal],
                      // Force all node_modules through Vite's transform pipeline
                      // so non-JS imports (CSS, images) don't hit Node's native
                      // ESM loader. Matches Next.js behavior of bundling everything.
                      // Packages in `external` above take precedence per Vite rules.
                      // When user sets `ssr.external: true`, skip noExternal since
                      // everything is already externalized.
                      ...(userSsrExternal === true ? {} : { noExternal: true as const }),
                    },
                  }),
              optimizeDeps: {
                exclude: [...new Set([...incomingExclude, "vinext", "@vercel/og"])],
                entries: optimizeEntries,
              },
              build: {
                outDir: options.rscOutDir ?? "dist/server",
                ...withBuildBundlerOptions(viteMajorVersion, {
                  input: { index: VIRTUAL_RSC_ENTRY },
                }),
              },
            },
            ssr: {
              ...(hasCloudflarePlugin || hasNitroPlugin
                ? {}
                : {
                    resolve: {
                      external: userSsrExternal === true ? true : [...userSsrExternal],
                      // Force all node_modules through Vite's transform pipeline
                      // so non-JS imports (CSS, images) don't hit Node's native
                      // ESM loader. Matches Next.js behavior of bundling everything.
                      // When user sets `ssr.external: true`, skip noExternal since
                      // everything is already externalized.
                      ...(userSsrExternal === true ? {} : { noExternal: true as const }),
                    },
                  }),
              optimizeDeps: {
                exclude: [...new Set([...incomingExclude, "vinext", "@vercel/og"])],
                entries: optimizeEntries,
              },
              build: {
                outDir: options.ssrOutDir ?? "dist/server/ssr",
                ...withBuildBundlerOptions(viteMajorVersion, {
                  input: { index: VIRTUAL_APP_SSR_ENTRY },
                }),
              },
            },
            client: {
              // Explicitly mark as client consumer so other plugins (e.g. Nitro)
              // can detect this during configEnvironment hooks — before Vite
              // applies the default consumer based on environment name.
              // Without this, Nitro's configEnvironment creates a server-side
              // service for the client environment, causing virtual module
              // imports to leak to Node's native ESM loader (ERR_UNSUPPORTED_ESM_URL_SCHEME).
              consumer: "client",
              optimizeDeps: {
                // Exclude server-external packages from the client dep optimizer.
                // These packages are server-only by design (listed in next.config's
                // `serverExternalPackages`). If the client optimizer crawls into
                // them through app/ entries, it will use browser export conditions
                // and pick the wrong conditional export (e.g. `file-type` exports
                // `fileTypeFromFile` only from its `node` condition via `index.js`,
                // but the browser optimizer resolves to `core.js` which lacks it,
                // causing MISSING_EXPORT build failures).
                exclude: [
                  ...new Set([...incomingExclude, "vinext", "@vercel/og", ...nextServerExternal]),
                ],
                // Crawl app/ source files up front so client-only deps imported
                // by user components are discovered during startup instead of
                // triggering a late re-optimisation + full page reload.
                entries: optimizeEntries,
                // React packages aren't crawled from app/ source files,
                // so must be pre-included to avoid late discovery (#25).
                include: [
                  ...new Set([
                    ...incomingInclude,
                    "react",
                    "react-dom",
                    "react-dom/client",
                    "react/jsx-runtime",
                    "react/jsx-dev-runtime",
                  ]),
                ],
              },
              build: {
                // When targeting Cloudflare Workers, enable manifest generation
                // so the vinext:cloudflare-build closeBundle hook can read the
                // client build manifest, compute lazy chunks (only reachable
                // via dynamic imports), and inject __VINEXT_LAZY_CHUNKS__ into
                // the worker entry. Without this, all chunks are modulepreloaded
                // on every page — defeating code-splitting for React.lazy() and
                // next/dynamic boundaries.
                ...(hasCloudflarePlugin ? { manifest: true } : {}),
                ...withBuildBundlerOptions(viteMajorVersion, {
                  input: { index: VIRTUAL_APP_BROWSER_ENTRY },
                  output: getClientOutputConfigForVite(viteMajorVersion),
                  treeshake: getClientTreeshakeConfigForVite(viteMajorVersion),
                }),
              },
            },
          };
        } else if (hasCloudflarePlugin) {
          // Pages Router on Cloudflare Workers: add a client environment
          // so the multi-environment build produces client JS bundles
          // alongside the worker. Without this, only the worker is built
          // and there's no client-side hydration.
          viteConfig.environments = {
            client: {
              consumer: "client",
              optimizeDeps:
                pagesOptimizeEntries.length > 0 ? { entries: pagesOptimizeEntries } : undefined,
              build: {
                manifest: true,
                ssrManifest: true,
                ...withBuildBundlerOptions(viteMajorVersion, {
                  input: { index: VIRTUAL_CLIENT_ENTRY },
                  output: getClientOutputConfigForVite(viteMajorVersion),
                  treeshake: getClientTreeshakeConfigForVite(viteMajorVersion),
                }),
              },
            },
          };
        } else if (!isSSR && !getBuildBundlerOptions(config.build)?.input) {
          // Plain Pages Router (Node): define client + ssr environments so
          // createBuilder + buildApp() produces both dist/client and
          // dist/server/entry.js. Without this, buildApp() only sees the
          // default client environment and never builds the server entry.
          // Guard with !isSSR and no explicit input so legacy vite.build()
          // calls that specify their own input (tests, hybrid build step)
          // still work via the single-build path — injecting environments
          // alongside an explicit build input conflicts with the caller's intent.
          viteConfig.environments = {
            client: {
              consumer: "client",
              optimizeDeps:
                pagesOptimizeEntries.length > 0 ? { entries: pagesOptimizeEntries } : undefined,
              build: {
                outDir: "dist/client",
                manifest: true,
                ssrManifest: true,
                ...withBuildBundlerOptions(viteMajorVersion, {
                  input: { index: VIRTUAL_CLIENT_ENTRY },
                  output: getClientOutputConfigForVite(viteMajorVersion),
                  treeshake: getClientTreeshakeConfigForVite(viteMajorVersion),
                }),
              },
            },
            ssr: {
              resolve: {
                external: ["react", "react-dom", "react-dom/server"],
                noExternal: true as const,
              },
              build: {
                outDir: "dist/server",
                ...withBuildBundlerOptions(viteMajorVersion, {
                  input: { index: VIRTUAL_SERVER_ENTRY },
                  output: {
                    entryFileNames: "entry.js",
                  },
                }),
              },
            },
          };
        }

        if (pagesOptimizeEntries.length > 0 && !hasCloudflarePlugin) {
          viteConfig.optimizeDeps = {
            ...viteConfig.optimizeDeps,
            entries: pagesOptimizeEntries,
          };
        }

        return viteConfig;
      },

      configResolved(config) {
        // Detect double React plugin registration. When vinext auto-injects
        // @vitejs/plugin-react AND the user also registers it manually, the
        // React transform / refresh pipeline runs twice.
        if (reactPluginPromise) {
          // Assumes @vitejs/plugin-react top-level plugin names continue to use
          // the vite:react* prefix across supported versions.
          const reactRootPlugins = config.plugins.filter(
            (p: unknown) =>
              p &&
              typeof p === "object" &&
              "name" in p &&
              typeof p.name === "string" &&
              p.name.startsWith("vite:react"),
          );
          const counts = new Map<string, number>();
          for (const plugin of reactRootPlugins) {
            counts.set(plugin.name, (counts.get(plugin.name) ?? 0) + 1);
          }
          const hasDuplicateReactPlugin = [...counts.values()].some((count) => count > 1);
          if (hasDuplicateReactPlugin) {
            throw new Error(
              "[vinext] Duplicate @vitejs/plugin-react detected.\n" +
                "         vinext auto-registers @vitejs/plugin-react by default.\n" +
                "         Your config also registers it manually, which duplicates React transforms.\n\n" +
                "         Fix: remove the explicit react() call from your plugins array.\n" +
                "         Or: pass react: false to vinext() if you want to configure react() yourself.",
            );
          }
        }

        // Detect double RSC plugin registration. When vinext auto-injects
        // @vitejs/plugin-rsc AND the user also registers it manually, the
        // RSC transform pipeline runs twice — doubling build time.
        // Rather than trying to magically fix this at runtime, fail fast
        // with a clear error telling the user how to fix their config.
        if (rscPluginPromise) {
          // Count top-level RSC plugins (name === "rsc") — each call to
          // the rsc() factory produces exactly one plugin with this name.
          const rscRootPlugins = config.plugins.filter(
            (p: unknown) => p && typeof p === "object" && "name" in p && p.name === "rsc",
          );
          if (rscRootPlugins.length > 1) {
            throw new Error(
              "[vinext] Duplicate @vitejs/plugin-rsc detected.\n" +
                "         vinext auto-registers @vitejs/plugin-rsc when app/ is detected.\n" +
                "         Your config also registers it manually, which doubles build time.\n\n" +
                "         Fix: remove the explicit rsc() call from your plugins array.\n" +
                "         Or: pass rsc: false to vinext() if you want to configure rsc() yourself.",
            );
          }
        }

        // Fail the build when targeting Cloudflare Workers without the
        // cloudflare() plugin. Without it, wrangler's esbuild can't resolve
        // virtual:vinext-rsc-entry and produces a cryptic error. (#325)
        if (
          config.command === "build" &&
          !hasCloudflarePlugin &&
          !hasNitroPlugin &&
          hasWranglerConfig(root) &&
          !options.disableAppRouter
        ) {
          throw new Error(
            formatMissingCloudflarePluginError({
              isAppRouter: hasAppDir,
              configFile: config.configFile,
            }),
          );
        }
      },

      resolveId: {
        // Hook filter: only invoke JS for next/* imports and virtual:vinext-* modules.
        // Matches "next/navigation", "next/router.js", "virtual:vinext-rsc-entry",
        // and \0-prefixed re-imports from @vitejs/plugin-rsc.
        filter: {
          id: /(?:next\/|virtual:vinext-)/,
        },
        handler(id) {
          // Strip \0 prefix if present — @vitejs/plugin-rsc's generated
          // browser entry imports our virtual module using the already-resolved
          // ID (with \0 prefix). We need to re-resolve it so the client
          // environment's import-analysis can find it.
          const cleanId = id.startsWith("\0") ? id.slice(1) : id;

          // Pages Router virtual modules
          if (cleanId === VIRTUAL_SERVER_ENTRY) return RESOLVED_SERVER_ENTRY;
          if (cleanId === VIRTUAL_CLIENT_ENTRY) return RESOLVED_CLIENT_ENTRY;
          if (
            cleanId.endsWith("/" + VIRTUAL_SERVER_ENTRY) ||
            cleanId.endsWith("\\" + VIRTUAL_SERVER_ENTRY)
          ) {
            return RESOLVED_SERVER_ENTRY;
          }
          if (
            cleanId.endsWith("/" + VIRTUAL_CLIENT_ENTRY) ||
            cleanId.endsWith("\\" + VIRTUAL_CLIENT_ENTRY)
          ) {
            return RESOLVED_CLIENT_ENTRY;
          }
          // App Router virtual modules
          if (cleanId === VIRTUAL_RSC_ENTRY) return RESOLVED_RSC_ENTRY;
          if (cleanId === VIRTUAL_APP_SSR_ENTRY) return RESOLVED_APP_SSR_ENTRY;
          if (cleanId === VIRTUAL_APP_BROWSER_ENTRY) return RESOLVED_APP_BROWSER_ENTRY;
          if (cleanId.startsWith(VIRTUAL_GOOGLE_FONTS + "?")) {
            return RESOLVED_VIRTUAL_GOOGLE_FONTS + cleanId.slice(VIRTUAL_GOOGLE_FONTS.length);
          }
          if (
            cleanId.endsWith("/" + VIRTUAL_RSC_ENTRY) ||
            cleanId.endsWith("\\" + VIRTUAL_RSC_ENTRY)
          ) {
            return RESOLVED_RSC_ENTRY;
          }
          if (
            cleanId.endsWith("/" + VIRTUAL_APP_SSR_ENTRY) ||
            cleanId.endsWith("\\" + VIRTUAL_APP_SSR_ENTRY)
          ) {
            return RESOLVED_APP_SSR_ENTRY;
          }
          if (
            cleanId.endsWith("/" + VIRTUAL_APP_BROWSER_ENTRY) ||
            cleanId.endsWith("\\" + VIRTUAL_APP_BROWSER_ENTRY)
          ) {
            return RESOLVED_APP_BROWSER_ENTRY;
          }
          if (
            cleanId.includes("/" + VIRTUAL_GOOGLE_FONTS + "?") ||
            cleanId.includes("\\" + VIRTUAL_GOOGLE_FONTS + "?")
          ) {
            const queryIndex = cleanId.indexOf(VIRTUAL_GOOGLE_FONTS + "?");
            return (
              RESOLVED_VIRTUAL_GOOGLE_FONTS +
              cleanId.slice(queryIndex + VIRTUAL_GOOGLE_FONTS.length)
            );
          }
        },
      },

      async load(id) {
        // Pages Router virtual modules
        if (id === RESOLVED_SERVER_ENTRY) {
          return await generateServerEntry();
        }
        if (id === RESOLVED_CLIENT_ENTRY) {
          return await generateClientEntry();
        }
        // App Router virtual modules
        if (id === RESOLVED_RSC_ENTRY && hasAppDir) {
          const routes = await appRouter(appDir, nextConfig?.pageExtensions, fileMatcher);
          const metaRoutes = scanMetadataFiles(appDir);
          // Check for global-error.tsx at app root
          const globalErrorPath = findFileWithExts(appDir, "global-error", fileMatcher);
          return generateRscEntry(
            appDir,
            routes,
            middlewarePath,
            metaRoutes,
            globalErrorPath,
            nextConfig?.basePath,
            nextConfig?.trailingSlash,
            {
              redirects: nextConfig?.redirects,
              rewrites: nextConfig?.rewrites,
              headers: nextConfig?.headers,
              allowedOrigins: nextConfig?.serverActionsAllowedOrigins,
              allowedDevOrigins: nextConfig?.allowedDevOrigins,
              bodySizeLimit: nextConfig?.serverActionsBodySizeLimit,
              i18n: nextConfig?.i18n,
              hasPagesDir,
            },
            instrumentationPath,
          );
        }
        if (id === RESOLVED_APP_SSR_ENTRY && hasAppDir) {
          return generateSsrEntry(hasPagesDir);
        }
        if (id === RESOLVED_APP_BROWSER_ENTRY && hasAppDir) {
          return generateBrowserEntry();
        }
        if (id.startsWith(RESOLVED_VIRTUAL_GOOGLE_FONTS + "?")) {
          return generateGoogleFontsVirtualModule(id, _fontGoogleShimPath);
        }
      },
    },
    // Stub node:async_hooks in client builds — see src/plugins/async-hooks-stub.ts
    asyncHooksStubPlugin,
    createInstrumentationClientTransformPlugin(() => instrumentationClientPath),
    // Dedup client references from RSC proxy modules — see src/plugins/client-reference-dedup.ts
    ...(options.experimental?.clientReferenceDedup ? [clientReferenceDedupPlugin()] : []),
    // Proxy plugin for @mdx-js/rollup. The real MDX plugin is created lazily
    // during vinext:config's config() (when MDX files are detected), but
    // plugins returned from config() hooks run too late in the pipeline —
    // after vite:import-analysis. This top-level proxy with enforce:"pre"
    // ensures MDX transforms run at the correct stage. Both vinext:config
    // and this proxy are enforce:"pre", and vinext:config comes first in
    // the array, so mdxDelegate is already set when this proxy's hooks fire.
    {
      name: "vinext:mdx",
      enforce: "pre",
      config(config, env) {
        if (!mdxDelegate?.config) return;
        const hook = mdxDelegate.config;
        const fn = typeof hook === "function" ? hook : hook.handler;
        return fn.call(this, config, env);
      },
      async transform(code, id, options) {
        // Skip ?raw and other query imports — @mdx-js/rollup ignores the query
        // and would compile the file as MDX instead of returning raw text.
        if (id.includes("?")) return;
        // Case-insensitive extension check for cross-platform compatibility
        // (Windows/macOS case-insensitive, Linux case-sensitive)
        if (!id.toLowerCase().endsWith(".mdx")) return;

        const delegate = mdxDelegate ?? (await ensureMdxDelegate("on-demand"));
        if (delegate?.transform) {
          const hook = delegate.transform;
          const transform = typeof hook === "function" ? hook : hook.handler;
          return transform.call(this, code, id, options);
        }

        if (!hasUserMdxPlugin) {
          throw new Error(
            `[vinext] Encountered MDX module ${id} but no MDX plugin is configured. ` +
              `Install @mdx-js/rollup or register an MDX plugin manually.`,
          );
        }
      },
    },
    // Shim React canary/experimental APIs (ViewTransition, addTransitionType)
    // that exist in Next.js's bundled React canary but not in stable React 19.
    // Provides graceful no-op fallbacks so projects using these APIs degrade
    // instead of crashing with "does not provide an export named 'ViewTransition'".
    {
      name: "vinext:react-canary",
      enforce: "pre",

      resolveId(id) {
        if (id === "virtual:vinext-react-canary") return "\0virtual:vinext-react-canary";
      },

      load(id) {
        if (id === "\0virtual:vinext-react-canary") {
          return [
            `export * from "react";`,
            `export { default } from "react";`,
            `import * as _React from "react";`,
            `export const ViewTransition = _React.ViewTransition || function ViewTransition({ children }) { return children; };`,
            `export const addTransitionType = _React.addTransitionType || function addTransitionType() {};`,
          ].join("\n");
        }
      },

      transform(code, id) {
        // Only transform user source files, not node_modules or virtual modules
        if (id.includes("node_modules")) return null;
        if (id.startsWith("\0")) return null;
        if (!/\.(tsx?|jsx?|mjs)$/.test(id)) return null;

        // Quick check: does this file reference canary APIs and import from "react"?
        if (
          !(code.includes("ViewTransition") || code.includes("addTransitionType")) ||
          !/from\s+['"]react['"]/.test(code)
        ) {
          return null;
        }

        // Only rewrite if the import actually destructures a canary API
        const canaryImportRegex =
          /import\s*\{[^}]*(ViewTransition|addTransitionType)[^}]*\}\s*from\s*['"]react['"]/;
        if (!canaryImportRegex.test(code)) return null;

        // Rewrite all `from "react"` / `from 'react'` to use the canary shim.
        // This is safe because the virtual module re-exports everything from
        // react, so non-canary imports continue to work.
        const result = code.replace(/from\s*['"]react['"]/g, 'from "virtual:vinext-react-canary"');
        if (result !== code) {
          return { code: result, map: null };
        }
        return null;
      },
    },
    {
      name: "vinext:pages-router",

      // HMR: trigger full-reload for Pages Router page changes.
      // Even with @vitejs/plugin-react providing React Fast Refresh,
      // the Pages Router injects hydration via inline <script type="module">
      // which may not be tracked in Vite's module graph. Explicitly
      // sending full-reload ensures changes are always reflected in
      // the browser.
      hotUpdate(options: { file: string; server: ViteDevServer; modules: unknown[] }) {
        if (!hasPagesDir || hasAppDir) return;
        if (options.file.startsWith(pagesDir) && fileMatcher.extensionRegex.test(options.file)) {
          options.server.environments.client.hot.send({ type: "full-reload" });
          return [];
        }
      },

      configureServer(server: ViteDevServer) {
        // Watch pages directory for file additions/removals to invalidate route cache.
        const pageExtensions = fileMatcher.extensionRegex;

        // Build a long-lived ModuleRunner for loading all Pages Router modules
        // (middleware, API routes, SSR page rendering) on every request.
        //
        // We must NOT use server.ssrLoadModule() here: when @cloudflare/vite-plugin
        // is present its environments replace the SSR transport, causing
        // SSRCompatModuleRunner to crash with:
        //   TypeError: Cannot read properties of undefined (reading 'outsideEmitter')
        // on the very first request.
        //
        // createDirectRunner() builds a runner on environment.fetchModule() which
        // is a plain async method — safe with all plugin combinations, including
        // @cloudflare/vite-plugin.
        //
        // The runner is created lazily on first use so that all environments are
        // fully registered before we inspect them. We prefer "ssr", then any
        // non-"rsc" environment, then whatever is available.
        let pagesRunner: import("vite/module-runner").ModuleRunner | null = null;
        function getPagesRunner() {
          if (!pagesRunner) {
            const env =
              server.environments["ssr"] ??
              Object.values(server.environments).find((e) => e !== server.environments["rsc"]) ??
              Object.values(server.environments)[0];
            pagesRunner = createDirectRunner(env);
          }
          return pagesRunner;
        }

        /**
         * Invalidate the virtual RSC entry module in Vite's module graph.
         *
         * The App Router route table is baked into the virtual RSC entry
         * at generation time. When routes are added or removed, clearing
         * the route cache alone is not enough: the virtual module must
         * also be invalidated so Vite re-calls the load() hook to
         * regenerate the entry with the updated route table.
         */
        function invalidateRscEntryModule() {
          const rscEnv = server.environments["rsc"];
          if (!rscEnv) return;
          const mod = rscEnv.moduleGraph.getModuleById(RESOLVED_RSC_ENTRY);
          if (mod) {
            rscEnv.moduleGraph.invalidateModule(mod);
            rscEnv.hot.send({ type: "full-reload" });
          }
        }

        server.watcher.on("add", (filePath: string) => {
          if (hasPagesDir && filePath.startsWith(pagesDir) && pageExtensions.test(filePath)) {
            invalidateRouteCache(pagesDir);
          }
          if (hasAppDir && filePath.startsWith(appDir) && pageExtensions.test(filePath)) {
            invalidateAppRouteCache();
            invalidateRscEntryModule();
          }
        });
        server.watcher.on("unlink", (filePath: string) => {
          if (hasPagesDir && filePath.startsWith(pagesDir) && pageExtensions.test(filePath)) {
            invalidateRouteCache(pagesDir);
          }
          if (hasAppDir && filePath.startsWith(appDir) && pageExtensions.test(filePath)) {
            invalidateAppRouteCache();
            invalidateRscEntryModule();
          }
        });

        // ── Dev request origin check ─────────────────────────────────────
        // Registered directly (not in the returned function) so it runs
        // BEFORE Vite's built-in middleware. This ensures all requests
        // (including /@*, /__vite*, /node_modules* paths) are validated
        // before Vite serves any content.
        server.middlewares.use((req, res, next) => {
          const blockReason = validateDevRequest(
            {
              origin: req.headers.origin as string | undefined,
              host: req.headers.host,
              "x-forwarded-host": req.headers["x-forwarded-host"] as string | undefined,
              "sec-fetch-site": req.headers["sec-fetch-site"] as string | undefined,
              "sec-fetch-mode": req.headers["sec-fetch-mode"] as string | undefined,
            },
            nextConfig?.allowedDevOrigins,
          );
          if (blockReason) {
            console.warn(`[vinext] Blocked dev request: ${blockReason} (${req.url})`);
            res.writeHead(403, { "Content-Type": "text/plain" });
            res.end("Forbidden");
            return;
          }
          next();
        });

        // Return a function to register middleware AFTER Vite's built-in middleware
        return () => {
          // Run instrumentation.ts register() if present (once at server startup).
          // Must be inside the returned function so that all environments are
          // fully registered before getPagesRunner() inspects them.
          //
          // App Router: register() is baked into the generated RSC entry as a
          // top-level await, so it runs inside the Worker process (or RSC Vite
          // environment) — the same process as request handling. Calling
          // runInstrumentation() here too would run it a second time in the host
          // process, which is wrong when @cloudflare/vite-plugin is present.
          //
          // Pages Router prod: register() is baked into generateServerEntry() as
          // a top-level await, so it runs inside the Worker bundle — the same
          // process as request handling. configureServer() is never called during
          // a prod build, so there is no double-invocation risk there either.
          //
          // We pass getPagesRunner() (createDirectRunner) rather than server so
          // that this is safe when @cloudflare/vite-plugin is present. That
          // plugin replaces the SSR environment's hot channel, causing
          // server.ssrLoadModule() to crash with outsideEmitter. The runner
          // calls environment.fetchModule() directly and never touches the hot
          // channel, making it safe with all Vite plugin combinations.
          if (instrumentationPath && !hasAppDir) {
            runInstrumentation(getPagesRunner(), instrumentationPath).catch((err) => {
              console.error("[vinext] Instrumentation error:", err);
            });
          }
          // App Router request logging in dev server
          //
          // For App Router, the RSC plugin handles requests internally.
          // We install a timing middleware here that:
          //   1. Intercepts writeHead() to pluck the X-Vinext-Timing header
          //      (compileMs,renderMs) that the RSC entry attaches before
          //      it is flushed to the client.
          //   2. Logs the full request after res finishes, using those timings.
          if (hasAppDir) {
            server.middlewares.use((req, res, next) => {
              const url = req.url ?? "/";
              // Skip Vite internals, HMR, and static assets.
              // Do NOT skip .rsc-suffixed URLs or RSC wire requests (Accept: text/x-component)
              // — those are soft navigations and should be logged like any other page request.
              const [pathname] = url.split("?");
              if (
                url.startsWith("/@") ||
                url.startsWith("/__vite") ||
                url.startsWith("/node_modules") ||
                (url.includes(".") && !pathname.endsWith(".html") && !pathname.endsWith(".rsc"))
              ) {
                return next();
              }
              const _reqStart = now();
              let _compileMs: number | undefined;
              let _renderMs: number | undefined;

              // Intercept setHeader and writeHead so we can strip X-Vinext-Timing
              // before it reaches the client and capture the compile/render split.
              // The RSC plugin may set headers either way depending on its version.
              // Parse the three-part X-Vinext-Timing header:
              //   "handlerStart,inHandlerCompileMs,renderMs"
              //
              // True compile time = time the RSC plugin spent loading/transforming
              // modules before our handler code ran, plus any in-handler work before
              // renderToReadableStream. Concretely:
              //   compileMs = (handlerStart - _reqStart) + inHandlerCompileMs
              //   renderMs  = renderMs from header, or -1 for RSC-only (soft-nav)
              //               responses where rendering is not measured in the handler.
              //               In that case the middleware computes render time as
              //               totalMs - compileMs.
              //
              // handlerStart is performance.now() recorded at the very top of
              // _handleRequest in the generated RSC entry. _reqStart is recorded
              // here in the Node middleware, one stack frame before the RSC plugin
              // loads the module. The gap between them is exactly the Vite
              // compile/transform cost.
              function _parseTiming(raw: unknown) {
                const [handlerStart, inHandlerCompileMs, renderMs] = String(raw)
                  .split(",")
                  .map((v) => Number(v));
                if (
                  !Number.isNaN(handlerStart) &&
                  !Number.isNaN(inHandlerCompileMs) &&
                  inHandlerCompileMs !== -1
                ) {
                  _compileMs =
                    Math.max(0, Math.round(handlerStart - _reqStart)) + inHandlerCompileMs;
                }
                if (!Number.isNaN(renderMs) && renderMs !== -1) {
                  _renderMs = renderMs;
                }
              }

              const _origSetHeader = res.setHeader.bind(res);
              res.setHeader = function (name, value) {
                if (name.toLowerCase() === "x-vinext-timing") {
                  _parseTiming(value);
                  return res; // drop the header — don't forward to client
                }
                return _origSetHeader(name, value);
              };

              const _origWriteHead = res.writeHead.bind(res);
              // oxlint-disable-next-line typescript/no-explicit-any
              res.writeHead = function (statusCode, ...args: any[]) {
                // Normalise the optional headers argument (may be reason, headers object, or both).
                let headers: Record<string, unknown> | undefined;
                const [reasonOrHeaders, maybeHeaders] = args;
                if (typeof reasonOrHeaders === "string") {
                  headers = maybeHeaders;
                } else {
                  headers = reasonOrHeaders;
                }

                // Pull timing out of the headers object when present.
                if (headers && typeof headers === "object" && !Array.isArray(headers)) {
                  const timingKey = Object.keys(headers).find(
                    (k) => k.toLowerCase() === "x-vinext-timing",
                  );
                  if (timingKey) {
                    _parseTiming(headers[timingKey]);
                    delete headers[timingKey];
                  }
                }

                return _origWriteHead(statusCode, ...args);
              };

              res.on("finish", () => {
                // Strip .rsc suffix — it's an internal RSC protocol detail,
                // not part of the actual page path the user navigated to.
                const logUrl = url.replace(/\.rsc(\?|$)/, "$1");
                const totalMs = now() - _reqStart;

                // For RSC-only responses (soft nav), renderMs is -1 (sentinel meaning
                // "not measured in the handler"). Compute it as totalMs - compileMs,
                // which is how long the RSC stream took to fully flush to the client —
                // matching what Next.js shows for soft navigations.
                const resolvedRenderMs =
                  _renderMs !== undefined
                    ? _renderMs
                    : _compileMs !== undefined
                      ? Math.max(0, Math.round(totalMs - _compileMs))
                      : undefined;

                logRequest({
                  method: req.method ?? "GET",
                  url: logUrl,
                  status: res.statusCode,
                  totalMs,
                  compileMs: _compileMs,
                  renderMs: resolvedRenderMs,
                });
              });

              next();
            });
          }

          server.middlewares.use(async (req, res, next) => {
            try {
              let url: string = req.url ?? "/";

              // If no pages directory, skip this middleware entirely
              // (app router is handled by @vitejs/plugin-rsc's built-in middleware)
              if (!hasPagesDir) return next();

              // Skip Vite internal requests and static files
              if (
                url.startsWith("/@") ||
                url.startsWith("/__vite") ||
                url.startsWith("/node_modules")
              ) {
                return next();
              }

              // Skip .rsc requests — those are for the App Router RSC handler
              if (url.split("?")[0].endsWith(".rsc")) {
                return next();
              }

              // ── Cross-origin request protection (defense-in-depth) ──────
              // The pre-Vite middleware above already blocks cross-origin
              // requests before Vite serves any content. This second check
              // guards the Pages Router handler specifically, in case the
              // middleware ordering changes or new middleware is added between
              // the two. Both calls use the same validateDevRequest() function.
              const blockReason = validateDevRequest(
                {
                  origin: req.headers.origin as string | undefined,
                  host: req.headers.host,
                  "x-forwarded-host": req.headers["x-forwarded-host"] as string | undefined,
                  "sec-fetch-site": req.headers["sec-fetch-site"] as string | undefined,
                  "sec-fetch-mode": req.headers["sec-fetch-mode"] as string | undefined,
                },
                nextConfig?.allowedDevOrigins,
              );
              if (blockReason) {
                console.warn(`[vinext] Blocked dev request: ${blockReason} (${url})`);
                res.writeHead(403, { "Content-Type": "text/plain" });
                res.end("Forbidden");
                return;
              }

              // ── Image optimization passthrough (dev mode) ─────────────
              // In dev, redirect to the original asset URL so Vite serves it.
              if (url.split("?")[0] === "/_vinext/image") {
                const imgParams = new URLSearchParams(url.split("?")[1] ?? "");
                const rawImgUrl = imgParams.get("url");
                // Normalize backslashes: browsers and the URL constructor treat
                // /\evil.com as //evil.com, bypassing the // check.
                const imgUrl = rawImgUrl?.replaceAll("\\", "/") ?? null;
                // Allowlist: must start with "/" but not "//" — blocks absolute
                // URLs, protocol-relative, backslash variants, and exotic schemes.
                // Also block internal Vite paths (/@*, /__vite*, /node_modules*)
                // to prevent redirecting to dev server endpoints.
                if (
                  !imgUrl ||
                  !imgUrl.startsWith("/") ||
                  imgUrl.startsWith("//") ||
                  imgUrl.startsWith("/@") ||
                  imgUrl.startsWith("/__vite") ||
                  imgUrl.startsWith("/node_modules")
                ) {
                  res.writeHead(400);
                  res.end(!rawImgUrl ? "Missing url parameter" : "Only relative URLs allowed");
                  return;
                }
                // Validate the constructed URL's origin hasn't changed (defense in depth).
                const resolvedImg = new URL(imgUrl, `http://${req.headers.host || "localhost"}`);
                if (resolvedImg.origin !== `http://${req.headers.host || "localhost"}`) {
                  res.writeHead(400);
                  res.end("Only relative URLs allowed");
                  return;
                }
                const encodedLocation = resolvedImg.pathname + resolvedImg.search;
                res.writeHead(302, { Location: encodedLocation });
                res.end();
                return;
              }

              // Vite's built-in middleware may rewrite "/" to "/index.html".
              // Normalize it back so our router can match correctly.
              const rawPathname = url.split("?")[0];
              if (rawPathname.endsWith("/index.html")) {
                url = url.replace("/index.html", "/");
              } else if (rawPathname.endsWith(".html")) {
                // Strip .html extensions (e.g. "/about.html" -> "/about")
                url = url.replace(/\.html(?=\?|$)/, "");
              }

              // Skip requests for files with extensions (static assets)
              let pathname = url.split("?")[0];
              if (pathname.includes(".") && !pathname.endsWith(".html")) {
                return next();
              }

              // Guard against protocol-relative URL open redirects.
              // Normalize backslashes first: browsers treat /\ as // in URL
              // context. Check the RAW pathname before normalizePath so the
              // guard fires before normalizePath collapses //.
              pathname = pathname.replaceAll("\\", "/");
              if (pathname.startsWith("//")) {
                res.writeHead(404);
                res.end("404 Not Found");
                return;
              }

              // Normalize the pathname to prevent path-confusion attacks.
              // decodeURIComponent prevents /%61dmin bypassing /admin matchers.
              // normalizePath collapses // and resolves . / .. segments.
              try {
                pathname = normalizePath(normalizePathnameForRouteMatchStrict(pathname));
              } catch {
                // Malformed percent-encoding (e.g. /%E0%A4%A) — return 400 instead of crashing.
                res.writeHead(400);
                res.end("Bad Request");
                return;
              }

              // Strip basePath prefix from URL for route matching.
              // All internal routing uses basePath-free paths.
              //
              // NOTE: When basePath is set, we also set Vite's `base` config to
              // `basePath + "/"`. Vite's connect middleware stack strips the base
              // prefix from req.url before passing it to our middleware, so the
              // URL will already lack the basePath prefix. We still attempt to
              // strip it (for robustness) but don't reject paths that don't start
              // with basePath — Vite has already done the filtering.
              const bp = nextConfig?.basePath ?? "";
              if (bp && pathname.startsWith(bp)) {
                const stripped = pathname.slice(bp.length) || "/";
                const qs = url.includes("?") ? url.slice(url.indexOf("?")) : "";
                url = stripped + qs;
                pathname = stripped;
              }

              // Normalize trailing slash based on next.config.js trailingSlash setting.
              // Redirect to the canonical form if needed.
              if (
                nextConfig &&
                pathname !== "/" &&
                pathname !== "/api" &&
                !pathname.startsWith("/api/")
              ) {
                const hasTrailing = pathname.endsWith("/");
                if (nextConfig.trailingSlash && !hasTrailing) {
                  // trailingSlash: true — redirect /about → /about/
                  const qs = url.includes("?") ? url.slice(url.indexOf("?")) : "";
                  const dest = bp + pathname + "/" + qs;
                  res.writeHead(308, { Location: dest });
                  res.end();
                  return;
                } else if (!nextConfig.trailingSlash && hasTrailing) {
                  // trailingSlash: false (default) — redirect /about/ → /about
                  const qs = url.includes("?") ? url.slice(url.indexOf("?")) : "";
                  const dest = bp + pathname.replace(/\/+$/, "") + qs;
                  res.writeHead(308, { Location: dest });
                  res.end();
                  return;
                }
              }

              // When @cloudflare/vite-plugin is present, delegate the entire
              // Pages Router request pipeline to the Worker/miniflare side.
              // That keeps middleware, headers, redirects, rewrites, API
              // routes, and rendering in one place instead of mutating the
              // host request and forwarding post-middleware state downstream.
              if (hasCloudflarePlugin) return next();

              // Snapshot of req.headers before middleware runs. Used for both
              // preMiddlewareReqCtx and the middleware Request itself. Intentionally
              // captured once here — applyRequestHeadersToNodeRequest() mutates
              // req.headers later, but by then this Headers object is no longer read.
              const nodeRequestHeaders = new Headers(
                Object.fromEntries(
                  Object.entries(req.headers)
                    .filter(([, v]) => v !== undefined)
                    .map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : String(v)]),
                ),
              );

              const requestOrigin = `http://${req.headers.host || "localhost"}`;
              const preMiddlewareReqUrl = new URL(url, requestOrigin);
              const preMiddlewareReqCtx: RequestContext = requestContextFromRequest(
                new Request(preMiddlewareReqUrl, { headers: nodeRequestHeaders }),
              );

              // Config redirects run before middleware, but still match against
              // the original normalized pathname and request headers/cookies.
              if (nextConfig?.redirects.length) {
                const redirected = applyRedirects(
                  pathname,
                  res,
                  nextConfig.redirects,
                  preMiddlewareReqCtx,
                  nextConfig.basePath ?? "",
                );
                if (redirected) return;
              }

              const applyRequestHeadersToNodeRequest = (nextRequestHeaders: Headers) => {
                for (const key of Object.keys(req.headers)) {
                  delete req.headers[key];
                }
                for (const [key, value] of nextRequestHeaders) {
                  req.headers[key] = value;
                }
              };

              let middlewareRequestHeaders: Headers | null = null;
              let deferredMwResponseHeaders: [string, string][] | null = null;

              const applyDeferredMwHeaders = () => {
                if (deferredMwResponseHeaders) {
                  for (const [key, value] of deferredMwResponseHeaders) {
                    res.appendHeader(key, value);
                  }
                }
              };

              // Run middleware.ts if present
              if (middlewarePath) {
                // Only trust X-Forwarded-Proto when behind a trusted proxy
                const devTrustProxy =
                  process.env.VINEXT_TRUST_PROXY === "1" ||
                  (process.env.VINEXT_TRUSTED_HOSTS ?? "").split(",").some((h) => h.trim());
                const rawProto = devTrustProxy
                  ? String(req.headers["x-forwarded-proto"] || "")
                      .split(",")[0]
                      .trim()
                  : "";
                const mwProto = rawProto === "https" || rawProto === "http" ? rawProto : "http";
                const origin = `${mwProto}://${req.headers.host || "localhost"}`;
                const middlewareRequest = new Request(new URL(url, origin), {
                  method: req.method,
                  headers: nodeRequestHeaders,
                });
                const result = await runMiddleware(
                  getPagesRunner(),
                  middlewarePath,
                  middlewareRequest,
                  nextConfig?.i18n,
                  nextConfig?.basePath,
                );

                // Settle waitUntil promises — no ctx.waitUntil() in dev, but
                // promises must still run for parity with prod (session sync, telemetry, etc.)
                if (result.waitUntilPromises?.length) {
                  void Promise.allSettled(result.waitUntilPromises);
                }

                if (!result.continue) {
                  if (result.redirectUrl) {
                    const redirectHeaders: Record<string, string | string[]> = {
                      Location: result.redirectUrl,
                    };
                    if (result.responseHeaders) {
                      for (const [key, value] of result.responseHeaders) {
                        const existing = redirectHeaders[key];
                        if (existing === undefined) {
                          redirectHeaders[key] = value;
                        } else if (Array.isArray(existing)) {
                          existing.push(value);
                        } else {
                          redirectHeaders[key] = [existing, value];
                        }
                      }
                    }
                    res.writeHead(result.redirectStatus ?? 307, redirectHeaders);
                    res.end();
                    return;
                  }
                  if (result.response) {
                    res.statusCode = result.response.status;
                    for (const [key, value] of result.response.headers) {
                      res.appendHeader(key, value);
                    }
                    const body = Buffer.from(await result.response.arrayBuffer());
                    res.end(body);
                    return;
                  }
                }

                // Apply middleware response headers. Unpack
                // x-middleware-request-* headers into req.headers so
                // config has/missing conditions and downstream handlers
                // see middleware-modified cookies and headers.
                if (result.responseHeaders) {
                  const currentRequestHeaders = new Headers();
                  for (const [key, value] of Object.entries(req.headers)) {
                    if (Array.isArray(value)) {
                      currentRequestHeaders.set(key, value.join(", "));
                    } else if (value !== undefined) {
                      currentRequestHeaders.set(key, value);
                    }
                  }

                  middlewareRequestHeaders = buildRequestHeadersFromMiddlewareResponse(
                    currentRequestHeaders,
                    result.responseHeaders,
                  );

                  if (middlewareRequestHeaders && !hasAppDir) {
                    applyRequestHeadersToNodeRequest(middlewareRequestHeaders);
                  }

                  if (hasAppDir) {
                    // Hybrid app+pages: defer response headers. They'll be
                    // applied to res for Pages routes or forwarded to the RSC
                    // entry (via x-vinext-mw-ctx) for App Router routes.
                    deferredMwResponseHeaders = [];
                    for (const [key, value] of result.responseHeaders) {
                      if (!key.startsWith("x-middleware-")) {
                        deferredMwResponseHeaders.push([key, value]);
                      }
                    }
                  } else {
                    for (const [key, value] of result.responseHeaders) {
                      if (!key.startsWith("x-middleware-")) {
                        res.appendHeader(key, value);
                      }
                    }
                  }
                }

                // Apply middleware rewrite (URL and optional status code)
                if (result.rewriteUrl) {
                  url = result.rewriteUrl;
                  // Write the rewritten URL back onto req.url so every subsequent
                  // handler in the connect chain sees the correct path. The local
                  // `url` variable is only visible within this handler — anything
                  // further down the chain (Vite's built-in middleware, the
                  // Cloudflare plugin's handler, or any other connect middleware)
                  // reads req.url directly. Without this, a middleware rewrite
                  // would be invisible to those handlers and the original URL
                  // would be dispatched instead.
                  req.url = url;
                }
                if (result.rewriteStatus) {
                  req.__vinextRewriteStatus = result.rewriteStatus;
                }

                // Forward middleware context to the RSC entry so it can
                // populate _mwCtx without re-running the middleware function.
                // This prevents double execution in hybrid app+pages dev mode.
                if (hasAppDir) {
                  const mwCtxEntries: [string, string][] = [];
                  if (result.responseHeaders) {
                    for (const [key, value] of result.responseHeaders) {
                      // Exclude control headers that runMiddleware already
                      // consumed — matches the RSC entry's inline filtering.
                      if (key !== "x-middleware-next" && key !== "x-middleware-rewrite") {
                        mwCtxEntries.push([key, value]);
                      }
                    }
                  }
                  req.headers["x-vinext-mw-ctx"] = JSON.stringify({
                    h: mwCtxEntries,
                    s: result.rewriteStatus ?? null,
                    r: result.rewriteUrl ?? null,
                  });
                }
              }

              // Build request context once for has/missing condition checks
              // for config rules that execute after middleware (rewrites).
              // Convert Node.js IncomingMessage headers to a Web Request for
              // requestContextFromRequest(), which uses the standard Web API.
              const reqUrl = new URL(url, requestOrigin);
              const reqCtxHeaders = middlewareRequestHeaders ?? nodeRequestHeaders;
              const reqCtx: RequestContext = requestContextFromRequest(
                new Request(reqUrl, { headers: reqCtxHeaders }),
              );

              // Apply custom headers from next.config.js
              // Header matching still uses the original normalized pathname and
              // pre-middleware request state; middleware response headers win
              // later because they are already on the outgoing response.
              if (nextConfig?.headers.length) {
                applyHeaders(pathname, res, nextConfig.headers, preMiddlewareReqCtx);
              }

              // Apply rewrites from next.config.js (beforeFiles)
              let resolvedUrl = url;
              if (nextConfig?.rewrites.beforeFiles.length) {
                resolvedUrl =
                  applyRewrites(pathname, nextConfig.rewrites.beforeFiles, reqCtx) ?? url;
              }

              // External rewrite from beforeFiles — proxy to external URL
              if (isExternalUrl(resolvedUrl)) {
                applyDeferredMwHeaders();
                await proxyExternalRewriteNode(req, res, resolvedUrl);
                return;
              }

              // Handle API routes first (pages/api/*)
              const resolvedPathname = resolvedUrl.split("?")[0];
              if (resolvedPathname.startsWith("/api/") || resolvedPathname === "/api") {
                const apiRoutes = await apiRouter(
                  pagesDir,
                  nextConfig?.pageExtensions,
                  fileMatcher,
                );
                const apiMatch = matchRoute(resolvedUrl, apiRoutes);
                if (apiMatch) {
                  applyDeferredMwHeaders();
                  if (middlewareRequestHeaders) {
                    applyRequestHeadersToNodeRequest(middlewareRequestHeaders);
                  }
                }
                const handled = await handleApiRoute(
                  getPagesRunner(),
                  req,
                  res,
                  resolvedUrl,
                  apiRoutes,
                );
                if (handled) return;

                // No API route matched — if app dir exists, let the RSC plugin handle it
                // (app/api/* route handlers live there). Otherwise hard-404.
                if (hasAppDir) return next();

                res.statusCode = 404;
                res.end("404 - API route not found");
                return;
              }

              const routes = await pagesRouter(pagesDir, nextConfig?.pageExtensions, fileMatcher);

              // Apply afterFiles rewrites — these run after initial route matching
              // If beforeFiles already rewrote the URL, afterFiles still run on the
              // *resolved* pathname. Next.js applies these when route matching succeeds
              // but allows overriding with rewrites.
              if (nextConfig?.rewrites.afterFiles.length) {
                const afterRewrite = applyRewrites(
                  resolvedUrl.split("?")[0],
                  nextConfig.rewrites.afterFiles,
                  reqCtx,
                );
                if (afterRewrite) resolvedUrl = afterRewrite;
              }

              // External rewrite from afterFiles — proxy to external URL
              if (isExternalUrl(resolvedUrl)) {
                applyDeferredMwHeaders();
                await proxyExternalRewriteNode(req, res, resolvedUrl);
                return;
              }

              const handler = createSSRHandler(
                server,
                getPagesRunner(),
                routes,
                pagesDir,
                nextConfig?.i18n,
                fileMatcher,
                nextConfig?.basePath ?? "",
                nextConfig?.trailingSlash ?? false,
              );
              const mwStatus = req.__vinextRewriteStatus;

              // Try rendering the resolved URL
              const match = matchRoute(resolvedUrl.split("?")[0], routes);
              if (match) {
                applyDeferredMwHeaders();
                if (middlewareRequestHeaders) {
                  applyRequestHeadersToNodeRequest(middlewareRequestHeaders);
                }
                await handler(req, res, resolvedUrl, mwStatus);
                return;
              }

              // No route matched — try fallback rewrites
              if (nextConfig?.rewrites.fallback.length) {
                const fallbackRewrite = applyRewrites(
                  resolvedUrl.split("?")[0],
                  nextConfig.rewrites.fallback,
                  reqCtx,
                );
                if (fallbackRewrite) {
                  // External fallback rewrite — proxy to external URL
                  if (isExternalUrl(fallbackRewrite)) {
                    applyDeferredMwHeaders();
                    await proxyExternalRewriteNode(req, res, fallbackRewrite);
                    return;
                  }
                  const fallbackMatch = matchRoute(fallbackRewrite.split("?")[0], routes);
                  if (!fallbackMatch && hasAppDir) {
                    return next();
                  }
                  applyDeferredMwHeaders();
                  if (middlewareRequestHeaders) {
                    applyRequestHeadersToNodeRequest(middlewareRequestHeaders);
                  }
                  await handler(req, res, fallbackRewrite, mwStatus);
                  return;
                }
              }

              // No fallback matched - if app dir exists, let the RSC plugin handle it,
              // otherwise render via the pages SSR handler (will 404 for unknown routes).
              if (hasAppDir) return next();

              await handler(req, res, resolvedUrl, mwStatus);
            } catch (e) {
              next(e);
            }
          });
        };
      },
    },
    // Strip server-only data-fetching exports (getServerSideProps, getStaticProps,
    // getStaticPaths) from page modules in the client bundle. These functions
    // often import server-only modules (database drivers, fs, etc.) that would
    // break or bloat the client bundle. Next.js does this via an SWC transform
    // (next-ssg-transform); we use Vite's parseAst + MagicString.
    //
    // Only applies to client builds (not SSR) and only to files under the
    // pages/ directory.
    {
      name: "vinext:strip-server-exports",
      transform: {
        // Only match page source files, not node_modules
        filter: { id: /\.(tsx?|jsx?|mjs)$/ },
        handler(code, id) {
          const ssr = this.environment?.name !== "client";
          if (ssr) return null;
          if (!hasPagesDir) return null;
          // Only transform files under the pages/ directory
          if (!id.startsWith(pagesDir)) return null;
          // Skip API routes, _app, _document, _error
          const relativePath = id.slice(pagesDir.length);
          if (relativePath.startsWith("/api/") || relativePath === "/api") return null;
          if (/\/_(?:app|document|error)\b/.test(relativePath)) return null;

          const result = stripServerExports(code);
          if (!result) return null;
          return { code: result, map: null };
        },
      },
    },
    // Local image import transform:
    // When a source file imports a local image (e.g., `import hero from './hero.jpg'`),
    // this plugin transforms the default import to a StaticImageData object with
    // { src, width, height } so the next/image shim can set correct dimensions
    // on <img> tags, preventing CLS.
    //
    // Vite's default image import returns a URL string. We intercept this by
    // adding a `?vinext-meta` suffix: the original import gets the URL from Vite,
    // and we resolve the `?vinext-meta` virtual module to provide dimensions.
    {
      name: "vinext:image-imports",
      enforce: "pre",

      // Cache of image dimensions to avoid re-reading files
      _dimCache: imageImportDimCache,

      resolveId: {
        filter: { id: /\?vinext-meta$/ },
        handler(source, _importer) {
          if (!source.endsWith("?vinext-meta")) return null;
          // Resolve the real image path from the importer
          const realPath = source.replace("?vinext-meta", "");
          return `\0vinext-image-meta:${realPath}`;
        },
      },

      async load(id) {
        if (!id.startsWith("\0vinext-image-meta:")) return null;
        const imagePath = id.replace("\0vinext-image-meta:", "");

        // Read from cache first
        const cache = imageImportDimCache;
        let dims = cache.get(imagePath);
        if (!dims) {
          try {
            const { imageSize } = await import("image-size");
            const buffer = fs.readFileSync(imagePath);
            const result = imageSize(buffer);
            dims = { width: result.width ?? 0, height: result.height ?? 0 };
            cache.set(imagePath, dims);
          } catch {
            dims = { width: 0, height: 0 };
          }
        }

        return `export default ${JSON.stringify(dims)};`;
      },

      transform: {
        // Hook filter: Rolldown evaluates these on the Rust side, skipping
        // the JS handler entirely for files that don't match.
        filter: {
          id: {
            include: /\.(tsx?|jsx?|mjs)$/,
            exclude: /node_modules/,
          },
          code: new RegExp(`import\\s+\\w+\\s+from\\s+['"][^'"]+\\.(${IMAGE_EXTS})['"]`),
        },
        async handler(code, id) {
          // Defensive guard — duplicates filter logic
          if (id.includes("node_modules")) return null;
          if (id.startsWith("\0")) return null;
          if (!id.match(/\.(tsx?|jsx?|mjs)$/)) return null;

          const imageImportRe = new RegExp(
            `import\\s+(\\w+)\\s+from\\s+['"]([^'"]+\\.(${IMAGE_EXTS}))['"];?`,
            "g",
          );
          if (!imageImportRe.test(code)) return null;

          imageImportRe.lastIndex = 0;

          const s = new MagicString(code);
          let hasChanges = false;

          let match;
          while ((match = imageImportRe.exec(code)) !== null) {
            const [fullMatch, varName, importPath] = match;
            const matchStart = match.index;
            const matchEnd = matchStart + fullMatch.length;

            // Resolve the absolute path of the image
            const dir = path.dirname(id);
            const absImagePath = path.resolve(dir, importPath);

            if (!fs.existsSync(absImagePath)) continue;

            // Replace the single import with two:
            // 1. Original import (Vite gives us the URL string)
            // 2. Meta import (we provide { width, height })
            // Combined into a StaticImageData object
            const urlVar = `__vinext_img_url_${varName}`;
            const metaVar = `__vinext_img_meta_${varName}`;
            const replacement =
              `import ${urlVar} from ${JSON.stringify(importPath)};\n` +
              `import ${metaVar} from ${JSON.stringify(absImagePath + "?vinext-meta")};\n` +
              `const ${varName} = { src: ${urlVar}, width: ${metaVar}.width, height: ${metaVar}.height };`;

            s.overwrite(matchStart, matchEnd, replacement);
            hasChanges = true;
          }

          if (!hasChanges) return null;

          return {
            code: s.toString(),
            map: s.generateMap({ hires: "boundary" }),
          };
        },
      },
    } as Plugin & { _dimCache: Map<string, { width: number; height: number }> },
    // Google Fonts import rewrite + self-hosting — see src/plugins/fonts.ts
    createGoogleFontsPlugin(_fontGoogleShimPath, _shimsDir),
    // Local font path resolution — see src/plugins/fonts.ts
    createLocalFontsPlugin(),
    // Barrel import optimization:
    // Rewrites `import { Slot } from "radix-ui"` → `import * as Slot from "@radix-ui/react-slot"`
    // for packages listed in optimizePackageImports or DEFAULT_OPTIMIZE_PACKAGES.
    // This prevents Vite from eagerly evaluating barrel re-exports that call
    // React.createContext() in RSC environments where createContext doesn't exist.
    createOptimizeImportsPlugin(
      () => nextConfig,
      () => root,
    ),
    // "use cache" directive transform:
    // Detects "use cache" at file-level or function-level and wraps the
    // exports/functions with registerCachedFunction() from vinext/cache-runtime.
    // Runs without enforce so it executes after JSX transform (parseAst needs plain JS).
    {
      name: "vinext:use-cache",

      transform: {
        // Hook filter: only invoke JS when code contains 'use cache'.
        // The vast majority of files don't use this directive.
        filter: {
          id: {
            include: /\.(tsx?|jsx?|mjs)$/,
            exclude: /node_modules/,
          },
          code: "use cache",
        },
        async handler(code, id) {
          // Defensive guard — duplicates filter logic
          if (id.includes("node_modules")) return null;
          if (id.startsWith("\0")) return null;
          if (!id.match(/\.(tsx?|jsx?|mjs)$/)) return null;
          if (!code.includes("use cache")) return null;

          // Parse the AST first to check for actual "use cache" directives before
          // throwing the missing-RSC error. The fast-path string check above can
          // fire on files that contain "use cache" only in comments or string
          // literals (e.g., in error messages), not as real directives.
          const ast = parseAst(code);

          // Check for file-level "use cache" directive
          const cacheDirective = ast.body.find(
            (node) =>
              node.type === "ExpressionStatement" &&
              node.expression?.type === "Literal" &&
              typeof node.expression.value === "string" &&
              node.expression.value.startsWith("use cache"),
          );

          // Check for function-level "use cache" directives by walking function bodies.
          // Accepts any function-like node: FunctionDeclaration/Expression, ArrowFunctionExpression,
          // or MethodDefinition. MethodDefinition stores its FunctionExpression in `.value`, not
          // `.body`, so we unwrap it here rather than at each call site to keep the callee safe.
          function nodeHasInlineCacheDirective(node: ASTNode): boolean {
            if (!node || typeof node !== "object") return false;
            // MethodDefinition wraps its FunctionExpression in .value; unwrap to reach .body.
            const fn = node.type === "MethodDefinition" ? node.value : node;
            // fn.body is a BlockStatement node ({type:"BlockStatement", body:Statement[]}), not
            // a raw array. Unwrap it. Arrow functions with expression bodies have a non-array
            // .body — the BlockStatement check handles that case (body.body would be undefined).
            const stmts: ASTNode[] | null =
              // oxlint-disable-next-line typescript/no-explicit-any
              (fn as any)?.body?.type === "BlockStatement" ? (fn as any).body.body : null;
            if (Array.isArray(stmts)) {
              for (const stmt of stmts) {
                if (
                  stmt?.type === "ExpressionStatement" &&
                  stmt.expression?.type === "Literal" &&
                  typeof stmt.expression?.value === "string" &&
                  /^use cache(:\s*\w+)?$/.test(stmt.expression.value)
                ) {
                  return true;
                }
              }
            }
            return false;
          }
          function astHasInlineCache(nodes: ASTNode[]): boolean {
            for (const node of nodes) {
              if (!node || typeof node !== "object") continue;
              if (
                (node.type === "FunctionDeclaration" ||
                  node.type === "FunctionExpression" ||
                  node.type === "ArrowFunctionExpression" ||
                  node.type === "MethodDefinition") &&
                nodeHasInlineCacheDirective(node)
              ) {
                return true;
              }
              // Walk into variable declarations, export declarations, etc.
              for (const key of Object.keys(node)) {
                if (key === "type" || key === "start" || key === "end" || key === "loc") continue;
                const child = node[key as keyof typeof node] as ASTNode;
                if (Array.isArray(child) && child.some((c) => c && typeof c === "object")) {
                  if (astHasInlineCache(child)) return true;
                } else if (child && typeof child === "object" && child.type) {
                  if (astHasInlineCache([child])) return true;
                }
              }
            }
            return false;
          }
          const hasInlineCache = !cacheDirective && astHasInlineCache(ast.body);

          if (!cacheDirective && !hasInlineCache) return null;

          if (!resolvedRscTransformsPath) {
            throw new Error(
              "vinext: 'use cache' requires @vitejs/plugin-rsc to be installed.\n" +
                "Run: " +
                detectPackageManager(process.cwd()) +
                " @vitejs/plugin-rsc",
            );
          }
          const { transformWrapExport, transformHoistInlineDirective } = await import(
            pathToFileURL(resolvedRscTransformsPath).href
          );

          if (cacheDirective) {
            // File-level "use cache" — wrap function exports with
            // registerCachedFunction. Page default exports are wrapped directly
            // (they're leaf components). Layout/template defaults are excluded
            // because they receive {children} from the framework.
            // oxlint-disable-next-line typescript/no-explicit-any
            const directiveValue = (cacheDirective as any).expression.value;
            const variant =
              directiveValue === "use cache"
                ? ""
                : directiveValue.replace("use cache:", "").replace("use cache: ", "").trim();

            // Only skip default export wrapping for layouts and templates —
            // they receive {children} from the framework which requires
            // temporary reference handling that registerCachedFunction doesn't
            // support yet. Pages, not-found, loading, error, and default are
            // leaf components with no {children} prop and can be cached directly.
            const isLayoutOrTemplate = /\/(layout|template)\.(tsx?|jsx?|mjs)$/.test(id);

            const runtimeModuleUrl = pathToFileURL(
              resolveShimModulePath(shimsDir, "cache-runtime"),
            ).href;
            const result = transformWrapExport(code, ast, {
              runtime: (value: string, name: string) =>
                `(await import(${JSON.stringify(runtimeModuleUrl)})).registerCachedFunction(${value}, ${JSON.stringify(id + ":" + name)}, ${JSON.stringify(variant)})`,
              rejectNonAsyncFunction: false,
              filter: (name: string, meta: { isFunction?: boolean }) => {
                // Skip non-functions (constants, types, etc.)
                if (meta.isFunction === false) return false;
                // Skip the default export on layout/template files — these
                // receive {children} from the framework, and caching them
                // requires temporary reference handling for the children slot.
                // Named exports (e.g. generateMetadata) are still wrapped.
                if (isLayoutOrTemplate && name === "default") return false;
                return true;
              },
            });

            if (result.exportNames.length > 0) {
              // Remove the directive itself so it doesn't cause runtime errors
              const output = result.output;
              output.overwrite(
                cacheDirective.start,
                cacheDirective.end,
                `/* "use cache" — wrapped by vinext */`,
              );
              return {
                code: output.toString(),
                map: output.generateMap({ hires: "boundary" }),
              };
            }

            // Even if no exports were wrapped, still strip the directive
            // (e.g., layout/template file with only a default export)
            const output = new MagicString(code);
            output.overwrite(
              cacheDirective.start,
              cacheDirective.end,
              `/* "use cache" — handled by vinext */`,
            );
            return {
              code: output.toString(),
              map: output.generateMap({ hires: "boundary" }),
            };
          }

          // Check for function-level "use cache" directives
          // (e.g., async function getData() { "use cache"; ... })
          if (hasInlineCache) {
            const runtimeModuleUrl2 = pathToFileURL(
              resolveShimModulePath(shimsDir, "cache-runtime"),
            ).href;

            try {
              const result = transformHoistInlineDirective(code, ast, {
                directive: /^use cache(:\s*\w+)?$/,
                runtime: (value: string, name: string, meta: { directiveMatch: string[] }) => {
                  const directiveMatch = meta.directiveMatch[0];
                  const variant =
                    directiveMatch === "use cache"
                      ? ""
                      : directiveMatch.replace("use cache:", "").replace("use cache: ", "").trim();
                  return `(await import(${JSON.stringify(runtimeModuleUrl2)})).registerCachedFunction(${value}, ${JSON.stringify(id + ":" + name)}, ${JSON.stringify(variant)})`;
                },
                rejectNonAsyncFunction: false,
              });

              if (result.names.length > 0) {
                return {
                  code: result.output.toString(),
                  map: result.output.generateMap({ hires: "boundary" }),
                };
              }
            } catch {
              // If hoisting fails (e.g., complex closure), fall through
            }
          }

          return null;
        },
      },
    },
    // Inline binary assets fetched via `fetch(new URL("./asset", import.meta.url))` —
    // see src/plugins/og-assets.ts
    createOgInlineFetchAssetsPlugin(),
    // Copy @vercel/og binary assets to the RSC output directory — see src/plugins/og-assets.ts
    ogAssetsPlugin,
    // Collect SSR/RSC bundle externals and write dist/server/vinext-externals.json.
    // Used by emitStandaloneOutput to determine which packages to copy into
    // standalone/node_modules/ — uses the bundler's own import graph instead of
    // fragile regex scanning of emitted files.
    createServerExternalsManifestPlugin(),
    // Write image config JSON for the App Router production server.
    // The App Router RSC entry doesn't export vinextConfig (that's a Pages
    // Router pattern), so we write a separate JSON file at build time that
    // prod-server.ts reads at startup for SVG/security header config.
    {
      name: "vinext:image-config",
      apply: "build",
      enforce: "post",
      writeBundle: {
        sequential: true,
        order: "post",
        handler(options) {
          const envName = this.environment?.name;
          if (envName !== "rsc") return;

          const outDir = options.dir;
          if (!outDir) return;

          const imageConfig = {
            dangerouslyAllowSVG: nextConfig?.images?.dangerouslyAllowSVG,
            contentDispositionType: nextConfig?.images?.contentDispositionType,
            contentSecurityPolicy: nextConfig?.images?.contentSecurityPolicy,
          };

          fs.writeFileSync(path.join(outDir, "image-config.json"), JSON.stringify(imageConfig));
        },
      },
    },
    // Write BUILD_ID to dist/server/ so post-build tools (TPR, seed-cache) can
    // read the build identifier without depending on the prerender manifest.
    // Uses closeBundle (not writeBundle) with a one-time write guard so the file
    // is written exactly once per build regardless of how many environments are
    // active (App Router RSC+SSR+client, Pages Router SSR+client, etc.).
    // The path is always dist/server/BUILD_ID — derived from root, not from the
    // per-environment options.dir — so it works for all router types.
    (() => {
      let buildIdWritten = false;
      return {
        name: "vinext:build-id",
        apply: "build" as const,
        enforce: "post" as const,
        closeBundle: {
          sequential: true,
          order: "post" as const,
          handler() {
            if (buildIdWritten) return;
            buildIdWritten = true;
            const outDir = path.join(root, "dist", "server");
            fs.mkdirSync(outDir, { recursive: true });
            fs.writeFileSync(path.join(outDir, "BUILD_ID"), nextConfig!.buildId);
          },
        },
      };
    })(),
    // Write vinext-server.json to dist/server/ with a per-build prerender secret.
    // The prerender secret is used by prod-server.ts to authenticate requests to
    // the internal /__vinext/prerender/* endpoints, which are only reachable during
    // the prerender phase of `vinext build`. A new secret is generated on every
    // build so it rotates with every deployment.
    //
    // The secret is generated once at plugin creation time so that both the rsc
    // and ssr environments write the exact same value (they share the same
    // closure). Without this, each env would call randomBytes() independently
    // and the second write would silently overwrite the first with a different
    // secret, causing prerender auth to fail for whichever env's server reads
    // the file last.
    (() => {
      const prerenderSecret = randomBytes(32).toString("hex");
      return {
        name: "vinext:server-manifest",
        apply: "build" as const,
        enforce: "post" as const,
        writeBundle: {
          sequential: true,
          order: "post" as const,
          handler(options: { dir?: string }) {
            const envName = this.environment?.name;
            // Fire for App Router RSC builds (rsc env) and Pages Router SSR builds
            // (ssr env). Skip client and other environments.
            if (envName !== "rsc" && envName !== "ssr") return;

            const outDir = options.dir;
            if (!outDir) return;

            const manifest = { prerenderSecret };
            fs.writeFileSync(path.join(outDir, "vinext-server.json"), JSON.stringify(manifest));
          },
        },
      };
    })(),
    {
      name: "vinext:nitro-route-rules",
      nitro: {
        setup: async (nitro: NitroSetupContext) => {
          if (nitro.options.dev) return;
          if (!nextConfig) return;
          if (!hasAppDir && !hasPagesDir) return;

          const { collectNitroRouteRules, mergeNitroRouteRules } =
            await import("./build/nitro-route-rules.js");
          const generatedRouteRules = await collectNitroRouteRules({
            appDir: hasAppDir ? appDir : null,
            pagesDir: hasPagesDir ? pagesDir : null,
            pageExtensions: nextConfig.pageExtensions,
          });

          if (Object.keys(generatedRouteRules).length === 0) return;

          const { routeRules, skippedRoutes } = mergeNitroRouteRules(
            nitro.options.routeRules,
            generatedRouteRules,
          );

          nitro.options.routeRules = routeRules;

          if (skippedRoutes.length > 0) {
            const warn = nitro.logger?.warn ?? console.warn;
            warn(
              `[vinext] Skipping generated Nitro routeRules for routes with existing exact cache config: ${skippedRoutes.join(", ")}`,
            );
          }
        },
      },
    } as Plugin & { nitro: { setup: (nitro: NitroSetupContext) => Promise<void> } }, // Nitro plugin extension convention: https://nitro.build/guide/plugins
    // Vite can emit empty SSR manifest entries for modules that Rollup inlines
    // into another chunk. Pages Router looks up assets by page module path at
    // runtime, so rebuild those mappings from the emitted client bundle.
    {
      name: "vinext:ssr-manifest-backfill",
      apply: "build",
      enforce: "post",
      writeBundle: {
        sequential: true,
        order: "post",
        handler(options, bundle) {
          const outDir = options.dir;
          if (!outDir) return;

          const viteDir = path.join(outDir, ".vite");
          const ssrManifestPath = path.join(viteDir, "ssr-manifest.json");
          if (!fs.existsSync(ssrManifestPath)) return;

          try {
            const ssrManifest = JSON.parse(fs.readFileSync(ssrManifestPath, "utf-8")) as Record<
              string,
              string[]
            >;
            const buildRoot = this.environment?.config.root ?? process.cwd();
            const buildBase = this.environment?.config.base ?? "/";
            const augmentedManifest = augmentSsrManifestFromBundle(
              ssrManifest,
              bundle as Record<string, BundleBackfillChunk | { type: string }>,
              buildRoot,
              buildBase,
            );
            fs.writeFileSync(ssrManifestPath, JSON.stringify(augmentedManifest, null, 2));
          } catch (err) {
            // Leave Vite's manifest untouched if parsing fails.
            console.warn("[vinext] Failed to augment SSR manifest:", err);
          }
        },
      },
    },
    // Build-time precompression: generate .br, .gz, .zst for hashed assets.
    // Runs after the client bundle is written so compressed variants are
    // available for the production server's static file cache.
    // Opt-in via `precompress: true` in plugin options or `--precompress`
    // CLI flag. Not useful for edge platforms (Cloudflare Workers, Nitro)
    // that handle compression at the CDN layer.
    (() => {
      let pendingPrecompress: Promise<void> | null = null;
      let pendingPrecompressError: unknown = null;

      return {
        name: "vinext:precompress",
        apply: "build" as const,
        enforce: "post" as const,
        writeBundle: {
          sequential: true,
          order: "post" as const,
          handler(outputOptions: { dir?: string }) {
            if (this.environment?.name !== "client") return;

            if (!options.precompress && process.env.VINEXT_PRECOMPRESS !== "1") return;

            const outDir = outputOptions.dir;
            if (!outDir) return;

            // Only precompress hashed assets — public directory files use
            // on-the-fly compression since they may change between deploys.
            const assetsDir = path.join(outDir, "assets");
            if (!fs.existsSync(assetsDir)) return;

            const isTTY = process.stderr.isTTY;
            let lastLineLen = 0;

            // Start precompression as soon as the client bundle is written, but
            // defer awaiting it until the SSR environment finishes. This overlaps
            // the extra asset work with the final build phase instead of putting
            // the full precompression cost on the critical path of step 4/5.
            pendingPrecompressError = null;
            pendingPrecompress = (async () => {
              const result = await precompressAssets(outDir, (completed, total, file) => {
                if (!isTTY) return;
                const pct = total > 0 ? Math.floor((completed / total) * 100) : 0;
                const bar = `[${"█".repeat(Math.floor(pct / 5))}${" ".repeat(20 - Math.floor(pct / 5))}]`;
                const maxFile = 30;
                const fileLabel = file.length > maxFile ? "…" + file.slice(-(maxFile - 1)) : file;
                const line = `Compressing assets... ${bar} ${String(completed).padStart(String(total).length)}/${total} ${fileLabel}`;
                const padded = line.padEnd(lastLineLen);
                lastLineLen = line.length;
                process.stderr.write(`\r${padded}`);
              });
              if (isTTY) {
                process.stderr.write(`\r${" ".repeat(lastLineLen)}\r`);
              }
              if (result.filesCompressed > 0) {
                const ratio = (
                  (1 - result.totalBrotliBytes / result.totalOriginalBytes) *
                  100
                ).toFixed(1);
                console.log(
                  `  Precompressed ${result.filesCompressed} assets (${ratio}% smaller with brotli)`,
                );
              }
            })().catch((error) => {
              pendingPrecompressError = error;
              // Log immediately so the error isn't invisible if closeBundle
              // never fires (e.g. a crash in a later SSR build plugin).
              console.error("[vinext] Precompression failed:", error);
            });
          },
        },
        closeBundle: {
          sequential: true,
          order: "post" as const,
          async handler() {
            if (this.environment?.name !== "ssr") return;
            if (!pendingPrecompress) return;

            const task = pendingPrecompress;
            pendingPrecompress = null;
            await task;
            if (pendingPrecompressError) {
              const error = pendingPrecompressError;
              pendingPrecompressError = null;
              throw error;
            }
          },
        },
      };
    })(),
    // Cloudflare Workers production build integration:
    // After all environments are built, compute lazy chunks from the client
    // build manifest and inject globals into the worker entry.
    //
    // Pages Router: injects __VINEXT_CLIENT_ENTRY__, __VINEXT_SSR_MANIFEST__,
    //   and __VINEXT_LAZY_CHUNKS__ into the worker entry (found via wrangler.json).
    // App Router: the RSC plugin handles __VINEXT_CLIENT_ENTRY__ via
    //   loadBootstrapScriptContent(), but we still inject __VINEXT_LAZY_CHUNKS__
    //   and __VINEXT_SSR_MANIFEST__ into the worker entry at dist/server/index.js.
    // Both: generates _headers file for immutable asset caching.
    {
      name: "vinext:cloudflare-build",
      apply: "build",
      enforce: "post",
      closeBundle: {
        sequential: true,
        order: "post",
        async handler() {
          const envName = this.environment?.name;
          if (!envName || !hasCloudflarePlugin) return;
          if (envName !== "client") return;

          const envConfig = this.environment?.config;
          if (!envConfig) return;
          const buildRoot = envConfig.root ?? process.cwd();
          const distDir = path.resolve(buildRoot, "dist");
          if (!fs.existsSync(distDir)) return;

          const clientDir = path.resolve(buildRoot, "dist", "client");
          const clientBase = envConfig.base ?? "/";

          // Read build manifest and compute lazy chunks (only reachable via
          // dynamic imports). This runs for BOTH App Router and Pages Router.
          // clientEntryFile is only used by the Pages Router path below —
          // App Router gets its client entry via the RSC plugin instead.
          let lazyChunksData: string[] | null = null;
          let clientEntryFile: string | null = null;
          const buildManifestPath = path.join(clientDir, ".vite", "manifest.json");
          if (fs.existsSync(buildManifestPath)) {
            try {
              const buildManifest = JSON.parse(fs.readFileSync(buildManifestPath, "utf-8"));
              // oxlint-disable-next-line typescript/no-explicit-any
              for (const [, value] of Object.entries(buildManifest) as [string, any][]) {
                if (value && value.isEntry && value.file) {
                  clientEntryFile = manifestFileWithBase(value.file, clientBase);
                  break;
                }
              }
              const lazy = manifestFilesWithBase(computeLazyChunks(buildManifest), clientBase);
              if (lazy.length > 0) lazyChunksData = lazy;
            } catch {
              /* ignore parse errors */
            }
          }

          // Read SSR manifest for per-page CSS/JS injection
          let ssrManifestData: Record<string, string[]> | null = null;
          const ssrManifestPath = path.join(clientDir, ".vite", "ssr-manifest.json");
          if (fs.existsSync(ssrManifestPath)) {
            try {
              ssrManifestData = JSON.parse(fs.readFileSync(ssrManifestPath, "utf-8"));
            } catch {
              /* ignore parse errors */
            }
          }

          if (hasAppDir) {
            // App Router: the RSC plugin handles __VINEXT_CLIENT_ENTRY__
            // via loadBootstrapScriptContent(), but we still need to inject
            // __VINEXT_LAZY_CHUNKS__ and __VINEXT_SSR_MANIFEST__ into the
            // worker entry at dist/server/index.js.
            const workerEntry = path.resolve(distDir, "server", "index.js");
            if (fs.existsSync(workerEntry) && (lazyChunksData || ssrManifestData)) {
              let code = fs.readFileSync(workerEntry, "utf-8");
              const globals: string[] = [];
              if (ssrManifestData) {
                globals.push(
                  `globalThis.__VINEXT_SSR_MANIFEST__ = ${JSON.stringify(ssrManifestData)};`,
                );
              }
              if (lazyChunksData) {
                globals.push(
                  `globalThis.__VINEXT_LAZY_CHUNKS__ = ${JSON.stringify(lazyChunksData)};`,
                );
              }
              code = globals.join("\n") + "\n" + code;
              fs.writeFileSync(workerEntry, code);
            }
          } else {
            // Pages Router: find worker output by scanning dist/ for a
            // directory containing wrangler.json (Cloudflare plugin default).
            let workerOutDir: string | null = null;
            for (const entry of fs.readdirSync(distDir)) {
              const candidate = path.join(distDir, entry);
              if (entry === "client") continue;
              if (
                fs.statSync(candidate).isDirectory() &&
                fs.existsSync(path.join(candidate, "wrangler.json"))
              ) {
                workerOutDir = candidate;
                break;
              }
            }
            if (!workerOutDir) return;

            const workerEntry = path.join(workerOutDir, "index.js");
            if (!fs.existsSync(workerEntry)) return;

            // Fallback: scan dist/client/assets/ for the client entry chunk.
            // Pages Router uses "vinext-client-entry", App Router uses
            // "vinext-app-browser-entry".
            if (!clientEntryFile) {
              const assetsDir = path.join(clientDir, "assets");
              if (fs.existsSync(assetsDir)) {
                const files = fs.readdirSync(assetsDir);
                const entry = files.find(
                  (f: string) =>
                    (f.includes("vinext-client-entry") || f.includes("vinext-app-browser-entry")) &&
                    f.endsWith(".js"),
                );
                if (entry) clientEntryFile = manifestFileWithBase("assets/" + entry, clientBase);
              }
            }

            // Prepend globals to worker entry
            if (clientEntryFile || ssrManifestData || lazyChunksData) {
              let code = fs.readFileSync(workerEntry, "utf-8");
              const globals: string[] = [];
              if (clientEntryFile) {
                globals.push(
                  `globalThis.__VINEXT_CLIENT_ENTRY__ = ${JSON.stringify(clientEntryFile)};`,
                );
              }
              if (ssrManifestData) {
                globals.push(
                  `globalThis.__VINEXT_SSR_MANIFEST__ = ${JSON.stringify(ssrManifestData)};`,
                );
              }
              if (lazyChunksData) {
                globals.push(
                  `globalThis.__VINEXT_LAZY_CHUNKS__ = ${JSON.stringify(lazyChunksData)};`,
                );
              }
              code = globals.join("\n") + "\n" + code;
              fs.writeFileSync(workerEntry, code);
            }
          }

          // Generate _headers file for Cloudflare Workers static asset caching.
          // Vite outputs content-hashed files (JS, CSS, fonts) to the assetsDir
          // (defaults to "assets"). These are safe to cache indefinitely since
          // the hash changes on any content change. Without this, Cloudflare
          // serves them with max-age=0 which forces unnecessary revalidation
          // on every page load.
          const headersPath = path.join(clientDir, "_headers");
          if (!fs.existsSync(headersPath)) {
            const assetsDir = envConfig.build?.assetsDir ?? "assets";
            const headersContent = [
              "# Cache content-hashed assets immutably (generated by vinext)",
              `/${assetsDir}/*`,
              "  Cache-Control: public, max-age=31536000, immutable",
              "",
            ].join("\n");
            fs.mkdirSync(clientDir, { recursive: true });
            fs.writeFileSync(headersPath, headersContent);
          }
        },
      },
    },
    {
      // @vercel/og WASM patch — universal (workerd + Node.js)
      //
      // @vercel/og/dist/index.edge.js uses two WASM modules that need special handling:
      //
      // 1. YOGA WASM: yoga-layout embeds its WASM as a base64 data URL and instantiates
      //    it via WebAssembly.instantiate(bytes). workerd forbids this — WASM must be
      //    loaded as a pre-compiled WebAssembly.Module via the module system.
      //
      // 2. RESVG WASM: imported as `import resvg_wasm from "./resvg.wasm?module"` which
      //    only works on workerd. Node.js can't import WASM files as ESM modules.
      //
      // Fix: replace all static WASM imports with dynamic imports that try the ?module
      // path (for workerd) and fall back to compiling from bytes (for Node.js). This
      // produces a single build output that runs on both runtimes.
      name: "vinext:og-font-patch",
      enforce: "pre" as const,
      transform(code: string, id: string) {
        if (!id.includes("@vercel/og") || !id.includes("index.edge.js")) return null;
        let result = code;

        // ── Yoga WASM: dynamic import + inline base64 fallback ──────────────────────
        // yoga-layout's emscripten bundle sets H to a data URL containing the yoga WASM,
        // then later calls WebAssembly.instantiate(bytes, imports), which workerd rejects.
        // Emscripten supports a custom h2.instantiateWasm(imports, callback) escape hatch.
        //
        // Strategy: try dynamic import("./yoga.wasm?module") for workerd (pre-compiled
        // module), fall back to compiling from inline base64 bytes for Node.js.
        // Yoga WASM is ~70KB so inlining the base64 (~95KB) is acceptable.
        const YOGA_DATA_URL_RE = /H = "data:application\/octet-stream;base64,([A-Za-z0-9+/]+=*)";/;
        const yogaMatch = YOGA_DATA_URL_RE.exec(result);
        if (yogaMatch) {
          const yogaBase64 = yogaMatch[1];
          const distDir = path.dirname(id);
          const yogaWasmPath = path.join(distDir, "yoga.wasm");
          // Write yoga.wasm to disk idempotently at transform time (Node.js side)
          // so the ?module dynamic import can resolve it on workerd builds.
          if (!fs.existsSync(yogaWasmPath)) {
            fs.writeFileSync(yogaWasmPath, Buffer.from(yogaBase64, "base64"));
          }
          // Disable the data-URL branch so emscripten doesn't try to instantiate from bytes
          result = result.replace(yogaMatch[0], `H = "";`);
          // Patch the loadYoga call site to inject instantiateWasm with universal handler.
          // WebAssembly.instantiate(Module, imports) → Instance (workerd path)
          // WebAssembly.instantiate(bytes, imports)  → { module, instance } (Node.js path)
          const YOGA_CALL = `yoga_wasm_base64_esm_default()`;
          const YOGA_CALL_PATCHED = [
            `yoga_wasm_base64_esm_default({ instantiateWasm: function(imports, callback) {`,
            `  __vi_yoga_mod.then(function(mod) {`,
            `    if (mod) {`,
            `      WebAssembly.instantiate(mod, imports).then(function(inst) { callback(inst); });`,
            `    } else {`,
            `      var b = Buffer.from(__vi_yoga_b64, "base64");`,
            `      WebAssembly.instantiate(b, imports).then(function(r) { callback(r.instance); });`,
            `    }`,
            `  });`,
            `  return {};`,
            `} })`,
          ].join("\n");
          result = result.replace(YOGA_CALL, YOGA_CALL_PATCHED);
          // Prepend dynamic import with base64 fallback (no static import — Node.js safe)
          const yogaPreamble = [
            `var __vi_yoga_b64 = ${JSON.stringify(yogaBase64)};`,
            `var __vi_yoga_mod = import("./yoga.wasm?module").then(function(m) { return m.default; }).catch(function() { return null; });`,
          ].join("\n");
          result = yogaPreamble + "\n" + result;
        }

        // ── Resvg WASM: dynamic import + disk fallback ──────────────────────────────
        // The edge entry has `import resvg_wasm from "./resvg.wasm?module"` which is a
        // static ESM import that only works on workerd. Node.js fails because the WASM
        // binary's emscripten imports (module "a") can't be resolved as npm packages.
        //
        // Strategy: replace the static import with a dynamic import for workerd, falling
        // back to reading the .wasm file from disk + WebAssembly.compile for Node.js.
        // Resvg WASM is ~1.3MB so we read from disk instead of inlining base64.
        const RESVG_STATIC_IMPORT_RE =
          /import\s+resvg_wasm\s+from\s+["']\.\/resvg\.wasm\?module["']\s*;?/;
        const resvgMatch = RESVG_STATIC_IMPORT_RE.exec(result);
        if (resvgMatch) {
          // Note: new URL("./resvg.wasm", import.meta.url) MUST be inside the catch handler,
          // not at the top level. In workerd, import.meta.url is "worker" (not a valid URL
          // base), so new URL(..., "worker") throws TypeError at module load time.
          // The catch block only runs on Node.js where import.meta.url is a file:// URL.
          const resvgLoader = [
            `var resvg_wasm = import("./resvg.wasm?module").then(function(m) { return m.default; }).catch(function() {`,
            `  return Promise.all([import("node:fs"), import("node:url")]).then(function(mods) {`,
            `    var p = mods[1].fileURLToPath(new URL("./resvg.wasm", import.meta.url));`,
            `    return mods[0].promises.readFile(p).then(function(buf) { return WebAssembly.compile(buf); });`,
            `  });`,
            `});`,
          ].join("\n");
          result = result.replace(resvgMatch[0], resvgLoader);
        }

        if (result === code) return null;
        return { code: result, map: null };
      },
    },
  ];

  // Append auto-injected RSC plugins if applicable
  if (rscPluginPromise) {
    plugins.push(rscPluginPromise);
  }

  return plugins;
}

/**
 * Collect all NEXT_PUBLIC_* env vars and create Vite define entries
 * so they get inlined into the client bundle.
 */
function getNextPublicEnvDefines(): Record<string, string> {
  const defines: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("NEXT_PUBLIC_") && value !== undefined) {
      defines[`process.env.${key}`] = JSON.stringify(value);
    }
  }
  return defines;
}

// matchConfigPattern is imported from config-matchers.ts and re-exported
// for tests and other consumers that import it from vinext's main entry.
// The duplicate local implementation and its extractConstraint helper
// have been removed in favor of the canonical config-matchers.ts version
// which uses a single-pass tokenizer (fixing the chained .replace()
// divergence that CodeQL flagged as incomplete sanitization).
export { matchConfigPattern } from "./config/config-matchers.js";

/**
 * Strip server-only data-fetching exports (getServerSideProps,
 * getStaticProps, getStaticPaths) from page modules for the client
 * bundle. Uses Vite's parseAst (Rollup/acorn) for correct handling
 * of all export patterns including function expressions, arrow
 * functions with TS return types, and re-exports.
 *
 * Modeled after Next.js's SWC `next-ssg-transform`.
 */
function stripServerExports(code: string): string | null {
  const SERVER_EXPORTS = new Set(["getServerSideProps", "getStaticProps", "getStaticPaths"]);
  if (![...SERVER_EXPORTS].some((name) => code.includes(name))) return null;

  let ast: ReturnType<typeof parseAst>;
  try {
    ast = parseAst(code);
  } catch {
    // If parsing fails (shouldn't happen post-JSX/TS transform), bail out
    return null;
  }

  const s = new MagicString(code);
  let changed = false;

  for (const node of ast.body) {
    if (node.type !== "ExportNamedDeclaration") continue;

    // Case 1: export function name() {} / export async function name() {}
    // Case 2: export const/let/var name = ...
    if (node.declaration) {
      const decl = node.declaration;
      if (decl.type === "FunctionDeclaration" && decl.id && SERVER_EXPORTS.has(decl.id.name)) {
        s.overwrite(
          node.start,
          node.end,
          `export function ${decl.id.name}() { return { props: {} }; }`,
        );
        changed = true;
      } else if (decl.type === "VariableDeclaration") {
        for (const declarator of decl.declarations) {
          if (declarator.id?.type === "Identifier" && SERVER_EXPORTS.has(declarator.id.name)) {
            s.overwrite(node.start, node.end, `export const ${declarator.id.name} = undefined;`);
            changed = true;
          }
        }
      }
      continue;
    }

    // Case 3: export { getServerSideProps } or export { getServerSideProps as gSSP }
    if (node.specifiers && node.specifiers.length > 0 && !node.source) {
      const kept: Extract<ASTNode, { type: "ExportSpecifier" }>[] = [];
      const stripped: string[] = [];
      for (const spec of node.specifiers) {
        // spec.local.name is the binding name, spec.exported.name is the export name
        // oxlint-disable-next-line typescript/no-explicit-any
        const exportedName = (spec.exported as any)?.name ?? (spec.exported as any)?.value;
        if (SERVER_EXPORTS.has(exportedName)) {
          stripped.push(exportedName);
        } else {
          kept.push(spec);
        }
      }
      if (stripped.length > 0) {
        // Build replacement: keep non-server specifiers, add stubs for stripped ones
        const parts: string[] = [];
        if (kept.length > 0) {
          const keptStr = kept
            // oxlint-disable-next-line typescript/no-explicit-any
            .map((sp: any) => {
              const local = sp.local.name;
              const exported = sp.exported?.name ?? sp.exported?.value;
              return local === exported ? local : `${local} as ${exported}`;
            })
            .join(", ");
          parts.push(`export { ${keptStr} };`);
        }
        for (const name of stripped) {
          parts.push(`export const ${name} = undefined;`);
        }
        s.overwrite(node.start, node.end, parts.join("\n"));
        changed = true;
      }
    }
  }

  if (!changed) return null;
  return s.toString();
}

/**
 * Apply redirect rules from next.config.js.
 * Returns true if a redirect was applied.
 */
function applyRedirects(
  pathname: string,
  // oxlint-disable-next-line typescript/no-explicit-any
  res: any,
  redirects: NextRedirect[],
  ctx: RequestContext,
  basePath = "",
): boolean {
  const result = matchRedirect(pathname, redirects, ctx);
  if (result) {
    // Sanitize to prevent open redirect via protocol-relative URLs
    const dest = sanitizeDestination(
      basePath && !isExternalUrl(result.destination) && !hasBasePath(result.destination, basePath)
        ? basePath + result.destination
        : result.destination,
    );
    res.writeHead(result.permanent ? 308 : 307, { Location: dest });
    res.end();
    return true;
  }
  return false;
}

/*
 * Converts the Node.js IncomingMessage into a Web Request, calls
 * proxyExternalRequest(), and pipes the response back to the Node.js
 * ServerResponse.
 */
async function proxyExternalRewriteNode(
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
  externalUrl: string,
): Promise<void> {
  try {
    const proto = "http";
    const host = req.headers.host || "localhost";
    const origin = `${proto}://${host}`;
    const method = req.method ?? "GET";
    const hasBody = method !== "GET" && method !== "HEAD";
    const init: RequestInit & { duplex?: string } = {
      method,
      headers: Object.fromEntries(
        Object.entries(req.headers)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : String(v)]),
      ),
    };
    if (hasBody) {
      const { Readable } = await import("node:stream");
      init.body = Readable.toWeb(req) as ReadableStream;
      init.duplex = "half";
    }
    const webRequest = new Request(new URL(req.url ?? "/", origin), init);
    const proxyResponse = await proxyExternalRequest(webRequest, externalUrl);

    // Preserve multi-value headers (e.g. Set-Cookie) — Object.fromEntries()
    // would collapse them into a single value.
    const nodeHeaders: Record<string, string | string[]> = {};
    proxyResponse.headers.forEach((value, key) => {
      const existing = nodeHeaders[key];
      if (existing !== undefined) {
        nodeHeaders[key] = Array.isArray(existing) ? [...existing, value] : [existing, value];
      } else {
        nodeHeaders[key] = value;
      }
    });
    res.writeHead(proxyResponse.status, nodeHeaders);

    if (proxyResponse.body) {
      const { Readable: ReadableImport } = await import("node:stream");
      const nodeStream = ReadableImport.fromWeb(
        proxyResponse.body as import("stream/web").ReadableStream,
      );
      nodeStream.pipe(res);
    } else {
      res.end();
    }
  } catch (e) {
    console.error("[vinext] External rewrite proxy error:", e);
    if (!res.headersSent) {
      res.writeHead(502);
      res.end("Bad Gateway");
    }
  }
}

/**
 * Apply rewrite rules from next.config.js.
 * Returns the rewritten URL or null if no rewrite matched.
 */
function applyRewrites(
  pathname: string,
  rewrites: NextRewrite[],
  ctx: RequestContext,
): string | null {
  const dest = matchRewrite(pathname, rewrites, ctx);
  if (dest) {
    // Sanitize to prevent open redirect via protocol-relative URLs
    return sanitizeDestination(dest);
  }
  return null;
}

/**
 * Apply custom header rules from next.config.js.
 * Middleware headers take precedence: if a header key was already set on the
 * response (by middleware), the config value is skipped for that key.
 */
function applyHeaders(
  pathname: string,
  // oxlint-disable-next-line typescript/no-explicit-any
  res: any,
  headers: NextHeader[],
  ctx: RequestContext,
): void {
  const matched = matchHeaders(pathname, headers, ctx);
  for (const header of matched) {
    // Use append semantics for headers where multiple values must coexist
    // (Vary, Set-Cookie). Using setHeader() on these would destroy
    // existing values like "Vary: RSC, Accept".
    const lk = header.key.toLowerCase();
    if (lk === "set-cookie") {
      // Node.js res.getHeader("set-cookie") returns string[] when
      // multiple Set-Cookie headers have been set. Preserve the array.
      const existing = res.getHeader(lk);
      if (Array.isArray(existing)) {
        res.setHeader(header.key, [...existing, header.value]);
      } else if (existing) {
        res.setHeader(header.key, [String(existing), header.value]);
      } else {
        res.setHeader(header.key, header.value);
      }
    } else if (lk === "vary") {
      const existing = res.getHeader(lk);
      if (existing) {
        res.setHeader(header.key, existing + ", " + header.value);
      } else {
        res.setHeader(header.key, header.value);
      }
    } else {
      // Middleware headers take precedence: skip config keys already set by
      // middleware so middleware always wins over next.config.js headers.
      if (!res.getHeader(lk)) {
        res.setHeader(header.key, header.value);
      }
    }
  }
}

/**
 * Find a file by name (without extension) in a directory.
 * Checks the configured page extensions.
 */
function findFileWithExts(
  dir: string,
  name: string,
  matcher: ReturnType<typeof createValidFileMatcher>,
): string | null {
  for (const ext of matcher.dottedExtensions) {
    const filePath = path.join(dir, name + ext);
    if (fs.existsSync(filePath)) return filePath;
  }
  return null;
}

/** Module-level cache for hasMdxFiles — avoids re-scanning per Vite environment. */
const _mdxScanCache = new Map<string, boolean>();

/**
 * Check if the project has .mdx files in app/ or pages/ directories.
 */
function hasMdxFiles(root: string, appDir: string | null, pagesDir: string | null): boolean {
  const cacheKey = `${root}\0${appDir ?? ""}\0${pagesDir ?? ""}`;
  if (_mdxScanCache.has(cacheKey)) return _mdxScanCache.get(cacheKey)!;
  const dirs = [appDir, pagesDir].filter(Boolean) as string[];
  for (const dir of dirs) {
    if (fs.existsSync(dir) && scanDirForMdx(dir)) {
      _mdxScanCache.set(cacheKey, true);
      return true;
    }
  }
  _mdxScanCache.set(cacheKey, false);
  return false;
}

function scanDirForMdx(dir: string): boolean {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (scanDirForMdx(full)) return true;
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".mdx")) {
        return true;
      }
    }
  } catch {
    // ignore unreadable dirs
  }
  return false;
}

// Public exports for static export
export { staticExportPages, staticExportApp } from "./build/static-export.js";
export type {
  StaticExportResult,
  StaticExportOptions,
  AppStaticExportOptions,
} from "./build/static-export.js";

// Export NextConfig type so next.config.ts files can import it from "vinext"
// instead of "next".
export type { NextConfig } from "./config/next-config.js";

// Exported for CLI and testing
export {
  clientManualChunks,
  clientOutputConfig,
  clientTreeshakeConfig,
  computeLazyChunks,
  getClientOutputConfigForVite,
  getClientTreeshakeConfigForVite,
};
export { augmentSsrManifestFromBundle as _augmentSsrManifestFromBundle };
export { resolvePostcssStringPlugins as _resolvePostcssStringPlugins };
export { _postcssCache };
export { hasMdxFiles as _hasMdxFiles };
export { _mdxScanCache };
export { parseStaticObjectLiteral as _parseStaticObjectLiteral };
export { _findBalancedObject, _findCallEnd };
export { stripServerExports as _stripServerExports };
export { asyncHooksStubPlugin as _asyncHooksStubPlugin };
