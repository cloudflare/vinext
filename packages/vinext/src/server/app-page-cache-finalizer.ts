import type { CacheControlMetadata } from "vinext/shims/cache-handler";
import type { AppRscRenderMode } from "./app-rsc-render-mode.js";
import { applyCdnResponseHeaders, NO_STORE_CACHE_CONTROL } from "./cache-control.js";
import { setCacheStateHeaders } from "./cache-headers.js";
import { NEXTJS_CACHE_HEADER, VINEXT_CACHE_HEADER } from "./headers.js";
import {
  createEmptyAppPageRenderObservationState,
  type AppPageRenderObservationState,
} from "./app-page-render-observation.js";
import { buildAppPageCacheValue, isrCacheControl, type AppPageCacheSetter } from "./isr-cache.js";
import type { RenderObservation } from "./cache-proof.js";
import { resolveClientStaleTimeSeconds } from "../utils/cache-control-metadata.js";
import { readStreamAsText } from "../utils/text-stream.js";
import { markFrameworkLinkHeaders } from "./app-response-header-provenance.js";

type AppPageDebugLogger = (event: string, detail: string) => void;
type AppPageRscCacheKeyBuilder = (
  pathname: string,
  mountedSlotsHeader?: string | null,
  renderMode?: AppRscRenderMode,
  interceptionContext?: string | null,
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
  omitPendingDynamicCacheState?: boolean;
  preserveClientResponseHeaders?: boolean;
  expireSeconds?: number;
  revalidateSeconds: number | null;
  linkHeader: string | null;
  waitUntil?: (promise: Promise<void>) => void;
};

type ScheduleAppPageRscCacheWriteOptions = {
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
  options: { omitCacheState?: boolean } = {},
): void {
  const cacheable = headers.get("Cache-Control") ?? "";
  applyCdnResponseHeaders(headers, { cacheControl: cacheable, pendingDynamicCheck: true });
  finalizePendingCacheStateHeaders(headers, options);
}

function applyMountedSlotRscNoStoreHeaders(
  headers: Headers,
  options: { omitCacheState?: boolean } = {},
): void {
  // Mounted-slot RSC payloads deliberately bypass the slot-blind persistent
  // cache. Make that same bypass explicit to every CDN adapter: unlike an
  // ordinary pending stream, this variant can never be admitted later.
  // This branch additionally forces no-store because mounted variants have no
  // persistent admission path at all. The active adapter clears any stale
  // provider-specific headers that it owns.
  applyCdnResponseHeaders(headers, { cacheControl: NO_STORE_CACHE_CONTROL });
  // Dynamic and draft responses intentionally have no cache state. Do not
  // manufacture a MISS solely because the request carried mounted slots.
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

/**
 * Persist a rendered page, unless the drained stream showed the render was
 * dynamic or left no cache lifetime. The client response is already private;
 * only a successful write can make a later request eligible for promotion.
 */
async function writeAppPageHtmlCacheEntry(
  cachedHtml: string,
  options: FinalizeAppPageHtmlCacheResponseOptions,
): Promise<void> {
  const htmlKey = options.isrHtmlKey(options.cleanPathname);
  try {
    if (
      options.capturedDynamicUsageBeforeContextCleanup?.() === true ||
      options.consumeDynamicUsage()
    ) {
      options.isrDebug?.("HTML cache write skipped (dynamic usage during render)", htmlKey);
      return;
    }

    const cachePolicy = resolveAppPageCacheControl({
      expireSeconds: options.expireSeconds,
      requestCacheLife: options.getRequestCacheLife?.(),
      revalidateSeconds: options.revalidateSeconds,
    });
    if (!cachePolicy) {
      options.isrDebug?.("HTML cache write skipped (no cache policy)", htmlKey);
      return;
    }

    const rscKey = options.isrRscKey(
      options.cleanPathname,
      null,
      undefined,
      options.interceptionContext,
    );
    const cacheTags = [...options.getPageTags()];
    const observationState =
      options.consumeRenderObservationState?.() ?? createEmptyAppPageRenderObservationState();
    const htmlRenderObservation = options.createHtmlRenderObservation?.({
      cacheTags,
      state: observationState,
    });
    const rscRenderObservation = options.createRscRenderObservation?.({
      cacheTags,
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
        { cacheControl: cachePolicy, tags: [...cacheTags] },
      ),
    ];

    if (options.capturedRscDataPromise) {
      writes.push(
        options.capturedRscDataPromise.then((rscData) =>
          options.isrSet(rscKey, buildAppPageCacheValue("", rscData, 200, rscRenderObservation), {
            cacheControl: cachePolicy,
            tags: [...cacheTags],
          }),
        ),
      );
    }

    await Promise.all(writes);
    options.isrDebug?.("HTML cache written", htmlKey);
  } catch (cacheError) {
    console.error("[vinext] ISR cache write error:", cacheError);
  }
}

export function finalizeAppPageHtmlCacheResponse(
  response: Response,
  options: FinalizeAppPageHtmlCacheResponseOptions,
): Response {
  if (!response.body) {
    return response;
  }

  const [streamForClient, streamForCache] = response.body.tee();

  const cachePromise = (async (): Promise<void> => {
    try {
      const cachedHtml = await readStreamAsText(streamForCache);
      await writeAppPageHtmlCacheEntry(cachedHtml, options);
    } catch (cacheError) {
      // A broken cache branch must not create an unhandled rejection after the
      // private client stream has already left the Worker.
      console.error("[vinext] ISR cache stream error:", cacheError);
    }
  })();

  options.waitUntil?.(cachePromise.then(() => undefined));

  const clientHeaders = new Headers(response.headers);
  if (options.preserveClientResponseHeaders !== true) {
    applyPendingDynamicCdnHeaders(clientHeaders, {
      omitCacheState: options.omitPendingDynamicCacheState === true,
    });
  }

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
  void startAppPageRscCacheWrite(options);
  // Persisting to the ISR store and finalizing the client-facing headers are
  // independent decisions. Mounted-slot variants are deliberately never stored
  // (their RSC key is slot-blind), but a fresh MISS stream can still reach a
  // dynamic API after the cache policy was chosen, so shared caches must not
  // keep it either way. An explicit no-store policy is required for mounted
  // slots because they have no durable admission path.
  const isMountedSlotVariant = Boolean(options.mountedSlotsHeader);
  if (options.preserveClientResponseHeaders === true && !isMountedSlotVariant) {
    return response;
  }

  if (isMountedSlotVariant) {
    const clientHeaders = new Headers(response.headers);
    applyMountedSlotRscNoStoreHeaders(clientHeaders, {
      omitCacheState: options.omitPendingDynamicCacheState === true,
    });
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: clientHeaders,
    });
  }

  const clientHeaders = new Headers(response.headers);
  applyPendingDynamicCdnHeaders(clientHeaders, {
    omitCacheState: options.omitPendingDynamicCacheState === true,
  });

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: clientHeaders,
  });
}

export function scheduleAppPageRscCacheWrite(
  options: ScheduleAppPageRscCacheWriteOptions,
): boolean {
  return startAppPageRscCacheWrite(options) !== null;
}

/**
 * Schedule the RSC admission write. Returns `null` when there is no complete
 * artifact to persist or this request is not eligible for durable admission.
 */
function startAppPageRscCacheWrite(
  options: ScheduleAppPageRscCacheWriteOptions,
): Promise<void> | null {
  const capturedRscDataPromise = options.capturedRscDataPromise;
  if (!capturedRscDataPromise || options.dynamicUsedDuringBuild || options.mountedSlotsHeader) {
    return null;
  }

  const rscKey = options.isrRscKey(
    options.cleanPathname,
    null,
    options.renderMode,
    options.interceptionContext,
  );
  const cachePromise = (async (): Promise<void> => {
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

      const cacheTags = [...options.getPageTags()];
      const observationState =
        options.consumeRenderObservationState?.() ?? createEmptyAppPageRenderObservationState();
      const rscRenderObservation = options.createRscRenderObservation?.({
        cacheTags,
        state: observationState,
      });
      await options.isrSet(rscKey, buildAppPageCacheValue("", rscData, 200, rscRenderObservation), {
        cacheControl,
        tags: [...cacheTags],
      });
      options.isrDebug?.("RSC cache written", rscKey);
    } catch (cacheError) {
      console.error("[vinext] ISR RSC cache write error:", cacheError);
    }
  })();

  options.waitUntil?.(cachePromise.then(() => undefined));
  return cachePromise;
}
