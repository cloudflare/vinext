import { createInlineScriptTag } from "./html.js";
import { createNavigationRuntimeRscMetadataScript } from "./app-ssr-stream.js";

const PPR_DYNAMIC_FALLBACK_SHELL_MARKER = "<!--vinext-ppr-dynamic-fallback-shell-->";
const PPR_SHELL_STATE_TRAILER_START = "<!--vinext-ppr-shell-state:";
const PPR_SHELL_STATE_TRAILER_END = "-->";

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
  return html.endsWith(PPR_DYNAMIC_FALLBACK_SHELL_MARKER)
    ? html.slice(0, -PPR_DYNAMIC_FALLBACK_SHELL_MARKER.length)
    : html;
}

function formatSegmentKeyParamValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value.join("/") : (value ?? "");
}

/**
 * A shell's tree keys its segments by its fallback params' placeholders, as
 * `slug|%5Bslug%5D|d`, where a request renders its own values. React resumes
 * only a tree whose keys match, so like Next.js's postponed state, which swaps
 * its fallback param placeholders for the request's values, the keys are
 * rewritten to the request's before it resumes. Both sides are the encoded
 * values the segment keys hold.
 */
export function replaceAppPprShellFallbackParamKeys(
  postponed: unknown,
  replacements: ReadonlyArray<{
    name: string;
    shellValue: string | string[] | undefined;
    requestValue: string | string[] | undefined;
  }>,
): unknown {
  const tokens = replacements
    .map(({ name, shellValue, requestValue }) => ({
      from: `"${name}|${formatSegmentKeyParamValue(shellValue)}|`,
      to: `"${name}|${formatSegmentKeyParamValue(requestValue)}|`,
    }))
    .filter(({ from, to }) => from !== to);
  if (tokens.length === 0) return postponed;
  const replace = (value: unknown): unknown => {
    if (typeof value === "string") {
      let replaced = value;
      for (const { from, to } of tokens) replaced = replaced.replaceAll(from, to);
      return replaced;
    }
    if (Array.isArray(value)) return value.map(replace);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replace(item)]));
    }
    return value;
  };
  return replace(postponed);
}

/**
 * What a request resumes a dynamic shell from, stored as its entry's
 * `postponed` value.
 */
export type AppPprShellState = {
  /**
   * Whether the shell's document is a prelude: the document up to its holes,
   * without its payload, which a request sends first and then resumes.
   * Otherwise it's whole, and a request renders the page with the shell's
   * cached values.
   */
  prelude: boolean;
  /** React's postponed state for the prelude, or null when only the payload has holes. */
  postponed: unknown;
  resumeDataCache: string | null;
};

// `<` and `>` occur only inside JSON strings, where `\u003c` and `\u003e` are
// the same values, so a state never holds `-->` and fits in an HTML comment.
function escapeJsonForHtmlComment(json: string): string {
  return json.replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");
}

/**
 * A shell's state as one string: like Next.js's postponed state, the length of
 * its JSON header, the header, then the resume data cache.
 */
export function formatAppPprShellState(state: AppPprShellState): string {
  const header = escapeJsonForHtmlComment(
    JSON.stringify({ prelude: state.prelude, postponed: state.postponed }),
  );
  return (
    `${header.length}:${header}` +
    (state.resumeDataCache === null ? "" : escapeJsonForHtmlComment(state.resumeDataCache))
  );
}

export function parseAppPprShellState(value: string | undefined): AppPprShellState | null {
  const match = value === undefined ? null : /^(\d+):/.exec(value);
  if (!value || !match) return null;
  const headerEnd = match[0].length + Number(match[1]);
  let header: { prelude?: unknown; postponed?: unknown };
  try {
    header = JSON.parse(value.slice(match[0].length, headerEnd)) as typeof header;
  } catch {
    return null;
  }
  return {
    prelude: header.prelude === true,
    postponed: header.postponed ?? null,
    resumeDataCache: value.length > headerEnd ? value.slice(headerEnd) : null,
  };
}

/**
 * Carry a fallback shell's state to the build after its HTML. It's complete
 * once the shell's body ends, and a header could not hold it. Only a trusted
 * fallback-shell prerender request gets the trailer, and build/prerender.ts
 * removes it before the shell is written.
 */
export function appendAppPprFallbackShellState(
  stream: ReadableStream<Uint8Array>,
  readState: () => AppPprShellState,
): ReadableStream<Uint8Array> {
  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      flush(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            PPR_SHELL_STATE_TRAILER_START +
              formatAppPprShellState(readState()) +
              PPR_SHELL_STATE_TRAILER_END,
          ),
        );
      },
    }),
  );
}

export function splitAppPprFallbackShellState(html: string): {
  html: string;
  state: string | null;
} {
  const start = html.lastIndexOf(PPR_SHELL_STATE_TRAILER_START);
  if (start === -1 || !html.endsWith(PPR_SHELL_STATE_TRAILER_END)) {
    return { html, state: null };
  }
  return {
    html: html.slice(0, start),
    state: html.slice(
      start + PPR_SHELL_STATE_TRAILER_START.length,
      html.length - PPR_SHELL_STATE_TRAILER_END.length,
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

function isSameParamValue(value: string | string[] | undefined, other: string | string[]): boolean {
  if (!Array.isArray(other)) return value === other;
  return (
    Array.isArray(value) &&
    value.length === other.length &&
    value.every((item, index) => item === other[index])
  );
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
        // A shell is keyed by its decoded pathname, where a value equal to its
        // param's placeholder would share the entry of the shell that leaves
        // the param out. A root param is never left out.
        if (
          (!rootParamNames.has(paramName) &&
            isSameParamValue(value, placeholderForParam(part, paramName))) ||
          !pushParamValue(segments, value)
        ) {
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

/**
 * The shell of a request's own path, which keeps every param, as Next.js
 * prerenders one for a path generateStaticParams produced, a route without
 * fallback params, and a path it renders blocking. Null when a value equals
 * its param's placeholder, as the path would share the entry of a fallback
 * shell leaving the param out. A root param is never left out.
 */
export function createAppPprRequestConcreteShell(
  route: AppPprFallbackShellRoute,
  requestParams: Record<string, string | string[]>,
): AppPprFallbackShell | null {
  const rootParamNames = routeRootParamNames(route);
  const segments: string[] = [];
  const params: Record<string, string | string[]> = Object.create(null);
  for (const part of route.pattern.split("/").filter(Boolean)) {
    if (!part.startsWith(":")) {
      segments.push(part);
      continue;
    }
    const isCatchAll = part.endsWith("+") || part.endsWith("*");
    const paramName = isCatchAll ? part.slice(1, -1) : part.slice(1);
    const requestValue = requestParams[paramName];
    if (requestValue === undefined || (Array.isArray(requestValue) && requestValue.length === 0)) {
      // An optional catch-all without a value leaves its segment out.
      if (part.endsWith("*")) continue;
      return null;
    }
    const value = Array.isArray(requestValue)
      ? requestValue.map(decodeParamValue)
      : decodeParamValue(requestValue);
    if (
      !rootParamNames.has(paramName) &&
      isSameParamValue(value, placeholderForParam(part, paramName))
    ) {
      return null;
    }
    pushParamValue(segments, value);
    params[paramName] = value;
  }
  return { fallbackParamNames: [], pathname: "/" + segments.join("/"), params };
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
