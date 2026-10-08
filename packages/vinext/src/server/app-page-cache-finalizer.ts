import type { AppRscRenderMode } from "./app-rsc-render-mode.js";
import {
  applyCdnResponseHeaders,
  captureCdnResponsePolicyHeaders,
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
import {
  buildAppPageCacheValue,
  isrCacheControl,
  resolveRouteExpireSeconds,
  type AppPageCacheSetter,
} from "./isr-cache.js";
import type { CacheControlMetadata } from "vinext/shims/cache-handler";
import { hasQueryInvariantRenderProof, type RenderObservation } from "./cache-proof.js";
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
import { getCdnCacheAdapter } from "vinext/shims/cdn-cache";
import {
  resolveAppPageRscResponseStatus,
  type AppPageRscRenderStatus,
} from "./app-page-rsc-render-status.js";

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
  /**
   * `false` for routes Next.js classifies as dynamic (ƒ), which are never
   * cacheable even when a cacheLife resolves during the render.
   */
  isStaticEligible: boolean;
  /** An RSC render's status, from its document's shell. */
  resolveRscRenderStatus?: () => Promise<AppPageRscRenderStatus>;
  revalidateSeconds: number | null;
};

type FinalizeAppPageHtmlCacheResponseOptions = {
  bypassInterceptionContextCache?: boolean;
  capturedDynamicUsageBeforeContextCleanup?: () => boolean;
  capturedRscDataPromise: Promise<ArrayBuffer> | null;
  cleanPathname: string;
  /** Private marker surrounding this render's injected client trace metadata. */
  clientTraceMetadataMarker?: string;
  consumeDynamicUsage: () => boolean;
  consumeRenderObservationState?: () => AppPageRenderObservationState;
  createHtmlRenderObservation: BuildAppPageCacheRenderObservation;
  createRscRenderObservation: BuildAppPageCacheRenderObservation;
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
  isStaticEligible: boolean;
  revalidateSeconds: number | null;
  linkHeader: string | null;
  /**
   * The status and headers stored with both entries, for a render that ended
   * in a special error: 404/403/401, or 307/308 with its `location`.
   */
  status?: number;
  headers?: Record<string, string>;
  waitUntil?: (promise: Promise<void>) => void;
};

type ScheduleAppPageRscCacheWriteOptions = {
  bypassInterceptionContextCache?: boolean;
  capturedRscDataPromise: Promise<ArrayBuffer> | null;
  cleanPathname: string;
  consumeDynamicUsage: () => boolean;
  consumeRenderObservationState?: () => AppPageRenderObservationState;
  createRscRenderObservation: BuildAppPageCacheRenderObservation;
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
  /** The render's status, from its document's shell. Without it the render is a 200. */
  resolveRscRenderStatus?: () => Promise<AppPageRscRenderStatus>;
  preserveClientResponseHeaders?: boolean;
  expireSeconds?: number;
  isStaticEligible: boolean;
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

function applyUncacheableVariantNoStoreHeaders(
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
  const requestCacheLife = options.requestCacheLife;

  if (requestCacheLife?.revalidate !== undefined) {
    revalidateSeconds =
      revalidateSeconds === null
        ? requestCacheLife.revalidate
        : Math.min(revalidateSeconds, requestCacheLife.revalidate);
  }
  const expireSeconds =
    requestCacheLife?.expire ?? resolveRouteExpireSeconds(revalidateSeconds, options.expireSeconds);

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

/**
 * The completed response replaces a streamed 200 with the status Next.js sends
 * for the render's special error, and stores that.
 */
function applyRscRenderStatus(
  outcome: RouteCacheabilityOutcome,
  renderStatus: AppPageRscRenderStatus,
): RouteCacheabilityOutcome {
  if (renderStatus.kind === "page") return outcome;
  if (renderStatus.kind === "unstorable") {
    return { cacheable: false, reason: "render ended in a special error Next.js doesn't store" };
  }
  return {
    ...outcome,
    status: resolveAppPageRscResponseStatus(renderStatus.status),
    ...(renderStatus.headers ? { headers: renderStatus.headers } : {}),
  };
}

function finalizeEvaluatedAppPageResponse(
  response: Response,
  options: FinalizeAppPageCacheabilityEvaluationOptions,
): Response | null {
  if (!isRouteCacheabilityEvaluation()) return null;
  const complete = deferRouteCacheability();
  if (!complete) return response;
  captureRouteCacheabilityResponsePolicy(captureCdnResponsePolicyHeaders(response.headers));

  let completed = false;
  const finish = (): void => {
    if (completed) return;
    completed = true;

    const observationState = options.consumeRenderObservationState?.();
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
    } else if (options.isStaticEligible === false) {
      outcome = { cacheable: false, reason: "route is not statically generated" };
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
            ...(observationState && !observationState.requestApis.includes("searchParams")
              ? { searchParamsUnread: true }
              : {}),
            tags: options.getPageTags(),
          }
        : { cacheable: false, reason: "render did not produce a cache policy" };
    }
    if (outcome.cacheable && options.resolveRscRenderStatus) {
      const cacheableOutcome = outcome;
      void options.resolveRscRenderStatus().then(
        (renderStatus) => complete(applyRscRenderStatus(cacheableOutcome, renderStatus)),
        () => complete({ cacheable: false, reason: "render status could not be resolved" }),
      );
      return;
    }
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
    if (options.capturedRscDataPromise) {
      const adapter = getCdnCacheAdapter();
      if (adapter.captureAppPageRscData) {
        adapter.captureAppPageRscData(options.capturedRscDataPromise);
      } else {
        void options.capturedRscDataPromise.catch(() => {});
      }
    }
    return probeResponse;
  }
  if (options.bypassInterceptionContextCache === true) {
    void options.capturedRscDataPromise?.catch(() => {});
    const headers = new Headers(response.headers);
    applyUncacheableVariantNoStoreHeaders(headers, {
      omitCacheState: options.omitPendingDynamicCacheState === true,
    });
    const clientResponse = new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
    markFrameworkLinkHeaders(clientResponse.headers, options.linkHeader);
    return clientResponse;
  }
  // A redirect has no body, so its entry stores an empty document.
  const [streamForClient, streamForCache] = response.body ? response.body.tee() : [null, null];
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
      let cachedHtml = streamForCache ? await readStreamAsText(streamForCache) : "";
      // The page's Flight render can outlive a document it didn't render, such
      // as a special error's, and the store reads what that render observed.
      const rscData = options.capturedRscDataPromise
        ? await options.capturedRscDataPromise
        : undefined;

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

      if (options.clientTraceMetadataMarker) {
        const { stripClientTraceMetadataBlock } = await import("./client-trace-metadata.js");
        cachedHtml = stripClientTraceMetadataBlock(cachedHtml, options.clientTraceMetadataMarker);
      }

      const pageTags = options.getPageTags();
      const observationState =
        options.consumeRenderObservationState?.() ?? createEmptyAppPageRenderObservationState();
      const htmlRenderObservation = options.createHtmlRenderObservation({
        cacheTags: pageTags,
        state: observationState,
      });
      const rscRenderObservation = options.createRscRenderObservation({
        cacheTags: pageTags,
        state: observationState,
      });
      const linkHeader = options.linkHeader;
      const status = options.status ?? 200;
      // Every query shares these entries, so a render not proven to leave the
      // query unread is never stored.
      if (
        !hasQueryInvariantRenderProof(htmlRenderObservation) ||
        !hasQueryInvariantRenderProof(rscRenderObservation)
      ) {
        options.isrDebug?.("HTML cache write skipped (searchParams not proven unread)", htmlKey);
        return;
      }
      const writes = [
        options.isrSet(
          htmlKey,
          buildAppPageCacheValue(
            cachedHtml,
            undefined,
            status,
            htmlRenderObservation,
            linkHeader ? { ...options.headers, link: linkHeader } : options.headers,
          ),
          { cacheControl, tags: pageTags },
        ),
      ];

      if (rscData) {
        writes.push(
          options.isrSet(
            rscKey,
            buildAppPageCacheValue("", rscData, status, rscRenderObservation, options.headers),
            { cacheControl, tags: pageTags },
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
    applyUncacheableVariantNoStoreHeaders(clientHeaders, {
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
      const rscRenderObservation = options.createRscRenderObservation({
        cacheTags: pageTags,
        state: observationState,
      });
      // Every query shares this entry, so a render not proven to leave the
      // query unread is never stored.
      if (!hasQueryInvariantRenderProof(rscRenderObservation)) {
        options.isrDebug?.("RSC cache write skipped (searchParams not proven unread)", rscKey);
        return;
      }
      // Like Next.js, store the status and `location` of a special error that
      // rejects the document's shell. Replay sends a redirect as a 200.
      const renderStatus = (await options.resolveRscRenderStatus?.()) ?? { kind: "page" };
      if (renderStatus.kind === "unstorable") {
        options.isrDebug?.("RSC cache write skipped (unstorable special error)", rscKey);
        return;
      }
      await options.isrSet(
        rscKey,
        renderStatus.kind === "special-error"
          ? buildAppPageCacheValue(
              "",
              rscData,
              renderStatus.status,
              rscRenderObservation,
              renderStatus.headers,
            )
          : buildAppPageCacheValue("", rscData, 200, rscRenderObservation),
        { cacheControl, tags: pageTags },
      );
      options.isrDebug?.("RSC cache written", rscKey);
    } catch (cacheError) {
      console.error("[vinext] ISR RSC cache write error:", cacheError);
    }
  })();

  options.waitUntil?.(cachePromise);
  return true;
}
