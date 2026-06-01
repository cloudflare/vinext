import { createInlineScriptTag } from "./html.js";
import { createNavigationRuntimeRscMetadataScript } from "./app-ssr-stream.js";

type AppPprFallbackShellRoute = {
  params: readonly string[];
  pattern: string;
  rootParamNames?: readonly string[] | null;
};

type AppPprFallbackShell = {
  fallbackParamNames: readonly string[];
  pathname: string;
  params: Record<string, string | string[]>;
};

function routeRootParamNames(route: AppPprFallbackShellRoute): Set<string> {
  return new Set(route.rootParamNames ?? []);
}

function placeholderForParam(part: string, paramName: string): string | string[] {
  if (part.endsWith("+")) return [`[...${paramName}]`];
  if (part.endsWith("*")) return [`[[...${paramName}]]`];
  return `[${paramName}]`;
}

function pushParamValue(segments: string[], value: string | string[] | undefined): boolean {
  if (Array.isArray(value)) {
    if (value.length === 0) return false;
    segments.push(...value.map((item) => encodeURIComponent(item)));
    return true;
  }

  if (typeof value !== "string") return false;
  segments.push(encodeURIComponent(value));
  return true;
}

export function createAppPprFallbackShell(
  route: AppPprFallbackShellRoute,
  matchedParams: Record<string, string | string[]>,
): AppPprFallbackShell | null {
  return createAppPprFallbackShells(route, matchedParams).at(-1) ?? null;
}

export function createAppPprFallbackShells(
  route: AppPprFallbackShellRoute,
  matchedParams: Record<string, string | string[]>,
): AppPprFallbackShell[] {
  const rootParamNames = routeRootParamNames(route);
  if (rootParamNames.size === 0) return [];

  let minKeptParamCount = 0;
  for (const rootParamName of rootParamNames) {
    const rootParamIndex = route.params.indexOf(rootParamName);
    if (rootParamIndex === -1 || matchedParams[rootParamName] === undefined) return [];
    minKeptParamCount = Math.max(minKeptParamCount, rootParamIndex + 1);
  }

  if (minKeptParamCount >= route.params.length) {
    return [];
  }

  const shells: AppPprFallbackShell[] = [];
  for (
    let keptParamCount = route.params.length - 1;
    keptParamCount >= minKeptParamCount;
    keptParamCount--
  ) {
    const keptParamNames = new Set(route.params.slice(0, keptParamCount));
    const fallbackParamNames = route.params.filter((name) => !keptParamNames.has(name));
    if (fallbackParamNames.length === 0) continue;

    const fallbackParamNameSet = new Set(fallbackParamNames);
    const segments: string[] = [];
    const fallbackParams: Record<string, string | string[]> = {};

    let isValidShell = true;
    for (const part of route.pattern.split("/").filter(Boolean)) {
      if (part.startsWith(":")) {
        const isCatchAll = part.endsWith("+") || part.endsWith("*");
        const paramName = isCatchAll ? part.slice(1, -1) : part.slice(1);

        if (fallbackParamNameSet.has(paramName)) {
          const placeholder = placeholderForParam(part, paramName);
          segments.push(...(Array.isArray(placeholder) ? placeholder : [placeholder]));
          fallbackParams[paramName] = placeholder;
          continue;
        }

        const value = matchedParams[paramName];
        if (!pushParamValue(segments, value)) {
          isValidShell = false;
          break;
        }
        fallbackParams[paramName] = value;
        continue;
      }

      segments.push(part);
    }

    if (!isValidShell) continue;
    shells.push({
      fallbackParamNames,
      pathname: "/" + segments.join("/"),
      params: fallbackParams,
    });
  }

  return shells;
}

export function rewriteAppPprFallbackShellHtmlNavigation(options: {
  html: string;
  params: Record<string, string | string[]>;
  pathname: string;
  searchParams: URLSearchParams;
}): string {
  const metadataScript = createInlineScriptTag(
    createNavigationRuntimeRscMetadataScript(options.params, {
      pathname: options.pathname,
      searchParams: [...options.searchParams.entries()],
    }),
  );

  const headCloseIndex = options.html.indexOf("</head>");
  if (headCloseIndex !== -1) {
    return (
      options.html.slice(0, headCloseIndex) + metadataScript + options.html.slice(headCloseIndex)
    );
  }

  return metadataScript + options.html;
}
