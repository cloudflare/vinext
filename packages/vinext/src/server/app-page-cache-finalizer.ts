import type { AppRscRenderMode } from "./app-rsc-render-mode.js";
import {
  applyCdnResponseHeaders,
  buildRevalidateCacheControl,
  hasExplicitNonCacheableResponsePolicy,
  NO_STORE_CACHE_CONTROL,
  STATIC_CACHE_CONTROL,
} from "./cache-control.js";
import { setCacheStateHeaders } from "./cache-headers.js";
import { NEXTJS_CACHE_HEADER, VINEXT_CACHE_HEADER } from "./headers.js";
import {
  createEmptyAppPageRenderObservationState,
  type AppPageRenderObservationState,
} from "./app-page-render-observation.js";
import { buildAppPageCacheValue, isrCacheControl, type AppPageCacheSetter } from "./isr-cache.js";
import type { CacheControlMetadata } from "vinext/shims/cache-handler";
import type { RenderObservation } from "./cache-proof.js";
import { resolveClientStaleTimeSeconds } from "../utils/cache-control-metadata.js";
import { readStreamAsText } from "../utils/text-stream.js";
import { markFrameworkLinkHeaders } from "./app-response-header-provenance.js";
import { deferUntilStreamConsumed } from "./defer-until-stream-consumed.js";
import {
  captureRouteCacheabilityResponsePolicy,
  deferRouteCacheability,
  isRouteCacheabilityEvaluation,
  type RouteCacheabilityOutcome,
} from "vinext/shims/cacheability-classification";

type AppPageDebugLogger = (event: string, detail: string) => void;
type AppPageRscCacheKeyBuilder = (
  pathname: string,
  mountedSlotsHeader?: string | null,
  renderMode?: AppRscRenderMode,
  interceptionContext?: string | null,
  interceptionId?: string | null,
) => string;
type AppPageRequestCacheLife = {
  revalidate?: number;
  expire?: number;
  stale?: number;
};
type BuildAppPageCacheRenderObservation = (input: {
  cacheTags: readonly string[];
  state: AppPageRenderObservationState;
}) => RenderObservation;

type FinalizeAppPageCacheabilityEvaluationOptions = {
  capturedDynamicUsageBeforeContextCleanup?: () => boolean;
  consumeDynamicUsage: () => boolean;
  consumeRenderObservationState?: () => AppPageRenderObservationState;
  getPageTags: () => string[];
  getRequestCacheLife?: () => AppPageRequestCacheLife | null;
  expireSeconds?: number;
  revalidateSeconds: number | null;
};

type FinalizeAppPageHtmlCacheResponseOptions = {
  capturedDynamicUsageBeforeContextCleanup?: () => boolean;
  capturedRscDataPromise: Promise<ArrayBuffer> | null;
  cleanPathname: string;
  consumeDynamicUsage: () => boolean;
  consumeRenderObservationState?: () => AppPageRenderObservationState;
  createHtmlRenderObservation?: BuildAppPageCacheRenderObservation;
  createRscRenderObservation?: BuildAppPageCacheRenderObservation;
  getPageTags: () => string[];
  getRequestCacheLife?: () => AppPageRequestCacheLife | null;
  isrDebug?: AppPageDebugLogger;
  isrHtmlKey: (pathname: string) => string;
  isrRscKey: AppPageRscCacheKeyBuilder;
  isrSet: AppPageCacheSetter;
  interceptionContext?: string | null;
  interceptionId?: string | null;
  omitPendingDynamicCacheState?: boolean;
  preserveClientResponseHeaders?: boolean;
  expireSeconds?: number;
  revalidateSeconds: number | null;
  linkHeader: string | null;
  waitUntil?: (promise: Promise<void>) => void;
};

type ScheduleAppPageRscCacheWriteOptions = {
  bypassInterceptionContextCache?: boolean;
  capturedRscDataPromise: Promise<ArrayBuffer> | null;
  cleanPathname: string;
  consumeDynamicUsage: () => boolean;
  consumeRenderObservationState?: () => AppPageRenderObservationState;
  createRscRenderObservation?: BuildAppPageCacheRenderObservation;
  dynamicUsedDuringBuild: boolean;
  getPageTags: () => string[];
  getRequestCacheLife?: () => AppPageRequestCacheLife | null;
  isrDebug?: AppPageDebugLogger;
  isrRscKey: AppPageRscCacheKeyBuilder;
  isrSet: AppPageCacheSetter;
  interceptionContext?: string | null;
  interceptionId?: string | null;
  mountedSlotsHeader?: string | null;
  omitPendingDynamicCacheState?: boolean;
  renderMode?: AppRscRenderMode;
  preserveClientResponseHeaders?: boolean;
  expireSeconds?: number;
  revalidateSeconds: number | null;
  waitUntil?: (promise: Promise<void>) => void;
};

function applyPendingDynamicCdnHeaders(
  headers: Headers,
  tags?: readonly string[],
  options: { omitCacheState?: boolean } = {},
): void {
  const cacheable = headers.get("Cache-Control") ?? "";
  applyCdnResponseHeaders(headers, { cacheControl: cacheable, pendingDynamicCheck: true, tags });
  finalizePendingCacheStateHeaders(headers, options);
}

function applyUncacheableRscVariantNoStoreHeaders(
  headers: Headers,
  options: { omitCacheState?: boolean } = {},
): void {
  // Request-specific RSC payloads deliberately bypass persistent caches. Make
  // that bypass explicit to every CDN adapter: an edge-managed adapter may
  // intentionally cache pending-dynamic responses, so that generic signal is
  // not strong enough.
  // The active adapter clears any stale provider-specific headers that it owns.
  applyCdnResponseHeaders(headers, { cacheControl: NO_STORE_CACHE_CONTROL });
  // Dynamic and draft responses intentionally have no cache state. Do not
  // manufacture a MISS solely because the request carried an uncacheable
  // selector variant.
  finalizePendingCacheStateHeaders(headers, {
    ...options,
    preserveMissingCacheState: true,
  });
}

function finalizePendingCacheStateHeaders(
  headers: Headers,
  options: { omitCacheState?: boolean; preserveMissingCacheState?: boolean } = {},
): void {
  const hadCacheState = headers.has(VINEXT_CACHE_HEADER) || headers.has(NEXTJS_CACHE_HEADER);
  // Either an explicitly omitted provisional state or an intentionally absent
  // mounted dynamic/draft state must remain headerless.
  if (
    options.omitCacheState === true ||
    (options.preserveMissingCacheState === true && !hadCacheState)
  ) {
    headers.delete(VINEXT_CACHE_HEADER);
    headers.delete(NEXTJS_CACHE_HEADER);
    return;
  }
  setCacheStateHeaders(headers, "MISS");
}

function resolveAppPageCacheControl(options: {
  expireSeconds?: number;
  requestCacheLife?: AppPageRequestCacheLife | null;
  revalidateSeconds: number | null;
}): CacheControlMetadata | null {
  let revalidateSeconds = options.revalidateSeconds;
  let expireSeconds = options.expireSeconds;
  const requestCacheLife = options.requestCacheLife;

  if (requestCacheLife?.revalidate !== undefined) {
    revalidateSeconds =
      revalidateSeconds === null
        ? requestCacheLife.revalidate
        : Math.min(revalidateSeconds, requestCacheLife.revalidate);
  }
  if (requestCacheLife?.expire !== undefined) {
    expireSeconds = requestCacheLife.expire;
  }

  if (revalidateSeconds === null || Number.isNaN(revalidateSeconds) || revalidateSeconds <= 0) {
    return null;
  }

  // Callers reach this only after the render's stream drained, so the
  // request-scoped accumulation is the completed render's minimum.
  return isrCacheControl(revalidateSeconds, {
    expireSeconds,
    staleSeconds: resolveClientStaleTimeSeconds(requestCacheLife),
  });
}

function appPageCacheControlHeader(cacheControl: CacheControlMetadata): string {
  return cacheControl.revalidate === Infinity
    ? STATIC_CACHE_CONTROL
    : buildRevalidateCacheControl(cacheControl.revalidate, cacheControl.expire);
}

function finalizeEvaluatedAppPageResponse(
  response: Response,
  options: FinalizeAppPageCacheabilityEvaluationOptions,
): Response | null {
  if (!isRouteCacheabilityEvaluation()) return null;
  const complete = deferRouteCacheability();
  if (!complete) return response;
  captureRouteCacheabilityResponsePolicy(response.headers);

  let completed = false;
  const finish = (): void => {
    if (completed) return;
    completed = true;

    let outcome: RouteCacheabilityOutcome;
    if (
      options.capturedDynamicUsageBeforeContextCleanup?.() === true ||
      options.consumeDynamicUsage()
    ) {
      outcome = {
        cacheable: false,
        dynamicUsage: true,
        reason: "dynamic API used during render",
      };
    } else if (
      response.headers.has("set-cookie") ||
      hasExplicitNonCacheableResponsePolicy(response.headers)
    ) {
      outcome = { cacheable: false, reason: "response explicitly opts out of shared caching" };
    } else {
      const cacheControl = resolveAppPageCacheControl({
        expireSeconds: options.expireSeconds,
        requestCacheLife: options.getRequestCacheLife?.(),
        revalidateSeconds: options.revalidateSeconds,
      });
      outcome = cacheControl
        ? {
            cacheable: true,
            cacheControl: appPageCacheControlHeader(cacheControl),
            tags: options.getPageTags(),
          }
        : { cacheable: false, reason: "render did not produce a cache policy" };
    }
    options.consumeRenderObservationState?.();
    complete(outcome);
  };

  if (!response.body) {
    finish();
    return response;
  }
  return new Response(deferUntilStreamConsumed(response.body, finish), {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  });
}

/**
 * Complete probe/admission classification for an App Page response that does
 * not enter the ISR cache-write path. Ordinary requests pass through unchanged.
 */
export function finalizeAppPageCacheabilityEvaluationResponse(
  response: Response,
  options: FinalizeAppPageCacheabilityEvaluationOptions,
): Response {
  return finalizeEvaluatedAppPageResponse(response, options) ?? response;
}

export function finalizeAppPageHtmlCacheResponse(
  response: Response,
  options: FinalizeAppPageHtmlCacheResponseOptions,
): Response {
  const probeResponse = finalizeEvaluatedAppPageResponse(response, options);
  if (probeResponse) {
    void options.capturedRscDataPromise?.catch(() => {});
    return probeResponse;
  }
  if (!response.body) {
    return response;
  }

  const [streamForClient, streamForCache] = response.body.tee();
  const htmlKey = options.isrHtmlKey(options.cleanPathname);
  const rscKey = options.isrRscKey(
    options.cleanPathname,
    null,
    undefined,
    options.interceptionContext,
    options.interceptionId,
  );
  const clientHeaders = new Headers(response.headers);
  if (options.preserveClientResponseHeaders !== true) {
    applyPendingDynamicCdnHeaders(clientHeaders, options.getPageTags(), {
      omitCacheState: options.omitPendingDynamicCacheState === true,
    });
  }

  const cachePromise = (async () => {
    try {
      const cachedHtml = await readStreamAsText(streamForCache);

      if (
        options.capturedDynamicUsageBeforeContextCleanup?.() === true ||
        options.consumeDynamicUsage()
      ) {
        options.isrDebug?.("HTML cache write skipped (dynamic usage during render)", htmlKey);
        return;
      }

      const cacheControl = resolveAppPageCacheControl({
        expireSeconds: options.expireSeconds,
        requestCacheLife: options.getRequestCacheLife?.(),
        revalidateSeconds: options.revalidateSeconds,
      });
      if (!cacheControl) {
        options.isrDebug?.("HTML cache write skipped (no cache policy)", htmlKey);
        return;
      }

      const pageTags = options.getPageTags();
      const observationState =
        options.consumeRenderObservationState?.() ?? createEmptyAppPageRenderObservationState();
      const htmlRenderObservation = options.createHtmlRenderObservation?.({
        cacheTags: pageTags,
        state: observationState,
      });
      const rscRenderObservation = options.createRscRenderObservation?.({
        cacheTags: pageTags,
        state: observationState,
      });
      const linkHeader = options.linkHeader;
      const writes = [
        options.isrSet(
          htmlKey,
          buildAppPageCacheValue(
            cachedHtml,
            undefined,
            200,
            htmlRenderObservation,
            linkHeader ? { link: linkHeader } : undefined,
          ),
          { cacheControl, tags: pageTags },
        ),
      ];

      if (options.capturedRscDataPromise) {
        writes.push(
          options.capturedRscDataPromise.then((rscData) =>
            options.isrSet(rscKey, buildAppPageCacheValue("", rscData, 200, rscRenderObservation), {
              cacheControl,
              tags: pageTags,
            }),
          ),
        );
      }

      await Promise.all(writes);
      options.isrDebug?.("HTML cache written", htmlKey);
    } catch (cacheError) {
      console.error("[vinext] ISR cache write error:", cacheError);
    }
  })();

  options.waitUntil?.(cachePromise);

  const clientResponse = new Response(streamForClient, {
    status: response.status,
    statusText: response.statusText,
    headers: clientHeaders,
  });
  markFrameworkLinkHeaders(clientResponse.headers, options.linkHeader);
  return clientResponse;
}

export function finalizeAppPageRscCacheResponse(
  response: Response,
  options: ScheduleAppPageRscCacheWriteOptions,
): Response {
  const probeResponse = finalizeEvaluatedAppPageResponse(response, options);
  if (probeResponse) {
    void options.capturedRscDataPromise?.catch(() => {});
    return probeResponse;
  }
  // Persisting to the ISR store and finalizing the client-facing headers are
  // independent decisions. Mounted-slot and unverified-interception variants
  // are deliberately never stored, but a fresh MISS stream can still reach a
  // dynamic API after the cache policy was chosen, so shared caches must not
  // keep it either way. An explicit no-store policy is required because
  // edge-managed adapters may cache pending-dynamic responses.
  scheduleAppPageRscCacheWrite(options);

  const isUncacheableVariant =
    Boolean(options.mountedSlotsHeader) || options.bypassInterceptionContextCache === true;
  if (options.preserveClientResponseHeaders === true && !isUncacheableVariant) {
    return response;
  }

  const clientHeaders = new Headers(response.headers);
  if (isUncacheableVariant) {
    applyUncacheableRscVariantNoStoreHeaders(clientHeaders, {
      omitCacheState: options.omitPendingDynamicCacheState === true,
    });
  } else {
    applyPendingDynamicCdnHeaders(clientHeaders, options.getPageTags(), {
      omitCacheState: options.omitPendingDynamicCacheState === true,
    });
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: clientHeaders,
  });
}

export function scheduleAppPageRscCacheWrite(
  options: ScheduleAppPageRscCacheWriteOptions,
): boolean {
  const capturedRscDataPromise = options.capturedRscDataPromise;
  if (
    !capturedRscDataPromise ||
    options.dynamicUsedDuringBuild ||
    options.mountedSlotsHeader ||
    options.bypassInterceptionContextCache === true
  ) {
    return false;
  }

  const rscKey = options.isrRscKey(
    options.cleanPathname,
    null,
    options.renderMode,
    options.interceptionContext,
    options.interceptionId,
  );
  const cachePromise = (async () => {
    try {
      const rscData = await capturedRscDataPromise;

      if (options.consumeDynamicUsage()) {
        options.isrDebug?.("RSC cache write skipped (dynamic usage during render)", rscKey);
        return;
      }

      const cacheControl = resolveAppPageCacheControl({
        expireSeconds: options.expireSeconds,
        requestCacheLife: options.getRequestCacheLife?.(),
        revalidateSeconds: options.revalidateSeconds,
      });
      if (!cacheControl) {
        options.isrDebug?.("RSC cache write skipped (no cache policy)", rscKey);
        return;
      }

      const pageTags = options.getPageTags();
      const observationState =
        options.consumeRenderObservationState?.() ?? createEmptyAppPageRenderObservationState();
      const rscRenderObservation = options.createRscRenderObservation?.({
        cacheTags: pageTags,
        state: observationState,
      });
      await options.isrSet(rscKey, buildAppPageCacheValue("", rscData, 200, rscRenderObservation), {
        cacheControl,
        tags: pageTags,
      });
      options.isrDebug?.("RSC cache written", rscKey);
    } catch (cacheError) {
      console.error("[vinext] ISR RSC cache write error:", cacheError);
    }
  })();

  options.waitUntil?.(cachePromise);
  return true;
}
