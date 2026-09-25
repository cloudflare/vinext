import type { CachedAppPageValue, CacheControlMetadata } from "vinext/shims/cache-handler";
import {
  VINEXT_RSC_CONTENT_TYPE,
  VINEXT_RSC_VARY_HEADER,
  applyRscCompatibilityIdHeader,
  applyRscDeploymentIdHeader,
} from "./app-rsc-cache-busting.js";
import { applyCdnResponseHeaders } from "./cache-control.js";
import { decideIsr } from "./isr-decision.js";
import {
  VINEXT_MOUNTED_SLOTS_HEADER,
  VINEXT_PARAMS_HEADER,
  VINEXT_RENDERED_PATH_AND_SEARCH_HEADER,
} from "./headers.js";
import { applyClientStaleTimeHeader, applyEdgeRuntimeHeader } from "./app-page-response.js";
import { resolveClientStaleTimeSeconds } from "../utils/cache-control-metadata.js";
import { setCacheStateHeaders } from "./cache-headers.js";
import {
  buildAppPageCacheValue,
  isrCacheControl,
  resolveRouteExpireSeconds,
  type AppPageCacheSetter,
  type ISRCacheEntry,
} from "./isr-cache.js";
import { mergeMiddlewareResponseHeaders } from "./middleware-response-headers.js";
import { encodeCacheTag } from "../utils/encode-cache-tag.js";
import type { AppRscRenderMode } from "./app-rsc-render-mode.js";
import { hasQueryInvariantRenderProof, type RenderObservation } from "./cache-proof.js";
import { isAppPprDynamicFallbackShellHtml } from "./app-ppr-fallback-shell.js";
import { buildPageCacheTags } from "./implicit-tags.js";
import { markFrameworkLinkHeaders } from "./app-response-header-provenance.js";
export {
  finalizeAppPageHtmlCacheResponse,
  finalizeAppPageRscCacheResponse,
  scheduleAppPageRscCacheWrite,
} from "./app-page-cache-finalizer.js";

type AppPageDebugLogger = (event: string, detail: string) => void;
type AppPageCacheGetter = (key: string) => Promise<ISRCacheEntry | null>;
type AppPageBackgroundRegenerator = (key: string, renderFn: () => Promise<void>) => void;
type AppPageRscCacheKeyBuilder = (
  pathname: string,
  mountedSlotsHeader?: string | null,
  renderMode?: AppRscRenderMode,
  interceptionContext?: string | null,
  interceptionId?: string | null,
) => string;
export type AppPageCacheOutcomeMetric = Readonly<{
  artifact: "html" | "rsc";
  /**
   * Internal cache lookup key for debugging and tests. Runtime telemetry sinks should hash or
   * redact this value before export to avoid high-cardinality or user-derived labels.
   */
  cacheKey: string;
  outcome: "hit" | "miss" | "stale";
  reason:
    | "empty-entry"
    | "expired"
    | "no-entry"
    | "non-app-page-entry"
    | "query-variant-unproven"
    | "read-error"
    | "served"
    | "stale-empty-entry";
}>;
type AppPageCacheOutcomeRecorder = (metric: AppPageCacheOutcomeMetric) => void;

type AppPageCacheRenderResult = {
  cacheControl?: CacheControlMetadata;
  html: string;
  htmlRenderObservation: RenderObservation;
  linkHeader?: string;
  rscData: ArrayBuffer;
  rscRenderObservation: RenderObservation;
  /**
   * The route-level revalidate of the route this render regenerated, or null
   * when it has none and the render's cacheLife sets it. Undefined keeps the
   * matched route's read seed, as when the render regenerated that route.
   */
  revalidateSeconds?: number | null;
  tags: string[];
  usedDynamicApi: boolean;
};

type BuildAppPageCachedResponseOptions = {
  cacheControl?: CacheControlMetadata;
  cacheState: "HIT" | "STALE";
  expireSeconds?: number;
  isEdgeRuntime?: boolean;
  isRscRequest: boolean;
  middlewareHeaders?: Headers | null;
  middlewareStatus?: number | null;
  mountedSlotsHeader?: string | null;
  /** The current request's route params, which the client reads on RSC responses. */
  params?: Record<string, string | string[]>;
  /** The current request's path and query, which the client reads on RSC responses. */
  renderedPathAndSearch?: string | null;
  revalidateSeconds: number;
};

type ReadAppPageCacheResponseOptions = {
  cleanPathname: string;
  clearRequestContext: () => void;
  isEdgeRuntime?: boolean;
  isRoutePPREnabled?: boolean;
  isRscRequest: boolean;
  isrDebug?: AppPageDebugLogger;
  isrGet: AppPageCacheGetter;
  isrHtmlKey: (pathname: string) => string;
  isrRscKey: AppPageRscCacheKeyBuilder;
  isrSet: AppPageCacheSetter;
  interceptionContext?: string | null;
  interceptionId?: string | null;
  hasRequestSearchParams?: boolean;
  middlewareHeaders?: Headers | null;
  middlewareStatus?: number | null;
  mountedSlotsHeader?: string | null;
  params?: Record<string, string | string[]>;
  recordCacheOutcome?: AppPageCacheOutcomeRecorder;
  renderedPathAndSearch?: string | null;
  renderMode?: AppRscRenderMode;
  expireSeconds?: number;
  revalidateSeconds: number;
  renderFreshPageForCache: () => Promise<AppPageCacheRenderResult>;
  scheduleBackgroundRegeneration: AppPageBackgroundRegenerator;
};

type ReadAppPageFallbackShellCacheResponseOptions = {
  clearRequestContext: () => void;
  expireSeconds?: number;
  fallbackPathname: string;
  isEdgeRuntime?: boolean;
  isrDebug?: AppPageDebugLogger;
  isrGet: AppPageCacheGetter;
  isrHtmlKey: (pathname: string) => string;
  middlewareHeaders?: Headers | null;
  middlewareStatus?: number | null;
  revalidateSeconds: number;
  rewriteHtml: (html: string) => string;
};

function recordAppPageCacheOutcome(
  recordCacheOutcome: AppPageCacheOutcomeRecorder | undefined,
  input: AppPageCacheOutcomeMetric,
): void {
  try {
    recordCacheOutcome?.(input);
  } catch {
    // Metrics are observational only; telemetry failures must not alter cache serving behavior.
  }
}

export function buildAppPageCacheTags(pathname: string, extraTags: readonly string[]): string[] {
  // Strip trailing slash for the _N_T_ tag so it matches revalidatePath(),
  // which also strips trailing slash before building the tag.
  const stem = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  const tags = [pathname, `_N_T_${stem}`, "_N_T_/layout"];
  const segments = pathname.split("/");
  let built = "";
  for (let index = 1; index < segments.length; index++) {
    const segment = segments[index];
    if (segment) {
      built += `/${segment}`;
      tags.push(`_N_T_${built}/layout`);
    }
  }

  tags.push(`_N_T_${built}/page`);
  for (const tag of extraTags) {
    if (!tags.includes(tag)) {
      tags.push(tag);
    }
  }
  // Canonicalise to ASCII-safe form so path-derived tags from non-ASCII
  // pathnames match what `revalidatePath`/`revalidateTag` produce after
  // their own encoding pass.
  return tags.map(encodeCacheTag);
}

export function buildAppRouteCacheTags(
  pathname: string,
  extraTags: readonly string[],
  routeSegments: readonly string[],
): string[] {
  return buildPageCacheTags(pathname, [...extraTags], [...routeSegments], "route");
}

function buildAppPageCachedHeaders(options: {
  cacheControl: string;
  cacheState: BuildAppPageCachedResponseOptions["cacheState"];
  contentType: string;
  linkHeader?: string | string[];
  isEdgeRuntime?: boolean;
  middlewareHeaders?: Headers | null;
  mountedSlotsHeader?: string | null;
  staleTimeSeconds?: number;
}): Headers {
  const headers = new Headers({
    "Content-Type": options.contentType,
    Vary: VINEXT_RSC_VARY_HEADER,
  });
  // Page artifacts served from the origin store get their cache headers from the
  // CDN adapter (default: a single Cache-Control identical to the prior behavior).
  applyCdnResponseHeaders(headers, { cacheControl: options.cacheControl });
  setCacheStateHeaders(headers, options.cacheState);
  applyEdgeRuntimeHeader(headers, options.isEdgeRuntime);

  if (options.mountedSlotsHeader) {
    headers.set(VINEXT_MOUNTED_SLOTS_HEADER, options.mountedSlotsHeader);
  }

  applyClientStaleTimeHeader(headers, options.staleTimeSeconds);

  mergeMiddlewareResponseHeaders(headers, options.middlewareHeaders ?? null);
  if (options.linkHeader) {
    if (Array.isArray(options.linkHeader)) {
      for (const value of options.linkHeader) headers.append("Link", value);
    } else {
      headers.append("Link", options.linkHeader);
    }
  }
  return headers;
}

function getCachedAppPageValue(entry: ISRCacheEntry | null): CachedAppPageValue | null {
  return entry?.value.value && entry.value.value.kind === "APP_PAGE" ? entry.value.value : null;
}

function resolveRegeneratedAppPageCacheControl(options: {
  expireSeconds?: number;
  renderCacheControl?: CacheControlMetadata;
  routeRevalidateSeconds: number | null;
}): CacheControlMetadata {
  const renderRevalidateSeconds = options.renderCacheControl?.revalidate;
  // The render's cacheLife lowers the route's revalidate, down to a
  // `revalidate = 0` route's zero, and sets it for a route without one. An
  // indefinite nested cache lifetime does not tighten the route's own finite
  // revalidation policy.
  let revalidateSeconds: number;
  if (typeof renderRevalidateSeconds === "number") {
    revalidateSeconds =
      options.routeRevalidateSeconds === null
        ? renderRevalidateSeconds
        : Math.min(options.routeRevalidateSeconds, renderRevalidateSeconds);
  } else {
    revalidateSeconds = options.routeRevalidateSeconds ?? 0;
  }

  return isrCacheControl(revalidateSeconds, {
    expireSeconds:
      options.renderCacheControl?.expire ??
      resolveRouteExpireSeconds(revalidateSeconds, options.expireSeconds),
    // Carry the regenerating render's own claim onto the refreshed entry, so a
    // background regen does not quietly drop it and widen client reuse.
    staleSeconds: resolveClientStaleTimeSeconds(options.renderCacheControl),
  });
}

/**
 * When a regeneration fails, Next.js re-stores the previous entry with a short
 * revalidate so it isn't retried on every request
 * (`server/response-cache/index.ts`). `revalidate = false`, which vinext holds
 * as Infinity, retries after 3 s like Next.js's `revalidate || 3`.
 */
function resolveRegenerationFailureCacheControl(
  previous: CacheControlMetadata,
): CacheControlMetadata {
  const previousRevalidate =
    typeof previous.revalidate === "number" && Number.isFinite(previous.revalidate)
      ? previous.revalidate
      : 0;
  const revalidate = Math.min(Math.max(previousRevalidate || 3, 3), 30);
  return {
    revalidate,
    ...(previous.expire === undefined ? {} : { expire: Math.max(revalidate + 3, previous.expire) }),
    // The client reuse bound belongs to the stored payload, which is unchanged.
    ...(previous.stale === undefined ? {} : { stale: previous.stale }),
  };
}

export function buildAppPageCachedResponse(
  cachedValue: CachedAppPageValue,
  options: BuildAppPageCachedResponseOptions,
): Response | null {
  // Preserve the legacy fallback semantics from the generated entry: invalid
  // falsy statuses still fall back to 200 rather than being forwarded through.
  const status = options.middlewareStatus ?? (cachedValue.status || 200);
  const { cacheControl } = decideIsr({
    cacheState: options.cacheState,
    kind: "app-page",
    revalidateSeconds: options.revalidateSeconds,
    expireSeconds: options.expireSeconds,
    cacheControlMeta: options.cacheControl,
  });
  // Replay the producing render's claim verbatim, not aged — Next.js re-emits
  // the stored header unchanged on every hit, and the cached HTML body embeds
  // the same original value in its done-script.
  const staleTimeSeconds = resolveClientStaleTimeSeconds(options.cacheControl);
  if (options.isRscRequest) {
    if (!cachedValue.rscData) {
      return null;
    }

    const rscHeaders = buildAppPageCachedHeaders({
      cacheControl,
      cacheState: options.cacheState,
      contentType: VINEXT_RSC_CONTENT_TYPE,
      isEdgeRuntime: options.isEdgeRuntime,
      middlewareHeaders: options.middlewareHeaders,
      mountedSlotsHeader: options.mountedSlotsHeader,
      staleTimeSeconds,
    });
    // These describe the current request, not the shared RSC bytes, so a hit
    // composes them as a fresh render does.
    if (options.params && Object.keys(options.params).length > 0) {
      rscHeaders.set(VINEXT_PARAMS_HEADER, encodeURIComponent(JSON.stringify(options.params)));
    }
    if (options.renderedPathAndSearch) {
      rscHeaders.set(
        VINEXT_RENDERED_PATH_AND_SEARCH_HEADER,
        encodeURIComponent(options.renderedPathAndSearch),
      );
    }
    applyRscCompatibilityIdHeader(rscHeaders);
    applyRscDeploymentIdHeader(rscHeaders);

    return new Response(cachedValue.rscData, {
      status,
      headers: rscHeaders,
    });
  }

  if (typeof cachedValue.html !== "string" || cachedValue.html.length === 0) {
    return null;
  }

  const htmlHeaders = buildAppPageCachedHeaders({
    cacheControl,
    cacheState: options.cacheState,
    contentType: "text/html; charset=utf-8",
    isEdgeRuntime: options.isEdgeRuntime,
    linkHeader: cachedValue.headers?.link,
    middlewareHeaders: options.middlewareHeaders,
    staleTimeSeconds,
  });

  const response = new Response(cachedValue.html, {
    status,
    headers: htmlHeaders,
  });
  markFrameworkLinkHeaders(response.headers, cachedValue.headers?.link);
  return response;
}

type ServeAppPageCachedHtmlOptions = {
  cached: ISRCacheEntry | null;
  cachedValue: CachedAppPageValue;
  clearRequestContext: () => void;
  emptyDebugMessage: string;
  expireSeconds?: number;
  isEdgeRuntime?: boolean;
  isrDebug?: AppPageDebugLogger;
  middlewareHeaders?: Headers | null;
  middlewareStatus?: number | null;
  pathname: string;
  revalidateSeconds: number;
  scheduleRegeneration: () => void;
  stateDebugLabel: string;
};

async function serveAppPageCachedHtml(
  options: ServeAppPageCachedHtmlOptions,
  transformValue?: (value: CachedAppPageValue) => CachedAppPageValue,
): Promise<Response | null> {
  if (options.cached?.isExpired) {
    options.isrDebug?.("MISS (expired)", options.pathname);
    return null;
  }

  if (typeof options.cachedValue.html !== "string" || options.cachedValue.html.length === 0) {
    if (options.cached?.isStale) {
      options.scheduleRegeneration();
    }
    options.isrDebug?.(options.emptyDebugMessage, options.pathname);
    return null;
  }

  const cacheState = options.cached?.isStale ? "STALE" : "HIT";
  if (options.cached?.isStale) {
    options.scheduleRegeneration();
  }

  const responseValue = transformValue ? transformValue(options.cachedValue) : options.cachedValue;
  const response = buildAppPageCachedResponse(responseValue, {
    cacheState,
    cacheControl: options.cached?.value.cacheControl,
    expireSeconds: options.expireSeconds,
    isEdgeRuntime: options.isEdgeRuntime,
    isRscRequest: false,
    middlewareHeaders: options.middlewareHeaders,
    middlewareStatus: options.middlewareStatus,
    revalidateSeconds: options.revalidateSeconds,
  });

  if (!response) return null;

  options.isrDebug?.(`${cacheState} (${options.stateDebugLabel})`, options.pathname);
  options.clearRequestContext();
  return response;
}

export async function readAppPageCacheResponse(
  options: ReadAppPageCacheResponseOptions,
): Promise<Response | null> {
  if (options.isRscRequest && options.mountedSlotsHeader) {
    options.isrDebug?.("MISS (mounted slots RSC variant)", options.cleanPathname);
    return null;
  }

  const isrKey = options.isRscRequest
    ? options.isrRscKey(
        options.cleanPathname,
        null,
        options.renderMode,
        options.interceptionContext,
        options.interceptionId,
      )
    : options.isrHtmlKey(options.cleanPathname);
  const artifact = options.isRscRequest ? "rsc" : "html";

  try {
    const cached = await options.isrGet(isrKey);
    const cachedValue = getCachedAppPageValue(cached);

    if (cached?.isExpired) {
      recordAppPageCacheOutcome(options.recordCacheOutcome, {
        artifact,
        cacheKey: isrKey,
        outcome: "miss",
        reason: "expired",
      });
      options.isrDebug?.("MISS (expired)", options.cleanPathname);
      return null;
    }

    if (cached && !cachedValue) {
      recordAppPageCacheOutcome(options.recordCacheOutcome, {
        artifact,
        cacheKey: isrKey,
        outcome: "miss",
        reason: "non-app-page-entry",
      });
      options.isrDebug?.("MISS (non app-page cache entry)", options.cleanPathname);
      return null;
    }

    if (
      cachedValue &&
      options.hasRequestSearchParams === true &&
      !hasQueryInvariantRenderProof(cachedValue.renderObservation)
    ) {
      recordAppPageCacheOutcome(options.recordCacheOutcome, {
        artifact,
        cacheKey: isrKey,
        outcome: "miss",
        reason: "query-variant-unproven",
      });
      options.isrDebug?.("MISS (query-bearing request lacks cache proof)", options.cleanPathname);
      return null;
    }

    if (cachedValue && !cached?.isStale) {
      const hitResponse = buildAppPageCachedResponse(cachedValue, {
        cacheState: "HIT",
        cacheControl: cached?.value.cacheControl,
        expireSeconds: options.expireSeconds,
        isEdgeRuntime: options.isEdgeRuntime,
        isRscRequest: options.isRscRequest,
        middlewareHeaders: options.middlewareHeaders,
        middlewareStatus: options.middlewareStatus,
        mountedSlotsHeader: options.mountedSlotsHeader,
        params: options.params,
        renderedPathAndSearch: options.renderedPathAndSearch,
        revalidateSeconds: options.revalidateSeconds,
      });

      if (hitResponse) {
        recordAppPageCacheOutcome(options.recordCacheOutcome, {
          artifact,
          cacheKey: isrKey,
          outcome: "hit",
          reason: "served",
        });
        options.isrDebug?.(
          options.isRscRequest ? "HIT (RSC)" : "HIT (HTML)",
          options.cleanPathname,
        );
        options.clearRequestContext();
        return hitResponse;
      }

      recordAppPageCacheOutcome(options.recordCacheOutcome, {
        artifact,
        cacheKey: isrKey,
        outcome: "miss",
        reason: "empty-entry",
      });
      options.isrDebug?.("MISS (empty cached entry)", options.cleanPathname);
    }

    if (cached?.isStale && cachedValue) {
      // Re-store a key's previous entry with a backoff policy after a failed
      // render, as Next.js does. Another regeneration can write the key too (an
      // HTML one also writes the RSC key), so a newer entry is left alone. A
      // missing one is restored, as Next.js restores unconditionally.
      const keepPreviousEntry = async (key: string, previous: ISRCacheEntry): Promise<void> => {
        const previousValue = getCachedAppPageValue(previous);
        const previousCacheControl = previous.value.cacheControl;
        // Its tags come from its render observation; an entry without one can't
        // be re-stored with the tags it was written with, so it is left alone.
        // An expired one must not be served, so re-storing would revive it.
        const previousTags = previousValue?.renderObservation?.cacheTags;
        if (!previousValue || !previousCacheControl || !previousTags || previous.isExpired) return;
        try {
          const current = await options.isrGet(key);
          if (!current || current.value.lastModified === previous.value.lastModified) {
            await options.isrSet(key, previousValue, {
              cacheControl: resolveRegenerationFailureCacheControl(previousCacheControl),
              tags: [...previousTags],
            });
          }
        } catch (storeError) {
          // Report the regeneration's own failure, not the store's.
          console.error(`[vinext] Failed to keep the previous entry for ${key}:`, storeError);
        }
      };

      // Preserve the legacy behavior from the inline generator: stale entries
      // still trigger background regeneration even if this request cannot use
      // the stale payload and will fall through to a fresh render.
      //
      // The regeneration key is derived from exactly the same inputs as `isrKey`
      // above (the RSC variant when `isRscRequest`, the HTML key otherwise), so
      // reuse it instead of recomputing the hash.
      const regenerate = async (): Promise<void> => {
        const revalidatedPage = await options.renderFreshPageForCache();
        const cacheControl = resolveRegeneratedAppPageCacheControl({
          expireSeconds: options.expireSeconds,
          renderCacheControl: revalidatedPage.cacheControl,
          // The route's read seed is 0 only when it has no route-level
          // revalidate, since a `revalidate = 0` route is never read from the
          // cache.
          routeRevalidateSeconds:
            revalidatedPage.revalidateSeconds === undefined
              ? options.revalidateSeconds || null
              : revalidatedPage.revalidateSeconds,
        });
        // Like Next.js, a regeneration whose render turned dynamic fails
        // without PPR, whose shell expects it: a dynamic API use, or an
        // effective revalidate of 0 from its fetches or its cacheLife.
        // https://github.com/vercel/next.js/blob/v16.2.7/packages/next/src/build/templates/app-page.ts
        if (
          options.isRoutePPREnabled !== true &&
          (revalidatedPage.usedDynamicApi || cacheControl.revalidate === 0)
        ) {
          throw new Error(
            `Page changed from static to dynamic at runtime ${options.cleanPathname}` +
              "\nsee more here https://nextjs.org/docs/messages/app-static-to-dynamic-error",
          );
        }
        // Every query shares these entries, so a render not proven to leave
        // the query unread is never stored.
        if (
          !hasQueryInvariantRenderProof(revalidatedPage.rscRenderObservation) ||
          (!options.isRscRequest &&
            !hasQueryInvariantRenderProof(revalidatedPage.htmlRenderObservation))
        ) {
          options.isrDebug?.("regen write skipped (searchParams not proven unread)", isrKey);
          return;
        }
        // For an RSC request `isrKey` is already the RSC variant key, so
        // reuse it; an HTML-triggered regen still needs the RSC key here,
        // computed lazily so a deduped (skipped) regen pays nothing.
        const rscKey = options.isRscRequest
          ? isrKey
          : options.isrRscKey(
              options.cleanPathname,
              null,
              options.renderMode,
              options.interceptionContext,
              options.interceptionId,
            );
        // Next.js's IncrementalCache.set only warns when its cache handler
        // fails, so a failed store is not a failed regeneration: it neither
        // throws nor re-stores the previous entry with a backoff policy.
        const store = async (key: string, value: CachedAppPageValue): Promise<boolean> => {
          try {
            await options.isrSet(key, value, { cacheControl, tags: revalidatedPage.tags });
            return true;
          } catch (storeError) {
            console.warn(`[vinext] Failed to update prerender cache for ${key}:`, storeError);
            return false;
          }
        };
        const storedRsc = await store(
          rscKey,
          buildAppPageCacheValue(
            "",
            revalidatedPage.rscData,
            200,
            revalidatedPage.rscRenderObservation,
          ),
        );
        // A failed RSC write leaves the previous page untouched, so the HTML
        // key isn't written either.
        if (!storedRsc) return;

        if (!options.isRscRequest) {
          // HTML cache is slot-state-independent (canonical), so only refresh it
          // during HTML-triggered regens. RSC-triggered regens only update the
          // requesting client's RSC slot variant; a stale HTML cache entry will
          // be regenerated independently by the next full-page HTML request.
          const storedHtml = await store(
            isrKey,
            buildAppPageCacheValue(
              revalidatedPage.html,
              undefined,
              200,
              revalidatedPage.htmlRenderObservation,
              revalidatedPage.linkHeader ? { link: revalidatedPage.linkHeader } : undefined,
            ),
          );
          // A failed HTML write leaves this regeneration's RSC beside the
          // stale HTML: the state an RSC-triggered regeneration leaves anyway,
          // and the stale HTML regenerates on its next request.
          if (!storedHtml) return;
        }
        options.isrDebug?.("regen complete", options.cleanPathname);
      };
      // As in Next.js, a failed render keeps the previous entry, re-stored
      // with a backoff policy.
      options.scheduleBackgroundRegeneration(isrKey, async () => {
        try {
          await regenerate();
        } catch (error) {
          // Keep the previous entry under this key only: an RSC-triggered
          // regeneration must not write its payload under the HTML key.
          await keepPreviousEntry(isrKey, cached);
          throw error;
        }
      });

      const staleResponse = buildAppPageCachedResponse(cachedValue, {
        cacheState: "STALE",
        cacheControl: cached.value.cacheControl,
        expireSeconds: options.expireSeconds,
        isEdgeRuntime: options.isEdgeRuntime,
        isRscRequest: options.isRscRequest,
        middlewareHeaders: options.middlewareHeaders,
        middlewareStatus: options.middlewareStatus,
        mountedSlotsHeader: options.mountedSlotsHeader,
        params: options.params,
        renderedPathAndSearch: options.renderedPathAndSearch,
        revalidateSeconds: options.revalidateSeconds,
      });

      if (staleResponse) {
        recordAppPageCacheOutcome(options.recordCacheOutcome, {
          artifact,
          cacheKey: isrKey,
          outcome: "stale",
          reason: "served",
        });
        options.isrDebug?.(
          options.isRscRequest ? "STALE (RSC)" : "STALE (HTML)",
          options.cleanPathname,
        );
        options.clearRequestContext();
        return staleResponse;
      }

      recordAppPageCacheOutcome(options.recordCacheOutcome, {
        artifact,
        cacheKey: isrKey,
        outcome: "miss",
        reason: "stale-empty-entry",
      });
      options.isrDebug?.("STALE MISS (empty stale entry)", options.cleanPathname);
    }

    if (!cached) {
      recordAppPageCacheOutcome(options.recordCacheOutcome, {
        artifact,
        cacheKey: isrKey,
        outcome: "miss",
        reason: "no-entry",
      });
      options.isrDebug?.("MISS (no cache entry)", options.cleanPathname);
    }
  } catch (isrReadError) {
    recordAppPageCacheOutcome(options.recordCacheOutcome, {
      artifact,
      cacheKey: isrKey,
      outcome: "miss",
      reason: "read-error",
    });
    console.error("[vinext] ISR cache read error:", isrReadError);
  }

  return null;
}

export async function readAppPageFallbackShellCacheResponse(
  options: ReadAppPageFallbackShellCacheResponseOptions,
): Promise<Response | null> {
  const isrKey = options.isrHtmlKey(options.fallbackPathname);

  try {
    const cached = await options.isrGet(isrKey);
    const cachedValue = getCachedAppPageValue(cached);
    if (!cachedValue) {
      options.isrDebug?.("MISS (fallback shell)", options.fallbackPathname);
      return null;
    }
    if (isAppPprDynamicFallbackShellHtml(cachedValue.html)) {
      options.isrDebug?.("MISS (dynamic fallback shell requires resume)", options.fallbackPathname);
      return null;
    }

    return await serveAppPageCachedHtml(
      {
        cached,
        cachedValue,
        clearRequestContext: options.clearRequestContext,
        emptyDebugMessage: "MISS (empty fallback shell)",
        expireSeconds: options.expireSeconds,
        isEdgeRuntime: options.isEdgeRuntime,
        isrDebug: options.isrDebug,
        middlewareHeaders: options.middlewareHeaders,
        middlewareStatus: options.middlewareStatus,
        pathname: options.fallbackPathname,
        revalidateSeconds: options.revalidateSeconds,
        scheduleRegeneration() {},
        stateDebugLabel: "fallback shell",
      },
      (value) => ({ ...value, html: options.rewriteHtml(value.html) }),
    );
  } catch (isrReadError) {
    options.isrDebug?.("MISS (fallback shell read error)", options.fallbackPathname);
    console.error("[vinext] ISR fallback shell cache read error:", isrReadError);
    return null;
  }
}
