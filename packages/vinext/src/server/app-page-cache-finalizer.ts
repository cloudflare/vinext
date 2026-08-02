import type { AppRscRenderMode } from "./app-rsc-render-mode.js";
import { applyCdnResponseHeaders } from "./cache-control.js";
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
  tags?: readonly string[],
  options: { omitCacheState?: boolean } = {},
): void {
  const cacheable = headers.get("Cache-Control") ?? "";
  applyCdnResponseHeaders(headers, { cacheControl: cacheable, pendingDynamicCheck: true, tags });
  if (options.omitCacheState === true) {
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

export function finalizeAppPageHtmlCacheResponse(
  response: Response,
  options: FinalizeAppPageHtmlCacheResponseOptions,
): Response {
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
      const linkHeader = response.headers.get("link");
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

  return new Response(streamForClient, {
    status: response.status,
    statusText: response.statusText,
    headers: clientHeaders,
  });
}

export function finalizeAppPageRscCacheResponse(
  response: Response,
  options: ScheduleAppPageRscCacheWriteOptions,
): Response {
  const didSchedule = scheduleAppPageRscCacheWrite(options);
  if (!didSchedule) {
    return response;
  }

  if (options.preserveClientResponseHeaders === true) {
    return response;
  }

  const clientHeaders = new Headers(response.headers);
  applyPendingDynamicCdnHeaders(clientHeaders, options.getPageTags(), {
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
  const capturedRscDataPromise = options.capturedRscDataPromise;
  if (!capturedRscDataPromise || options.dynamicUsedDuringBuild || options.mountedSlotsHeader) {
    return false;
  }

  const rscKey = options.isrRscKey(
    options.cleanPathname,
    null,
    options.renderMode,
    options.interceptionContext,
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
