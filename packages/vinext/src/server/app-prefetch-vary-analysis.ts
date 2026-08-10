import fs from "node:fs";
import type { VinextRuntimePrefetchLoadingFallback } from "../client/vinext-next-data.js";
import type { AppRoute } from "../routing/app-router.js";
import { escapeRegExp } from "../utils/regex.js";

export type AppPrefetchVaryAnalysis = {
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

function skipQuotedSource(source: string, index: number): number {
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
  while (cursor < source.length && /\s/.test(source[cursor] ?? "")) cursor++;
  return cursor;
}

function collectNextServerConnectionIdentifiers(source: string): Set<string> {
  const identifiers = new Set<string>();
  const importPattern = /\bimport\s*\{([^}]+)\}\s*from\s*["']next\/server(?:\.js)?["']/g;
  for (const match of source.matchAll(importPattern)) {
    for (const specifier of (match[1] ?? "").split(",")) {
      const connectionImport = specifier
        .trim()
        .match(/^connection(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
      if (connectionImport) identifiers.add(connectionImport[1] ?? "connection");
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
      index = skipQuotedSource(source, index);
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
    if (!/\s/.test(char ?? "")) previousToken = char ?? "";
    index++;
  }
  return null;
}

function staticPrefetchRegion(source: string): string {
  const connectionIndex = findConnectionCallIndex(source);
  return connectionIndex === null ? source : source.slice(0, connectionIndex);
}

function findExportedFunctionBounds(
  source: string,
  functionName: string,
): { end: number; start: number } | null {
  const startMatch = new RegExp(
    String.raw`\bexport\s+(?:async\s+)?function\s+${escapeRegExp(functionName)}\b`,
  ).exec(source);
  if (!startMatch || startMatch.index === undefined) return null;
  const paramsStart = source.indexOf("(", startMatch.index);
  if (paramsStart === -1) return null;

  let parenDepth = 0;
  let bodyStart = -1;
  for (let index = paramsStart; index < source.length; index++) {
    const char = source[index];
    if (char === "(") parenDepth++;
    else if (char === ")") {
      parenDepth--;
      if (parenDepth === 0) {
        bodyStart = source.indexOf("{", index);
        break;
      }
    }
  }
  if (bodyStart === -1) return null;

  let braceDepth = 0;
  for (let index = bodyStart; index < source.length; index++) {
    const char = source[index];
    if (char === "{") braceDepth++;
    else if (char === "}") {
      braceDepth--;
      if (braceDepth === 0) return { end: index + 1, start: startMatch.index };
    }
  }
  return null;
}

function extractExportedFunction(source: string, functionName: string): string {
  const bounds = findExportedFunctionBounds(source, functionName);
  return bounds ? source.slice(bounds.start, bounds.end) : "";
}

function removeExportedFunction(source: string, functionName: string): string {
  const bounds = findExportedFunctionBounds(source, functionName);
  return bounds ? `${source.slice(0, bounds.start)}\n${source.slice(bounds.end)}` : source;
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

function sourcePattern(
  identifiers: readonly string[],
  memberPropName: string,
  source: string,
): string {
  const patterns = identifiers.map((name) => String.raw`\b${escapeRegExp(name)}\b`);
  if (new RegExp(propMemberSourcePattern(memberPropName)).test(source)) {
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
    const expression = sourcePattern([...seen], memberPropName, source);
    const discovered = Array.from(
      source.matchAll(
        new RegExp(String.raw`\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*${expression}\b`, "g"),
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
  const propAliases = collectPropAliases(region, "params");
  const promiseIdentifiers = [
    "params",
    ...propAliases,
    ...collectSourceAliases(region, ["params", ...propAliases], "params"),
  ];
  const promiseSource = sourcePattern(promiseIdentifiers, "params", region);
  const awaitedAliases = Array.from(
    region.matchAll(
      new RegExp(
        String.raw`\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+${promiseSource}`,
        "g",
      ),
    ),
    (match) => match[1],
  );
  const paramSource = sourcePattern([...promiseIdentifiers, ...awaitedAliases], "params", region);
  const unknownRead =
    new RegExp(
      String.raw`(?:\{\s*\.\.\.\s*${paramSource}\s*\}|\bObject\.(?:keys|values|entries)\s*\(\s*(?:await\s+)?${paramSource}|\bObject\.assign\s*\([^)]*(?:await\s+)?${paramSource}|\b${paramSource}\s*\[|\bReflect\.get\s*\(\s*${paramSource}\b)`,
    ).test(region) ||
    new RegExp(
      String.raw`\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?\(\s*(?:await\s+${promiseSource}|${paramSource})`,
    ).test(region);
  if (unknownRead) for (const name of paramNames) accessed.add(name);

  for (const name of paramNames) {
    const escaped = escapeRegExp(name);
    if (
      new RegExp(
        String.raw`\{[^}]*\b${escaped}\b[^}]*\}\s*=\s*(?:await\s+${promiseSource}|${paramSource})\b`,
      ).test(region) ||
      new RegExp(String.raw`\(\s*await\s+${promiseSource}\s*\)\s*\.\s*${escaped}\b`).test(region) ||
      new RegExp(String.raw`\b${paramSource}\s*\.\s*${escaped}\b`).test(region) ||
      new RegExp(String.raw`["']${escaped}["']\s+in\s*${paramSource}\b`).test(region)
    ) {
      accessed.add(name);
    }
  }
  return accessed;
}

function collectRootParamAccesses(source: string, paramNames: readonly string[]): Set<string> {
  if (!/\bfrom\s+["']next\/root-params["']/.test(source)) return new Set();
  const region = staticPrefetchRegion(source);
  return new Set(
    paramNames.filter((name) => new RegExp(String.raw`\b${escapeRegExp(name)}\s*\(`).test(region)),
  );
}

function mergeAccesses(target: Set<string>, source: Set<string>): void {
  for (const name of source) target.add(name);
}

function sourceAccessesSearchParams(source: string): boolean {
  const region = staticPrefetchRegion(source);
  const propAliases = collectPropAliases(region, "searchParams");
  const promiseIdentifiers = [
    "searchParams",
    ...propAliases,
    ...collectSourceAliases(region, ["searchParams", ...propAliases], "searchParams"),
  ];
  const promiseSource = sourcePattern(promiseIdentifiers, "searchParams", region);
  const awaitedAliases = Array.from(
    region.matchAll(
      new RegExp(
        String.raw`\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+${promiseSource}`,
        "g",
      ),
    ),
    (match) => match[1],
  );
  const searchSource = sourcePattern(
    [...promiseIdentifiers, ...awaitedAliases],
    "searchParams",
    region,
  );
  return (
    new RegExp(String.raw`\bawait\s+${promiseSource}`).test(region) ||
    new RegExp(String.raw`\b${searchSource}\s*(?:\.|\[)`).test(region) ||
    new RegExp(
      String.raw`\bObject\.(?:keys|values|entries)\s*\(\s*(?:await\s+)?${searchSource}`,
    ).test(region) ||
    new RegExp(String.raw`\bObject\.assign\s*\([^)]*(?:await\s+)?${searchSource}`).test(region) ||
    new RegExp(String.raw`\{\s*\.\.\.\s*(?:await\s+)?${searchSource}\s*\}`).test(region) ||
    new RegExp(String.raw`\bReflect\.get\s*\(\s*${searchSource}\b`).test(region) ||
    new RegExp(
      String.raw`\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?\(\s*(?:await\s+${promiseSource}|${searchSource})\b`,
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

function sourceHasSuspenseFallback(source: string): boolean {
  return /<\s*Suspense\b/.test(source);
}

function decodeSimpleJsxText(value: string): string {
  return value.replace(/&(quot|#39|amp|lt|gt);/g, (match, entity: string) => {
    if (entity === "quot") return '"';
    if (entity === "#39") return "'";
    if (entity === "amp") return "&";
    if (entity === "lt") return "<";
    if (entity === "gt") return ">";
    return match;
  });
}

function parseSimpleJsxAttributes(source: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const pattern = /\s([A-Za-z_:][\w:.-]*)(?:=(?:"([^"]*)"|'([^']*)'|\{\s*["']([^"']*)["']\s*\}))?/g;
  for (const match of source.matchAll(pattern)) {
    attributes[match[1]] = decodeSimpleJsxText(match[2] ?? match[3] ?? match[4] ?? "true");
  }
  return attributes;
}

function extractRuntimePrefetchLoadingFallback(
  source: string,
): VinextRuntimePrefetchLoadingFallback | null {
  const pattern = /fallback=\{\s*<([a-z][\w-]*)([^>]*)>\s*([^<{}]+?)\s*<\/\1>\s*\}/g;
  const fallbacks: VinextRuntimePrefetchLoadingFallback[] = [];
  for (const match of source.matchAll(pattern)) {
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

export function analyzeAppPrefetchVary(route: AppRoute): AppPrefetchVaryAnalysis {
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
      if (route.layouts[index]?.replace(/[/\\][^/\\]+$/, "") === pageDir) {
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
    route.isDynamic && canPrefetchStaticRoute && findConnectionCallIndex(pageBodySource) !== null;
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
