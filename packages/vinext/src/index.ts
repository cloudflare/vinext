import type {
  CSSModulesOptions,
  Plugin,
  PluginOption,
  SassPreprocessorOptions,
  UserConfig,
  ViteDevServer,
} from "vite";
import { loadEnv, parseAst, transformWithOxc } from "vite";
import {
  pagesRouter,
  apiRouter,
  invalidateRouteCache,
  matchRoute,
} from "./routing/pages-router.js";
import { generateServerEntry as _generateServerEntry } from "./entries/pages-server-entry.js";
import { generateClientEntry as _generateClientEntry } from "./entries/pages-client-entry.js";
import {
  appRouteGraph,
  appRouter,
  invalidateAppRouteCache,
  matchAppRoute,
} from "./routing/app-router.js";
import type { NitroRouteRuleConfig } from "./build/nitro-route-rules.js";
import {
  buildViteResolveExtensions,
  normalizeViteResolveExtensions,
  createValidFileMatcher,
  findFileWithExts,
} from "./routing/file-matcher.js";
import { createSSRHandler } from "./server/dev-server.js";
import { handleApiRoute } from "./server/api-handler.js";
import {
  DEFAULT_DEVICE_SIZES,
  DEFAULT_IMAGE_SIZES,
  isImageOptimizationPath,
  resolveDevImageRedirect,
} from "./server/image-optimization.js";

import { installSocketErrorBackstop } from "./server/socket-error-backstop.js";
import { shouldInvalidateAppRouteFile } from "./server/dev-route-files.js";
import { createDirectRunner } from "./server/dev-module-runner.js";
import { generateRscEntry } from "./entries/app-rsc-entry.js";
import { generateSsrEntry } from "./entries/app-ssr-entry.js";
import {
  VIRTUAL_CACHE_ADAPTERS,
  generateCacheAdaptersModule,
  type VinextCacheConfig,
} from "./cache/cache-adapters-virtual.js";
import {
  generateBrowserEntry,
  isLinkPrefetchRoute,
  toDocumentOnlyAppRoute,
  toLinkPrefetchRoute,
} from "./entries/app-browser-entry.js";
import {
  collectRouteClassificationManifest,
  type RouteClassificationManifest,
} from "./build/route-classification-manifest.js";
import { planRouteClassificationInjection } from "./build/route-classification-injector.js";
import { normalizePathnameForRouteMatchStrict } from "./routing/utils.js";
import {
  createRscCompatibilityId,
  findNextConfigPath,
  loadNextConfig,
  resolveNextConfigInput,
  resolveNextConfig,
  type NextConfig,
  type NextConfigInput,
  type ResolvedNextConfig,
} from "./config/next-config.js";

import { findMiddlewareFile, runMiddleware } from "./server/middleware.js";
import { isNextDataPathname, parseNextDataPathname } from "./server/pages-data-route.js";
import {
  MIDDLEWARE_NEXT_HEADER,
  MIDDLEWARE_REWRITE_HEADER,
  NEXTJS_DEPLOYMENT_ID_HEADER,
  VINEXT_MW_CTX_HEADER,
  VINEXT_TIMING_HEADER,
} from "./server/headers.js";
import { logRequest, now } from "./server/request-log.js";
import { normalizePath } from "./server/normalize-path.js";
import {
  filterInternalHeaders,
  INTERNAL_HEADERS,
  isOpenRedirectShaped,
  normalizeTrailingSlash,
  VINEXT_INTERNAL_HEADERS,
} from "./server/request-pipeline.js";
import {
  findInstrumentationClientFile,
  findInstrumentationFile,
  runInstrumentation,
} from "./server/instrumentation.js";
import { PHASE_PRODUCTION_BUILD, PHASE_DEVELOPMENT_SERVER } from "vinext/shims/constants";
import { precompressAssets } from "./build/precompress.js";
import { ensureAssetsIgnore } from "./build/assets-ignore.js";
import { emitNextClientRuntimeManifests } from "./build/next-client-runtime-manifests.js";
import { collectInlineCssManifest, injectInlineCssManifestGlobal } from "./build/inline-css.js";
import { validateDevRequest } from "./server/dev-origin-check.js";
import { installDevStackSourcemapMiddleware } from "./server/dev-stack-sourcemap.js";

import { scanMetadataFiles } from "./server/metadata-routes.js";

import {
  runPagesRequest,
  type PagesPipelineDeps,
  type MiddlewareResult,
} from "./server/pages-request-pipeline.js";
import {
  pagesRouteHasPriorityOverAppRoute,
  validateHybridRouteConflicts,
} from "./server/hybrid-route-priority.js";
import { matchesRewriteSource, proxyExternalRequest } from "./config/config-matchers.js";
import { detectPackageManager } from "./utils/project.js";
import { isUnknownRecord as isRecord } from "./utils/record.js";
import { ASSET_PREFIX_URL_DIR, resolveAssetsDir } from "./utils/asset-prefix.js";
import { renderVinextBuiltUrl } from "./utils/built-asset-url.js";
import { asyncHooksStubPlugin } from "./plugins/async-hooks-stub.js";
import { clientReferenceDedupPlugin } from "./plugins/client-reference-dedup.js";
import { dataUrlCssPlugin } from "./plugins/css-data-url.js";
import { createRscClientReferenceLoadersPlugin } from "./plugins/rsc-client-reference-loaders.js";
import { createInstrumentationClientTransformPlugin } from "./plugins/instrumentation-client.js";
import {
  generateInstrumentationClientInjectModule,
  INSTRUMENTATION_CLIENT_EMPTY_MODULE,
} from "./client/instrumentation-client-inject.js";
import { createMiddlewareServerOnlyPlugin } from "./plugins/middleware-server-only.js";
import { createOptimizeImportsPlugin } from "./plugins/optimize-imports.js";
import { createDynamicPreloadMetadataPlugin } from "./plugins/dynamic-preload-metadata.js";
import { createOgInlineFetchAssetsPlugin, createOgAssetsPlugin } from "./plugins/og-assets.js";
import { generateRouteTypes } from "./typegen.js";
import {
  mergeOptimizeDepsExclude,
  SSR_EXTERNAL_REACT_ENTRIES,
  VINEXT_OPTIMIZE_DEPS_EXCLUDE,
} from "./plugins/rsc-client-shim-excludes.js";
import { createServerExternalsManifestPlugin } from "./plugins/server-externals-manifest.js";
import {
  VIRTUAL_GOOGLE_FONTS,
  RESOLVED_VIRTUAL_GOOGLE_FONTS,
  parseStaticObjectLiteral,
  generateGoogleFontsVirtualModule,
  createGoogleFontsPlugin,
  createLocalFontsPlugin,
} from "./plugins/fonts.js";
import { hasWranglerConfig, formatMissingCloudflarePluginError } from "./deploy.js";
import {
  computeClientRuntimeMetadata,
  buildRuntimeGlobalsScript,
} from "./utils/client-runtime-metadata.js";
import {
  VINEXT_CLIENT_ENTRY_MANIFEST,
  type ClientEntryManifest,
} from "./utils/client-entry-manifest.js";
import { resolvePostcssStringPlugins } from "./plugins/postcss.js";
import {
  buildSassPreprocessorOptions,
  createSassTildeImporter,
  createSassAwareFileSystemLoader,
} from "./plugins/sass.js";
import {
  createClientFileNameConfig,
  createClientManualChunks,
  createClientOutputConfig,
  createClientCodeSplittingConfig,
  createClientAssetFileNames,
  createRscFrameworkChunkOutputConfig,
  getClientTreeshakeConfigForVite,
  getBuildBundlerOptions,
  withBuildBundlerOptions,
} from "./build/client-build-config.js";
import {
  markCssUrlAssetReferences,
  restoreDedupedCssAssetReferences,
} from "./build/css-url-assets.js";
import {
  augmentSsrManifestFromBundle,
  tryRealpathSync,
  relativeWithinRoot,
  type BundleBackfillChunk,
} from "./build/ssr-manifest.js";
import {
  hasExportAllCandidate,
  hasServerExportCandidate,
  stripServerExports,
  validatePageExports,
} from "./plugins/strip-server-exports.js";
import { removeConsoleCalls } from "./plugins/remove-console.js";
import { createImportMetaUrlPlugin } from "./plugins/import-meta-url.js";
import { createRequireContextPlugin } from "./plugins/require-context.js";
import { createExtensionlessDynamicImportPlugin } from "./plugins/extensionless-dynamic-import.js";
import { createWasmModuleImportPlugin } from "./plugins/wasm-module-import.js";
import { getTypeofWindowReplacement, replaceTypeofWindow } from "./plugins/typeof-window.js";
import { hasMdxFiles } from "./utils/mdx-scan.js";
import { scanPublicFileRoutes } from "./utils/public-routes.js";
import tsconfigPaths from "vite-tsconfig-paths";
import type { Options as VitePluginReactOptions } from "@vitejs/plugin-react";
import MagicString from "magic-string";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import fs from "node:fs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import commonjs from "vite-plugin-commonjs";
import { normalizePathSeparators, stripJsExtension, stripViteModuleQuery } from "./utils/path.js";
import {
  getDepOptimizeNodeEnvOptions,
  getViteMajorVersion,
  serializeViteDefine,
} from "./utils/vite-version.js";

// Install the process-level peer-disconnect backstop at module load.
// Vite plugin lifecycle hooks (config / configureServer) proved
// timing-fragile in vite-plus — install was silently skipped,
// confirmed via VINEXT_DEBUG_SOCKET_ERRORS=1. Skips Vitest workers
// via env-var gate; bypasses during prerender via fire-time
// VINEXT_PRERENDER check. See socket-error-backstop.ts.
installSocketErrorBackstop();

type ASTNode = ReturnType<typeof parseAst>["body"][number]["parent"];

function isInsideDirectory(dir: string, filePath: string): boolean {
  const relativePath = path.relative(dir, filePath);
  return relativePath !== "" && !relativePath.startsWith("..") && !path.isAbsolute(relativePath);
}

function hasServerOnlyMarkerImport(code: string): boolean {
  if (!code.includes("server-only")) return false;

  let ast: ReturnType<typeof parseAst>;
  try {
    ast = parseAst(code);
  } catch {
    return false;
  }

  function walk(node: ASTNode | ASTNode[] | null | undefined): boolean {
    if (!node) return false;
    if (Array.isArray(node)) return node.some((child) => walk(child));
    if (typeof node !== "object") return false;

    if (node.type === "ImportDeclaration") {
      const source = (node as ASTNode & { source?: { value?: unknown } }).source?.value;
      if (source === "server-only") return true;
    }

    if (node.type === "CallExpression") {
      const call = node as ASTNode & {
        callee?: { type?: string; name?: string };
        arguments?: Array<{ type?: string; value?: unknown }>;
      };
      if (
        call.callee?.type === "Identifier" &&
        call.callee.name === "require" &&
        call.arguments?.[0]?.type === "Literal" &&
        call.arguments[0].value === "server-only"
      ) {
        return true;
      }
    }

    for (const key of Object.keys(node)) {
      if (key === "type" || key === "start" || key === "end" || key === "loc" || key === "parent") {
        continue;
      }
      const value = (node as unknown as Record<string, unknown>)[key];
      if (Array.isArray(value)) {
        if (value.some((child) => child && typeof child === "object" && walk(child as ASTNode))) {
          return true;
        }
      } else if (value && typeof value === "object" && "type" in value) {
        if (walk(value as ASTNode)) return true;
      }
    }

    return false;
  }

  return walk(ast.body);
}

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
  const candidates = [".ts", ".tsx", ".js"];
  for (const ext of candidates) {
    const candidate = path.posix.join(shimsDir, `${moduleName}${ext}`);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return path.posix.join(shimsDir, `${moduleName}.js`);
}

function isVercelOgImport(id: string): boolean {
  return id === "@vercel/og" || id === "@vercel/og.js";
}

function isVinextOgShimImporter(importer: string | undefined): boolean {
  if (!importer) return false;
  const cleanImporter = (importer.startsWith("\0") ? importer.slice(1) : importer).split("?")[0];
  const normalizedImporter = cleanImporter.replace(/\\/g, "/");
  return (
    normalizedImporter.endsWith("/shims/og.tsx") ||
    normalizedImporter.endsWith("/shims/og.js") ||
    normalizedImporter.endsWith("/dist/shims/og.js")
  );
}

function toRelativeFileEntry(root: string, absPath: string): string {
  return path.relative(root, absPath).split(path.sep).join("/");
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

/**
 * Normalize a tsconfig `extends` field into a list of specifier strings.
 *
 * TypeScript 5.0+ allows `extends` to be either a string or an array of
 * strings. Matches Next.js's handling in
 * packages/next/src/build/next-config-ts/transpile-config.ts, where parents
 * are iterated in order and later entries override earlier ones.
 */
function normalizeTsconfigExtends(extendsField: unknown): string[] {
  if (typeof extendsField === "string") return [extendsField];
  if (Array.isArray(extendsField)) {
    return extendsField.filter((value): value is string => typeof value === "string");
  }
  return [];
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
  // `extends` may be a string or (TypeScript 5.0+) an array; iterate parents in
  // order so later entries override earlier ones (matching Next.js).
  for (const extendsSpecifier of normalizeTsconfigExtends(parsed.extends)) {
    const extendedPath = resolveTsconfigExtends(normalizedPath, extendsSpecifier);
    if (extendedPath) {
      aliases = { ...aliases, ...loadTsconfigPathAliases(extendedPath, projectRoot, seen) };
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
 * Read the vinext package version once at plugin load. Surfaced via
 * `process.env.__NEXT_VERSION` define so `window.next.version` lands a
 * real string instead of the `"vinext"` fallback. Resolved relative to
 * this module's own `package.json`, not the project root.
 *
 * Defaults to `"vinext"` on read failure so a malformed install never
 * breaks the build — only the diagnostic global loses fidelity.
 */
let _vinextVersionCache: string | null = null;
function getVinextVersion(): string {
  if (_vinextVersionCache !== null) return _vinextVersionCache;
  try {
    const pkgUrl = new URL("../package.json", import.meta.url);
    const pkg = JSON.parse(fs.readFileSync(pkgUrl, "utf-8")) as { version?: unknown };
    _vinextVersionCache = typeof pkg.version === "string" ? pkg.version : "vinext";
  } catch {
    _vinextVersionCache = "vinext";
  }
  return _vinextVersionCache;
}

type UserResolveConfigWithTsconfigPaths = NonNullable<UserConfig["resolve"]> & {
  tsconfigPaths?: boolean;
};

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
const VIRTUAL_ROOT_PARAMS = "virtual:vinext-root-params";
const RESOLVED_ROOT_PARAMS = "\0" + VIRTUAL_ROOT_PARAMS;
/** Virtual module that registers config-driven cache adapters (see VinextOptions.cache). */
const RESOLVED_CACHE_ADAPTERS = "\0" + VIRTUAL_CACHE_ADAPTERS;
/** Virtual module for composed instrumentation-client bootstrap. */
const VIRTUAL_INSTRUMENTATION_CLIENT = "private-next-instrumentation-client";
const RESOLVED_INSTRUMENTATION_CLIENT = `\0${VIRTUAL_INSTRUMENTATION_CLIENT}.mjs`;
/** Image file extensions handled by the vinext:image-imports plugin.
 *  Shared between the Rolldown hook filter and the transform handler regex. */
const IMAGE_EXTS = "png|jpe?g|gif|webp|avif|svg|ico|bmp|tiff?";

function createStaticImageAsset(imagePath: string): { fileName: string; source: Buffer } {
  const source = fs.readFileSync(imagePath);
  const extension = path.extname(imagePath);
  const name = path.basename(imagePath, extension);
  const hash = createHash("sha256").update(source).digest("hex").slice(0, 8);
  return { fileName: `media/${name}.${hash}${extension}`, source };
}

/**
 * Absolute path to vinext's shims directory, with a trailing slash. Normalized
 * to forward slashes because it is prefix-matched against Vite module ids (which
 * Vite always normalizes to forward slashes) in the font plugins and
 * clientManualChunks — a raw path.resolve value has backslashes on Windows and
 * the `id.startsWith(_shimsDir)` checks would never match.
 */
const _shimsDir = normalizePathSeparators(path.resolve(__dirname, "shims")) + "/";
const _fontGoogleShimPath = resolveShimModulePath(_shimsDir, "font-google");
const _appRscHandlerPath = resolveShimModulePath(
  path.resolve(__dirname, "server"),
  "app-rsc-handler",
);
// Source checkouts resolve to TypeScript and must stay in Vite's graph so tests
// do not execute a stale dist build. Published packages resolve to emitted JS,
// which Node can load natively outside the RSC transform graph.
const _canExternalizeAppRscHandler = _appRscHandlerPath.endsWith(".js");

function isValidExportIdentifier(name: string): boolean {
  return /^[$A-Z_a-z][$\w]*$/.test(name);
}

function isVirtualEntryFacade(id: string | null | undefined, virtualId: string): boolean {
  if (!id) return false;
  const cleanId = id.startsWith("\0") ? id.slice(1) : id;
  return (
    cleanId === virtualId || cleanId.endsWith("/" + virtualId) || cleanId.endsWith("\\" + virtualId)
  );
}

/**
 * Returns the leading React `"use client"` or `"use server"` directive after
 * stripping leading comments, hashbang, and whitespace.
 *
 * Used by `vinext:jsx-in-js` to opt `.js` files inside `node_modules` into the
 * JSX transform. We mirror `@vitejs/plugin-rsc`'s detection by looking at the
 * directive prologue rather than scanning the whole file — `code.includes`
 * alone would match incidental occurrences in template literals or comments.
 */
function getLeadingReactDirective(code: string): "use client" | "use server" | null {
  let i = 0;
  const len = code.length;
  // Strip BOM.
  if (code.charCodeAt(0) === 0xfeff) i = 1;
  // Strip hashbang.
  if (code[i] === "#" && code[i + 1] === "!") {
    const nl = code.indexOf("\n", i);
    if (nl === -1) return null;
    i = nl + 1;
  }
  while (i < len) {
    // Skip whitespace.
    while (i < len && /\s/.test(code[i] ?? "")) i++;
    if (i >= len) return null;
    // Skip line comments.
    if (code[i] === "/" && code[i + 1] === "/") {
      const nl = code.indexOf("\n", i + 2);
      if (nl === -1) return null;
      i = nl + 1;
      continue;
    }
    // Skip block comments.
    if (code[i] === "/" && code[i + 1] === "*") {
      const end = code.indexOf("*/", i + 2);
      if (end === -1) return null;
      i = end + 2;
      continue;
    }
    // At first non-comment, non-whitespace token. Must be a string literal
    // directive to qualify (per ECMA-262 Directive Prologue grammar).
    const quote = code[i];
    if (quote !== '"' && quote !== "'") return null;
    const closing = code.indexOf(quote, i + 1);
    if (closing === -1) return null;
    const directive = code.slice(i + 1, closing);
    if (directive === "use client" || directive === "use server") return directive;
    // Other directives (e.g., "use strict") may precede the React directive.
    // Continue scanning past the statement-terminating `;` or newline.
    i = closing + 1;
    while (i < len && (code[i] === ";" || code[i] === " " || code[i] === "\t")) i++;
    if (code[i] === "\n") i++;
  }
  return null;
}

function hasReactDirective(code: string): boolean {
  return getLeadingReactDirective(code) !== null;
}

function generateRootParamsModule(rootParamNames: Iterable<string>): string {
  const names = Array.from(new Set(rootParamNames)).filter(isValidExportIdentifier).sort();
  if (names.length === 0) return "export {};\n";

  const rootParamsShimPath = resolveShimModulePath(_shimsDir, "root-params");
  const exports = names
    .map((name) => `export function ${name}() { return getRootParam(${JSON.stringify(name)}); }`)
    .join("\n");
  return `import { getRootParam } from ${JSON.stringify(rootParamsShimPath)};\n${exports}\n`;
}

/**
 * Shims with a `.react-server.ts` variant for the RSC environment.
 * Maps import specifier → base shim name. In the RSC env, resolveId
 * appends `.react-server`; in other envs it resolves to the base.
 *
 * These MUST NOT appear in `nextShimMap` (resolve.alias) because Vite's
 * alias plugin runs before user `enforce:"pre"` plugins — aliases are
 * unoverridable. Keeping them out of the alias lets the resolveId hook
 * control resolution per-environment.
 *
 * To add a new react-server shim:
 *   1. Create `<name>.react-server.ts` in src/shims/
 *   2. Add entries here for each import specifier.
 */
const _reactServerShims = new Map<string, string>([
  ["next/navigation", "navigation"],
  ["next/navigation.js", "navigation"],
  ["next/dist/client/components/navigation", "navigation"],
  ["next/error", "error"],
  ["next/error.js", "error"],
]);

const clientManualChunks = createClientManualChunks(_shimsDir);
const clientCodeSplittingConfig = createClientCodeSplittingConfig(clientManualChunks);

function getClientOutputConfigForVite(viteMajorVersion: number, assetsDir: string) {
  return viteMajorVersion >= 8
    ? {
        ...createClientFileNameConfig(assetsDir),
        assetFileNames: createClientAssetFileNames(assetsDir),
        codeSplitting: clientCodeSplittingConfig,
      }
    : createClientOutputConfig(clientManualChunks, assetsDir);
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
   * Configure cache handlers declaratively, so you don't need a custom worker
   * entry that calls `setDataCacheHandler()` / `setCdnCacheAdapter()`. Each slot
   * is a `{ adapter, options }` descriptor pointing at an adapter module whose
   * default export is a factory; the plugin registers them automatically on the
   * first request, passing the host `env` (Worker bindings) so adapters that
   * need a binding — e.g. a KV namespace — can read it.
   *
   * @example
   * import { kvDataAdapter } from "@vinext/cloudflare/cache/kv-data-adapter";
   *
   * vinext({
   *   cache: {
   *     data: kvDataAdapter({ binding: "MY_KV" }),
   *   },
   * })
   */
  cache?: VinextCacheConfig;
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
  let canonicalPagesDir: string;
  let appDir: string;
  let hasAppDir = false;
  let hasPagesDir = false;
  let nextConfig: ResolvedNextConfig;
  let fileMatcher: ReturnType<typeof createValidFileMatcher>;
  let middlewarePath: string | null = null;
  let instrumentationPath: string | null = null;
  let instrumentationClientPath: string | null = null;
  let clientInjectModule: string | null = null;
  // Resolved in the `config` hook from the user's `build.assetsInlineLimit`
  // (default 0 = always emit files, matching Next's `asset/resource`). Read by
  // the per-environment build config and the `configEnvironment` defaults
  // plugin. `config` runs before `configEnvironment`/build, and the `= 0`
  // initializer guards any unexpected hook ordering.
  let clientAssetsInlineLimit: NonNullable<UserConfig["build"]>["assetsInlineLimit"] = 0;
  let hasCloudflarePlugin = false;
  let warnedInlineNextConfigOverride = false;
  let hasNitroPlugin = false;
  let rscCompatibilityId: string | undefined;
  const draftModeSecret = randomUUID();

  // Per-plugin-instance binding of the Sass-aware CSS Modules Loader. The
  // `config` hook injects `Loader` as `css.modules.Loader` and
  // `configResolved` binds the resolved config, so multiple vinext builds in
  // one process never preprocess `composes` deps with another build's config.
  const sassComposesLoader = createSassAwareFileSystemLoader();

  // Build-time layout classification manifest, captured in the RSC virtual
  // module's load hook and consumed in renderChunk to patch the generated
  // `__VINEXT_CLASS` stub with a real dispatch table.
  let rscClassificationManifest: RouteClassificationManifest | null = null;

  // Resolve shim paths - works both from source (.ts) and built (.js)
  const shimsDir = path.resolve(__dirname, "shims");

  // Shared with the Layer 2 renderChunk hook below. Rolldown stores module
  // IDs as canonicalized filesystem paths (fs.realpathSync.native), so we must
  // canonicalize anything we hand to the classifier and anything we ask the
  // module graph for. The shim files exist in the vinext package before plugin
  // init, so realpath is safe to evaluate eagerly.
  const canonicalize = (p: string): string => tryRealpathSync(p) ?? p;
  const pageTransformCanonicalPaths = new Map<string, string>();
  const canonicalizePageTransformPath = (modulePath: string): string => {
    const cached = pageTransformCanonicalPaths.get(modulePath);
    if (cached) return cached;
    const canonicalPath = canonicalize(modulePath);
    pageTransformCanonicalPaths.set(modulePath, canonicalPath);
    return canonicalPath;
  };
  const isWithinPagesDirectory = (modulePath: string): boolean =>
    modulePath === pagesDir ||
    modulePath.startsWith(`${pagesDir}/`) ||
    modulePath === canonicalPagesDir ||
    modulePath.startsWith(`${canonicalPagesDir}/`);
  const isApiPage = (canonicalId: string): boolean => {
    const relativePath = fileMatcher.stripExtension(canonicalId.slice(canonicalPagesDir.length));
    return relativePath === "/api" || relativePath.startsWith("/api/");
  };
  const dynamicShimPaths: ReadonlySet<string> = new Set(
    [
      resolveShimModulePath(shimsDir, "headers"),
      resolveShimModulePath(shimsDir, "server"),
      resolveShimModulePath(shimsDir, "cache"),
    ].map(canonicalize),
  );

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
    // In a hybrid Pages + App Router build, expose the App Router prefetch
    // manifest to the Pages Router client entry so `<Link>`s and
    // `Router.prefetch` can mark App Router targets on `Router.components`
    // with `{ __appRouter: true }`. See `pages-client-entry.ts` and issue
    // #1526 for the Next.js parity rationale.
    const appPrefetchRoutes = hasAppDir
      ? (await appRouter(appDir, nextConfig?.pageExtensions, fileMatcher)).map((route) =>
          isLinkPrefetchRoute(route) ? toLinkPrefetchRoute(route) : toDocumentOnlyAppRoute(route),
        )
      : [];
    return _generateClientEntry(pagesDir, nextConfig, fileMatcher, {
      appPrefetchRoutes,
      instrumentationClientPath,
    });
  }

  async function writeRouteTypes(): Promise<void> {
    if (!hasAppDir) return;
    await generateRouteTypes({
      root,
      appDir,
      pageExtensions: nextConfig.pageExtensions,
    });
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
        throw new Error("vinext: Failed to load @vitejs/plugin-rsc.", {
          cause,
        });
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
        throw new Error("vinext: Failed to load @vitejs/plugin-react.", {
          cause,
        });
      });
  }

  const imageImportDimCache = new Map<string, { width: number; height: number }>();
  const staticImageAssets = new Map<string, { fileName: string; source: Buffer }>();
  const staticImageImportsByModule = new Map<string, Set<string>>();
  const writtenStaticImageFiles = new Set<string>();

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
    // Enable JSX in plain .js files. Next.js allows JSX in .js files
    // (Babel/SWC handle it transparently), but Vite 8's built-in `vite:oxc`
    // plugin excludes .js files by default (`exclude: /\.js$/`) AND infers
    // `lang: "js"` from the extension (which disables JSX parsing).
    //
    // We can't fix both issues via config alone:
    //  - Setting `oxc.exclude: []` bypasses the filter, but `lang` is still
    //    inferred as "js" from the extension, causing parse errors.
    //  - Setting `oxc.lang: "jsx"` globally breaks TypeScript files (OXC
    //    can't parse TS type annotations with `lang: "jsx"`).
    //
    // Additionally, `@vitejs/plugin-react` sets `jsxRefreshInclude` which
    // matches `.js` files, pulling them into `vite:oxc`'s transform even
    // when the main filter excludes them.
    //
    // Solution: use `enforce: "pre"` so this plugin's transform runs before
    // `vite:oxc`. We transform `.js` files with `lang: "jsx"` using Vite's
    // exported `transformWithOxc`. When `vite:oxc` later processes the
    // output, the JSX has already been compiled to createElement calls.
    //
    // For files inside `node_modules`, we only re-transform `.js`/`.mjs`
    // modules that begin with a React `"use client"` or `"use server"`
    // directive. Third-party Next.js client libraries routinely ship plain
    // `.js` files containing `"use client"` + JSX (Next.js's SWC pipeline
    // compiles JSX in `.js` transparently). Without this, `@vitejs/plugin-rsc`'s
    // `rsc:use-client` analysis pass parses those files via rolldown/oxc with
    // `lang: "js"` and fails with `RolldownError: Unexpected JSX expression`.
    //
    // We limit the node_modules transform to directive-bearing files to:
    //   1. avoid re-parsing every `.js` in `node_modules` (build perf), and
    //   2. avoid forcibly applying `lang: "jsx"` to library code that may use
    //      syntax incompatible with the JSX-enabled OXC parser.
    ...(viteMajorVersion >= 8
      ? [
          {
            name: "vinext:jsx-in-js",
            enforce: "pre" as const,
            async transform(code: string, id: string) {
              // Only handle .js/.mjs files.
              // TypeScript (.ts/.tsx/.jsx) files are handled by vite:oxc.
              const cleanId = id.split("?")[0];
              if (!/\.(m?js)$/.test(cleanId)) return;

              // Inside node_modules, restrict the JSX transform to files that
              // carry a React directive. `@vitejs/plugin-rsc` only parses
              // such modules (and only those failures have been observed in
              // the wild). The cheap `includes` check avoids any work for the
              // vast majority of `.js` files in `node_modules`.
              if (cleanId.includes("/node_modules/")) {
                if (!code.includes("use client") && !code.includes("use server")) {
                  return;
                }
                if (!hasReactDirective(code)) {
                  return;
                }
              }

              const result = await transformWithOxc(code, id, {
                lang: "jsx",
                jsx: { runtime: "automatic" as const },
                sourcemap: true,
              });
              return {
                code: result.code,
                map: result.map,
              };
            },
          } satisfies Plugin,
        ]
      : []),
    // Allow `import 'server-only'` from middleware (and any module reachable
    // from it) in non-RSC environments. Registered before `vinext:config` so
    // its `enforce: "pre"` resolveId runs ahead of @vitejs/plugin-rsc's
    // `rsc:validate-imports` (which rejects bare `server-only` outside RSC).
    // See packages/vinext/src/plugins/middleware-server-only.ts for the
    // import-chain taint design.
    createMiddlewareServerOnlyPlugin({
      getMiddlewarePath: () => middlewarePath,
      getCanonicalMiddlewarePath: () =>
        middlewarePath ? (tryRealpathSync(middlewarePath) ?? middlewarePath) : null,
      serverOnlyShimPath: resolveShimModulePath(shimsDir, "server-only"),
    }),
    // Resolve `data:text/css[+module],...` imports into virtual CSS files so
    // Vite's CSS pipeline (LightningCSS, CSS modules) processes them instead
    // of leaving the data URL as a runtime import that Node/workerd cannot
    // load. Matches Turbopack's behaviour for the Next.js
    // `css-modules-data-urls` fixture. See plugins/css-data-url.ts.
    dataUrlCssPlugin(),
    {
      name: "vinext:config",
      enforce: "pre",

      async config(config, env) {
        root = normalizePathSeparators(config.root ?? process.cwd());
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
        // Align NODE_ENV with Next.js semantics: build/preview -> production,
        // development server -> development. Next.js unconditionally forces
        // NODE_ENV during build/dev, so we do the same.
        let resolvedNodeEnv: string;
        if (mode === "test") {
          resolvedNodeEnv = "test";
        } else if (env?.command === "build" || env?.isPreview === true) {
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
          const dir = path.isAbsolute(options.appDir)
            ? options.appDir
            : path.resolve(root, options.appDir);
          baseDir = normalizePathSeparators(dir);
        } else {
          // Auto-detect: prefer root-level app/ and pages/, fall back to src/
          const hasRootApp = fs.existsSync(path.posix.join(root, "app"));
          const hasRootPages = fs.existsSync(path.posix.join(root, "pages"));
          const hasSrcApp = fs.existsSync(path.posix.join(root, "src", "app"));
          const hasSrcPages = fs.existsSync(path.posix.join(root, "src", "pages"));

          if (hasRootApp || hasRootPages) {
            baseDir = root;
          } else if (hasSrcApp || hasSrcPages) {
            baseDir = path.posix.join(root, "src");
          } else {
            baseDir = root;
          }
        }

        pagesDir = path.posix.join(baseDir, "pages");
        canonicalPagesDir = canonicalize(pagesDir);
        appDir = path.posix.join(baseDir, "app");
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
          nextConfig = await resolveNextConfig(rawConfig, root, {
            dev: env?.command === "serve" && env?.isPreview !== true,
          });

          // Build-ID coordination across plugin instances.
          //
          // A single `vinext build` can instantiate vinext() more than once —
          // the App Router multi-environment build (createBuilder().buildApp())
          // and the separate Pages Router SSR build for hybrid app+pages apps
          // are distinct plugin instances, each resolving its own config. Each
          // instance runs resolveBuildId() independently, so any non-deterministic
          // build ID diverges per instance: no `generateBuildId` (random UUID), a
          // `generateBuildId` that returns `null` (also a random UUID — see
          // resolveBuildId()), or any side-effecting `generateBuildId`. The result
          // is that the App Router runtime, the Pages Router runtime, the prerender
          // manifest, and dist/server/BUILD_ID could each get a different ID.
          //
          // The CLI resolves the build ID exactly once via the same
          // resolveBuildId() (so it already honors the user's generateBuildId,
          // including the null→UUID fallback) and publishes that authoritative
          // value via __VINEXT_SHARED_BUILD_ID. We always adopt it when set —
          // there is no case where a per-instance re-resolution should win over
          // the single shared value. The env var is only ever set by the build
          // CLI, so resolveBuildId()'s standalone semantics (dev, tests) are
          // unchanged.
          const sharedBuildId = process.env.__VINEXT_SHARED_BUILD_ID;
          if (sharedBuildId && sharedBuildId.length > 0) {
            nextConfig = { ...nextConfig, buildId: sharedBuildId };
          }
        }
        // RSC-compat ID coordination across plugin instances — same rationale as
        // the build ID above. createRscCompatibilityId() falls back to a random
        // UUID per instance when no deploymentId is pinned, so a hybrid app+pages
        // build would otherwise bake two different compatibility tokens. The CLI
        // resolves it once and publishes it via __VINEXT_SHARED_RSC_COMPATIBILITY_ID;
        // we always adopt it when set (only the build CLI ever sets it, so dev and
        // standalone resolution are unchanged).
        if (rscCompatibilityId === undefined) {
          const sharedRscCompatibilityId = process.env.__VINEXT_SHARED_RSC_COMPATIBILITY_ID;
          rscCompatibilityId =
            sharedRscCompatibilityId && sharedRscCompatibilityId.length > 0
              ? sharedRscCompatibilityId
              : createRscCompatibilityId(nextConfig);
        }
        fileMatcher = createValidFileMatcher(nextConfig.pageExtensions);
        instrumentationPath = findInstrumentationFile(root, fileMatcher);
        instrumentationClientPath = findInstrumentationClientFile(root, fileMatcher);
        middlewarePath = findMiddlewareFile(root, fileMatcher);
        const instrumentationClientInjects = nextConfig.instrumentationClientInject.map((spec) =>
          spec.startsWith("./") || spec.startsWith("../") ? path.resolve(root, spec) : spec,
        );
        clientInjectModule = instrumentationClientInjects.length
          ? generateInstrumentationClientInjectModule(
              instrumentationClientInjects,
              instrumentationClientPath,
              INSTRUMENTATION_CLIENT_EMPTY_MODULE,
            )
          : null;
        if (env?.command === "build") {
          await writeRouteTypes();
        }

        // Merge env from next.config.js with NEXT_PUBLIC_* env vars
        const defines = getNextPublicEnvDefines();
        const userNodeEnvDefine = config.define?.["process.env.NODE_ENV"];
        const hasUserNodeEnvDefine = Object.hasOwn(config.define ?? {}, "process.env.NODE_ENV");
        const nodeEnvDefine = hasUserNodeEnvDefine
          ? serializeViteDefine(userNodeEnvDefine)
          : JSON.stringify(resolvedNodeEnv);
        if (!hasUserNodeEnvDefine) {
          defines["process.env.NODE_ENV"] = nodeEnvDefine;
        }
        for (const [key, value] of Object.entries(nextConfig.env)) {
          // Skip NODE_ENV from next.config.js env — Next.js ignores it too,
          // and it would silently override the value we just set above.
          if (key === "NODE_ENV") continue;
          defines[`process.env.${key}`] = JSON.stringify(value);
        }
        // Expose basePath to client-side code
        defines["process.env.__NEXT_ROUTER_BASEPATH"] = JSON.stringify(nextConfig.basePath);
        // Expose experimental.staleTimes.static to client-side code so the
        // App Router prefetch cache can honor the configured freshness window.
        // Value is in seconds; matches Next.js' `define-env.ts` plumbing.
        //
        // Note: Next.js also defines `__NEXT_CLIENT_ROUTER_DYNAMIC_STALETIME`
        // to control partial/hover-prefetch TTL, but vinext currently uses
        // a single PREFETCH_CACHE_TTL for all prefetches without
        // distinguishing prefetch kind. Wire that up alongside the consumer
        // when prefetch-kind differentiation lands.
        defines["process.env.__NEXT_CLIENT_ROUTER_STATIC_STALETIME"] = JSON.stringify(
          String(nextConfig.staleTimes.static),
        );
        defines["process.env.__VINEXT_PREFETCH_INLINING"] = JSON.stringify(
          nextConfig.prefetchInlining ? "true" : "false",
        );
        // Emit a raw boolean (not the "true"/"false" string form used by the
        // sibling defines above): the consumer guards with
        // `if (process.env.__NEXT_GESTURE_TRANSITION)`, so the literal `false`
        // tree-shakes the gesture method away when disabled, whereas the
        // string "false" would be truthy. Matches Next.js define-env.ts.
        defines["process.env.__NEXT_GESTURE_TRANSITION"] = JSON.stringify(
          nextConfig.gestureTransition,
        );
        defines["process.env.__NEXT_APP_NAV_FAIL_HANDLING"] = JSON.stringify(
          nextConfig.appNavFailHandling,
        );
        // Expose experimental.scrollRestoration to the Pages Router client.
        // Next.js defines this from config.experimental.scrollRestoration in
        // packages/next/src/build/define-env.ts.
        defines["process.env.__NEXT_SCROLL_RESTORATION"] = JSON.stringify(
          nextConfig.scrollRestoration ? "true" : "false",
        );
        // Expose trailingSlash to client-side code so <Link> can render hrefs
        // in the canonical form and avoid an unnecessary 308 redirect bounce.
        defines["process.env.__VINEXT_TRAILING_SLASH"] = JSON.stringify(
          nextConfig.trailingSlash ? "true" : "false",
        );
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
          // Emit the configured qualities allowlist, or `null` when unset so the
          // runtime permits any quality 1-100 (matches Next.js: an unset
          // `images.qualities` is not restricted to a single value).
          defines["process.env.__VINEXT_IMAGE_QUALITIES"] = JSON.stringify(
            JSON.stringify(nextConfig.images?.qualities ?? null),
          );
        }
        // Expose dangerouslyAllowSVG flag for the image shim's auto-skip logic.
        // When false (default), .svg sources bypass the optimization endpoint.
        defines["process.env.__VINEXT_IMAGE_DANGEROUSLY_ALLOW_SVG"] = JSON.stringify(
          String(nextConfig.images?.dangerouslyAllowSVG ?? false),
        );
        // Expose dangerouslyAllowLocalIP flag for the image shim's private-IP guard.
        // When false (default), remote image URLs with literal private-IP hostnames are blocked.
        defines["process.env.__VINEXT_IMAGE_DANGEROUSLY_ALLOW_LOCAL_IP"] = JSON.stringify(
          String(nextConfig.images?.dangerouslyAllowLocalIP ?? false),
        );
        // Build ID — resolved from next.config generateBuildId() or random UUID.
        // Exposed so server entries and the next/server shim can inject it.
        // Also used to namespace ISR cache keys so old cached entries from a
        // previous deploy are never served by the new one.
        defines["process.env.__VINEXT_BUILD_ID"] = JSON.stringify(nextConfig.buildId);
        // Public browser-facing identity for App Router RSC compatibility
        // checks. Prefer Next.js-style deploymentId when configured; otherwise
        // generate a separate token so RSC headers do not expose
        // generateBuildId() verbatim.
        defines["process.env.__VINEXT_RSC_COMPATIBILITY_ID"] = JSON.stringify(rscCompatibilityId);
        // Deployment ID — mirrors Next.js' configured NEXT_DEPLOYMENT_ID.
        // This remains empty when deploymentId is not configured; the separate
        // "use cache" key builder falls back to __VINEXT_BUILD_ID when needed.
        defines["process.env.__VINEXT_DEPLOYMENT_ID"] = JSON.stringify(
          nextConfig.deploymentId ?? "",
        );
        // Public `process.env.NEXT_DEPLOYMENT_ID` — Next.js statically inlines
        // this into client (and web worker) bundles via its DefinePlugin so
        // that user code like `new Worker(new URL('./w.ts', import.meta.url))`
        // can read `process.env.NEXT_DEPLOYMENT_ID` from inside the worker.
        // Workers can't easily share a globalThis with the main thread, so
        // inlining at compile time is the only reliable channel.
        //
        // We keep parity by exposing the same identifier in vinext: when a
        // deploymentId is configured we inline the string, otherwise inline
        // `false` to mirror Next.js' behavior when the value is absent.
        // See: packages/next/src/build/define-env.ts (`isClient` branch).
        defines["process.env.NEXT_DEPLOYMENT_ID"] = nextConfig.deploymentId
          ? JSON.stringify(nextConfig.deploymentId)
          : "false";
        // `process.env.NEXT_RUNTIME` — compile-time constant that identifies
        // the target runtime for the current bundle.  Next.js sets this in
        // every environment via its webpack DefinePlugin
        // (see packages/next/src/build/define-env.ts).  Client bundles receive
        // `''` (empty string); server bundles receive `'nodejs'` or `'edge'`
        // depending on the route's configured runtime.
        //
        // Here we set the client-bundle default to `''` at the top-level Vite
        // define, matching Next.js's client value.  The server value
        // (`'nodejs'`) is overlaid per-environment in the
        // `vinext:compiler-define-server` configEnvironment hook below, which
        // Vite merges over this base value for server environments only.
        defines["process.env.NEXT_RUNTIME"] = '""';
        // Next.js version compat — mirrors Next.js' `process.env.__NEXT_VERSION`,
        // which is substituted by their webpack DefinePlugin at build time
        // (see `packages/next/src/client/next.ts` line 5 and
        // `packages/next/src/client/app-bootstrap.ts` line 11). Userland code
        // and third-party libraries occasionally branch on this value, and
        // it's the source for `window.next.version` (set in
        // `client/window-next.ts`). We report the vinext package version
        // because vinext is the runtime — there is no underlying Next.js
        // version to surface.
        defines["process.env.__NEXT_VERSION"] = JSON.stringify(getVinextVersion());
        // App Shells — plumbing-only flag. The value is read from
        // `experimental.appShells` in next.config. Actual App Shell prefetching
        // behavior requires the segment-cache architecture, which vinext does not
        // yet implement (see issue #1614). Setting this to `true` only makes the
        // build-time define available for client-side feature gating; it does not
        // enable functional App Shell prefetching.
        // See: https://github.com/vercel/next.js/pull/93997
        defines["process.env.__NEXT_APP_SHELLS"] = JSON.stringify(nextConfig.appShells);
        // Cache Components — Next.js exposes this as a boolean build-time
        // DefinePlugin value. Some upstream fixtures intentionally use
        // `!!process.env.__NEXT_CACHE_COMPONENTS`, so the disabled state must
        // compile to `false`, not the truthy string "false".
        // See: packages/next/src/build/define-env.ts
        defines["process.env.__NEXT_CACHE_COMPONENTS"] = JSON.stringify(
          nextConfig.cacheComponents ?? false,
        );

        // User-defined compile-time constants from `compiler.define` in
        // next.config. Applied to BOTH client and server bundles via Vite's
        // top-level `define`. Values are already JSON-stringified by
        // resolveNextConfig (matching Webpack DefinePlugin semantics).
        // Server-only `compiler.defineServer` entries are layered in below
        // via `configEnvironment` so they never leak into the client bundle.
        //
        // Parity with Next.js: collide against any internal define (e.g.
        // `process.env.NODE_ENV`, `process.env.__NEXT_*`, `__VINEXT_*`) and
        // throw, instead of silently overwriting. Mirrors the check in
        // packages/next/src/build/define-env.ts.
        // See: https://nextjs.org/docs/app/api-reference/config/next-config-js/compiler#define
        for (const [key, value] of Object.entries(nextConfig.compilerDefine)) {
          if (key in defines) {
            throw new Error(
              `The \`compiler.define\` option is configured to replace the \`${key}\` variable. ` +
                `This variable is either part of a built-in or is already configured.`,
            );
          }
          defines[key] = value;
        }
        // `compiler.defineServer` is applied per-environment below, but we
        // still validate collisions here against (a) vinext's internal
        // defines and (b) the user's own `compiler.define` map — Next.js
        // rejects both cases. Doing the check eagerly keeps the failure
        // mode predictable: misconfigured projects fail at config resolution
        // instead of producing subtly wrong output.
        for (const key of Object.keys(nextConfig.compilerDefineServer)) {
          if (key in defines) {
            throw new Error(
              `The \`compiler.defineServer\` option is configured to replace the \`${key}\` variable. ` +
                `This variable is either part of a built-in or is already configured.`,
            );
          }
        }

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
            // "next/navigation" is NOT here — it's in _reactServerShims and
            // handled by the resolveId hook for per-environment control (#834).
            "next/headers": path.join(shimsDir, "headers"),
            "next/font/google": path.join(shimsDir, "font-google"),
            "next/font/local": path.join(shimsDir, "font-local"),
            "next/cache": path.join(shimsDir, "cache"),
            "next/form": path.join(shimsDir, "form"),
            "next/og": path.join(shimsDir, "og"),
            "next/web-vitals": path.join(shimsDir, "web-vitals"),
            "next/amp": path.join(shimsDir, "amp"),
            "next/offline": path.join(shimsDir, "offline"),
            // "next/error" is NOT here — it's in _reactServerShims so Server
            // Components receive Next.js's client-only throwing stub.
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
            "next/dist/server/request/root-params": path.join(shimsDir, "root-params"),
            // Re-export public modules for internal path imports
            // "next/dist/client/components/navigation" in _reactServerShims (#834).
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
            "vinext/pages-router-runtime": path.join(shimsDir, "pages-router-runtime"),
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
            "vinext/dev-error-overlay": path.resolve(__dirname, "server", "dev-error-overlay"),
            "vinext/html": path.resolve(__dirname, "server", "html"),
            ...(clientInjectModule === null
              ? {
                  "private-next-instrumentation-client":
                    instrumentationClientPath ?? INSTRUMENTATION_CLIENT_EMPTY_MODULE,
                }
              : {}),
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

        // Translate `sassOptions` from next.config into Vite's
        // `css.preprocessorOptions.scss` / `.sass` shape so SCSS variables
        // defined via `additionalData` / `prependData`, partials resolved
        // via `includePaths` / `loadPaths`, and a custom `implementation`
        // all behave the same as in Next.js. Next.js destructures these
        // keys before forwarding the rest to sass-loader; we mirror that
        // mapping so users who configured SCSS in next.config don't have
        // to duplicate it in vite.config.
        //
        // Reference: packages/next/src/build/webpack/config/blocks/css/index.ts
        const sassPreprocessorOptions = buildSassPreprocessorOptions(nextConfig.sassOptions);

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
        const hasBuildInput = getBuildBundlerOptions(config.build)?.input !== undefined;
        // True when a dedicated client build environment exists to carry the
        // client-only `assetsInlineLimit` default; otherwise we apply it at the
        // top level (single-build client output) so RSC/SSR stay untouched.
        const shouldInjectPlainPagesEnvironments =
          !hasAppDir && !hasCloudflarePlugin && !isSSR && !hasBuildInput;
        const hasClientBuildEnvironment =
          hasAppDir || hasCloudflarePlugin || hasNitroPlugin || shouldInjectPlainPagesEnvironments;
        const clientAssetsDir = resolveAssetsDir(nextConfig.assetPrefix ?? "");
        // Next emits CSS url() deps as files, not inlined data URLs. A user's
        // explicit `build.assetsInlineLimit` always wins.
        clientAssetsInlineLimit = config.build?.assetsInlineLimit ?? 0;
        const devHmrConfig =
          config.server?.hmr === false
            ? false
            : {
                ...(typeof config.server?.hmr === "object" ? config.server.hmr : {}),
                overlay: false,
              };

        // Override the default postcss-modules FileSystemLoader so that
        // .scss/.sass files referenced via `composes: from` are preprocessed
        // through Sass before PostCSS scoping runs (spread into `css` below).
        // The `Loader` field is a postcss-modules option not reflected in
        // Vite's `CSSModulesOptions` type definition, hence the cast.
        //
        // Plugin `config` returns are merged *over* the user config, and
        // Vite's `mergeConfigRecursively` lets an object override a `false`
        // value — so injecting unconditionally would silently re-enable
        // CSS Modules for a user who set `css.modules: false`, and would
        // clobber a user-provided custom `Loader`. Skip injection in both
        // cases.
        const cssModulesOverride: { modules?: CSSModulesOptions } =
          config.css?.modules === false ||
          (typeof config.css?.modules === "object" && "Loader" in config.css.modules)
            ? {}
            : { modules: { Loader: sassComposesLoader.Loader } as CSSModulesOptions };

        const viteConfig: UserConfig = {
          // Disable Vite's default HTML serving - we handle all routing
          appType: "custom",
          build: {
            // Emit asset files (CSS, etc.) referenced by SSR JS chunks.
            //
            // Vite defaults `environments.ssr.build.emitAssets` to `false`
            // because the SSR environment has `consumer: "server"`. With
            // code-split CSS (the default), the CSS plugin still rewrites
            // server-component CSS imports into `import "<hash>.css"`
            // statements in the SSR JS, then emits the CSS asset via
            // `emitFile`. The asset is subsequently stripped from the
            // bundle by Vite's `vite:asset` generateBundle hook because
            // `emitAssets` is false — leaving Node's ESM loader to crash
            // on the unresolvable import the first time `vinext start`
            // imports the SSR entry:
            //
            //   Error [ERR_MODULE_NOT_FOUND]: Cannot find module
            //     'dist/server/ssr/style.css'
            //     imported from 'dist/server/ssr/index.js'
            //
            // Setting `ssrEmitAssets: true` at the top level propagates
            // into `environments.ssr.build.emitAssets`. We use the
            // top-level form because Vite re-applies it during
            // `resolveConfig` (see `resolveConfig` in vite/src/node/config.ts)
            // and would otherwise overwrite any per-environment value we
            // tried to set in `environments.ssr.build`. `@vitejs/plugin-rsc`
            // already sets `emitAssets: true` on the `rsc` environment for
            // the same reason; this mirrors that for `ssr`. Affects only
            // the build pipeline.
            ssrEmitAssets: true,
            // CSS minification target. Vite/esbuild defaults to the same target
            // as JS (modern evergreens), which lets esbuild's CSS minifier rewrite
            // `@media (max-width: 768px)` to the Media Queries Level 4 range
            // syntax `@media (width <= 768px)`. Both forms are semantically
            // equivalent in modern browsers, but the rewrite is observable to
            // user code that inspects `cssText` of `CSSMediaRule`s and breaks
            // tools that pattern-match the raw query string. Next.js does not
            // perform this rewrite by default (its webpack/lightningcss CSS
            // pipeline preserves the original syntax), so user code carried
            // over from Next.js can break when migrating to vinext.
            //
            // esbuild lowers a CSS feature when ANY target in the list lacks
            // support, so we only need to pin one engine below the range-syntax
            // baseline. Range syntax shipped in Chrome 104, Edge 104, Firefox 63,
            // and Safari 16.4 (per esbuild's `internal/compat/css_table.go`
            // MediaRange entry — and caniuse). Of those, Safari is the latest:
            // pinning `safari15` (semantically Safari 15.0, which predates
            // Safari 16.4) is sufficient to suppress the rewrite on its own.
            //
            // The other three targets are pinned to ~2023 baselines instead of
            // the absolute oldest supported version so esbuild does NOT
            // collaterally downlevel unrelated modern CSS features. With
            // chrome111/edge111/firefox114 we keep through:
            //   - `:is()` pseudo-class (Chrome 88, Firefox 78)
            //   - `hwb()` colors (Chrome 101, Firefox 96)
            //   - `lab()`, `oklch()`, `color()` (Chrome 111, Firefox 113)
            //   - gradient interpolation hints (Chrome 111)
            // CSS Nesting (Chrome 120, Safari 17.2) and Firefox-137 gradient
            // interpolation will still be lowered; that is an intentional
            // trade-off — those features are newer than the baseline and
            // lowering them is the correct behavior for our target audience.
            //
            // Mirrors the Next.js fixture
            // test/e2e/app-dir/css-media-query/css-media-query.test.ts which
            // asserts `cssText` preserves `max-width: 768px`.
            cssTarget: ["chrome111", "edge111", "firefox114", "safari15"],
            // Direct Vite to write build output under the canonical Next.js
            // layout so the on-disk path mirrors the emitted URL path:
            //   - empty `assetPrefix`     → `_next/static/`
            //   - path prefix (`/cdn`)    → `cdn/_next/static/`
            //   - absolute URL            → `_next/static/` (CDN serves it
            //                                directly via renderBuiltUrl)
            //
            // Pair with `experimental.renderBuiltUrl` below: the on-disk
            // layout matches the URL path so the Cloudflare ASSETS binding
            // and any static file server can resolve
            // `<assetPrefix?>/_next/static/...` requests directly, and
            // misses naturally fall through as plain-text 404s.
            assetsDir: clientAssetsDir,
            // Single-build client output has no client environment to carry the
            // default, so apply it at the top level. Multi-env builds set it on
            // `environments.client.build` below to avoid changing RSC/SSR asset
            // handling.
            ...(!isSSR && !hasClientBuildEnvironment
              ? { assetsInlineLimit: clientAssetsInlineLimit }
              : {}),
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
                  // proxy.ts / middleware.ts may export either a named handler
                  // or default export. The generated virtual entries probe both
                  // forms and validate at runtime, which can trigger noisy
                  // IMPORT_IS_UNDEFINED warnings when only one form exists.
                  // Match any file extension because findMiddlewareFile() scans
                  // all configured pageExtensions, not just .ts/.js.
                  if (
                    warning.code === "IMPORT_IS_UNDEFINED" &&
                    /Import `(?:default|proxy|middleware)` will always be undefined/.test(
                      warning.message ?? "",
                    ) &&
                    /\b(?:proxy|middleware)\.\w+\b/.test(warning.message ?? "") &&
                    (warning.message?.includes("virtual:vinext-rsc-entry") ||
                      warning.message?.includes("virtual:vinext-server-entry"))
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
                ? {
                    treeshake: getClientTreeshakeConfigForVite(viteMajorVersion),
                  }
                : {}),
              // Code-split client bundles: separate framework (React/ReactDOM),
              // vinext runtime (shims), and vendor packages into their own
              // chunks so pages only load the JS they need.
              // Only apply globally for standalone client builds (CLI Pages
              // Router). For multi-environment builds (App Router, Cloudflare),
              // manualChunks is set per-environment on the client env below
              // to avoid leaking into RSC/SSR environments.
              ...(!isSSR && !isMultiEnv
                ? { output: getClientOutputConfigForVite(viteMajorVersion, clientAssetsDir) }
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
            hmr: devHmrConfig,
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
          // Also skip `noExternal: true` when the user opted into
          // `ssr.external: true` — they've explicitly asked for everything
          // external, and forcing `noExternal: true` here leaks down into
          // `environments.ssr.resolve.noExternal` (Vite uses top-level
          // `ssr.*` as the default for the per-env resolve config), which
          // makes Vite bundle React despite the user's intent and produces
          // the duplicate-React crashes documented in #1103.
          // This also resolves extensionless-import issues in packages like
          // `validator` (see #189) by routing them through Vite's resolver.
          ...(hasCloudflarePlugin || hasNitroPlugin
            ? {}
            : config.ssr?.external === true
              ? { ssr: { external: true as const } }
              : {
                  ssr: {
                    external: ["react", "react-dom", "react-dom/server", "ipaddr.js"],
                    noExternal: true,
                  },
                }),
          resolve: {
            // Materialize simple tsconfig/jsconfig path aliases into resolve.alias
            // so Vite can transform import.meta.glob("@/...") and import(`@/...`).
            alias: {
              ...tsconfigPathAliases,
              ...nextConfig.aliases,
              ...nextShimMap,
            },
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
          // Enable JSX in .js files. Next.js allows JSX in plain .js
          // files (Babel/SWC handle it transparently), but Vite 8's OXC
          // transform defaults exclude .js files (both via the filter
          // `exclude: /\.js$/` and by inferring `lang: "js"` from the
          // extension, which disables JSX parsing).
          //
          // We leave the OXC filter defaults alone (letting `.js` files be
          // excluded from `vite:oxc`) and instead handle `.js` files in a
          // separate `vinext:jsx-in-js` plugin that runs before `vite:oxc`.
          // That plugin transforms `.js` files with OXC using `lang: "jsx"`
          // so JSX syntax is parsed correctly, while TypeScript files
          // continue to use `vite:oxc`'s default `lang` inference.
          //
          // Vite 7 uses `esbuild` for transforms, Vite 8+ uses `oxc`.
          ...(viteMajorVersion >= 8
            ? { oxc: { jsx: { runtime: "automatic" } } }
            : { esbuild: { jsx: "automatic" } }),
          // Define env vars for client bundle
          define: defines,
          // Set base path if configured.
          //
          // `base` controls both the dev server URL prefix and the default
          // asset URL prefix in production. Routes live under `basePath`,
          // so we anchor `base` there. Asset URLs are then re-prefixed with
          // `assetPrefix` (when configured) via `experimental.renderBuiltUrl`
          // below — that keeps `basePath` and `assetPrefix` independent, as
          // they are in Next.js.
          ...(nextConfig.basePath ? { base: nextConfig.basePath + "/" } : {}),
          // When `assetPrefix` is configured, override Vite's default
          // `assetsURL = base + url` behaviour so emitted JS/CSS/asset URLs
          // start with the configured asset prefix and use Next.js's
          // canonical `_next/static/` directory convention. We also write
          // assets to disk under that same path layout (via `build.assetsDir`
          // above) so the Cloudflare ASSETS binding and any static file
          // server can serve them without runtime rewrites.
          //
          // When `assetPrefix` is empty, Vite's default `base + url`
          // composition already produces the correct `/_next/static/...`
          // URLs because `build.assetsDir` is `_next/static` — so this
          // override is only needed for the configured cases.
          //
          // See packages/vinext/src/utils/asset-prefix.ts for the helpers
          // and Next.js docs for the contract:
          // https://nextjs.org/docs/app/api-reference/config/next-config-js/assetPrefix
          ...(nextConfig.assetPrefix || nextConfig.deploymentId
            ? {
                experimental: {
                  renderBuiltUrl: (filename: string, context) =>
                    renderVinextBuiltUrl(
                      filename,
                      nextConfig.assetPrefix,
                      nextConfig.deploymentId,
                      context.hostType,
                    ),
                },
              }
            : {}),
          // Inject resolved PostCSS plugins (when found), any sassOptions
          // translated from next.config, and the Sass-aware CSS Modules Loader.
          // All end up on `css.*`, so we merge them into a single `css` object
          // rather than emitting `{ css: ... }` twice (the second would clobber
          // the first).
          //
          // The tilde importer is ALWAYS injected so that SCSS files can use
          // webpack-style `~pkg/file` (node_modules) and `~/path` (root)
          // imports that Next.js (sass-loader) supports out of the box.
          // See: test/e2e/app-dir/scss/npm-import-tilde and #1825.
          //
          // The `SassAwareFileSystemLoader` is injected as
          // `css.modules.Loader` (via `cssModulesOverride` above) so that
          // SCSS files referenced by
          // `composes: className from './other.module.scss'` are compiled
          // through Sass before CSS-module class scoping runs.  Without this,
          // raw SCSS variables (`$var: red;`) end up in the PostCSS output and
          // cause LightningCSS to fail with "Invalid empty selector" during
          // the production minification step.  See issue #1825.
          css: {
            ...(nextConfig.useLightningcss
              ? {
                  transformer: "lightningcss" as const,
                  lightningcss: {
                    ...(nextConfig.lightningCssFeatures.include
                      ? { include: nextConfig.lightningCssFeatures.include }
                      : {}),
                    ...(nextConfig.lightningCssFeatures.exclude
                      ? { exclude: nextConfig.lightningCssFeatures.exclude }
                      : {}),
                  },
                }
              : {}),
            ...(postcssOverride ? { postcss: postcssOverride } : {}),
            preprocessorOptions: (() => {
              // Tilde importer: strip the leading ~ and resolve the rest
              // either from node_modules (~pkg/...) or project root (~/).
              // Placed first so it runs before Vite's own internal importer,
              // which is appended at the end of `importers[]` by the vite:css
              // plugin (vite/src/node/plugins/css.ts makeScssWorker).
              const tildeImporter = createSassTildeImporter(root);

              // Base options shared by both .scss and .sass preprocessors.
              const baseOpts: SassPreprocessorOptions = {
                ...sassPreprocessorOptions,
                // Merge user-supplied importers (from sassOptions) with the
                // tilde importer. Tilde goes first so it gets first crack at
                // ~ prefixed URLs; other importers follow; Vite's own internal
                // importer is appended last by the vite:css plugin.
                //
                // Cast: the tilde importer implements the modern Sass
                // `FileImporter` shape structurally and user importers are
                // forwarded as-is. Vite's `importers` type resolves to the
                // concrete `sass` package types only when `sass` is
                // installed (it is `any` otherwise), so the array needs an
                // explicit cast to typecheck in both situations.
                importers: [
                  tildeImporter,
                  ...((sassPreprocessorOptions?.importers as unknown[]) ?? []),
                ] as SassPreprocessorOptions["importers"],
              };

              return {
                // Apply the same options to both `.scss` and `.sass` entry
                // points. Next.js's sass-loader rule matches /\.s[ca]ss$/,
                // so a single `sassOptions` block covers both syntaxes there.
                scss: baseOpts,
                sass: baseOpts,
              };
            })(),
            ...cssModulesOverride,
          },
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
        // Build a rolldown plugin for shims resolved via resolveId instead
        // of resolve.alias. The dep optimizer's bundler uses its own
        // rolldown pipeline (not the Vite plugin pipeline), so it needs
        // these aliases injected separately. See #834.
        const depOptimizeAliasPlugin = {
          name: "vinext:dep-optimize-alias",
          resolveId(id: string) {
            const shimBase = _reactServerShims.get(id);
            if (shimBase !== undefined) {
              return resolveShimModulePath(shimsDir, shimBase);
            }
          },
        };
        const depOptimizeNodeEnvOptions = getDepOptimizeNodeEnvOptions(
          viteMajorVersion,
          nodeEnvDefine,
        );
        // Apply the define to the default optimizer and explicitly to server
        // environments, where Vite's keepProcessEnv default prevents replacement.
        viteConfig.optimizeDeps = {
          // @tailwindcss/oxide contains native .node bindings that Rolldown cannot process
          exclude: mergeOptimizeDepsExclude(incomingExclude, VINEXT_OPTIMIZE_DEPS_EXCLUDE, [
            "@tailwindcss/oxide",
          ]),
          ...(incomingInclude.length > 0 ? { include: incomingInclude } : {}),
          ...depOptimizeNodeEnvOptions,
          rolldownOptions: {
            ...depOptimizeNodeEnvOptions.rolldownOptions,
            plugins: [depOptimizeAliasPlugin],
          },
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
          const appClientInput: Record<string, string> = { index: VIRTUAL_APP_BROWSER_ENTRY };
          if (hasPagesDir) {
            appClientInput["vinext-client-entry"] = VIRTUAL_CLIENT_ENTRY;
          }

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
                          : [
                              "satori",
                              "@resvg/resvg-js",
                              "yoga-wasm-web",
                              ...(env?.command === "serve" && _canExternalizeAppRscHandler
                                ? ["vinext/server/app-rsc-handler"]
                                : []),
                              ...userSsrExternal,
                            ],
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
                exclude: mergeOptimizeDepsExclude(incomingExclude, VINEXT_OPTIMIZE_DEPS_EXCLUDE),
                entries: optimizeEntries,
                // plugin-rsc pre-includes server.edge, but not its vendored
                // static.edge import, which it rewrites to this package specifier.
                // Prebundle both so they share the large development renderer
                // instead of transforming its raw CJS source on the first request.
                include: [...new Set([...incomingInclude, "react-server-dom-webpack/static.edge"])],
                ...depOptimizeNodeEnvOptions,
              },
              build: {
                outDir: options.rscOutDir ?? "dist/server",
                ...withBuildBundlerOptions(viteMajorVersion, {
                  input: { index: VIRTUAL_RSC_ENTRY },
                  // Split React (and the RSC flight runtime) into a dedicated
                  // CSS-free "framework" chunk so `app/global-not-found.tsx`
                  // imports that chunk for its React helpers instead of the RSC
                  // entry chunk — which carries the root layout's CSS. Without
                  // this, global-not-found inherits the layout's stylesheet and
                  // the route-miss 404 document resolves the cascade to the
                  // layout's rules instead of global-not-found's (issue #1549).
                  output: createRscFrameworkChunkOutputConfig(viteMajorVersion),
                }),
              },
            },
            ssr: {
              ...(hasCloudflarePlugin || hasNitroPlugin
                ? {}
                : {
                    resolve: {
                      external: userSsrExternal === true ? true : [...userSsrExternal, "ipaddr.js"],
                      // Force all node_modules through Vite's transform pipeline
                      // so non-JS imports (CSS, images) don't hit Node's native
                      // ESM loader. Matches Next.js behavior of bundling everything.
                      // When user sets `ssr.external: true`, skip noExternal since
                      // everything is already externalized.
                      ...(userSsrExternal === true ? {} : { noExternal: true as const }),
                    },
                  }),
              optimizeDeps: {
                // When userSsrExternal === true, exclude React from the SSR
                // optimizer so plugin-rsc's crawlFrameworkPkgs doesn't pre-bundle
                // a duplicate React copy into deps_ssr/. The SSR env loads React
                // via Node's resolver instead, sharing one instance with the
                // renderer and any 'use client' module SSR'd through it. See
                // https://github.com/cloudflare/vinext/issues/1103.
                //
                // `ipaddr.js` is imported by the next/image client shim for
                // server-side private-IP validation. We externalize it on Node
                // SSR via resolve.external above; excluding it from the dep
                // optimizer prevents Vite from pre-bundling it on first request
                // (and the resulting "new dependencies optimized" full reload).
                // On bundled runtimes (Cloudflare/Nitro) the runtime build
                // bundles it anyway, so excluding it from the dev optimizer
                // is still correct — it just defers handling to the runtime
                // resolver instead of the SSR pre-bundle step.
                exclude: mergeOptimizeDepsExclude(
                  incomingExclude,
                  VINEXT_OPTIMIZE_DEPS_EXCLUDE,
                  ["ipaddr.js"],
                  userSsrExternal === true ? SSR_EXTERNAL_REACT_ENTRIES : [],
                ),
                entries: optimizeEntries,
                ...depOptimizeNodeEnvOptions,
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
                exclude: mergeOptimizeDepsExclude(
                  incomingExclude,
                  VINEXT_OPTIMIZE_DEPS_EXCLUDE,
                  nextServerExternal,
                ),
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
                // Production App Router rendering needs Vite's client manifest
                // to resolve next/dynamic module IDs to the exact JS/CSS files
                // that should be preloaded when a dynamic boundary renders.
                // Cloudflare builds also use it to inject lazy chunk metadata
                // into the Worker entry.
                manifest: true,
                ...(hasPagesDir ? { ssrManifest: true } : {}),
                // Client-scoped so RSC/SSR keep their normal asset handling
                // unless the user configured Vite globally.
                assetsInlineLimit: clientAssetsInlineLimit,
                ...withBuildBundlerOptions(viteMajorVersion, {
                  input: appClientInput,
                  output: getClientOutputConfigForVite(viteMajorVersion, clientAssetsDir),
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
                assetsInlineLimit: clientAssetsInlineLimit,
                ...withBuildBundlerOptions(viteMajorVersion, {
                  input: { index: VIRTUAL_CLIENT_ENTRY },
                  output: getClientOutputConfigForVite(viteMajorVersion, clientAssetsDir),
                  treeshake: getClientTreeshakeConfigForVite(viteMajorVersion),
                }),
              },
            },
          };
        } else if (shouldInjectPlainPagesEnvironments) {
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
                assetsInlineLimit: clientAssetsInlineLimit,
                ...withBuildBundlerOptions(viteMajorVersion, {
                  input: { index: VIRTUAL_CLIENT_ENTRY },
                  output: getClientOutputConfigForVite(viteMajorVersion, clientAssetsDir),
                  treeshake: getClientTreeshakeConfigForVite(viteMajorVersion),
                }),
              },
            },
            ssr: {
              resolve: {
                external: ["react", "react-dom", "react-dom/server", "ipaddr.js"],
                noExternal: true as const,
              },
              optimizeDeps: {
                // `ipaddr.js` is imported by the next/image shim for
                // private-IP validation and is externalized via
                // resolve.external above. Excluding it from the SSR dep
                // optimizer avoids the "new dependencies optimized" full
                // reload the first time a Pages Router page renders an
                // <Image>.
                exclude: ["ipaddr.js"],
                ...depOptimizeNodeEnvOptions,
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

      configEnvironment(name, config) {
        const configuredExtensions =
          name === "client" ? nextConfig.resolveExtensions : nextConfig.serverResolveExtensions;
        const extensions =
          configuredExtensions === null
            ? buildViteResolveExtensions(nextConfig.pageExtensions, config.resolve?.extensions)
            : normalizeViteResolveExtensions(configuredExtensions);
        config.resolve ??= {};
        config.resolve.extensions = extensions;
        return null;
      },

      async configResolved(config) {
        // Provide the resolved config to the Sass-aware CSS Modules Loader so
        // it can call Vite's `preprocessCSS` when processing SCSS files
        // referenced by `composes: className from './file.module.scss'`.
        // Must be called early in `configResolved` before any CSS transform
        // work begins, but after the config is fully resolved so that Sass
        // preprocessor options and `css.modules` settings are in place.
        sassComposesLoader.setResolvedConfig(config);

        if (config.command === "build" && hasAppDir && hasPagesDir) {
          const [appRoutes, pageRoutes, apiRoutes] = await Promise.all([
            appRouter(appDir, nextConfig?.pageExtensions, fileMatcher),
            pagesRouter(pagesDir, nextConfig?.pageExtensions, fileMatcher),
            apiRouter(pagesDir, nextConfig?.pageExtensions, fileMatcher),
          ]);
          validateHybridRouteConflicts(
            [...pageRoutes, ...apiRoutes].map((route) => ({
              ...route,
              sourcePath: path.relative(root, route.filePath),
            })),
            appRoutes
              .filter((route) => route.pagePath !== null || route.routePath !== null)
              .map((route) => ({
                ...route,
                sourcePath: path.relative(root, route.pagePath ?? route.routePath!),
              })),
          );
        }

        // When the user sets `ssr.external: true`, strip React entries from
        // `environments.ssr.resolve.noExternal`. @vitejs/plugin-rsc populates
        // this list via crawlFrameworkPkgs, but `noExternal` overrides
        // `external: true` for the listed packages. The result is that React
        // gets bundled by Vite's transform pipeline despite the user opting
        // for full externalization, producing a second React module record
        // alongside the Node-loaded one used by externalized callers (vinext's
        // runtime). 'use client' modules SSR'd through the bundled-React env
        // then crash with `Invalid hook call` / `useContext null`. Stripping
        // these entries forces the SSR env to load React via Node externals,
        // matching the renderer's React. See #1103.
        if (hasAppDir) {
          const ssrEnv = config.environments?.ssr;
          if (ssrEnv?.resolve?.external === true && Array.isArray(ssrEnv.resolve.noExternal)) {
            // Strip React entries that @vitejs/plugin-rsc auto-adds to
            // `environments.ssr.resolve.noExternal` via crawlFrameworkPkgs.
            // With `ssr.external: true`, the SSR env loads React via Node's
            // resolver, but `noExternal: ["react", ...]` overrides that for
            // the listed packages — Vite bundles React anyway, producing a
            // second module record alongside the Node-loaded one used by
            // externalized callers (vinext's runtime). 'use client' modules
            // SSR'd through that env then crash with `useContext null` /
            // `Invalid hook call`. Stripping these entries forces the SSR
            // env to load React via Node externals so the renderer and the
            // runtime share a single React. See #1103.
            ssrEnv.resolve.noExternal = ssrEnv.resolve.noExternal.filter(
              (entry) => typeof entry !== "string" || !SSR_EXTERNAL_REACT_ENTRIES.includes(entry),
            );
          }
        }

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
        // Hook filter: only invoke JS for handled Next/Vinext compatibility modules.
        // Matches "next/navigation", "next/router.js", "virtual:vinext-rsc-entry",
        // direct @vercel/og imports in metadata routes, and \0-prefixed
        // re-imports from @vitejs/plugin-rsc.
        filter: {
          id: /(?:next\/|vinext\/(?:shims\/|server\/app-rsc-handler)|virtual:vinext-|@vercel\/og(?:\.js)?$)/,
        },
        handler(id, importer) {
          // Strip \0 prefix if present — @vitejs/plugin-rsc's generated
          // browser entry imports our virtual module using the already-resolved
          // ID (with \0 prefix). We need to re-resolve it so the client
          // environment's import-analysis can find it.
          const cleanId = id.startsWith("\0") ? id.slice(1) : id;

          if (cleanId === "vinext/server/app-rsc-handler") {
            if (
              _canExternalizeAppRscHandler &&
              this.environment?.name === "rsc" &&
              this.environment.config?.command === "serve"
            ) {
              return { id: _appRscHandlerPath, external: true };
            }
            return _appRscHandlerPath;
          }

          if (isVercelOgImport(cleanId) && !isVinextOgShimImporter(importer)) {
            return resolveShimModulePath(_shimsDir, "og");
          }

          const vinextShimPrefix = "vinext/shims/";
          if (cleanId.startsWith(vinextShimPrefix)) {
            return resolveShimModulePath(
              _shimsDir,
              stripJsExtension(stripViteModuleQuery(cleanId.slice(vinextShimPrefix.length))),
            );
          }

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
          if (cleanId === "next/root-params" || cleanId === "next/root-params.js") {
            return RESOLVED_ROOT_PARAMS;
          }
          if (
            cleanId === VIRTUAL_CACHE_ADAPTERS ||
            cleanId.endsWith("/" + VIRTUAL_CACHE_ADAPTERS) ||
            cleanId.endsWith("\\" + VIRTUAL_CACHE_ADAPTERS)
          ) {
            return RESOLVED_CACHE_ADAPTERS;
          }
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

          // Shims with react-server variants — resolve per-environment.
          // These are NOT in resolve.alias (Vite's alias plugin runs
          // before enforce:"pre" plugins and can't be overridden).
          // See https://github.com/cloudflare/vinext/issues/834
          const reactServerShim = _reactServerShims.get(cleanId);
          if (reactServerShim !== undefined) {
            const shimName =
              this.environment?.name === "rsc"
                ? `${reactServerShim}.react-server`
                : reactServerShim;
            return resolveShimModulePath(_shimsDir, shimName);
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
          // Check for global-not-found.tsx at app root (Next.js 16+ feature)
          // When present, this file replaces the root layout when serving a
          // route-miss 404. The file is responsible for emitting its own
          // <html> and <body> tags (similar to global-error.tsx).
          // See https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/global-not-found
          const globalNotFoundPath = findFileWithExts(appDir, "global-not-found", fileMatcher);
          // Collect Layer 1 (segment config) classifications for all layouts.
          // Layer 2 (module graph) runs later in renderChunk once Rollup's
          // module info is available.
          // Invariant: rscClassificationManifest must be built from the same
          // `routes` value passed to generateRscEntry below so that layout
          // indices in the manifest correspond 1:1 to the route.layouts arrays
          // used during codegen. renderChunk clears this after patching.
          rscClassificationManifest = collectRouteClassificationManifest(routes);
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
              bodySizeLimitLabel: nextConfig?.serverActionsBodySizeLimitLabel,
              htmlLimitedBots: nextConfig?.htmlLimitedBots,
              clientTraceMetadata: nextConfig?.clientTraceMetadata,
              assetPrefix: nextConfig?.assetPrefix,
              expireTime: nextConfig?.expireTime,
              reactMaxHeadersLength: nextConfig?.reactMaxHeadersLength,
              cacheMaxMemorySize: nextConfig?.cacheMaxMemorySize,
              inlineCss: nextConfig?.inlineCss,
              cacheComponents: nextConfig?.cacheComponents,
              i18n: nextConfig?.i18n,
              imageConfig: {
                deviceSizes: nextConfig?.images?.deviceSizes,
                imageSizes: nextConfig?.images?.imageSizes,
                qualities: nextConfig?.images?.qualities,
              },
              hasPagesDir,
              publicFiles: scanPublicFileRoutes(root),
              globalNotFoundPath,
              draftModeSecret,
            },
            instrumentationPath,
          );
        }
        if (id === RESOLVED_ROOT_PARAMS) {
          const routes = hasAppDir
            ? await appRouter(appDir, nextConfig?.pageExtensions, fileMatcher)
            : [];
          return generateRootParamsModule(routes.flatMap((route) => route.rootParamNames ?? []));
        }
        if (id === RESOLVED_CACHE_ADAPTERS) {
          return generateCacheAdaptersModule(options.cache);
        }
        if (id === RESOLVED_APP_SSR_ENTRY && hasAppDir) {
          return generateSsrEntry(hasPagesDir);
        }
        if (id === RESOLVED_APP_BROWSER_ENTRY && hasAppDir) {
          const graph = await appRouteGraph(appDir, nextConfig?.pageExtensions, fileMatcher);
          // In a hybrid build, the App browser entry also exposes the Pages
          // route manifest so a user who lands on an App page can still
          // see Pages ownership from a `<Link>` click.
          const pagesPrefetchRoutes = hasPagesDir
            ? [
                ...(await pagesRouter(pagesDir, nextConfig?.pageExtensions, fileMatcher)).map(
                  (route) => ({
                    canPrefetchLoadingShell: false as const,
                    isDynamic: route.isDynamic,
                    patternParts: [...route.patternParts],
                  }),
                ),
                ...(await apiRouter(pagesDir, nextConfig?.pageExtensions, fileMatcher)).map(
                  (route) => ({
                    canPrefetchLoadingShell: false as const,
                    documentOnly: true,
                    isDynamic: route.isDynamic,
                    patternParts: [...route.patternParts],
                  }),
                ),
              ]
            : [];
          return generateBrowserEntry(
            graph.routes,
            graph.routeManifest,
            pagesPrefetchRoutes,
            nextConfig.rewrites,
          );
        }
        if (id.startsWith(RESOLVED_VIRTUAL_GOOGLE_FONTS + "?")) {
          return generateGoogleFontsVirtualModule(id, _fontGoogleShimPath);
        }
      },

      // Layer 2 build-time layout classification. The generated RSC entry
      // emits a `function __VINEXT_CLASS(routeIdx) { return null; }` stub;
      // this hook patches it with a switch-statement dispatch table so the
      // runtime probe loop in app-page-execution.ts can skip the Layer 3
      // per-layout dynamic-isolation probe for layouts we proved static or
      // dynamic at build time.
      //
      // @vitejs/plugin-rsc runs the RSC environment build in two phases:
      // a scan phase that discovers client references, and a final build
      // phase that emits the real RSC entry. We only patch when we actually
      // see the stub in a chunk — the scan phase produces a tiny stub chunk
      // that does not contain our code.
      //
      // This MUST run in `renderChunk` with `order: "pre"`, NOT in
      // `generateBundle`: when server environments are minified (the default —
      // see `vinext:server-minify-defaults`), rolldown's minifier renames the
      // top-level `__VINEXT_CLASS` function and mangles its `routeIdx`
      // parameter by the time `generateBundle` runs, so the stub regex would
      // never match and build-time classification would silently no-op (every
      // route would fall back to the Layer 3 runtime probe). `renderChunk`
      // with `order: "pre"` runs before minification, so the stub is still in
      // its readable form; the patched body is then minified along with the
      // rest of the chunk, which is fine because the runtime calls the function
      // by reference rather than by name.
      renderChunk: {
        order: "pre",
        handler(code, chunk) {
          // Only run in the RSC environment. SSR/client builds never contain
          // the __VINEXT_CLASS stub so there is nothing to patch there, and
          // pulling ModuleInfo from the wrong graph would give nonsense
          // results.
          if (this.environment?.name !== "rsc") return null;
          if (!rscClassificationManifest) return null;
          // Cheap pre-filter: skip chunks that don't mention the stub at all
          // (e.g. the scan-phase chunk and every non-entry chunk).
          if (!code.includes("__VINEXT_CLASS")) return null;

          // Patching per-chunk (rather than scanning the whole bundle in
          // generateBundle) assumes the stub body and its per-route call sites
          // are emitted into the same chunk. That holds with current codegen:
          // both live in the single RSC entry module, so they never split
          // across chunks. If a future codegen change hoisted the call sites
          // into a separate chunk, this hook would patch the stub but leave the
          // callers referencing the original — revisit the hook scope then.

          const enableClassificationDebug = Boolean(process.env.VINEXT_DEBUG_CLASSIFICATION);

          // `canonicalize` and `dynamicShimPaths` are hoisted to plugin init
          // (above) so they are constructed once per plugin instance instead of
          // on every renderChunk invocation. The macOS realpath quirk
          // (/var/folders/... → /private/var/folders/...) still applies to
          // every path we hand to the classifier.

          // Adapter: the classifier in `build/layout-classification.ts` uses
          // `dynamicImportedIds` (matches the old-Rollup field name we used when
          // we wrote it). Rolldown's current ModuleInfo exposes it as
          // `dynamicallyImportedIds` (the new Rollup field name). Keep the
          // translation in one place so future call sites don't have to remember.
          const moduleInfo = {
            getModuleInfo: (moduleId: string) => {
              const info = this.getModuleInfo(moduleId);
              if (!info) return null;
              return {
                importedIds: info.importedIds ?? [],
                dynamicImportedIds: info.dynamicallyImportedIds ?? [],
              };
            },
          };

          const patchPlan = planRouteClassificationInjection({
            canonicalizeLayoutPath: canonicalize,
            chunks: [{ code, fileName: chunk.fileName }],
            dynamicShimPaths,
            enableDebugReasons: enableClassificationDebug,
            manifest: rscClassificationManifest,
            moduleInfo,
          });
          if (patchPlan.kind === "skip") return null;

          // Consume the manifest exactly once per RSC entry. Clearing here
          // prevents a stale manifest from leaking into a subsequent build pass
          // if the load hook is not re-triggered (e.g., in non-standard rebuild
          // paths).
          rscClassificationManifest = null;

          // The patched body is longer than the stub, so any existing source
          // map would be stale. RSC entry source maps are not served or
          // consumed, so nulling the map is safe and prevents stale-map
          // confusion in tooling.
          return { code: patchPlan.code, map: patchPlan.map };
        },
      },
    },
    // CSS url() asset parity with Next.js. Build-only and client-scoped: dev CSS
    // is untouched, and server environments keep Vite's default asset handling.
    {
      name: "vinext:css-url-assets-mark",
      enforce: "pre",
      apply: "build",

      transform(code, id) {
        if (this.environment?.name !== "client") return null;
        const marked = markCssUrlAssetReferences(code, id);
        if (marked === null) return null;
        // No source map: the marker is transient — it's stripped before final
        // output (generateBundle), so emitted CSS positions are unchanged, and
        // a map over the intermediate marked text carries no useful information.
        return { code: marked, map: null };
      },
    },
    {
      name: "vinext:client-css-url-assets-defaults",
      apply: "build",

      configEnvironment(name) {
        if (name !== "client") return null;
        return { build: { assetsInlineLimit: clientAssetsInlineLimit } };
      },
    },
    {
      // Minify server-side build environments (rsc/ssr and the Cloudflare
      // worker env) by default. Vite only minifies the `client` environment
      // out of the box — `build.minify` defaults to `false` for every other
      // environment — so the deployed worker (dist/server/index.js) and the
      // SSR renderer (dist/server/ssr/index.js) ship full of readable
      // identifiers, comments, and whitespace. That bloats raw size (workerd
      // cold-start parse CPU) and gzip size (counted against the Cloudflare
      // Workers size limit).
      //
      // This is a TRUE DEFAULT that yields to user configuration, NOT a hard
      // override. `apply: "build"` already scopes it to production builds
      // (never dev/preview). We then read the *incoming* per-environment
      // config: Vite seeds each non-client environment's `build` from the
      // top-level `config.build` before running configEnvironment (see
      // getDefaultEnvironmentOptions), so `config.build?.minify` here reflects
      // any explicit setting from the user (top-level OR
      // `environments.<name>.build.minify`) or an earlier plugin (e.g.
      // @cloudflare/vite-plugin). If anyone already chose a value — including
      // `false` — we leave it alone; we only fill in the default when it is
      // still unset. `minify: true` lets the rolldown/oxc toolchain pick its
      // native minifier rather than pinning a specific one.
      name: "vinext:server-minify-defaults",
      apply: "build",

      configEnvironment(name, config) {
        // The client env is already minified by Vite's defaults.
        if (name === "client") return null;
        // Respect any explicit user/plugin minify choice (including `false`).
        if (config.build?.minify !== undefined) return null;
        return { build: { minify: true } };
      },
    },
    {
      name: "vinext:css-url-assets-restore",
      enforce: "post",
      apply: "build",

      generateBundle(_options, bundle) {
        if (this.environment?.name !== "client") return;
        restoreDedupedCssAssetReferences(bundle, (asset) => {
          this.emitFile({ type: "asset", fileName: asset.fileName, source: asset.source });
        });
      },
    },
    {
      name: "vinext:client-entry-manifest",
      apply: "build",

      generateBundle(_options, bundle) {
        if (this.environment?.name !== "client") return;

        const manifest: ClientEntryManifest = {};
        for (const chunk of Object.values(bundle)) {
          if (chunk.type !== "chunk" || !chunk.isEntry) continue;

          if (isVirtualEntryFacade(chunk.facadeModuleId, VIRTUAL_CLIENT_ENTRY)) {
            manifest.pagesClientEntry = chunk.fileName;
          } else if (isVirtualEntryFacade(chunk.facadeModuleId, VIRTUAL_APP_BROWSER_ENTRY)) {
            manifest.appBrowserEntry = chunk.fileName;
          }
        }

        if (!manifest.pagesClientEntry && !manifest.appBrowserEntry) return;

        this.emitFile({
          type: "asset",
          fileName: VINEXT_CLIENT_ENTRY_MANIFEST,
          source: JSON.stringify(manifest, null, 2) + "\n",
        });
      },
    },
    // Stub node:async_hooks in client builds — see src/plugins/async-hooks-stub.ts
    asyncHooksStubPlugin,
    createInstrumentationClientTransformPlugin(() => instrumentationClientPath),
    {
      name: "vinext:instrumentation-client-inject",
      enforce: "pre",

      resolveId(id) {
        if (id !== VIRTUAL_INSTRUMENTATION_CLIENT) return null;
        return clientInjectModule !== null ? RESOLVED_INSTRUMENTATION_CLIENT : null;
      },

      load(id) {
        if (id !== RESOLVED_INSTRUMENTATION_CLIENT) return null;
        return clientInjectModule;
      },
    },
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
        // Watch route files for additions/removals to invalidate route cache.
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

        function invalidateRootParamsModule() {
          for (const env of Object.values(server.environments)) {
            const mod = env.moduleGraph.getModuleById(RESOLVED_ROOT_PARAMS);
            if (mod) env.moduleGraph.invalidateModule(mod);
          }
        }

        function invalidateHybridClientEntries() {
          if (!hasAppDir || !hasPagesDir) return;
          for (const env of Object.values(server.environments)) {
            for (const id of [RESOLVED_CLIENT_ENTRY, RESOLVED_APP_BROWSER_ENTRY]) {
              const mod = env.moduleGraph.getModuleById(id);
              if (mod) env.moduleGraph.invalidateModule(mod);
            }
          }
          server.ws.send({ type: "full-reload" });
        }

        function invalidatePagesServerEntry() {
          for (const env of Object.values(server.environments)) {
            const mod = env.moduleGraph.getModuleById(RESOLVED_SERVER_ENTRY);
            if (mod) env.moduleGraph.invalidateModule(mod);
          }
          pagesRunner?.clearCache();
        }

        function invalidateAppRoutingModules() {
          invalidateAppRouteCache();
          invalidateRscEntryModule();
          invalidateRootParamsModule();
        }

        let hybridRouteValidation: Promise<void> = Promise.resolve();
        let hybridRouteValidationError: Error | null = null;
        function sendHybridRouteValidationError(error: Error) {
          server.ws.send({
            type: "error",
            err: { message: error.message, stack: error.stack ?? error.message },
          });
        }
        server.ws.on("connection", () => {
          if (hybridRouteValidationError)
            sendHybridRouteValidationError(hybridRouteValidationError);
        });
        function revalidateHybridRoutes() {
          if (!hasAppDir || !hasPagesDir) return;
          hybridRouteValidation = hybridRouteValidation
            .catch(() => {})
            .then(async () => {
              const [appRoutes, pageRoutes, apiRoutes] = await Promise.all([
                appRouter(appDir, nextConfig?.pageExtensions, fileMatcher),
                pagesRouter(pagesDir, nextConfig?.pageExtensions, fileMatcher),
                apiRouter(pagesDir, nextConfig?.pageExtensions, fileMatcher),
              ]);
              validateHybridRouteConflicts(
                [...pageRoutes, ...apiRoutes].map((route) => ({
                  ...route,
                  sourcePath: path.relative(root, route.filePath),
                })),
                appRoutes
                  .filter((route) => route.pagePath !== null || route.routePath !== null)
                  .map((route) => ({
                    ...route,
                    sourcePath: path.relative(root, route.pagePath ?? route.routePath!),
                  })),
              );
              if (hybridRouteValidationError) {
                hybridRouteValidationError = null;
                server.ws.send({ type: "full-reload" });
              }
            })
            .catch((error) => {
              const err = error instanceof Error ? error : new Error(String(error));
              hybridRouteValidationError = err;
              sendHybridRouteValidationError(err);
            });
        }

        let appRouteTypeGeneration: Promise<void> | null = null;
        let appRouteTypeGenerationPending = false;

        function warnRouteTypeGenerationFailure(error: unknown) {
          server.config.logger.warn(
            `[vinext] Failed to regenerate route types: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }

        async function drainAppRouteTypeGeneration() {
          while (appRouteTypeGenerationPending) {
            appRouteTypeGenerationPending = false;
            try {
              await writeRouteTypes();
            } catch (error) {
              warnRouteTypeGenerationFailure(error);
            }
          }
        }

        function regenerateAppRouteTypes() {
          appRouteTypeGenerationPending = true;
          if (appRouteTypeGeneration) return;

          appRouteTypeGeneration = drainAppRouteTypeGeneration().finally(() => {
            appRouteTypeGeneration = null;
            // A watcher event may have arrived after the drain loop's final
            // check but before this finally runs; restart the loop if so.
            if (appRouteTypeGenerationPending) regenerateAppRouteTypes();
          });
        }

        regenerateAppRouteTypes();
        revalidateHybridRoutes();

        // Node throws on unhandled 'error' events on sockets. When a browser
        // drops the connection mid-response (common in dev: HMR triggers a
        // reload while an RSC stream is still flushing), the next res.write
        // surfaces ECONNRESET on res.socket with no listener attached and
        // takes down the process. A no-op listener on every connection
        // neutralises the throw without hiding write failures from callers.
        // Matches the guard Vite's HMR server and Next.js install for the
        // same reason. See cloudflare/vinext#905.
        server.httpServer?.on("connection", (socket) => {
          socket.on("error", () => {});
        });

        server.watcher.on("add", (filePath: string) => {
          let routeChanged = false;
          if (hasPagesDir && filePath.startsWith(pagesDir) && pageExtensions.test(filePath)) {
            invalidateRouteCache(pagesDir);
            routeChanged = true;
          }
          if (hasAppDir && shouldInvalidateAppRouteFile(appDir, filePath, fileMatcher)) {
            invalidateAppRoutingModules();
            regenerateAppRouteTypes();
            routeChanged = true;
          }
          if (routeChanged) {
            invalidatePagesServerEntry();
            invalidateHybridClientEntries();
            revalidateHybridRoutes();
          }
        });
        server.watcher.on("unlink", (filePath: string) => {
          let routeChanged = false;
          if (hasPagesDir && filePath.startsWith(pagesDir) && pageExtensions.test(filePath)) {
            invalidateRouteCache(pagesDir);
            routeChanged = true;
          }
          if (hasAppDir && shouldInvalidateAppRouteFile(appDir, filePath, fileMatcher)) {
            invalidateAppRoutingModules();
            regenerateAppRouteTypes();
            routeChanged = true;
          }
          if (routeChanged) {
            invalidatePagesServerEntry();
            invalidateHybridClientEntries();
            revalidateHybridRoutes();
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

        installDevStackSourcemapMiddleware(server);

        // Return a function to register middleware AFTER Vite's built-in middleware
        return () => {
          const viteFilesystemMiddlewares = server.middlewares.stack
            .filter(({ handle }) => {
              const name = typeof handle === "function" ? handle.name : "";
              return name === "viteServePublicMiddleware" || name === "viteServeStaticMiddleware";
            })
            .map(({ handle }) => handle)
            .filter(
              (handle): handle is import("vite").Connect.NextHandleFunction =>
                typeof handle === "function",
            );

          const serveRewrittenViteFilesystemRoute = async (
            req: import("node:http").IncomingMessage,
            res: import("node:http").ServerResponse,
            requestPathname: string,
            stagedHeaders: Record<string, string | string[]>,
          ): Promise<boolean> => {
            const originalUrl = req.url;
            const originalStatusCode = res.statusCode;
            const originalStatusMessage = res.statusMessage;
            const originalHeaders = res.getHeaders();

            req.url = requestPathname;
            for (const [key, value] of Object.entries(stagedHeaders)) {
              res.setHeader(key, value);
            }

            const restore = () => {
              req.url = originalUrl;
              res.statusCode = originalStatusCode;
              res.statusMessage = originalStatusMessage;
              for (const key of Object.keys(res.getHeaders())) res.removeHeader(key);
              for (const [key, value] of Object.entries(originalHeaders)) {
                if (value !== undefined) res.setHeader(key, value);
              }
            };

            try {
              for (const middleware of viteFilesystemMiddlewares) {
                const outcome = await new Promise<"next" | "served">((resolve, reject) => {
                  let settled = false;
                  const settle = (value: "next" | "served", error?: unknown) => {
                    if (settled) return;
                    settled = true;
                    res.off("finish", onServed);
                    res.off("close", onServed);
                    if (error) reject(error);
                    else resolve(value);
                  };
                  const onServed = () => settle("served");
                  res.once("finish", onServed);
                  res.once("close", onServed);
                  middleware(req, res, (error?: unknown) => settle("next", error));
                  if (res.writableEnded) settle("served");
                });
                if (outcome === "served") {
                  req.url = originalUrl;
                  return true;
                }
              }
            } catch (error) {
              restore();
              throw error;
            }

            restore();
            return false;
          };

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
                if (name.toLowerCase() === VINEXT_TIMING_HEADER) {
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
                    (k) => k.toLowerCase() === VINEXT_TIMING_HEADER,
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

          const handlePagesMiddleware = async (
            req: import("node:http").IncomingMessage,
            res: import("node:http").ServerResponse,
            next: (err?: unknown) => void,
          ): Promise<void> => {
            try {
              let url: string = req.url ?? "/";
              const originalRequestUrl = url;

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
              if (isImageOptimizationPath(url.split("?")[0]!)) {
                const imageRequestUrl = new URL(url, `http://${req.headers.host || "localhost"}`);
                const allowedWidths = [
                  ...(nextConfig.images?.deviceSizes ?? DEFAULT_DEVICE_SIZES),
                  ...(nextConfig.images?.imageSizes ?? DEFAULT_IMAGE_SIZES),
                ];
                const encodedLocation = resolveDevImageRedirect(
                  imageRequestUrl,
                  allowedWidths,
                  nextConfig.images?.qualities,
                );
                if (!encodedLocation) {
                  res.writeHead(400);
                  res.end("Invalid image optimization parameters");
                  return;
                }
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

              let pathname = url.split("?")[0];

              // Guard against protocol-relative URL open redirects.
              // Check the RAW pathname before decode/normalize so both literal
              // (//, /\) and percent-encoded (%5C, %2F) leading delimiters are
              // rejected. Encoded forms survive the segment-wise decode below
              // and would otherwise reach trailing-slash redirect emitters.
              if (isOpenRedirectShaped(pathname)) {
                res.writeHead(404);
                res.end("This page could not be found");
                return;
              }
              pathname = pathname.replaceAll("\\", "/");

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
              // Keep url in sync with the normalized pathname so the pipeline
              // receives the decoded path for config rule matching.
              {
                const qs = url.includes("?") ? url.slice(url.indexOf("?")) : "";
                url = pathname + qs;
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

              if (nextConfig) {
                const qs = url.includes("?") ? url.slice(url.indexOf("?")) : "";
                const trailingSlashRedirect = normalizeTrailingSlash(
                  pathname,
                  bp,
                  nextConfig.trailingSlash,
                  qs,
                );
                if (trailingSlashRedirect) {
                  const location = trailingSlashRedirect.headers.get("Location");
                  res.writeHead(
                    trailingSlashRedirect.status,
                    location ? { Location: location } : undefined,
                  );
                  res.end();
                  return;
                }
              }

              // When @cloudflare/vite-plugin is present, delegate the entire
              // Pages Router request pipeline to the Worker/miniflare side
              // before mutating _next/data URLs. The generated Worker entry
              // owns build-ID-aware data normalization and trusted protocol
              // classification.
              if (hasCloudflarePlugin) return next();

              // ── `_next/data` normalization (Pages Router) ──────────────
              // Client-side navigations in the Pages Router fetch
              // `/_next/data/<buildId>/<page>.json`. Normalize the URL to the
              // page path BEFORE middleware runs so middleware sees `/page`
              // (matching Next.js — see `handleNextDataRequest` in
              // base-server.ts). If the buildId is missing (dev) or matches,
              // accept the request; if it is present and wrong, fall through
              // to the dot-extension skip below which returns 404.
              let isDataReq = false;
              if (isNextDataPathname(pathname)) {
                // Use the plugin's resolved buildId so a user-supplied
                // `generateBuildId` in next.config.mjs is honored in dev —
                // matching the value embedded into the prod entry. Fall back
                // to the env-var define (set by the plugin) and finally
                // "development" if the plugin hasn't resolved a config yet.
                const devBuildId =
                  nextConfig?.buildId ?? process.env.__VINEXT_BUILD_ID ?? "development";
                const dataMatch = parseNextDataPathname(pathname, devBuildId);
                if (dataMatch) {
                  isDataReq = true;
                  const qs = url.includes("?") ? url.slice(url.indexOf("?")) : "";
                  url = dataMatch.pagePathname + qs;
                  pathname = dataMatch.pagePathname;
                  // Rewrite req.url so downstream middleware sees the page
                  // path, not the raw _next/data URL.
                  req.url = url;
                } else {
                  // Stale buildId or malformed path. Return a JSON 404 here
                  // (matching the prod-server path) so clients hard-navigate
                  // instead of trying to parse Vite's HTML 404 as JSON.
                  // Mirror Next.js pages-handler.ts: set x-nextjs-deployment-id on
                  // `_next/data` notFound exits for deployment-skew protection. Fixes #1829.
                  const deploymentId =
                    process.env.__VINEXT_DEPLOYMENT_ID || process.env.NEXT_DEPLOYMENT_ID;
                  const notFoundHeaders: Record<string, string> = {
                    "Content-Type": "application/json",
                  };
                  if (deploymentId) notFoundHeaders[NEXTJS_DEPLOYMENT_ID_HEADER] = deploymentId;
                  res.writeHead(404, notFoundHeaders);
                  res.end("{}");
                  return;
                }
              }

              // Skip requests for files with extensions (static assets) after
              // trailing-slash canonicalization so file-looking dynamic routes
              // like /catch-all/hello.world/ still get the Next.js redirect.
              const filePathMatchesRewrite = [
                ...(nextConfig?.rewrites.beforeFiles ?? []),
                ...(nextConfig?.rewrites.afterFiles ?? []),
                ...(nextConfig?.rewrites.fallback ?? []),
              ].some((rewrite) =>
                matchesRewriteSource(pathname, rewrite, {
                  basePath: bp,
                  hadBasePath: true,
                }),
              );
              if (
                pathname.includes(".") &&
                !pathname.endsWith(".html") &&
                !filePathMatchesRewrite
              ) {
                return next();
              }

              // Snapshot of req.headers before middleware runs. Used for both
              // preMiddlewareReqCtx and the middleware Request itself. Intentionally
              // captured once here — applyRequestHeadersToNodeRequest() mutates
              // req.headers later, but by then this Headers object is no longer read.
              const rawHeaders = new Headers(
                Object.fromEntries(
                  Object.entries(req.headers)
                    // Drop `undefined` values and HTTP/2 pseudo-headers
                    // (`:method`/`:authority`/`:path`/`:scheme`, RFC 7540
                    // §8.1.2.1) — WHATWG `Headers` rejects `:`-prefixed names.
                    // See: https://github.com/cloudflare/vinext/issues/2013
                    .filter(([k, v]) => v !== undefined && !k.startsWith(":"))
                    .map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : String(v)]),
                ),
              );
              // Only a successfully parsed `/_next/data/...json` URL is a data
              // request. The inbound x-nextjs-data header is internal and must
              // not let callers opt normal URLs into the data redirect protocol.
              const isDataRequest = isDataReq;
              // Strip internal headers from inbound requests so they cannot be
              // forged to influence routing or impersonate internal state.
              // Both the middleware Request (built below) and the SSR handler
              // (which reads req.headers directly) must see clean headers.
              const nodeRequestHeaders = filterInternalHeaders(rawHeaders);
              for (const header of INTERNAL_HEADERS) {
                delete req.headers[header];
              }
              for (const header of VINEXT_INTERNAL_HEADERS) {
                delete req.headers[header];
              }

              const requestOrigin = `http://${req.headers.host || "localhost"}`;

              // Build a Web Request for the pipeline (no body — middleware and
              // SSR read req directly). The pipeline only needs the body when
              // proxying external rewrites; that case is handled via
              // proxyNodeReqExternal in pipelineDeps below.
              const method = req.method ?? "GET";
              const webRequest = new Request(new URL(url, requestOrigin), {
                method,
                headers: nodeRequestHeaders,
              });

              const applyRequestHeadersToNodeRequest = (nextRequestHeaders: Headers) => {
                for (const key of Object.keys(req.headers)) {
                  delete req.headers[key];
                }
                for (const [key, value] of nextRequestHeaders) {
                  req.headers[key] = value;
                }
              };

              // devRunMiddlewareAdapter: wraps the dev runMiddleware call and
              // returns a MiddlewareResult. Side-effects needed by App Router
              // hybrid mode (VINEXT_MW_CTX_HEADER) are applied here as a
              // side effect so the RSC entry sees them before rendering.
              const capturedMiddlewarePath = middlewarePath;
              const devRunMiddlewareAdapter: PagesPipelineDeps["runMiddleware"] =
                capturedMiddlewarePath
                  ? async (_request, _ctx, opts) => {
                      // Only trust X-Forwarded-Proto when behind a trusted proxy
                      const devTrustProxy =
                        process.env.VINEXT_TRUST_PROXY === "1" ||
                        (process.env.VINEXT_TRUSTED_HOSTS ?? "").split(",").some((h) => h.trim());
                      const rawProto = devTrustProxy
                        ? String(req.headers["x-forwarded-proto"] || "")
                            .split(",")[0]
                            .trim()
                        : "";
                      const mwProto =
                        rawProto === "https" || rawProto === "http" ? rawProto : "http";
                      const mwOrigin = `${mwProto}://${req.headers.host || "localhost"}`;
                      const middlewareRequest = new Request(new URL(url, mwOrigin), {
                        method: req.method,
                        headers: nodeRequestHeaders,
                      });
                      const result = await runMiddleware(
                        getPagesRunner(),
                        capturedMiddlewarePath,
                        middlewareRequest,
                        nextConfig?.i18n,
                        nextConfig?.basePath,
                        nextConfig?.trailingSlash,
                        opts.isDataRequest,
                      );

                      // Forward middleware context to the RSC entry so it can
                      // populate _mwCtx without re-running the middleware function.
                      // This prevents double execution in hybrid app+pages dev mode.
                      if (hasAppDir && result.continue) {
                        const mwCtxEntries: [string, string][] = [];
                        if (result.responseHeaders) {
                          for (const [key, value] of result.responseHeaders) {
                            if (
                              key !== MIDDLEWARE_NEXT_HEADER &&
                              key !== MIDDLEWARE_REWRITE_HEADER
                            ) {
                              mwCtxEntries.push([key, value]);
                            }
                          }
                        }
                        const mwStatus = result.status ?? result.rewriteStatus;
                        req.headers[VINEXT_MW_CTX_HEADER] = JSON.stringify({
                          h: mwCtxEntries,
                          s: mwStatus ?? null,
                          r: result.rewriteUrl ?? null,
                        });
                      }

                      return result as unknown as MiddlewareResult;
                    }
                  : null;

              // Pre-compute page routes so matchPageRoute can be sync (required by PagesPipelineDeps type).
              const devPageRoutes = await pagesRouter(
                pagesDir,
                nextConfig?.pageExtensions,
                fileMatcher,
              );

              const pipelineDeps: PagesPipelineDeps = {
                basePath: bp,
                trailingSlash: nextConfig?.trailingSlash ?? false,
                i18nConfig: nextConfig?.i18n ?? null,
                configRedirects: nextConfig?.redirects ?? [],
                configRewrites: nextConfig?.rewrites ?? {
                  beforeFiles: [],
                  afterFiles: [],
                  fallback: [],
                },
                configHeaders: nextConfig?.headers ?? [],
                hadBasePath: true, // Vite strips basePath before our middleware sees the request
                isDataReq,
                isDataRequest,
                // Raw query so redirect Locations aren't re-encoded by URL parsing.
                rawSearch: url.includes("?") ? url.slice(url.indexOf("?")) : "",
                runMiddleware: devRunMiddlewareAdapter,
                matchPageRoute: (resolvedPathname) => {
                  const m = matchRoute(resolvedPathname, devPageRoutes);
                  return m ? { route: { isDynamic: m.route.isDynamic } } : null;
                },
                // Dev adapter: forward body from the Node req when proxying
                // external rewrite targets. The pipeline's webRequest is
                // body-less; this override builds a proper request using the
                // pipeline's current headers (post-middleware) + Node req body.
                proxyExternal: async (currentRequest: Request, externalUrl: string) => {
                  const externalMethod = req.method ?? "GET";
                  const hasBody = externalMethod !== "GET" && externalMethod !== "HEAD";
                  const externalInit: RequestInit & { duplex?: string } = {
                    method: externalMethod,
                    // Use the pipeline's current request headers (post-middleware)
                    headers: currentRequest.headers,
                  };
                  if (hasBody) {
                    const { Readable } = await import("node:stream");
                    externalInit.body = Readable.toWeb(req) as ReadableStream;
                    externalInit.duplex = "half";
                  }
                  const reqWithBody = new Request(new URL(url, requestOrigin), externalInit);
                  return proxyExternalRequest(reqWithBody, externalUrl);
                },
                serveFilesystemRoute: async (requestPathname, stagedHeaders, phase) => {
                  if (
                    phase === "direct" ||
                    (req.method !== "GET" && req.method !== "HEAD") ||
                    requestPathname === "/" ||
                    requestPathname === "/api" ||
                    requestPathname.startsWith("/api/")
                  ) {
                    return false;
                  }
                  return serveRewrittenViteFilesystemRoute(
                    req,
                    res,
                    requestPathname,
                    stagedHeaders,
                  );
                },
                // handleApi and renderPage are omitted — pipeline emits intents
              };

              const pipelineResult = await runPagesRequest(webRequest, pipelineDeps);

              if (pipelineResult.type === "response") {
                await writeWebResponseToNodeRes(res, pipelineResult.response);
                return;
              }

              if (pipelineResult.type === "next") {
                return next();
              }

              // `handled` means an adapter wrote the response directly, including
              // Vite's filesystem middleware for rewritten public/static files.
              if (pipelineResult.type === "handled") {
                return;
              }

              // For render/api intents: flush staged middleware headers and
              // apply request header mutations before calling SSR/API handlers.
              const flushStagedHeaders = () => {
                for (const [key, value] of Object.entries(pipelineResult.stagedHeaders)) {
                  if (Array.isArray(value)) {
                    for (const v of value) res.appendHeader(key, v);
                  } else {
                    res.appendHeader(key, value);
                  }
                }
              };

              // Apply post-middleware request headers to req.headers so the
              // SSR/API handler sees middleware-modified cookies/headers.
              const flushRequestHeaders = () => {
                applyRequestHeadersToNodeRequest(pipelineResult.requestHeaders);
              };

              if (pipelineResult.type === "api") {
                const apiRoutes = await apiRouter(
                  pagesDir,
                  nextConfig?.pageExtensions,
                  fileMatcher,
                );
                // Only flush staged middleware headers / mutate req.headers when a
                // pages API route actually matches — mirroring the original
                // `if (apiMatch)` gate. On a miss we must NOT touch res or req.headers
                // before falling through to next(): an unconditional flushRequestHeaders()
                // deletes all req.headers and repopulates them from the body-less pipeline
                // request, wiping the hybrid app+pages middleware context
                // (VINEXT_MW_CTX_HEADER, set on req.headers) that the app RSC plugin reads.
                const apiMatch = matchRoute(pipelineResult.apiUrl, apiRoutes);
                if (apiMatch && hasAppDir && appDir) {
                  const appRoutes = await appRouter(
                    appDir,
                    nextConfig?.pageExtensions,
                    fileMatcher,
                  );
                  const appMatch = matchAppRoute(pipelineResult.apiUrl, appRoutes);
                  if (
                    appMatch &&
                    !pagesRouteHasPriorityOverAppRoute(apiMatch.route, appMatch.route)
                  ) {
                    return next();
                  }
                }
                if (apiMatch) {
                  flushStagedHeaders();
                  flushRequestHeaders();
                  if (pipelineResult.middlewareStatus !== undefined) {
                    req.__vinextMiddlewareStatus = pipelineResult.middlewareStatus;
                  }
                }
                const handled = await handleApiRoute(
                  getPagesRunner(),
                  req,
                  res,
                  pipelineResult.apiUrl,
                  apiRoutes,
                  {
                    basePath: nextConfig?.basePath,
                    i18n: nextConfig?.i18n,
                    trailingSlash: nextConfig?.trailingSlash,
                  },
                );
                if (handled) return;

                // No API route matched — if app dir exists, let the RSC plugin handle it
                // (app/api/* route handlers live there). Otherwise hard-404.
                if (hasAppDir) return next();

                res.statusCode = 404;
                res.end("404 - API route not found");
                return;
              }

              // pipelineResult.type === "render"
              {
                const routes = await pagesRouter(pagesDir, nextConfig?.pageExtensions, fileMatcher);
                // Hybrid app+pages dev: if the resolved URL matches no pages route
                // and an app/ dir exists, defer to the RSC plugin (app routes live
                // there). If both routers match, apply Next.js's merged route
                // precedence before choosing which plugin owns the request.
                const resolvedPathname = pipelineResult.resolvedUrl
                  .split("#", 1)[0]
                  .split("?", 1)[0];
                const renderMatch = matchRoute(resolvedPathname, routes);
                if (hasAppDir && appDir) {
                  if (!renderMatch) {
                    return next();
                  }
                  const appRoutes = await appRouter(
                    appDir,
                    nextConfig?.pageExtensions,
                    fileMatcher,
                  );
                  const appMatch = matchAppRoute(resolvedPathname, appRoutes);
                  if (
                    appMatch &&
                    !pagesRouteHasPriorityOverAppRoute(renderMatch.route, appMatch.route)
                  ) {
                    return next();
                  }
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
                  middlewarePath !== null,
                  (nextConfig?.rewrites.beforeFiles.length ?? 0) > 0 ||
                    (nextConfig?.rewrites.afterFiles.length ?? 0) > 0 ||
                    (nextConfig?.rewrites.fallback.length ?? 0) > 0,
                  nextConfig?.clientTraceMetadata,
                  nextConfig?.htmlLimitedBots,
                );
                flushStagedHeaders();
                flushRequestHeaders();
                if (pipelineResult.middlewareStatus !== undefined) {
                  req.__vinextMiddlewareStatus = pipelineResult.middlewareStatus;
                }
                // Update req.url to the resolved URL so SSR sees the post-mw path
                req.url = pipelineResult.resolvedUrl;
                await handler(
                  req,
                  res,
                  pipelineResult.resolvedUrl,
                  req.__vinextMiddlewareStatus,
                  pipelineResult.isDataReq,
                  originalRequestUrl,
                );
              }
            } catch (e) {
              next(e);
            }
          };

          server.middlewares.use((req, res, next) => {
            void handlePagesMiddleware(req, res, next);
          });
        };
      },
    },
    // Next.js rejects `export * from "..."` when compiling Pages Router files
    // for the client. API routes have no client compilation, so they are
    // excluded here along with virtual and non-page modules.
    {
      name: "vinext:validate-page-exports",
      transform: {
        handler(code, id) {
          if (this.environment?.name !== "client") return null;
          if (!hasPagesDir || id.startsWith("\0") || !hasExportAllCandidate(code)) {
            return null;
          }
          const modulePath = stripViteModuleQuery(id);
          if (!isWithinPagesDirectory(modulePath)) return null;
          const canonicalId = canonicalizePageTransformPath(modulePath);
          if (!isWithinPagesDirectory(canonicalId)) return null;
          if (!fileMatcher.isPageFile(canonicalId)) return null;
          if (isApiPage(canonicalId)) return null;
          validatePageExports(code);
          return null;
        },
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
        handler(code, id) {
          if (this.environment?.name !== "client") return null;
          if (!hasPagesDir || id.startsWith("\0") || !hasServerExportCandidate(code)) return null;
          // Only transform files under the pages/ directory
          const modulePath = stripViteModuleQuery(id);
          if (!isWithinPagesDirectory(modulePath)) return null;
          const canonicalId = canonicalizePageTransformPath(modulePath);
          if (!isWithinPagesDirectory(canonicalId)) return null;
          if (!fileMatcher.isPageFile(canonicalId)) return null;
          // Skip API routes, _app, _document, _error
          const relativePath = canonicalId.slice(canonicalPagesDir.length);
          if (isApiPage(canonicalId)) return null;
          if (/^\/(?:_app|_document|_error)(?:\.[^/]*)?$/.test(relativePath)) return null;

          const result = stripServerExports(code);
          if (!result) return null;
          return { code: result, map: null };
        },
      },
    },
    // Match Next.js's server-only boundary for browser/client graphs. This
    // must run after the Pages data-export transform so a valid
    // `export { getServerSideProps } from "./server"` boundary is removed
    // before the browser graph resolves and validates the server module.
    //
    // Ported behavior from Next.js:
    // test/development/acceptance/server-component-compiler-errors-in-pages.test.ts
    // packages/next/src/build/webpack-config.ts (server-only/client-only layers)
    {
      name: "vinext:validate-server-only-client-imports",
      transform: {
        filter: { id: /\.(tsx?|jsx?|mjs)$/, code: "server-only" },
        handler(code, id) {
          if (this.environment?.name !== "client") return null;
          if (id.startsWith("\0")) return null;
          if (getLeadingReactDirective(code) === "use server") return null;
          if (!hasServerOnlyMarkerImport(code)) return null;

          throw new Error(
            `You're importing a module that depends on "server-only". This API is only available in Server Components in the App Router, but this module is reachable from a client bundle.`,
          );
        },
      },
    },
    // Strip console.* calls from the client bundle when compiler.removeConsole
    // is enabled in next.config. Inspired by Next.js's SWC remove_console transform.
    // NOTE: Next.js applies this to both client and server (set in
    // getBaseSWCOptions, which feeds both isServer:true and isServer:false
    // configs); vinext scopes it to client-only so server-side console logging
    // remains available for debugging. Tracked as a known parity gap.
    // Production-only — Next.js documents removeConsole as a production-build
    // feature, and stripping logs in dev would silently hide debugging output.
    {
      name: "vinext:remove-console",
      apply: "build",
      transform: {
        // Only match source files, not node_modules or virtual modules
        filter: { id: /\.(tsx?|jsx?|mjs)$/ },
        handler(code, id) {
          const ssr = this.environment?.name !== "client";
          if (ssr) return null;
          if (!nextConfig.removeConsole) return null;
          // Skip node_modules to avoid transform overhead on application
          // dependencies. Next.js applies removeConsole to node_modules too
          // (the SWC option in getBaseSWCOptions runs on every file the SWC
          // loader processes); this is a minor divergence in exchange for
          // faster builds.
          if (id.includes("/node_modules/")) return null;

          const result = removeConsoleCalls(code, nextConfig.removeConsole);
          if (!result) return null;
          return { code: result, map: null };
        },
      },
    },
    // Fold `typeof window` like Next.js before Rolldown resolves imports. This
    // removes browser-only dynamic imports from server bundles before package
    // conditional exports are evaluated.
    {
      name: "vinext:typeof-window",
      enforce: "post",
      transform: {
        filter: { code: /typeof\s+window/ },
        handler(code) {
          return replaceTypeofWindow(code, getTypeofWindowReplacement(this.environment));
        },
      },
    },
    // Inject server-environment defines. Server environments receive
    // NEXT_RUNTIME + user `compiler.defineServer` entries. The universal
    // `compiler.define` map is already merged into the top-level Vite
    // `define` config above, so it applies to both client and server bundles.
    // Server-only defines MUST NOT leak into the browser bundle (they can
    // contain secrets such as the revalidate secret), so we layer them in via
    // the per-environment `define` hook, which Vite merges over the top-level
    // value for that environment only.
    //
    // Mirrors Next.js: packages/next/src/build/define-env.ts — the
    // `defineServer` entries are only added to the `nodejs` / `edge`
    // serialized define environments, never to `client`.
    {
      name: "vinext:compiler-define-server",
      configEnvironment(name) {
        if (name === "client") return null;

        const serverDefines: Record<string, string> = { ...nextConfig.compilerDefineServer };

        // Mirror Next.js's compile-time `process.env.NEXT_RUNTIME` constant
        // (see packages/next/src/build/define-env.ts).  This is a build-time
        // define — it is inlined at compile time and has no runtime equivalent.
        // Next.js compiles each route into its own bundle and stamps the bundle
        // with the runtime it targets ('edge' or 'nodejs').  Vinext compiles a
        // single RSC bundle that covers all routes, so we use 'nodejs' for
        // every server environment — the value that matches Vinext's Workers
        // Node.js compatibility target.
        //
        // Without this define, `process.env.NEXT_RUNTIME` falls back to the
        // top-level `''` value set for the client bundle.  User-land code (and
        // the Next.js test fixture at
        // test/e2e/app-dir/next-after-app-deploy/app/path-prefix.js) that uses
        // `process.env.NEXT_RUNTIME` to construct revalidation paths would then
        // compute `'/nodejs'` correctly instead of `''` (issue #1365).
        serverDefines["process.env.NEXT_RUNTIME"] = JSON.stringify("nodejs");

        // On-demand ISR revalidation secret — baked SERVER-ONLY (the `client`
        // early-return above guarantees it never reaches the browser bundle) so
        // every server bundle, and therefore every Workers isolate, shares the
        // exact same value. This makes `res.revalidate()`'s cross-isolate
        // loopback authenticate correctly where a per-process random secret would
        // mismatch. Generated once per build by the `vinext build` CLI (see
        // __VINEXT_SHARED_REVALIDATE_SECRET) and read at runtime by
        // `getRevalidateSecret()` in `server/isr-cache.ts`. The env var is only
        // set during `vinext build`, so dev (and any non-CLI build) omits the
        // define and the runtime falls back to a process-shared dev secret —
        // correct since dev is single-process.
        const sharedRevalidateSecret = process.env.__VINEXT_SHARED_REVALIDATE_SECRET;
        if (sharedRevalidateSecret) {
          serverDefines["process.env.__VINEXT_REVALIDATE_SECRET"] =
            JSON.stringify(sharedRevalidateSecret);
        }

        return { define: serverDefines };
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

      buildStart() {
        imageImportDimCache.clear();
        staticImageAssets.clear();
      },

      watchChange(id) {
        imageImportDimCache.delete(id);
        staticImageAssets.delete(id);
        staticImageImportsByModule.delete(id);
      },

      resolveId: {
        filter: { id: /\?vinext-(?:image-url|meta)$/ },
        handler(source, _importer) {
          if (source.endsWith("?vinext-image-url")) {
            return `\0vinext-image-url:${source.slice(0, -"?vinext-image-url".length)}`;
          }
          if (source.endsWith("?vinext-meta")) {
            return `\0vinext-image-meta:${source.slice(0, -"?vinext-meta".length)}`;
          }
          return null;
        },
      },

      async load(id) {
        if (id.startsWith("\0vinext-image-url:")) {
          const imagePath = id.replace("\0vinext-image-url:", "");
          this.addWatchFile(imagePath);
          if (this.environment.config.command === "serve") {
            return `import url from ${JSON.stringify(imagePath + "?url")}; export default url;`;
          }

          const asset = createStaticImageAsset(imagePath);
          staticImageAssets.set(imagePath, asset);

          const builtFileName = `${resolveAssetsDir(nextConfig.assetPrefix)}/${asset.fileName}`;
          return `export default ${JSON.stringify(
            renderVinextBuiltUrl(builtFileName, nextConfig.assetPrefix, nextConfig.deploymentId),
          )};`;
        }
        if (!id.startsWith("\0vinext-image-meta:")) return null;
        const imagePath = id.replace("\0vinext-image-meta:", "");
        this.addWatchFile(imagePath);

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

          // The `code` filter above (a regex) only decides whether to invoke
          // this handler; it can fire on text inside comments, strings, or
          // template literals. Scanning must therefore be AST-based so we only
          // rewrite real `import X from '...'` declarations, not text that
          // merely looks like one. Regex-based scanning generated phantom
          // variables for commented-out imports, crashing SSR with
          // `__vinext_img_url_X is not defined`.
          const imageExtRe = new RegExp(`\\.(${IMAGE_EXTS})$`);

          // This plugin uses `enforce: "pre"`, so the handler runs on RAW
          // source — before the JSX/TS transform. `parseAst` defaults to plain
          // JavaScript and would throw on JSX or TS type annotations, which
          // would silently skip image transforms for every `.tsx`/`.jsx`/typed
          // `.ts` file. (The adjacent `use-cache` plugin avoids this by running
          // after the JSX transform; we can't, since the import must be
          // rewritten before Vite resolves the asset.)
          //
          // Pick the parser language by extension. `.tsx`/`.jsx`/`.js`/`.mjs`
          // can contain JSX, so parse those as `tsx`. Plain `.ts` files must be
          // parsed as `ts`: the `tsx` grammar treats `<T>` as the start of a JSX
          // element, so legitimate TS-only syntax such as angle-bracket casts
          // (`<Foo>bar`) and non-comma generic arrows (`<T>(x) => x`) would throw
          // — which the `catch` below would swallow, silently leaving image
          // imports in those files untransformed.
          const lang = id.endsWith(".ts") ? "ts" : "tsx";
          let ast: ReturnType<typeof parseAst>;
          try {
            ast = parseAst(code, { lang });
          } catch {
            // Unparseable input (e.g. unsupported syntax) — leave untouched.
            return null;
          }

          const s = new MagicString(code);
          let hasChanges = false;
          const imageImports = new Set<string>();

          for (const node of ast.body) {
            if (node.type !== "ImportDeclaration") continue;

            const importNode = node as ASTNode & {
              start: number;
              end: number;
              source?: { value?: unknown };
              specifiers?: Array<{ type?: string; local?: { name?: string } }>;
            };

            const importPath = importNode.source?.value;
            if (typeof importPath !== "string") continue;
            if (!imageExtRe.test(importPath)) continue;

            // Only handle a single default import (`import X from '...'`),
            // matching the original behavior. Skip named/namespace imports and
            // side-effect-only imports (`import '...'`).
            const specifiers = importNode.specifiers ?? [];
            if (specifiers.length !== 1) continue;
            const specifier = specifiers[0];
            if (specifier.type !== "ImportDefaultSpecifier") continue;
            const varName = specifier.local?.name;
            if (!varName) continue;

            // Resolve the absolute path of the image. Normalize separators
            // since the path is embedded in the ESM module specifier below,
            // which should use forward slashes. fs accepts them on Windows,
            // so existsSync still works.
            const dir = path.dirname(id);
            const absImagePath = normalizePathSeparators(path.resolve(dir, importPath));

            if (!fs.existsSync(absImagePath)) continue;
            imageImports.add(absImagePath);

            // Replace the single import with two:
            // 1. URL module. In dev it delegates to Vite's asset server; in a
            //    production build it returns a stable Next-shaped URL and the
            //    client build writes the registered source under static/media.
            // 2. Meta import (we provide { width, height })
            // Combined into a StaticImageData object
            const urlVar = `__vinext_img_url_${varName}`;
            const metaVar = `__vinext_img_meta_${varName}`;
            const replacement =
              `import ${urlVar} from ${JSON.stringify(absImagePath + "?vinext-image-url")};\n` +
              `import ${metaVar} from ${JSON.stringify(absImagePath + "?vinext-meta")};\n` +
              `const ${varName} = { src: ${urlVar}, width: ${metaVar}.width, height: ${metaVar}.height };`;

            s.overwrite(importNode.start, importNode.end, replacement);
            hasChanges = true;
          }

          if (!hasChanges) {
            staticImageImportsByModule.delete(id);
            return null;
          }
          staticImageImportsByModule.set(id, imageImports);

          return {
            code: s.toString(),
            map: s.generateMap({ hires: "boundary" }),
          };
        },
      },

      writeBundle: {
        sequential: true,
        order: "post",
        handler(outputOptions) {
          if (this.environment?.name !== "client") return;
          const clientOutDir = outputOptions.dir
            ? path.resolve(root, outputOptions.dir)
            : path.resolve(root, options.clientOutDir ?? "dist/client");
          const assetsDir = resolveAssetsDir(nextConfig.assetPrefix);
          const activeImagePaths = new Set(
            Array.from(staticImageImportsByModule.values()).flatMap((imports) => [...imports]),
          );
          const nextWrittenFiles = new Set<string>();
          for (const imagePath of activeImagePaths) {
            if (!fs.existsSync(imagePath)) continue;
            const asset = staticImageAssets.get(imagePath) ?? createStaticImageAsset(imagePath);
            const outputPath = path.join(clientOutDir, assetsDir, asset.fileName);
            fs.mkdirSync(path.dirname(outputPath), { recursive: true });
            fs.writeFileSync(outputPath, asset.source);
            nextWrittenFiles.add(outputPath);
          }
          for (const outputPath of writtenStaticImageFiles) {
            if (!nextWrittenFiles.has(outputPath)) fs.rmSync(outputPath, { force: true });
          }
          writtenStaticImageFiles.clear();
          for (const outputPath of nextWrittenFiles) writtenStaticImageFiles.add(outputPath);
        },
      },
    } as Plugin & { _dimCache: Map<string, { width: number; height: number }> },
    // Google Fonts import rewrite + self-hosting — see src/plugins/fonts.ts
    createGoogleFontsPlugin(_fontGoogleShimPath, _shimsDir),
    // Local font path resolution — see src/plugins/fonts.ts
    createLocalFontsPlugin(_shimsDir),
    // Barrel import optimization:
    // Rewrites `import { Slot } from "radix-ui"` → `import * as Slot from "@radix-ui/react-slot"`
    // for packages listed in optimizePackageImports or DEFAULT_OPTIMIZE_PACKAGES.
    // This prevents Vite from eagerly evaluating barrel re-exports that call
    // React.createContext() in RSC environments where createContext doesn't exist.
    createOptimizeImportsPlugin(
      () => nextConfig,
      () => root,
    ),
    // next/dynamic preload metadata:
    // Mirrors Next.js's react-loadable transform by recording which resolved
    // module IDs belong to each dynamic() boundary. The runtime resolves those
    // IDs through Vite's build manifest so it can emit boundary-scoped preload
    // hints with the request CSP nonce.
    createDynamicPreloadMetadataPlugin(),
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
            const modulePath = stripViteModuleQuery(id);
            const moduleFileName = path.basename(modulePath);
            const isAppPageModule =
              hasAppDir &&
              isInsideDirectory(appDir, modulePath) &&
              path.parse(moduleFileName).name === "page" &&
              fileMatcher.extensionRegex.test(moduleFileName);

            const runtimeModuleUrl = pathToFileURL(
              resolveShimModulePath(shimsDir, "cache-runtime"),
            ).href;
            const result = transformWrapExport(code, ast, {
              runtime: (value: string, name: string) => {
                const pageOptions =
                  name === "default" && isAppPageModule ? `, { appPageDefaultExport: true }` : "";
                return `(await import(${JSON.stringify(runtimeModuleUrl)})).registerCachedFunction(${value}, ${JSON.stringify(id + ":" + name)}, ${JSON.stringify(variant)}${pageOptions})`;
              },
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
    createImportMetaUrlPlugin({
      getRoot: () => root,
    }),
    createExtensionlessDynamicImportPlugin(),
    // Expand Webpack's build-time `require.context(...)` into a static module
    // map backed by `import.meta.glob` — see src/plugins/require-context.ts
    createRequireContextPlugin(),
    // Inline binary assets fetched via `fetch(new URL("./asset", import.meta.url))` —
    // see src/plugins/og-assets.ts
    createOgInlineFetchAssetsPlugin(),
    // Dedupe/copy @vercel/og binary WASM assets in the RSC output — see src/plugins/og-assets.ts
    createOgAssetsPlugin(),
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
            deviceSizes: nextConfig?.images?.deviceSizes,
            imageSizes: nextConfig?.images?.imageSizes,
            qualities: nextConfig?.images?.qualities,
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
    // Uses writeBundle (not closeBundle) with a one-time write guard so the file
    // is written exactly once per build regardless of how many environments are
    // active (App Router RSC+SSR+client, Pages Router SSR+client, etc.).
    //
    // closeBundle does not fire reliably during the multi-environment
    // createBuilder().buildApp() pipeline used for App Router production builds,
    // so the file was silently never written for pure App Router apps. writeBundle
    // fires for every emitted bundle (matching the vinext:image-config plugin
    // above), so the guard captures the first one. The path is always
    // dist/server/BUILD_ID — derived from root, not from the per-environment
    // options.dir — so it works for all router types.
    (() => {
      let buildIdWritten = false;
      return {
        name: "vinext:build-id",
        apply: "build" as const,
        enforce: "post" as const,
        writeBundle: {
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
    // Mix experimental.outputHashSalt / NEXT_HASH_SALT into chunk content hashes.
    // This changes output filenames (e.g., index-[hash].js) without modifying source.
    // Uses augmentChunkHash (supported by Rolldown) instead of the unsupported output.hashSalt.
    {
      name: "vinext:hash-salt",
      apply: "build",
      augmentChunkHash() {
        // Only apply to client environment; SSR/RSC don't use content hashing
        if (this.environment?.name !== "client") return;
        const salt = nextConfig?.hashSalt;
        if (salt) {
          return salt;
        }
      },
    },
    // Note: augmentChunkHash only affects JS chunk hashes. CSS and static asset
    // hashes are not salted, which is a known gap vs Next.js behavior.
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
    } as Plugin & {
      nitro: { setup: (nitro: NitroSetupContext) => Promise<void> };
    }, // Nitro plugin extension convention: https://nitro.build/guide/plugins
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
    {
      name: "vinext:next-client-runtime-manifests",
      apply: "build",
      enforce: "post",
      writeBundle: {
        sequential: true,
        order: "post",
        handler(outputOptions: { dir?: string }) {
          const clientDir = outputOptions.dir;
          if (!clientDir) return;

          const isClientBuild = this.environment?.name === "client";
          if (!isClientBuild) return;

          emitNextClientRuntimeManifests({
            clientDir,
            assetsSubdir: resolveAssetsDir(nextConfig.assetPrefix),
            buildId: nextConfig.buildId,
            rewrites: nextConfig.rewrites,
          });
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
            // When `assetPrefix` is configured the assets live under a
            // different subdirectory (e.g. `cdn/_next/static/`); resolve from
            // the config so we walk the actual on-disk layout.
            const assetsSubdir = resolveAssetsDir(nextConfig.assetPrefix);
            const assetsDir = path.join(outDir, assetsSubdir);
            if (!fs.existsSync(assetsDir)) return;

            const isTTY = process.stderr.isTTY;
            let lastLineLen = 0;

            // Start precompression as soon as the client bundle is written, but
            // defer awaiting it until the SSR environment finishes. This overlaps
            // the extra asset work with the final build phase instead of putting
            // the full precompression cost on the critical path of step 4/5.
            pendingPrecompressError = null;
            pendingPrecompress = (async () => {
              const result = await precompressAssets(outDir, {
                assetsDir: assetsSubdir,
                onProgress: (completed, total, file) => {
                  if (!isTTY) return;
                  const pct = total > 0 ? Math.floor((completed / total) * 100) : 0;
                  const bar = `[${"█".repeat(Math.floor(pct / 5))}${" ".repeat(20 - Math.floor(pct / 5))}]`;
                  const maxFile = 30;
                  const fileLabel = file.length > maxFile ? "…" + file.slice(-(maxFile - 1)) : file;
                  const line = `Compressing assets... ${bar} ${String(completed).padStart(String(total).length)}/${total} ${fileLabel}`;
                  const padded = line.padEnd(lastLineLen);
                  lastLineLen = line.length;
                  process.stderr.write(`\r${padded}`);
                },
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
    {
      name: "vinext:inline-css-manifest",
      apply: "build",
      enforce: "post",
      closeBundle: {
        sequential: true,
        order: "post",
        handler() {
          if (this.environment?.name !== "client") return;
          if (!hasAppDir || nextConfig?.inlineCss !== true) return;

          const envConfig = this.environment?.config;
          if (!envConfig) return;

          const buildRoot = envConfig.root ?? process.cwd();
          const clientDir = path.resolve(buildRoot, "dist", "client");
          const manifest = collectInlineCssManifest(clientDir, nextConfig.assetPrefix);
          const rscOutDir = path.resolve(
            buildRoot,
            options.rscOutDir ?? path.join("dist", "server"),
          );
          for (const entryFile of ["index.js", "index.mjs"]) {
            if (injectInlineCssManifestGlobal(path.join(rscOutDir, entryFile), manifest)) break;
          }
        },
      },
    },
    // Cloudflare Workers production build integration:
    // After all environments are built, compute dynamic chunk metadata from
    // the client build manifest and inject globals into the worker entry.
    //
    // Pages Router: injects __VINEXT_CLIENT_ENTRY__, __VINEXT_SSR_MANIFEST__,
    //   __VINEXT_LAZY_CHUNKS__, and __VINEXT_DYNAMIC_PRELOADS__ into the worker
    //   entry (found via wrangler.json).
    // App Router: the RSC plugin handles App hydration via
    //   loadBootstrapScriptContent(), but we still inject __VINEXT_LAZY_CHUNKS__,
    //   __VINEXT_DYNAMIC_PRELOADS__, and __VINEXT_SSR_MANIFEST__ into the worker
    //   entry at dist/server/index.js. Mixed app+pages builds also inject
    //   __VINEXT_CLIENT_ENTRY__ for Pages Router fallback routes.
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

          // Compute runtime metadata from the client build manifest: lazy
          // chunks, per-next/dynamic preload files, and (for Pages Router)
          // the client entry file. This runs for BOTH App Router and Pages
          // Router — clientEntryFile is only used by the Pages Router path
          // below (App Router gets its client entry via the RSC plugin).
          const runtimeMetadata = computeClientRuntimeMetadata({
            clientDir,
            assetBase: clientBase,
            assetPrefix: nextConfig.assetPrefix,
            includeClientEntry: !hasAppDir ? true : hasPagesDir ? "pages-client-entry" : false,
          });
          const lazyChunksData: string[] | null = runtimeMetadata.lazyChunks ?? null;
          const dynamicPreloadsData: Record<string, string[]> | null =
            runtimeMetadata.dynamicPreloads ?? null;
          let clientEntryFile: string | null = runtimeMetadata.clientEntryFile ?? null;

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
            // App Router: the RSC plugin handles the App client bootstrap via
            // loadBootstrapScriptContent(). In mixed app+pages builds, Pages
            // fallback routes still render through the Pages entry and need
            // the Pages client entry global.
            const workerEntry = path.resolve(distDir, "server", "index.js");

            if (fs.existsSync(workerEntry)) {
              // `clientEntryFile` is only populated for mixed app+pages builds
              // (computeClientRuntimeMetadata was asked for "pages-client-entry");
              // pure App Router gets its client entry via the RSC plugin.
              const script = buildRuntimeGlobalsScript({
                clientEntryFile,
                ssrManifest: ssrManifestData,
                lazyChunks: lazyChunksData,
                dynamicPreloads: dynamicPreloadsData,
              });
              if (script) {
                const code = fs.readFileSync(workerEntry, "utf-8");
                fs.writeFileSync(workerEntry, script + "\n" + code);
              }
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

            // Prepend globals to worker entry
            const script = buildRuntimeGlobalsScript({
              clientEntryFile,
              ssrManifest: ssrManifestData,
              lazyChunks: lazyChunksData,
              dynamicPreloads: dynamicPreloadsData,
            });
            if (script) {
              const code = fs.readFileSync(workerEntry, "utf-8");
              fs.writeFileSync(workerEntry, script + "\n" + code);
            }
          }

          // Generate _headers file for Cloudflare Workers static asset caching.
          // Vite outputs content-hashed files (JS, CSS, fonts) to the assetsDir
          // (defaults to `_next/static` — Next.js's canonical convention; see
          // resolveAssetsDir in utils/asset-prefix.ts). These are safe to
          // cache indefinitely since the hash changes on any content change.
          // Without this, Cloudflare serves them with max-age=0 which forces
          // unnecessary revalidation on every page load.
          const headersPath = path.join(clientDir, "_headers");
          if (!fs.existsSync(headersPath)) {
            const assetsDir = envConfig.build?.assetsDir ?? ASSET_PREFIX_URL_DIR;
            const headersContent = [
              "# Cache content-hashed assets immutably (generated by vinext)",
              `/${assetsDir}/*`,
              "  Cache-Control: public, max-age=31536000, immutable",
              "",
            ].join("\n");
            fs.mkdirSync(clientDir, { recursive: true });
            fs.writeFileSync(headersPath, headersContent);
          }

          // Keep Vite build metadata (the `.vite/` manifests) out of the
          // deployed asset bundle. The Cloudflare ASSETS binding serves any
          // uploaded file matching the request path BEFORE the Worker runs, so
          // without this the build/SSR manifests would be publicly fetchable at
          // `/.vite/manifest.json` — leaking the source-file → chunk mapping and
          // unlinked route paths. The Node prod server blocks `/.vite/` for the
          // same reason (server/static-file-cache.ts); `.assetsignore` is the
          // Cloudflare-side equivalent.
          ensureAssetsIgnore(clientDir);
        },
      },
    },
    // Handle `import x from '*.wasm?module'` — see
    // src/plugins/wasm-module-import.ts. Fixes #1351.
    createWasmModuleImportPlugin(),
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

        // ── Yoga WASM: dynamic import + disk-read fallback ──────────────────────────
        // yoga-layout's emscripten bundle sets H to a data URL containing the yoga WASM,
        // then later calls WebAssembly.instantiate(bytes, imports), which workerd rejects.
        // Emscripten supports a custom h2.instantiateWasm(imports, callback) escape hatch.
        //
        // Strategy: try dynamic import("./yoga.wasm?module") for workerd (pre-compiled
        // module), fall back to reading the .wasm file from disk + WebAssembly.instantiate
        // for Node.js. We read from disk rather than inlining base64 so the bundle ships
        // exactly one physical copy of the WASM (the emitted ?module asset); the disk
        // fallback is wired to that same file by vinext:og-assets. This mirrors the resvg
        // handling below and keeps the dedup platform-agnostic.
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
          //
          // Note: new URL("./yoga.wasm", import.meta.url) MUST live inside the Node.js
          // branch (the else), never at the top level. In workerd, import.meta.url is
          // "worker" (not a valid URL base), so new URL(..., "worker") throws TypeError.
          // The else branch only runs on Node.js where the ?module import failed and
          // import.meta.url is a file:// URL.
          const YOGA_CALL = `yoga_wasm_base64_esm_default()`;
          const YOGA_CALL_PATCHED = [
            `yoga_wasm_base64_esm_default({ instantiateWasm: function(imports, callback) {`,
            `  __vi_yoga_mod.then(function(mod) {`,
            `    if (mod) {`,
            `      WebAssembly.instantiate(mod, imports).then(function(inst) { callback(inst); });`,
            `    } else {`,
            `      Promise.all([import("node:fs"), import("node:url")]).then(function(mods) {`,
            `        var p = mods[1].fileURLToPath(new URL("./yoga.wasm", import.meta.url));`,
            `        return mods[0].promises.readFile(p).then(function(bytes) {`,
            `          return WebAssembly.instantiate(bytes, imports).then(function(r) { callback(r.instance); });`,
            `        });`,
            `      });`,
            `    }`,
            `  });`,
            `  return {};`,
            `} })`,
          ].join("\n");
          result = result.replace(YOGA_CALL, YOGA_CALL_PATCHED);
          // Prepend dynamic import (no static import — Node.js safe). On Node.js the
          // ?module import fails and resolves to null, triggering the disk-read fallback.
          const yogaPreamble = [
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
    plugins.push(createRscClientReferenceLoadersPlugin());
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

/**
 * Write a Web API Response to a Node.js ServerResponse.
 * Handles multi-value headers (Set-Cookie) correctly.
 */
async function writeWebResponseToNodeRes(
  res: import("node:http").ServerResponse,
  response: Response,
): Promise<void> {
  const nodeHeaders: Record<string, string | string[]> = {};
  response.headers.forEach((value, key) => {
    if (key === "set-cookie") return;
    const existing = nodeHeaders[key];
    if (existing !== undefined) {
      nodeHeaders[key] = Array.isArray(existing) ? [...existing, value] : [existing, value];
    } else {
      nodeHeaders[key] = value;
    }
  });
  const cookies = response.headers.getSetCookie?.() ?? [];
  if (cookies.length > 0) nodeHeaders["set-cookie"] = cookies;

  if (response.statusText) {
    res.writeHead(response.status, response.statusText, nodeHeaders);
  } else {
    res.writeHead(response.status, nodeHeaders);
  }

  if (response.body) {
    const { Readable } = await import("node:stream");
    const nodeStream = Readable.fromWeb(response.body as import("stream/web").ReadableStream);
    await new Promise<void>((resolve, reject) => {
      nodeStream.on("error", reject);
      res.on("error", reject);
      nodeStream.pipe(res);
      nodeStream.on("end", resolve);
    });
  } else {
    res.end();
  }
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
