import { resolveClientRuntimeModule, resolveRuntimeEntryModule } from "./runtime-entry-module.js";
import fs from "node:fs";
import path from "node:path";
import type {
  VinextLinkPrefetchRoute,
  VinextPagesLinkPrefetchRoute,
} from "../client/vinext-next-data.js";
import type { AppRoute } from "../routing/app-router.js";
import type { RouteManifest } from "../routing/app-route-graph.js";
import type { NextRewrite } from "../config/next-config.js";
import { escapeRegExp } from "../utils/regex.js";

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
): string {
  const entryPath = resolveRuntimeEntryModule("app-browser-entry");
  const navigationRuntimePath = resolveClientRuntimeModule("navigation-runtime");
  const prefetchRoutes: VinextLinkPrefetchRoute[] = routes.map((route) =>
    isLinkPrefetchRoute(route) ? toLinkPrefetchRoute(route) : toDocumentOnlyAppRoute(route),
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

export function toDocumentOnlyAppRoute(route: AppRoute): VinextLinkPrefetchRoute {
  return {
    canPrefetchLoadingShell: false,
    documentOnly: true,
    patternParts: [...route.patternParts],
    isDynamic: route.isDynamic,
  };
}

function requiresDynamicNavigationRequest(route: AppRoute): boolean {
  return route.isDynamic && route.parallelSlots.length > 0;
}

/** Project an `AppRoute` down to the public `VinextLinkPrefetchRoute` shape. */
export function toLinkPrefetchRoute(route: AppRoute): VinextLinkPrefetchRoute {
  const prefetchMode = routePrefetchMode(route);
  return {
    canPrefetchLoadingShell: route.loadingPath !== null,
    ...(prefetchMode === "runtime" || prefetchMode === "inherited-runtime"
      ? { hasRuntimePrefetch: true }
      : {}),
    ...(prefetchMode ? { prefetchMode } : {}),
    patternParts: [...route.patternParts],
    isDynamic: route.isDynamic,
    ...(requiresDynamicNavigationRequest(route) ? { requiresDynamicNavigationRequest: true } : {}),
  };
}

type SegmentPrefetchMode = "runtime" | "static";

const segmentConfigExtensions = [".tsx", ".ts", ".jsx", ".js", ".mjs", ".mts", ".cjs", ".cts"];

function readFilePrefetchMode(filePath: string | null): SegmentPrefetchMode | null {
  if (filePath === null) return null;

  return readFileExportedPrefetchMode(filePath, "unstable_instant", new Set());
}

function readFileExportedPrefetchMode(
  filePath: string,
  exportName: string,
  visited: Set<string>,
): SegmentPrefetchMode | null {
  const cacheKey = `${path.resolve(filePath)}#${exportName}`;
  if (visited.has(cacheKey)) return null;
  visited.add(cacheKey);

  let source: string;
  try {
    source = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }

  const directExportExpression = findConstInitializer(source, exportName, { exported: true });
  if (directExportExpression) {
    return readPrefetchModeExpression({
      source,
      expression: directExportExpression,
      importerPath: filePath,
      visited,
    });
  }

  if (exportName === "default") {
    const defaultExportExpression = findDefaultExportExpression(source);
    if (defaultExportExpression) {
      return readPrefetchModeExpression({
        source,
        expression: defaultExportExpression,
        importerPath: filePath,
        visited,
      });
    }
  }

  const exportRef = findNamedExportReference(source, exportName);
  if (!exportRef) return null;
  if (exportRef.source) {
    const resolved = resolveRelativeImportPath(filePath, exportRef.source);
    return resolved ? readFileExportedPrefetchMode(resolved, exportRef.localName, visited) : null;
  }

  return readPrefetchModeExpression({
    source,
    expression: exportRef.localName,
    importerPath: filePath,
    visited,
  });
}

function readPrefetchModeExpression(input: {
  expression: string;
  importerPath: string;
  source: string;
  visited: Set<string>;
}): SegmentPrefetchMode | null {
  const expression = unwrapExpression(input.expression.trim());
  const objectMode = readObjectExpressionPrefetchMode(expression);
  if (objectMode) return objectMode;
  if (!isIdentifier(expression)) return null;

  const localInitializer = findConstInitializer(input.source, expression, { exported: false });
  if (localInitializer) {
    return readPrefetchModeExpression({
      ...input,
      expression: localInitializer,
    });
  }

  const importRef = findImportedBinding(input.source, expression);
  if (!importRef) return null;
  const resolved = resolveRelativeImportPath(input.importerPath, importRef.source);
  if (!resolved) return null;
  return readFileExportedPrefetchMode(resolved, importRef.importedName, input.visited);
}

function readObjectExpressionPrefetchMode(expression: string): SegmentPrefetchMode | null {
  if (!expression.startsWith("{")) return null;
  const match = /(?:^|[{,])\s*(?:prefetch|["']prefetch["'])\s*:\s*(["'])(runtime|static)\1/.exec(
    expression,
  );
  return match?.[2] === "runtime" || match?.[2] === "static" ? match[2] : null;
}

function findConstInitializer(
  source: string,
  name: string,
  options: { exported: boolean },
): string | null {
  const prefix = options.exported ? String.raw`export\s+const` : String.raw`const`;
  const match = new RegExp(`${prefix}\\s+${escapeRegExp(name)}\\b`, "m").exec(source);
  if (!match) return null;
  const initializerStart = readConstInitializerStart(source, match.index + match[0].length);
  if (initializerStart === null) return null;
  return readInitializerExpression(source, initializerStart);
}

function readConstInitializerStart(source: string, startIndex: number): number | null {
  let index = skipWhitespace(source, startIndex);
  if (source[index] === "=") return index + 1;
  if (source[index] !== ":") return null;

  index++;
  let quote: string | null = null;
  let escaped = false;
  let braceDepth = 0;
  let bracketDepth = 0;
  let parenDepth = 0;
  let angleDepth = 0;
  for (; index < source.length; index++) {
    const char = source[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") braceDepth++;
    if (char === "}") braceDepth--;
    if (char === "[") bracketDepth++;
    if (char === "]") bracketDepth--;
    if (char === "(") parenDepth++;
    if (char === ")") parenDepth--;
    if (char === "<") angleDepth++;
    if (char === ">" && angleDepth > 0) angleDepth--;
    const inNestedType = braceDepth > 0 || bracketDepth > 0 || parenDepth > 0 || angleDepth > 0;
    if (char === ";" && !inNestedType) return null;
    if (char === "=" && !inNestedType && source[index + 1] !== ">") return index + 1;
  }
  return null;
}

function skipWhitespace(source: string, startIndex: number): number {
  let index = startIndex;
  while (/\s/.test(source[index] ?? "")) index++;
  return index;
}

function findDefaultExportExpression(source: string): string | null {
  const match = /export\s+default\s+/.exec(source);
  if (!match) return null;
  return readInitializerExpression(source, match.index + match[0].length);
}

function findNamedExportReference(
  source: string,
  exportName: string,
): { localName: string; source: string | null } | null {
  const exportPattern = /export\s+{([^}]+)}(?:\s+from\s+(["'])([^"']+)\2)?/g;
  for (const match of source.matchAll(exportPattern)) {
    const exportSource = match[3] ?? null;
    for (const specifier of match[1].split(",")) {
      const ref = parseImportExportSpecifier(specifier);
      if (ref.exportedName === exportName) {
        return { localName: ref.localName, source: exportSource };
      }
    }
  }
  return null;
}

function findImportedBinding(
  source: string,
  localName: string,
): { importedName: string; source: string } | null {
  const namedImportPattern = /import\s+{([^}]+)}\s+from\s+(["'])([^"']+)\2/g;
  for (const match of source.matchAll(namedImportPattern)) {
    for (const specifier of match[1].split(",")) {
      const ref = parseImportExportSpecifier(specifier);
      if (ref.exportedName === localName) {
        return { importedName: ref.localName, source: match[3] };
      }
    }
  }

  const defaultImportPattern = /import\s+([A-Za-z_$][\w$]*)\s*(?:,|\s+from\s+(["'])([^"']+)\2)/g;
  for (const match of source.matchAll(defaultImportPattern)) {
    if (match[1] === localName && match[3]) {
      return { importedName: "default", source: match[3] };
    }
  }

  return null;
}

function parseImportExportSpecifier(specifier: string): {
  exportedName: string;
  localName: string;
} {
  const [localName, exportedName] = specifier
    .trim()
    .split(/\s+as\s+/)
    .map((part) => part.trim());
  return { exportedName: exportedName ?? localName, localName };
}

function readInitializerExpression(source: string, startIndex: number): string | null {
  let quote: string | null = null;
  let escaped = false;
  let braceDepth = 0;
  let bracketDepth = 0;
  let parenDepth = 0;
  for (let index = startIndex; index < source.length; index++) {
    const char = source[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") braceDepth++;
    if (char === "}") braceDepth--;
    if (char === "[") bracketDepth++;
    if (char === "]") bracketDepth--;
    if (char === "(") parenDepth++;
    if (char === ")") parenDepth--;
    if (char === ";" && braceDepth === 0 && bracketDepth === 0 && parenDepth === 0) {
      return source.slice(startIndex, index).trim();
    }
  }
  return source.slice(startIndex).trim() || null;
}

function unwrapExpression(expression: string): string {
  let current = expression;
  while (current.startsWith("(") && current.endsWith(")")) {
    current = current.slice(1, -1).trim();
  }
  return current;
}

function isIdentifier(value: string): boolean {
  return /^[A-Za-z_$][\w$]*$/.test(value);
}

function resolveRelativeImportPath(importerPath: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const basePath = path.resolve(path.dirname(importerPath), specifier);
  const candidates = path.extname(basePath)
    ? [basePath]
    : [
        ...segmentConfigExtensions.map((extension) => `${basePath}${extension}`),
        ...segmentConfigExtensions.map((extension) => path.join(basePath, `index${extension}`)),
      ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

function routePrefetchMode(route: AppRoute): "inherited-runtime" | SegmentPrefetchMode | null {
  const pagePrefetchMode = readFilePrefetchMode(route.pagePath);
  if (pagePrefetchMode) return pagePrefetchMode;
  return route.layouts.some((layoutPath) => readFilePrefetchMode(layoutPath) === "runtime")
    ? "inherited-runtime"
    : null;
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
