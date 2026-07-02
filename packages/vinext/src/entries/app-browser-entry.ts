import { resolveClientRuntimeModule, resolveRuntimeEntryModule } from "./runtime-entry-module.js";
import fs from "node:fs";
import type {
  VinextLinkPrefetchRoute,
  VinextPagesLinkPrefetchRoute,
  VinextRuntimePrefetchLoadingFallback,
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

function requiresDynamicNavigationRequest(route: AppRoute, vary: PrefetchVaryAnalysis): boolean {
  return (
    (route.isDynamic && route.parallelSlots.length > 0) || vary.requiresDynamicNavigationRequest
  );
}

/** Project an `AppRoute` down to the public `VinextLinkPrefetchRoute` shape. */
export function toLinkPrefetchRoute(route: AppRoute): VinextLinkPrefetchRoute {
  const vary = analyzePrefetchVary(route);
  return {
    canPrefetchLoadingShell: route.loadingPath !== null,
    ...(vary.canPrefetchRuntimeShell ? { canPrefetchRuntimeShell: true } : {}),
    ...(vary.canPrefetchStaticRoute || !route.isDynamic ? { canPrefetchStaticRoute: true } : {}),
    ...((route.loadingPath !== null || vary.canPrefetchRuntimeShell) &&
    vary.loadingShellParamNames.length > 0
      ? { loadingShellVaryParamNames: vary.loadingShellParamNames }
      : {}),
    patternParts: [...route.patternParts],
    ...(vary.prefetchParamNames.length > 0
      ? { prefetchVaryParamNames: vary.prefetchParamNames }
      : {}),
    ...(vary.prefetchVarySearchParams ? { prefetchVarySearchParams: true } : {}),
    ...(vary.runtimePrefetchParamNames.length > 0
      ? { runtimePrefetchVaryParamNames: vary.runtimePrefetchParamNames }
      : {}),
    ...(vary.runtimePrefetchLoadingFallback
      ? { runtimePrefetchLoadingFallback: vary.runtimePrefetchLoadingFallback }
      : {}),
    ...(vary.runtimePrefetchVarySearchParams ? { runtimePrefetchVarySearchParams: true } : {}),
    isDynamic: route.isDynamic,
    ...(requiresDynamicNavigationRequest(route, vary)
      ? { requiresDynamicNavigationRequest: true }
      : {}),
  };
}

type PrefetchVaryAnalysis = {
  canPrefetchRuntimeShell: boolean;
  canPrefetchStaticRoute: boolean;
  loadingShellParamNames: string[];
  prefetchParamNames: string[];
  prefetchVarySearchParams: boolean;
  runtimePrefetchLoadingFallback: VinextRuntimePrefetchLoadingFallback | null;
  runtimePrefetchParamNames: string[];
  runtimePrefetchVarySearchParams: boolean;
  requiresDynamicNavigationRequest: boolean;
};

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function readSource(filePath: string | null | undefined): string {
  if (!filePath) return "";
  try {
    return stripComments(fs.readFileSync(filePath, "utf8"));
  } catch {
    return "";
  }
}

function sourceHasUseClientDirective(source: string): boolean {
  return /^["']use client["']\s*;?/.test(source.trimStart());
}

function serverPrefetchSource(source: string): string {
  return sourceHasUseClientDirective(source) ? "" : source;
}

function readIdentifier(source: string, index: number): string | null {
  const match = /[A-Za-z_$][\w$]*/.exec(source.slice(index));
  return match?.index === 0 ? match[0] : null;
}

function skipsQuotedSource(source: string, index: number): number {
  const quote = source[index];
  let cursor = index + 1;
  while (cursor < source.length) {
    const char = source[cursor];
    if (char === "\\") {
      cursor += 2;
      continue;
    }
    if (char === quote) return cursor + 1;
    cursor++;
  }
  return source.length;
}

function nextNonWhitespaceIndex(source: string, index: number): number {
  let cursor = index;
  while (cursor < source.length && /\s/.test(source[cursor] ?? "")) {
    cursor++;
  }
  return cursor;
}

function collectNextServerConnectionIdentifiers(source: string): Set<string> {
  const identifiers = new Set<string>();
  const importPattern = /\bimport\s*\{([^}]+)\}\s*from\s*["']next\/server(?:\.js)?["']/g;

  for (const match of source.matchAll(importPattern)) {
    for (const specifier of (match[1] ?? "").split(",")) {
      const importName = specifier.trim().match(/^connection(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
      if (importName) {
        identifiers.add(importName[1] ?? "connection");
      }
    }
  }

  return identifiers;
}

function findConnectionCallIndex(source: string): number | null {
  const connectionIdentifiers = collectNextServerConnectionIdentifiers(source);
  if (connectionIdentifiers.size === 0) return null;

  const allowedPreviousIdentifiers = new Set(["await", "return", "void", "yield"]);
  const allowedPreviousPunctuation = new Set(["", "(", "{", "[", "=", ":", ",", ";", "?", "!"]);
  let previousToken = "";
  let index = 0;

  while (index < source.length) {
    const char = source[index];
    if (char === '"' || char === "'" || char === "`") {
      index = skipsQuotedSource(source, index);
      continue;
    }

    const identifier = readIdentifier(source, index);
    if (identifier !== null) {
      if (connectionIdentifiers.has(identifier)) {
        const nextIndex = nextNonWhitespaceIndex(source, index + identifier.length);
        if (
          source[nextIndex] === "(" &&
          (allowedPreviousIdentifiers.has(previousToken) ||
            allowedPreviousPunctuation.has(previousToken))
        ) {
          return index;
        }
      }
      previousToken = identifier;
      index += identifier.length;
      continue;
    }

    if (!/\s/.test(char ?? "")) {
      previousToken = char ?? "";
    }
    index++;
  }

  return null;
}

function staticPrefetchRegion(source: string): string {
  const connectionIndex = findConnectionCallIndex(source);
  return connectionIndex === null ? source : source.slice(0, connectionIndex);
}

function findExportedFunctionBodyStart(source: string, functionName: string): number | null {
  const startMatch = new RegExp(
    String.raw`\bexport\s+(?:async\s+)?function\s+${escapeRegExp(functionName)}\b`,
  ).exec(source);
  if (!startMatch || startMatch.index === undefined) return null;

  const paramsStart = source.indexOf("(", startMatch.index);
  if (paramsStart === -1) return null;

  let parenDepth = 0;
  for (let index = paramsStart; index < source.length; index++) {
    const char = source[index];
    if (char === "(") {
      parenDepth++;
    } else if (char === ")") {
      parenDepth--;
      if (parenDepth === 0) {
        const bodyStart = source.indexOf("{", index);
        return bodyStart === -1 ? null : bodyStart;
      }
    }
  }
  return null;
}

function findExportedFunctionBodyEnd(source: string, functionName: string): number | null {
  const bodyStart = findExportedFunctionBodyStart(source, functionName);
  if (bodyStart === null) return null;

  let depth = 0;
  for (let index = bodyStart; index < source.length; index++) {
    const char = source[index];
    if (char === "{") {
      depth++;
    } else if (char === "}") {
      depth--;
      if (depth === 0) return index + 1;
    }
  }
  return null;
}

function extractExportedFunction(source: string, functionName: string): string {
  const startMatch = new RegExp(
    String.raw`\bexport\s+(?:async\s+)?function\s+${escapeRegExp(functionName)}\b`,
  ).exec(source);
  if (!startMatch || startMatch.index === undefined) return "";
  const end = findExportedFunctionBodyEnd(source, functionName);
  return end === null ? "" : source.slice(startMatch.index, end);
}

function removeExportedFunction(source: string, functionName: string): string {
  const startMatch = new RegExp(
    String.raw`\bexport\s+(?:async\s+)?function\s+${escapeRegExp(functionName)}\b`,
  ).exec(source);
  if (!startMatch || startMatch.index === undefined) return source;
  const end = findExportedFunctionBodyEnd(source, functionName);
  return end === null ? source : `${source.slice(0, startMatch.index)}\n${source.slice(end)}`;
}

function collectPropAliases(source: string, propName: string): string[] {
  return Array.from(
    source.matchAll(
      new RegExp(String.raw`\{[^}]*\b${escapeRegExp(propName)}\s*:\s*([A-Za-z_$][\w$]*)`, "g"),
    ),
    (match) => match[1],
  );
}

function propMemberSourcePattern(propName: string): string {
  return String.raw`\b[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*\s*\.\s*${escapeRegExp(propName)}\b`;
}

function hasPropMemberSource(source: string, propName: string): boolean {
  return new RegExp(propMemberSourcePattern(propName)).test(source);
}

function sourcePattern(
  identifiers: readonly string[],
  memberPropName: string,
  source: string,
): string {
  const patterns = identifiers.map((name) => String.raw`\b${escapeRegExp(name)}\b`);
  if (hasPropMemberSource(source, memberPropName)) {
    patterns.push(propMemberSourcePattern(memberPropName));
  }
  return `(?:${patterns.join("|")})`;
}

function collectSourceAliases(
  source: string,
  identifiers: readonly string[],
  memberPropName: string,
): string[] {
  const aliases: string[] = [];
  const seen = new Set(identifiers);

  for (;;) {
    const sourceExpressionPattern = sourcePattern(Array.from(seen), memberPropName, source);
    const discovered = Array.from(
      source.matchAll(
        new RegExp(
          String.raw`\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*${sourceExpressionPattern}\b`,
          "g",
        ),
      ),
      (match) => match[1],
    ).filter((alias) => !seen.has(alias));

    if (discovered.length === 0) return aliases;
    for (const alias of discovered) {
      seen.add(alias);
      aliases.push(alias);
    }
  }
}

function collectParamAccesses(source: string, paramNames: readonly string[]): Set<string> {
  const region = staticPrefetchRegion(source);
  const accessed = new Set<string>();
  const paramPropAliases = collectPropAliases(region, "params");
  const paramPromiseIdentifiers = [
    "params",
    ...paramPropAliases,
    ...collectSourceAliases(region, ["params", ...paramPropAliases], "params"),
  ];
  const paramPromiseSourcePattern = sourcePattern(paramPromiseIdentifiers, "params", region);
  const awaitedParamAliases = Array.from(
    region.matchAll(
      new RegExp(
        String.raw`\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+${paramPromiseSourcePattern}`,
        "g",
      ),
    ),
    (match) => match[1],
  );
  const paramSourcePattern = sourcePattern(
    [...paramPromiseIdentifiers, ...awaitedParamAliases],
    "params",
    region,
  );
  const enumeratesParams = new RegExp(
    String.raw`(?:\{\s*\.\.\.\s*${paramSourcePattern}\s*\}|\bObject\.(?:keys|values|entries)\s*\(\s*(?:await\s+)?${paramSourcePattern}|\bObject\.assign\s*\([^)]*(?:await\s+)?${paramSourcePattern})`,
  ).test(region);
  const computedParamAccess = new RegExp(
    String.raw`(?:\b${paramSourcePattern}\s*\[|\bReflect\.get\s*\(\s*${paramSourcePattern}\b)`,
  ).test(region);
  const passesParamsToHelper = new RegExp(
    String.raw`\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?\(\s*(?:await\s+${paramPromiseSourcePattern}|${paramSourcePattern})`,
  ).test(region);

  // Unknown computed or helper reads must over-vary instead of sharing the wrong segment.
  if (enumeratesParams || computedParamAccess || passesParamsToHelper) {
    for (const name of paramNames) {
      accessed.add(name);
    }
  }

  for (const name of paramNames) {
    const escaped = escapeRegExp(name);
    if (
      new RegExp(
        String.raw`\{[^}]*\b${escaped}\b[^}]*\}\s*=\s*await\s+${paramPromiseSourcePattern}\b`,
      ).test(region)
    ) {
      accessed.add(name);
      continue;
    }
    if (
      new RegExp(String.raw`\{[^}]*\b${escaped}\b[^}]*\}\s*=\s*${paramSourcePattern}\b`).test(
        region,
      )
    ) {
      accessed.add(name);
      continue;
    }
    if (
      new RegExp(
        String.raw`\(\s*await\s+${paramPromiseSourcePattern}\s*\)\s*\.\s*${escaped}\b`,
      ).test(region)
    ) {
      accessed.add(name);
      continue;
    }
    if (new RegExp(String.raw`\b${paramSourcePattern}\s*\.\s*${escaped}\b`).test(region)) {
      accessed.add(name);
      continue;
    }
    if (new RegExp(String.raw`["']${escaped}["']\s+in\s*${paramSourcePattern}\b`).test(region)) {
      accessed.add(name);
      continue;
    }
    if (
      awaitedParamAliases.some((alias) =>
        new RegExp(String.raw`\b${escapeRegExp(alias)}\s*\.\s*${escaped}\b`).test(region),
      )
    ) {
      accessed.add(name);
      continue;
    }
  }

  return accessed;
}

function collectRootParamAccesses(source: string, paramNames: readonly string[]): Set<string> {
  if (!/\bfrom\s+["']next\/root-params["']/.test(source)) return new Set();

  const region = staticPrefetchRegion(source);
  const accessed = new Set<string>();
  for (const name of paramNames) {
    if (new RegExp(String.raw`\b${escapeRegExp(name)}\s*\(`).test(region)) {
      accessed.add(name);
    }
  }
  return accessed;
}

function mergeAccesses(target: Set<string>, source: Set<string>): void {
  for (const name of source) {
    target.add(name);
  }
}

function sourceAccessesSearchParams(source: string): boolean {
  const region = staticPrefetchRegion(source);
  const searchParamPropAliases = collectPropAliases(region, "searchParams");
  const searchParamPromiseIdentifiers = [
    "searchParams",
    ...searchParamPropAliases,
    ...collectSourceAliases(region, ["searchParams", ...searchParamPropAliases], "searchParams"),
  ];
  const searchParamPromiseSourcePattern = sourcePattern(
    searchParamPromiseIdentifiers,
    "searchParams",
    region,
  );
  const awaitedSearchParamAliases = Array.from(
    region.matchAll(
      new RegExp(
        String.raw`\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+${searchParamPromiseSourcePattern}`,
        "g",
      ),
    ),
    (match) => match[1],
  );
  const searchParamSourcePattern = sourcePattern(
    [...searchParamPromiseIdentifiers, ...awaitedSearchParamAliases],
    "searchParams",
    region,
  );
  return (
    new RegExp(String.raw`\bawait\s+${searchParamPromiseSourcePattern}`).test(region) ||
    new RegExp(String.raw`\b${searchParamSourcePattern}\s*(?:\.|\[)`).test(region) ||
    new RegExp(
      String.raw`\bObject\.(?:keys|values|entries)\s*\(\s*(?:await\s+)?${searchParamSourcePattern}`,
    ).test(region) ||
    new RegExp(String.raw`\bObject\.assign\s*\([^)]*(?:await\s+)?${searchParamSourcePattern}`).test(
      region,
    ) ||
    new RegExp(String.raw`\{\s*\.\.\.\s*(?:await\s+)?${searchParamSourcePattern}\s*\}`).test(
      region,
    ) ||
    new RegExp(String.raw`\bReflect\.get\s*\(\s*${searchParamSourcePattern}\b`).test(region) ||
    new RegExp(
      String.raw`\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?\(\s*(?:await\s+${searchParamPromiseSourcePattern}|${searchParamSourcePattern})\b`,
    ).test(region)
  );
}

function sourceAllowsRuntimePrefetch(source: string): boolean {
  return (
    /\bexport\s+const\s+prefetch\s*=\s*["']allow-runtime["']/.test(source) ||
    /\bexport\s+const\s+unstable_instant\b[\s\S]*?\bprefetch\s*:\s*["']runtime["']/.test(source)
  );
}

function sourceHasGenerateStaticParams(source: string): boolean {
  return /\bexport\s+(?:async\s+)?function\s+generateStaticParams\b/.test(source);
}

function sourceHasConnectionCall(source: string): boolean {
  return findConnectionCallIndex(source) !== null;
}

function sourceHasSuspenseFallback(source: string): boolean {
  return /<\s*Suspense\b/.test(source);
}

function decodeSimpleJsxText(value: string): string {
  // Decode only one entity layer so `&amp;lt;` remains `&lt;`, matching JSX text semantics.
  return value.replace(/&(quot|#39|amp|lt|gt);/g, (match, entity: string) => {
    switch (entity) {
      case "quot":
        return '"';
      case "#39":
        return "'";
      case "amp":
        return "&";
      case "lt":
        return "<";
      case "gt":
        return ">";
      default:
        return match;
    }
  });
}

function parseSimpleJsxAttributes(source: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const attributePattern =
    /\s([A-Za-z_:][\w:.-]*)(?:=(?:"([^"]*)"|'([^']*)'|\{\s*["']([^"']*)["']\s*\}))?/g;
  for (const match of source.matchAll(attributePattern)) {
    attributes[match[1]] = decodeSimpleJsxText(match[2] ?? match[3] ?? match[4] ?? "true");
  }
  return attributes;
}

function extractRuntimePrefetchLoadingFallback(
  source: string,
): VinextRuntimePrefetchLoadingFallback | null {
  const fallbackPattern = /fallback=\{\s*<([a-z][\w-]*)([^>]*)>\s*([^<{}]+?)\s*<\/\1>\s*\}/g;
  const fallbacks: VinextRuntimePrefetchLoadingFallback[] = [];
  for (const match of source.matchAll(fallbackPattern)) {
    fallbacks.push({
      attributes: parseSimpleJsxAttributes(match[2] ?? ""),
      tagName: match[1],
      text: decodeSimpleJsxText((match[3] ?? "").replace(/\s+/g, " ").trim()),
    });
  }
  return (
    fallbacks.find((fallback) => Object.hasOwn(fallback.attributes, "data-loading")) ??
    fallbacks[0] ??
    null
  );
}

function sortedKnownParams(input: Set<string>, route: AppRoute): string[] {
  return route.params.filter((name) => input.has(name));
}

function analyzePrefetchVary(route: AppRoute): PrefetchVaryAnalysis {
  const layoutSources = route.layouts.map((layoutPath) =>
    serverPrefetchSource(readSource(layoutPath)),
  );
  const pageSource = serverPrefetchSource(readSource(route.pagePath));
  const metadataSource = extractExportedFunction(pageSource, "generateMetadata");
  const pageBodySource = removeExportedFunction(pageSource, "generateMetadata");
  const pageDir = route.pagePath ? route.pagePath.replace(/[/\\][^/\\]+$/, "") : null;
  let terminalLayoutSource = "";
  if (pageDir !== null) {
    for (let index = route.layouts.length - 1; index >= 0; index--) {
      const layoutPath = route.layouts[index];
      if (layoutPath?.replace(/[/\\][^/\\]+$/, "") === pageDir) {
        terminalLayoutSource = layoutSources[index] ?? "";
        break;
      }
    }
  }
  const canPrefetchRuntimeShell =
    sourceAllowsRuntimePrefetch(pageSource) ||
    (route.loadingPath === null && sourceHasSuspenseFallback(pageSource));
  const canPrefetchStaticRoute =
    sourceHasGenerateStaticParams(pageSource) ||
    sourceHasGenerateStaticParams(terminalLayoutSource);
  const requiresDynamicNavigationRequest =
    route.isDynamic && canPrefetchStaticRoute && sourceHasConnectionCall(pageBodySource);
  const layoutParamAccesses = new Set<string>();
  const metadataParamAccesses = new Set<string>();
  const pageParamAccesses = new Set<string>();

  for (const source of layoutSources) {
    mergeAccesses(layoutParamAccesses, collectParamAccesses(source, route.params));
    mergeAccesses(layoutParamAccesses, collectRootParamAccesses(source, route.params));
  }
  mergeAccesses(metadataParamAccesses, collectParamAccesses(metadataSource, route.params));
  mergeAccesses(metadataParamAccesses, collectRootParamAccesses(metadataSource, route.params));

  if (
    !(
      route.loadingPath === null &&
      sourceHasSuspenseFallback(pageSource) &&
      !sourceAllowsRuntimePrefetch(pageSource)
    )
  ) {
    mergeAccesses(pageParamAccesses, collectParamAccesses(pageBodySource, route.params));
    mergeAccesses(pageParamAccesses, collectRootParamAccesses(pageBodySource, route.params));
  }

  const loadingShellParamAccesses = new Set(layoutParamAccesses);
  mergeAccesses(loadingShellParamAccesses, metadataParamAccesses);
  const runtimeParamAccesses = new Set(pageParamAccesses);
  mergeAccesses(runtimeParamAccesses, metadataParamAccesses);

  return {
    canPrefetchRuntimeShell,
    canPrefetchStaticRoute,
    loadingShellParamNames: sortedKnownParams(loadingShellParamAccesses, route),
    prefetchParamNames: sortedKnownParams(
      canPrefetchRuntimeShell ? runtimeParamAccesses : pageParamAccesses,
      route,
    ),
    prefetchVarySearchParams:
      sourceAccessesSearchParams(pageBodySource) || layoutSources.some(sourceAccessesSearchParams),
    runtimePrefetchLoadingFallback: canPrefetchRuntimeShell
      ? extractRuntimePrefetchLoadingFallback(pageBodySource)
      : null,
    runtimePrefetchParamNames: sortedKnownParams(runtimeParamAccesses, route),
    runtimePrefetchVarySearchParams:
      sourceAccessesSearchParams(pageBodySource) ||
      sourceAccessesSearchParams(metadataSource) ||
      layoutSources.some(sourceAccessesSearchParams),
    requiresDynamicNavigationRequest,
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
