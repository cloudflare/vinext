import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { resolveClientRuntimeModule, resolveRuntimeEntryModule } from "./runtime-entry-module.js";
import type {
  VinextLinkPrefetchRoute,
  VinextPagesLinkPrefetchRoute,
} from "../client/vinext-next-data.js";
import { loadTsconfigResolutionForRoot } from "../config/tsconfig-paths.js";
import type { AppRoute } from "../routing/app-router.js";
import type { RouteManifest } from "../routing/app-route-graph.js";
import type { NextRewrite } from "../config/next-config.js";

/**
 * Generate the virtual browser entry module.
 *
 * This runs in the client (browser). It hydrates the page from the
 * embedded RSC payload and handles client-side navigation by re-fetching
 * RSC streams.
 */
export function generateBrowserEntry(
  routes: readonly AppRoute[] = [],
  routeManifest: RouteManifest | null = null,
  pagesPrefetchRoutes: readonly VinextPagesLinkPrefetchRoute[] = [],
  rewrites: { afterFiles: NextRewrite[]; beforeFiles: NextRewrite[]; fallback: NextRewrite[] } = {
    afterFiles: [],
    beforeFiles: [],
    fallback: [],
  },
  projectRoot?: string,
): string {
  const entryPath = resolveRuntimeEntryModule("app-browser-entry");
  const navigationRuntimePath = resolveClientRuntimeModule("navigation-runtime");
  const dynamicRequestDetection = createDynamicRequestDetectionContext(projectRoot);
  const prefetchRoutes: VinextLinkPrefetchRoute[] = routes.map((route) =>
    isLinkPrefetchRoute(route)
      ? toLinkPrefetchRoute(route, dynamicRequestDetection)
      : toDocumentOnlyAppRoute(route, dynamicRequestDetection),
  );

  return `import { registerNavigationRuntimeBootstrap } from ${JSON.stringify(navigationRuntimePath)};

window.__VINEXT_LINK_PREFETCH_ROUTES__ = ${JSON.stringify(prefetchRoutes)};
// Pages route manifest for hybrid ownership decisions. In a hybrid
// app+pages build the user can land on an App page, so the App browser
// entry must also expose the Pages manifest (the Pages client entry does
// the same — whichever entry runs first emits both globals).
window.__VINEXT_PAGES_LINK_PREFETCH_ROUTES__ = ${JSON.stringify(pagesPrefetchRoutes)};
window.__VINEXT_CLIENT_REWRITES__ = ${JSON.stringify(rewrites)};
registerNavigationRuntimeBootstrap({
    routeManifest: ${buildRouteManifestExpression(routeManifest)}
});
import ${JSON.stringify(entryPath)};`;
}

/**
 * Filter for routes that should appear in the `__VINEXT_LINK_PREFETCH_ROUTES__`
 * manifest. Exported so the Pages Router client entry can reuse it when
 * emitting the same manifest for hybrid builds — see issue #1526 and
 * `pages-client-entry.ts`.
 */
export function isLinkPrefetchRoute(route: AppRoute): boolean {
  if (route.pagePath !== null) return true;
  return route.routePath === null && route.layouts.length > 0;
}

export function toDocumentOnlyAppRoute(
  route: AppRoute,
  context = createDynamicRequestDetectionContext(),
): VinextLinkPrefetchRoute {
  const prefetchDynamicShell = routeUsesDynamicRequestApi(route, context);
  const requiresDynamicRequest =
    (route.isDynamic && route.parallelSlots.length > 0) || prefetchDynamicShell;

  return {
    canPrefetchLoadingShell: false,
    documentOnly: true,
    patternParts: [...route.patternParts],
    isDynamic: route.isDynamic,
    ...(prefetchDynamicShell ? { prefetchDynamicShell: true } : {}),
    ...(requiresDynamicRequest ? { requiresDynamicNavigationRequest: true } : {}),
  };
}

const dynamicRequestApiPattern =
  /\b(?:connection|headers|cookies|draftMode|noStore|unstable_noStore)\s*(?:\?\.)?\s*\(/;
const dynamicRequestApiModules = new Map([
  ["next/cache", new Set(["noStore", "unstable_noStore"])],
  ["next/headers", new Set(["headers", "cookies", "draftMode"])],
  ["next/server", new Set(["connection"])],
]);
const staticImportPattern = /import\s+(?!type\b)([\s\S]*?)\s+from\s*["']([^"']+)["']/g;
const reExportPattern = /export\s+(?!type\b)([\s\S]*?)\s+from\s*["']([^"']+)["']/g;
const importSpecifierPattern =
  /(?:import|export)\s+(?:[^'"]*?\s+from\s*)?["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g;
const routeSourceExtensions = [".tsx", ".ts", ".jsx", ".js", ".mjs", ".cjs"];
const configFiles = ["tsconfig.json", "jsconfig.json"];
const UNRESOLVED_LOCAL_IMPORT = Symbol("unresolved-local-import");

type TsconfigResolution = ReturnType<typeof loadTsconfigResolutionForRoot>;
type ResolvedRouteImport = string | typeof UNRESOLVED_LOCAL_IMPORT | null;
type DynamicRequestDetectionContext = {
  packageResolutionCache: Map<string, boolean>;
  projectRoot: string | null;
  tsconfigResolutionCache: Map<string, TsconfigResolution>;
};

function createDynamicRequestDetectionContext(
  projectRoot?: string,
): DynamicRequestDetectionContext {
  return {
    packageResolutionCache: new Map(),
    projectRoot: projectRoot ? path.resolve(projectRoot) : null,
    tsconfigResolutionCache: new Map(),
  };
}

function resolveRouteSourceFile(candidate: string): string | null {
  const candidates = [
    candidate,
    ...routeSourceExtensions.map((extension) => `${candidate}${extension}`),
    ...routeSourceExtensions.map((extension) => path.join(candidate, `index${extension}`)),
  ];

  for (const candidate of candidates) {
    try {
      const stat = fs.statSync(candidate);
      if (stat.isFile()) return candidate;
    } catch {
      // Try the next candidate.
    }
  }

  return null;
}

function findTsconfigRootForFile(filePath: string): string | null {
  let current = path.dirname(filePath);
  for (;;) {
    if (configFiles.some((name) => fs.existsSync(path.join(current, name)))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function getTsconfigResolutionForRoot(
  context: DynamicRequestDetectionContext,
  root: string,
): TsconfigResolution {
  const normalizedRoot = path.resolve(root);
  const cached = context.tsconfigResolutionCache.get(normalizedRoot);
  if (cached) return cached;

  const resolution = loadTsconfigResolutionForRoot(normalizedRoot);
  context.tsconfigResolutionCache.set(normalizedRoot, resolution);
  return resolution;
}

function getTsconfigResolutionsForFile(
  context: DynamicRequestDetectionContext,
  filePath: string,
): TsconfigResolution[] {
  const roots = new Set<string>();
  if (context.projectRoot) roots.add(context.projectRoot);
  const inferredRoot = findTsconfigRootForFile(filePath);
  if (inferredRoot) roots.add(inferredRoot);

  return [...roots].map((root) => getTsconfigResolutionForRoot(context, root));
}

function isNodeBuiltinOrUrlSpecifier(specifier: string): boolean {
  return (
    specifier.startsWith("node:") ||
    specifier.startsWith("data:") ||
    specifier.startsWith("http:") ||
    specifier.startsWith("https:")
  );
}

function resolveAliasImport(
  specifier: string,
  resolution: TsconfigResolution,
): ResolvedRouteImport {
  let bestPrefixAlias: TsconfigResolution["pathAliases"][number] | null = null;

  for (const alias of resolution.pathAliases) {
    if (alias.kind === "exact") {
      if (specifier === alias.find) {
        return resolveRouteSourceFile(alias.replacement) ?? UNRESOLVED_LOCAL_IMPORT;
      }
      continue;
    }

    if (specifier.startsWith(`${alias.find}/`)) {
      if (bestPrefixAlias === null || alias.find.length > bestPrefixAlias.find.length) {
        bestPrefixAlias = alias;
      }
    }
  }

  if (bestPrefixAlias !== null) {
    const rest = specifier.slice(bestPrefixAlias.find.length + 1);
    return (
      resolveRouteSourceFile(path.join(bestPrefixAlias.replacement, rest)) ??
      UNRESOLVED_LOCAL_IMPORT
    );
  }

  return null;
}

function canResolvePackageSpecifier(
  context: DynamicRequestDetectionContext,
  specifier: string,
  fromFile: string,
): boolean {
  const cacheKey = `${fromFile}\0${specifier}`;
  const cached = context.packageResolutionCache.get(cacheKey);
  if (cached !== undefined) return cached;

  try {
    createRequire(fromFile).resolve(specifier);
    context.packageResolutionCache.set(cacheKey, true);
    return true;
  } catch {
    context.packageResolutionCache.set(cacheKey, false);
    return false;
  }
}

function isAliasShapedLocalSpecifier(specifier: string): boolean {
  return (
    specifier.startsWith("@") ||
    specifier.startsWith("~/") ||
    specifier.startsWith("#") ||
    specifier.startsWith("$")
  );
}

function normalizeDynamicRequestApiModule(specifier: string): string {
  return specifier.endsWith(".js") ? specifier.slice(0, -".js".length) : specifier;
}

function getDynamicRequestApiExports(specifier: string): Set<string> | null {
  return dynamicRequestApiModules.get(normalizeDynamicRequestApiModule(specifier)) ?? null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function stripBlockAndLineComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n\r]*/g, "");
}

function splitImportSpecifiers(specifiers: string): string[] {
  return specifiers
    .split(",")
    .map((specifier) => specifier.trim())
    .filter(Boolean);
}

function getNamedImportLocalBindings(importClause: string, exportedApis: Set<string>): Set<string> {
  const localBindings = new Set<string>();
  const namedMatch = /\{([\s\S]*?)\}/.exec(importClause);
  if (!namedMatch) return localBindings;

  for (const specifier of splitImportSpecifiers(namedMatch[1] ?? "")) {
    const match = /^(?:type\s+)?([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/.exec(specifier);
    if (!match) continue;
    const importedName = match[1] ?? "";
    if (exportedApis.has(importedName)) {
      localBindings.add(match[2] ?? importedName);
    }
  }

  return localBindings;
}

function getNamespaceImportBinding(importClause: string): string | null {
  return /\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(importClause)?.[1] ?? null;
}

function sourceCallsImportedBinding(source: string, binding: string): boolean {
  const escaped = escapeRegExp(binding);
  return new RegExp(`(?<![\\w$.:])${escaped}\\s*(?:\\?\\.)?\\s*\\(`).test(source);
}

function sourceCallsNamespaceImport(
  source: string,
  namespace: string,
  exportedApis: Set<string>,
): boolean {
  const escapedNamespace = escapeRegExp(namespace);
  const escapedApis = [...exportedApis].map(escapeRegExp).join("|");
  return new RegExp(
    `(?<![\\w$])${escapedNamespace}\\s*\\.\\s*(?:${escapedApis})\\s*(?:\\?\\.)?\\s*\\(`,
  ).test(source);
}

function sourceUsesImportedDynamicRequestApi(source: string): boolean {
  const sourceWithoutComments = stripBlockAndLineComments(source);

  staticImportPattern.lastIndex = 0;
  for (;;) {
    const match = staticImportPattern.exec(sourceWithoutComments);
    if (!match) break;
    const importClause = match[1] ?? "";
    const exportedApis = getDynamicRequestApiExports(match[2] ?? "");
    if (!exportedApis) continue;

    const namespace = getNamespaceImportBinding(importClause);
    if (namespace && sourceCallsNamespaceImport(sourceWithoutComments, namespace, exportedApis)) {
      return true;
    }

    for (const binding of getNamedImportLocalBindings(importClause, exportedApis)) {
      if (sourceCallsImportedBinding(sourceWithoutComments, binding)) {
        return true;
      }
    }
  }

  // Re-exported dynamic request APIs can be called under arbitrary aliases from
  // downstream modules. Keep these modules on the dynamic request path instead
  // of caching a potentially request-scoped prefetch artifact.
  reExportPattern.lastIndex = 0;
  for (;;) {
    const match = reExportPattern.exec(sourceWithoutComments);
    if (!match) break;
    const exportedApis = getDynamicRequestApiExports(match[2] ?? "");
    if (!exportedApis) continue;
    if (getNamedImportLocalBindings(match[1] ?? "", exportedApis).size > 0) {
      return true;
    }
  }

  return false;
}

function resolveRouteImport(
  fromFile: string,
  specifier: string,
  context: DynamicRequestDetectionContext,
): ResolvedRouteImport {
  if (!specifier || isNodeBuiltinOrUrlSpecifier(specifier)) return null;

  if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("\\")) {
    const base = specifier.startsWith(".")
      ? path.resolve(path.dirname(fromFile), specifier)
      : path.resolve(specifier);
    return resolveRouteSourceFile(base) ?? UNRESOLVED_LOCAL_IMPORT;
  }

  for (const resolution of getTsconfigResolutionsForFile(context, fromFile)) {
    const aliasResolved = resolveAliasImport(specifier, resolution);
    if (aliasResolved !== null) return aliasResolved;

    if (resolution.baseUrl) {
      const baseUrlResolved = resolveRouteSourceFile(path.resolve(resolution.baseUrl, specifier));
      if (baseUrlResolved) return baseUrlResolved;

      if (!canResolvePackageSpecifier(context, specifier, fromFile)) {
        return UNRESOLVED_LOCAL_IMPORT;
      }
    }
  }

  if (isAliasShapedLocalSpecifier(specifier)) {
    return canResolvePackageSpecifier(context, specifier, fromFile)
      ? null
      : UNRESOLVED_LOCAL_IMPORT;
  }

  return null;
}

function fileUsesDynamicRequestApi(
  filePath: string | null | undefined,
  context: DynamicRequestDetectionContext,
  seen: Set<string>,
): boolean {
  if (!filePath || seen.has(filePath)) return false;
  seen.add(filePath);

  let source: string;
  try {
    source = fs.readFileSync(filePath, "utf8");
  } catch {
    return false;
  }

  if (dynamicRequestApiPattern.test(source)) return true;
  if (sourceUsesImportedDynamicRequestApi(source)) return true;

  importSpecifierPattern.lastIndex = 0;
  for (;;) {
    const match = importSpecifierPattern.exec(source);
    if (!match) break;
    const imported = resolveRouteImport(filePath, match[1] ?? match[2] ?? "", context);
    if (imported === UNRESOLVED_LOCAL_IMPORT) return true;
    if (imported && fileUsesDynamicRequestApi(imported, context, seen)) return true;
  }

  return false;
}

function routeUsesDynamicRequestApi(
  route: AppRoute,
  context: DynamicRequestDetectionContext,
): boolean {
  const routeFiles = [
    route.pagePath,
    ...route.layouts,
    ...route.templates,
    ...route.parallelSlots.flatMap((slot) => [
      slot.pagePath,
      slot.defaultPath,
      slot.layoutPath,
      ...(slot.configLayoutPaths ?? []),
      ...slot.interceptingRoutes.flatMap((intercept) => [
        intercept.pagePath,
        ...intercept.layoutPaths,
      ]),
    ]),
    ...route.siblingIntercepts.flatMap((intercept) => [
      intercept.pagePath,
      ...intercept.layoutPaths,
    ]),
  ];
  const seen = new Set<string>();
  return routeFiles.some((file) => fileUsesDynamicRequestApi(file, context, seen));
}

/** Project an `AppRoute` down to the public `VinextLinkPrefetchRoute` shape. */
export function toLinkPrefetchRoute(
  route: AppRoute,
  context = createDynamicRequestDetectionContext(),
): VinextLinkPrefetchRoute {
  const prefetchDynamicShell = routeUsesDynamicRequestApi(route, context);
  const requiresDynamicRequest =
    (route.isDynamic && route.parallelSlots.length > 0) || prefetchDynamicShell;

  return {
    canPrefetchLoadingShell: route.loadingPath !== null,
    patternParts: [...route.patternParts],
    isDynamic: route.isDynamic,
    ...(prefetchDynamicShell ? { prefetchDynamicShell: true } : {}),
    ...(requiresDynamicRequest ? { requiresDynamicNavigationRequest: true } : {}),
  };
}

function buildRouteManifestExpression(routeManifest: RouteManifest | null): string {
  if (routeManifest === null) return "null";

  const graph = routeManifest.segmentGraph;
  return `{
  graphVersion: ${JSON.stringify(routeManifest.graphVersion)},
  segmentGraph: {
    routes: ${buildMapExpression(graph.routes)},
    pages: ${buildMapExpression(graph.pages)},
    routeHandlers: ${buildMapExpression(graph.routeHandlers)},
    layouts: ${buildMapExpression(graph.layouts)},
    templates: ${buildMapExpression(graph.templates)},
    slots: ${buildMapExpression(graph.slots)},
    defaults: ${buildMapExpression(graph.defaults)},
    slotBindings: ${buildMapExpression(graph.slotBindings)},
    interceptions: ${buildMapExpression(graph.interceptions)},
    interceptionsBySlotId: ${buildMapExpression(graph.interceptionsBySlotId)},
    boundaries: ${buildMapExpression(graph.boundaries)},
    rootBoundaries: ${buildMapExpression(graph.rootBoundaries)}
  }
}`;
}

function buildMapExpression<Key extends string, Value>(map: ReadonlyMap<Key, Value>): string {
  return `new Map(${JSON.stringify(Array.from(map.entries()))})`;
}
