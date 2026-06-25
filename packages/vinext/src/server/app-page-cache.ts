import type { CachedAppPageValue, CacheControlMetadata } from "vinext/shims/cache-handler";
import {
  VINEXT_RSC_CONTENT_TYPE,
  VINEXT_RSC_VARY_HEADER,
  applyRscCompatibilityIdHeader,
} from "./app-rsc-cache-busting.js";
import { applyCdnResponseHeaders } from "./cache-control.js";
import { decideIsr } from "./isr-decision.js";
import { VINEXT_MOUNTED_SLOTS_HEADER } from "./headers.js";
import { applyEdgeRuntimeHeader } from "./app-page-response.js";
import { setCacheStateHeaders } from "./cache-headers.js";
import { buildAppPageCacheValue, type ISRCacheEntry } from "./isr-cache.js";
import { mergeMiddlewareResponseHeaders } from "./middleware-response-headers.js";
import { encodeCacheTag } from "../utils/encode-cache-tag.js";
import type { AppRscRenderMode } from "./app-rsc-render-mode.js";
import { hasCompleteNegativeRequestApiProof, type RenderObservation } from "./cache-proof.js";
import { isAppPprDynamicFallbackShellHtml } from "./app-ppr-fallback-shell.js";
export {
  finalizeAppPageHtmlCacheResponse,
  finalizeAppPageRscCacheResponse,
  scheduleAppPageRscCacheWrite,
} from "./app-page-cache-finalizer.js";

type AppPageDebugLogger = (event: string, detail: string) => void;
type AppPageCacheGetter = (key: string) => Promise<ISRCacheEntry | null>;
type AppPageCacheSetter = (
  key: string,
  data: CachedAppPageValue,
  revalidateSeconds: number,
  tags: string[],
  expireSeconds?: number,
) => Promise<void>;
type AppPageBackgroundRegenerator = (key: string, renderFn: () => Promise<void>) => void;
type AppPageRscCacheKeyBuilder = (
  pathname: string,
  mountedSlotsHeader?: string | null,
  renderMode?: AppRscRenderMode,
  interceptionContext?: string | null,
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
  htmlRenderObservation?: RenderObservation;
  linkHeader?: string;
  rscData: ArrayBuffer;
  rscRenderObservation?: RenderObservation;
  tags: string[];
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
  revalidateSeconds: number;
};

type ReadAppPageCacheResponseOptions = {
  cleanPathname: string;
  clearRequestContext: () => void;
  isEdgeRuntime?: boolean;
  isRscRequest: boolean;
  isrDebug?: AppPageDebugLogger;
  isrGet: AppPageCacheGetter;
  isrHtmlKey: (pathname: string) => string;
  isrRscKey: AppPageRscCacheKeyBuilder;
  isrSet: AppPageCacheSetter;
  interceptionContext?: string | null;
  hasRequestSearchParams?: boolean;
  middlewareHeaders?: Headers | null;
  middlewareStatus?: number | null;
  mountedSlotsHeader?: string | null;
  recordCacheOutcome?: AppPageCacheOutcomeRecorder;
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
  const tags = [pathname, `_N_T_${pathname}`, "_N_T_/layout"];
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

function buildAppPageCachedHeaders(options: {
  cacheControl: string;
  cacheState: BuildAppPageCachedResponseOptions["cacheState"];
  contentType: string;
  linkHeader?: string | string[];
  isEdgeRuntime?: boolean;
  middlewareHeaders?: Headers | null;
  mountedSlotsHeader?: string | null;
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

  if (options.linkHeader) {
    if (Array.isArray(options.linkHeader)) {
      for (const value of options.linkHeader) headers.append("Link", value);
    } else {
      headers.set("Link", options.linkHeader);
    }
  }

  if (options.mountedSlotsHeader) {
    headers.set(VINEXT_MOUNTED_SLOTS_HEADER, options.mountedSlotsHeader);
  }

  mergeMiddlewareResponseHeaders(headers, options.middlewareHeaders ?? null);
  return headers;
}

function getCachedAppPageValue(entry: ISRCacheEntry | null): CachedAppPageValue | null {
  return entry?.value.value && entry.value.value.kind === "APP_PAGE" ? entry.value.value : null;
}

function hasQueryInvariantAppPageProof(cachedValue: CachedAppPageValue): boolean {
  return (
    cachedValue.renderObservation !== undefined &&
    hasCompleteNegativeRequestApiProof(cachedValue.renderObservation, ["searchParams"])
  );
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
    });
    applyRscCompatibilityIdHeader(rscHeaders);

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
  });

  return new Response(cachedValue.html, {
    status,
    headers: htmlHeaders,
  });
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
  const isrKey = options.isRscRequest
    ? options.isrRscKey(
        options.cleanPathname,
        options.mountedSlotsHeader,
        options.renderMode,
        options.interceptionContext,
      )
    : options.isrHtmlKey(options.cleanPathname);
  const artifact = options.isRscRequest ? "rsc" : "html";

  try {
    const cached = await options.isrGet(isrKey);
    const cachedValue = getCachedAppPageValue(cached);

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
      !hasQueryInvariantAppPageProof(cachedValue)
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
      // Preserve the legacy behavior from the inline generator: stale entries
      // still trigger background regeneration even if this request cannot use
      // the stale payload and will fall through to a fresh render.
      //
      // The regeneration key is derived from exactly the same inputs as `isrKey`
      // above (the RSC variant when `isRscRequest`, the HTML key otherwise), so
      // reuse it instead of recomputing the hash.
      options.scheduleBackgroundRegeneration(isrKey, async () => {
        const revalidatedPage = await options.renderFreshPageForCache();
        const revalidateSeconds =
          revalidatedPage.cacheControl?.revalidate ?? options.revalidateSeconds;
        const expireSeconds = revalidatedPage.cacheControl?.expire ?? options.expireSeconds;
        const writes = [
          options.isrSet(
            // For an RSC request `isrKey` is already the RSC variant key, so
            // reuse it; an HTML-triggered regen still needs the RSC key here,
            // computed lazily so a deduped (skipped) regen pays nothing.
            options.isRscRequest
              ? isrKey
              : options.isrRscKey(
                  options.cleanPathname,
                  options.mountedSlotsHeader,
                  options.renderMode,
                  options.interceptionContext,
                ),
            buildAppPageCacheValue(
              "",
              revalidatedPage.rscData,
              200,
              revalidatedPage.rscRenderObservation,
            ),
            revalidateSeconds,
            revalidatedPage.tags,
            expireSeconds,
          ),
        ];

        if (!options.isRscRequest) {
          // HTML cache is slot-state-independent (canonical), so only refresh it
          // during HTML-triggered regens. RSC-triggered regens only update the
          // requesting client's RSC slot variant; a stale HTML cache entry will
          // be regenerated independently by the next full-page HTML request.
          writes.push(
            options.isrSet(
              isrKey,
              buildAppPageCacheValue(
                revalidatedPage.html,
                undefined,
                200,
                revalidatedPage.htmlRenderObservation,
                revalidatedPage.linkHeader ? { link: revalidatedPage.linkHeader } : undefined,
              ),
              revalidateSeconds,
              revalidatedPage.tags,
              expireSeconds,
            ),
          );
        }

        await Promise.all(writes);
        options.isrDebug?.("regen complete", options.cleanPathname);
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
