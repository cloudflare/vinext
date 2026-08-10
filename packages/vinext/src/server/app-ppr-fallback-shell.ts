import { createInlineScriptTag } from "./html.js";
import {
  createNavigationRuntimeRscMetadataScript,
  navigationRuntimeRscBootstrapExpression,
} from "./app-ssr-stream.js";
import type { ResumeDataCacheEntry } from "vinext/shims/cache-handler";

const PPR_DYNAMIC_FALLBACK_SHELL_MARKER = "<!--vinext-ppr-dynamic-fallback-shell-->";
const PPR_POSTPONED_STATE_PREFIX = "<!--vinext-ppr-postponed:";
const PPR_POSTPONED_STATE_SUFFIX = "-->";
const PPR_RESUME_DATA_PREFIX = "vinext-rdc-v1:";

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

/**
 * A fallback-shell cache entry as consumed by the dispatch layer.
 * Produced at build time by the PPR prerender and served at request time
 * when the exact cache entry for a dynamic child param is missing.
 */
export type AppPagePprFallbackCacheShell = {
  fallbackParamNames: readonly string[];
  params: Record<string, string | string[]>;
  pathname: string;
};

export function markAppPprDynamicFallbackShellHtml(html: string): string {
  return html + PPR_DYNAMIC_FALLBACK_SHELL_MARKER;
}

export function isAppPprDynamicFallbackShellHtml(html: string): boolean {
  return html.includes(PPR_DYNAMIC_FALLBACK_SHELL_MARKER);
}

export function stripAppPprDynamicFallbackShellMarker(html: string): string {
  return html.replace(PPR_DYNAMIC_FALLBACK_SHELL_MARKER, "");
}

/**
 * Keep the reusable Fizz shell, but discard the build-time Flight bootstrap.
 * Resume embeds a fresh Flight stream for the concrete request; replaying the
 * fallback render's terminal `done=true` before those chunks makes the browser
 * close its RSC controller and reject the resumed model.
 */
export function prepareAppPprFallbackShellHtmlForResume(html: string): string {
  const bootstrap = navigationRuntimeRscBootstrapExpression();
  return html
    .replace(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script\s*>/gi, (script, content: string) =>
      content.includes(bootstrap) ? "" : script,
    )
    .replace(/<\/body>\s*<\/html>\s*$/i, "");
}

export function createAppPprPostponedStateMarker(postponed: string): string {
  return `${PPR_POSTPONED_STATE_PREFIX}${encodeURIComponent(postponed)}${PPR_POSTPONED_STATE_SUFFIX}`;
}

export function serializeAppPprPostponedState(
  postponed: string,
  resumeDataCache: readonly unknown[],
): string {
  return `${PPR_RESUME_DATA_PREFIX}${JSON.stringify({ postponed, resumeDataCache })}`;
}

export function parseAppPprPostponedState(value: string): {
  postponed: string;
  resumeDataCache: ResumeDataCacheEntry[];
} {
  if (!value.startsWith(PPR_RESUME_DATA_PREFIX)) {
    return { postponed: value, resumeDataCache: [] };
  }
  try {
    const parsed = JSON.parse(value.slice(PPR_RESUME_DATA_PREFIX.length)) as {
      postponed?: unknown;
      resumeDataCache?: unknown;
    };
    if (typeof parsed.postponed !== "string" || !Array.isArray(parsed.resumeDataCache)) {
      return { postponed: value, resumeDataCache: [] };
    }
    const resumeDataCache = parsed.resumeDataCache.filter(
      (entry): entry is ResumeDataCacheEntry =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as Partial<ResumeDataCacheEntry>).key === "string" &&
        typeof (entry as Partial<ResumeDataCacheEntry>).lastModified === "number" &&
        typeof (entry as Partial<ResumeDataCacheEntry>).value === "object" &&
        (entry as Partial<ResumeDataCacheEntry>).value !== null,
    );
    return { postponed: parsed.postponed, resumeDataCache };
  } catch {
    return { postponed: value, resumeDataCache: [] };
  }
}

export function extractAppPprPostponedState(html: string): {
  html: string;
  postponed: string | undefined;
} {
  const start = html.lastIndexOf(PPR_POSTPONED_STATE_PREFIX);
  if (start === -1 || !html.endsWith(PPR_POSTPONED_STATE_SUFFIX)) {
    return { html, postponed: undefined };
  }
  const encoded = html.slice(
    start + PPR_POSTPONED_STATE_PREFIX.length,
    -PPR_POSTPONED_STATE_SUFFIX.length,
  );
  try {
    return { html: html.slice(0, start), postponed: decodeURIComponent(encoded) };
  } catch {
    return { html, postponed: undefined };
  }
}

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
  const shellHtml = prepareAppPprFallbackShellHtmlForResume(options.html);
  const metadataScript = createInlineScriptTag(
    createNavigationRuntimeRscMetadataScript(options.params, {
      pathname: options.pathname,
      searchParams: [...options.searchParams.entries()],
    }),
  );

  const headCloseIndex = shellHtml.indexOf("</head>");
  if (headCloseIndex !== -1) {
    return shellHtml.slice(0, headCloseIndex) + metadataScript + shellHtml.slice(headCloseIndex);
  }

  return metadataScript + shellHtml;
}
