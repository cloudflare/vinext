import type { CachedAppPageValue } from "vinext/shims/cache-handler";
import { getRequestExecutionContext } from "vinext/shims/request-context";
import { resolveClientStaleTimeSeconds } from "../utils/cache-control-metadata.js";
import { buildAppPageCacheTags, resolveStaticStaleTimeSeconds } from "./app-page-cache.js";
import {
  hasSearchParams,
  renderAppPageStaticShell,
  type AppPageDispatchRoute,
  type DispatchAppPageOptions,
} from "./app-page-dispatch.js";
import { NO_STORE_CACHE_CONTROL } from "./cache-control.js";
import { VINEXT_STATIC_SHELL_HEADER } from "./app-rsc-render-mode.js";
import { NEXT_ROUTER_STALE_TIME_HEADER } from "./headers.js";
import { mergeMiddlewareResponseHeaders } from "./middleware-response-headers.js";
import { isUnknownRecord } from "../utils/record.js";
import {
  appIsrStaticShellRscKey,
  coalesceFallbackShellProduction,
  isrCacheControl,
  type ISRCacheEntry,
} from "./isr-cache.js";
import {
  readPrerenderCacheLifeHeader,
  readPrerenderCacheTagsHeader,
  resolveRenderedCacheControl,
} from "./prerender-cache-life-header.js";

/** Next.js's default `expireTime`. */
const DEFAULT_EXPIRE_SECONDS = 31_536_000;

/** Headers a stored shell doesn't replay: they belong to the render's own response. */
const UNREPLAYED_HEADERS = new Set([
  "cache-control",
  "content-length",
  "content-encoding",
  "date",
  "set-cookie",
  "transfer-encoding",
]);

function hasRuntimePrefetchConfig(module: unknown): boolean {
  if (!isUnknownRecord(module)) return false;
  const instant = module.unstable_instant;
  return isUnknownRecord(instant) && instant.prefetch === "runtime";
}

/**
 * Whether the page opts into a runtime prefetch through a segment's
 * `unstable_instant`, which Next.js renders with the request's cookies and
 * params instead of serving the static shell.
 */
export function prefetchesAtRuntime(route: AppPageDispatchRoute & { page?: unknown }): boolean {
  return route.layouts.some(hasRuntimePrefetchConfig) || hasRuntimePrefetchConfig(route.page);
}

/** Mark a runtime prefetch's response, which a navigation reuses like its own. */
export function markRuntimePrefetchResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set(VINEXT_STATIC_SHELL_HEADER, "runtime");
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

/**
 * Whether a prefetch can get a Cache Components page's static shell. Like
 * Next.js, only a production page's own payload has one: draft mode, an
 * interception or a search string make it the page's.
 */
function canServeStaticShell<TRoute extends AppPageDispatchRoute>(
  options: DispatchAppPageOptions<TRoute>,
  isDraftMode: boolean,
): boolean {
  return (
    options.isProduction &&
    options.pprRuntime !== undefined &&
    options.pprFallbackShell === undefined &&
    options.request.method === "GET" &&
    !isDraftMode &&
    options.interceptionContext === null &&
    !hasSearchParams(options.searchParams) &&
    options.dynamicConfig !== "force-dynamic"
  );
}

/**
 * Serve a shell to one request. The shell is shared, so the request's own
 * middleware headers and status merge over it, as they do over a cached page.
 */
function buildStaticShellResponse(
  value: CachedAppPageValue,
  middlewareContext: DispatchAppPageOptions<AppPageDispatchRoute>["middlewareContext"],
): Response {
  const headers = new Headers();
  for (const [name, headerValue] of Object.entries(value.headers ?? {})) {
    for (const item of Array.isArray(headerValue) ? headerValue : [headerValue]) {
      headers.append(name, item);
    }
  }
  // Each client keeps the shell for its own stale time, read from its headers.
  headers.set("Cache-Control", NO_STORE_CACHE_CONTROL);
  mergeMiddlewareResponseHeaders(headers, middlewareContext.headers);
  return new Response(value.rscData ?? null, {
    headers,
    status: middlewareContext.status ?? value.status ?? 200,
  });
}

/**
 * Render a page's static shell and, with a key, store it, as the build would
 * have. Returns the shell, or null when the page has none: its render failed,
 * redirected or bailed out of the prerender.
 */
async function produceStaticShell<TRoute extends AppPageDispatchRoute>(
  options: DispatchAppPageOptions<TRoute>,
  key: string | null,
): Promise<CachedAppPageValue | null> {
  const { isPartial, response } = await renderAppPageStaticShell(options);
  const cacheControlHeader = response.headers.get("cache-control") ?? "";
  const rscData = await response.arrayBuffer();
  if (response.status !== 200 || rscData.byteLength === 0) {
    options.isrDebug?.("SKIP (static shell render)", options.cleanPathname);
    return null;
  }

  // The lifetime and tags the build records for a prerendered page.
  const requestCacheLife = readPrerenderCacheLifeHeader(response.headers);
  const staleSeconds = resolveClientStaleTimeSeconds(requestCacheLife);

  const headers: Record<string, string> = {};
  for (const [name, headerValue] of response.headers) {
    if (!UNREPLAYED_HEADERS.has(name)) headers[name] = headerValue;
  }
  headers[VINEXT_STATIC_SHELL_HEADER.toLowerCase()] = isPartial ? "partial" : "complete";
  // A client keeps the shell for its cacheLife's stale time, as Next.js keeps
  // a prefetched segment. A shell with no cacheLife claim gets
  // `staleTimes.static`, as Next.js's `createSelectStaleTime` selects.
  const clientStaleSeconds = staleSeconds ?? resolveStaticStaleTimeSeconds();
  if (clientStaleSeconds !== undefined) {
    headers[NEXT_ROUTER_STALE_TIME_HEADER.toLowerCase()] = String(Math.floor(clientStaleSeconds));
  }
  const value: CachedAppPageValue = {
    kind: "APP_PAGE",
    html: "",
    rscData,
    headers,
    postponed: undefined,
    status: undefined,
  };
  if (key === null) return value;

  const renderedCacheControl = resolveRenderedCacheControl(
    requestCacheLife ?? {},
    cacheControlHeader,
    options.expireSeconds ?? DEFAULT_EXPIRE_SECONDS,
  );
  const revalidate = renderedCacheControl.revalidate ?? false;
  const cacheControl = isrCacheControl(revalidate, {
    expireSeconds: typeof revalidate === "number" ? renderedCacheControl.expire : undefined,
    staleSeconds,
  });
  const tags = buildAppPageCacheTags(
    options.cachePathname ?? options.cleanPathname,
    readPrerenderCacheTagsHeader(response.headers),
  );

  if (options.isrSetFallbackShell) {
    const write = options.isrSetFallbackShell(key, value, { cacheControl, tags }).catch((error) => {
      console.error("[vinext] ISR static shell cache write error:", error);
    });
    getRequestExecutionContext()?.waitUntil(write);
    // Requests sharing this production find the shell stored once it settles.
    await write;
  }
  options.isrDebug?.("STORE (static shell)", options.cleanPathname);
  return value;
}

/**
 * Answer a Cache Components page's static-shell prefetch, as Next.js serves a
 * prefetch the page's prerendered payload. A page without a stored shell
 * renders it first, blocking, as a build without the page would; a stale one is
 * served while it regenerates. Returns null when the prefetch can't have one.
 */
export async function serveAppPageStaticShellPrefetch<TRoute extends AppPageDispatchRoute>(
  options: DispatchAppPageOptions<TRoute>,
  isDraftMode: boolean,
): Promise<Response | null> {
  if (!canServeStaticShell(options, isDraftMode)) return null;
  if (options.mountedSlotsHeader) {
    // The client keeps the default-only slots it has mounted, so the shell
    // leaves them out. Like the page's other mounted-slot payloads, that
    // variant is rendered for the request, not stored.
    let value: CachedAppPageValue | null;
    try {
      value = await produceStaticShell(options, null);
    } catch (renderError) {
      console.error("[vinext] ISR static shell render error:", renderError);
      return null;
    }
    return value ? buildStaticShellResponse(value, options.middlewareContext) : null;
  }
  const key = appIsrStaticShellRscKey(options.cachePathname ?? options.cleanPathname);
  const produce = () => produceStaticShell(options, key);

  let cached: ISRCacheEntry | null;
  try {
    cached = await (options.isrGetFallbackShell ?? options.isrGet)(key);
  } catch (isrReadError) {
    options.isrDebug?.("MISS (static shell read error)", options.cleanPathname);
    console.error("[vinext] ISR static shell cache read error:", isrReadError);
    return null;
  }

  const cachedValue = cached?.value.value;
  if (cached !== null && cached.isExpired !== true && cachedValue?.kind === "APP_PAGE") {
    if (cached.isStale) {
      (options.scheduleFallbackShellRegeneration ?? options.scheduleBackgroundRegeneration)(
        key,
        async () => {
          await coalesceFallbackShellProduction(key, produce);
        },
        { routerKind: "App Router", routePath: options.route.pattern, routeType: "render" },
      );
    }
    options.isrDebug?.(cached.isStale ? "STALE (static shell)" : "HIT (static shell)", key);
    return buildStaticShellResponse(cachedValue, options.middlewareContext);
  }

  options.isrDebug?.("RENDER (static shell)", options.cleanPathname);
  let value: CachedAppPageValue | null;
  try {
    value = await coalesceFallbackShellProduction(key, produce);
  } catch (renderError) {
    options.isrDebug?.("MISS (static shell render error)", options.cleanPathname);
    console.error("[vinext] ISR static shell render error:", renderError);
    return null;
  }
  return value ? buildStaticShellResponse(value, options.middlewareContext) : null;
}
