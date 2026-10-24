import { createInlineScriptTag } from "./html.js";
import { createNavigationRuntimeRscMetadataScript } from "./app-ssr-stream.js";

const PPR_DYNAMIC_FALLBACK_SHELL_MARKER = "<!--vinext-ppr-dynamic-fallback-shell-->";
const PPR_RESUME_DATA_CACHE_TRAILER_START = "<!--vinext-ppr-resume-data-cache:";
const PPR_RESUME_DATA_CACHE_TRAILER_END = "-->";

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

/**
 * Carry a fallback shell's resume data cache to the build after its HTML. The
 * cache is complete once the shell's body ends, and a header could not hold
 * it. Only a trusted fallback-shell prerender request gets the trailer, and
 * build/prerender.ts removes it before the shell is written.
 */
export function appendAppPprFallbackShellResumeDataCache(
  stream: ReadableStream<Uint8Array>,
  readResumeDataCache: () => string | null,
): ReadableStream<Uint8Array> {
  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      flush(controller) {
        const resumeDataCache = readResumeDataCache();
        if (resumeDataCache === null) return;
        // `<` and `>` occur only inside JSON strings, where `\u003c` and
        // `\u003e` are the same values, so the comment cannot end early and
        // never holds another trailer start.
        controller.enqueue(
          new TextEncoder().encode(
            PPR_RESUME_DATA_CACHE_TRAILER_START +
              resumeDataCache.replaceAll("<", "\\u003c").replaceAll(">", "\\u003e") +
              PPR_RESUME_DATA_CACHE_TRAILER_END,
          ),
        );
      },
    }),
  );
}

export function splitAppPprFallbackShellResumeDataCache(html: string): {
  html: string;
  resumeDataCache: string | null;
} {
  const start = html.lastIndexOf(PPR_RESUME_DATA_CACHE_TRAILER_START);
  if (start === -1 || !html.endsWith(PPR_RESUME_DATA_CACHE_TRAILER_END)) {
    return { html, resumeDataCache: null };
  }
  return {
    html: html.slice(0, start),
    resumeDataCache: html.slice(
      start + PPR_RESUME_DATA_CACHE_TRAILER_START.length,
      html.length - PPR_RESUME_DATA_CACHE_TRAILER_END.length,
    ),
  };
}

/**
 * A shell whose fallback params suspend outside every Suspense boundary has an
 * empty prelude: only vinext's own scripts, no document. Like Next.js, such a
 * route renders blocking, without the shell's resume data cache.
 */
export function hasAppPprFallbackShellPrelude(html: string): boolean {
  return /^\s*<!doctype html>/i.test(html);
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
    const fallbackParams: Record<string, string | string[]> = Object.create(null);

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

/**
 * The shells a request may resume. Its matched params are percent-encoded, so
 * they are decoded first, like the generateStaticParams values the build
 * derives the same shells from.
 */
export function createAppPprRequestFallbackShells(
  route: AppPprFallbackShellRoute,
  requestParams: Record<string, string | string[]>,
): AppPprFallbackShell[] {
  const decodedParams: Record<string, string | string[]> = Object.create(null);
  for (const [name, value] of Object.entries(requestParams)) {
    decodedParams[name] = Array.isArray(value)
      ? value.map(decodeParamValue)
      : decodeParamValue(value);
  }
  return createAppPprFallbackShells(route, decodedParams);
}

function decodeParamValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function rewriteAppPprFallbackShellHtmlNavigation(options: {
  html: string;
  isForceStatic?: boolean;
  params: Record<string, string | string[]>;
  pathname: string;
  searchParams: URLSearchParams;
}): string {
  const metadataScript = createInlineScriptTag(
    createNavigationRuntimeRscMetadataScript(
      options.params,
      {
        pathname: options.pathname,
        searchParams: options.isForceStatic ? [] : [...options.searchParams.entries()],
      },
      undefined,
      options.isForceStatic !== true,
    ),
  );

  const headCloseIndex = options.html.indexOf("</head>");
  if (headCloseIndex !== -1) {
    return (
      options.html.slice(0, headCloseIndex) + metadataScript + options.html.slice(headCloseIndex)
    );
  }

  return metadataScript + options.html;
}
