import type { CachedAppPageValue, CacheControlMetadata } from "vinext/shims/cache";
import {
  VINEXT_RSC_CONTENT_TYPE,
  VINEXT_RSC_VARY_HEADER,
  applyRscCompatibilityIdHeader,
} from "./app-rsc-cache-busting.js";
import { buildCachedRevalidateCacheControl } from "./cache-control.js";
import { VINEXT_MOUNTED_SLOTS_HEADER } from "./headers.js";
import { applyEdgeRuntimeHeader } from "./app-page-response.js";
import { setCacheStateHeaders } from "./cache-headers.js";
import { buildAppPageCacheValue, type ISRCacheEntry } from "./isr-cache.js";
import { mergeMiddlewareResponseHeaders } from "./middleware-response-headers.js";
import { readStreamAsText } from "../utils/text-stream.js";
import { encodeCacheTag } from "../utils/encode-cache-tag.js";
import type { AppRscRenderMode } from "./app-rsc-render-mode.js";
import {
  createEmptyAppPageRenderObservationState,
  type AppPageRenderObservationState,
} from "./app-page-render-observation.js";
import type { RenderObservation } from "./cache-proof.js";

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
type AppPageRequestCacheLife = {
  revalidate?: number;
  expire?: number;
};
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
    | "read-error"
    | "served"
    | "stale-empty-entry";
}>;
type AppPageCacheOutcomeRecorder = (metric: AppPageCacheOutcomeMetric) => void;

type BuildAppPageCacheRenderObservation = (input: {
  cacheTags: readonly string[];
  state: AppPageRenderObservationState;
}) => RenderObservation;

type AppPageCacheRenderResult = {
  cacheControl?: CacheControlMetadata;
  html: string;
  htmlRenderObservation?: RenderObservation;
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
  renderMode?: AppRscRenderMode;
  preserveClientResponseHeaders?: boolean;
  expireSeconds?: number;
  revalidateSeconds: number | null;
  waitUntil?: (promise: Promise<void>) => void;
};

const NO_STORE_CACHE_CONTROL = "no-store, must-revalidate";

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

function buildAppPageCacheControl(
  cacheState: BuildAppPageCachedResponseOptions["cacheState"],
  revalidateSeconds: number,
  expireSeconds?: number,
): string {
  return buildCachedRevalidateCacheControl(cacheState, revalidateSeconds, expireSeconds);
}

function buildAppPageCachedHeaders(options: {
  cacheControl: string;
  cacheState: BuildAppPageCachedResponseOptions["cacheState"];
  contentType: string;
  isEdgeRuntime?: boolean;
  middlewareHeaders?: Headers | null;
  mountedSlotsHeader?: string | null;
}): Headers {
  const headers = new Headers({
    "Cache-Control": options.cacheControl,
    "Content-Type": options.contentType,
    Vary: VINEXT_RSC_VARY_HEADER,
  });
  setCacheStateHeaders(headers, options.cacheState);
  applyEdgeRuntimeHeader(headers, options.isEdgeRuntime);

  if (options.mountedSlotsHeader) {
    headers.set(VINEXT_MOUNTED_SLOTS_HEADER, options.mountedSlotsHeader);
  }

  mergeMiddlewareResponseHeaders(headers, options.middlewareHeaders ?? null);
  return headers;
}

function getCachedAppPageValue(entry: ISRCacheEntry | null): CachedAppPageValue | null {
  return entry?.value.value && entry.value.value.kind === "APP_PAGE" ? entry.value.value : null;
}

function resolveAppPageCacheWritePolicy(options: {
  expireSeconds?: number;
  requestCacheLife?: AppPageRequestCacheLife | null;
  revalidateSeconds: number | null;
}): { expireSeconds?: number; revalidateSeconds: number } | null {
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

  if (revalidateSeconds === null || revalidateSeconds <= 0 || !Number.isFinite(revalidateSeconds)) {
    return null;
  }

  return { expireSeconds, revalidateSeconds };
}

export function buildAppPageCachedResponse(
  cachedValue: CachedAppPageValue,
  options: BuildAppPageCachedResponseOptions,
): Response | null {
  // Preserve the legacy fallback semantics from the generated entry: invalid
  // falsy statuses still fall back to 200 rather than being forwarded through.
  const status = options.middlewareStatus ?? (cachedValue.status || 200);
  const revalidateSeconds = options.cacheControl?.revalidate ?? options.revalidateSeconds;
  const expireSeconds =
    options.cacheControl === undefined
      ? undefined
      : (options.cacheControl.expire ?? options.expireSeconds);
  const cacheControl = buildAppPageCacheControl(
    options.cacheState,
    revalidateSeconds,
    expireSeconds,
  );
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
    middlewareHeaders: options.middlewareHeaders,
  });

  return new Response(cachedValue.html, {
    status,
    headers: htmlHeaders,
  });
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
      const regenerationKey = options.isRscRequest
        ? options.isrRscKey(
            options.cleanPathname,
            options.mountedSlotsHeader,
            options.renderMode,
            options.interceptionContext,
          )
        : options.isrHtmlKey(options.cleanPathname);

      // Preserve the legacy behavior from the inline generator: stale entries
      // still trigger background regeneration even if this request cannot use
      // the stale payload and will fall through to a fresh render.
      options.scheduleBackgroundRegeneration(regenerationKey, async () => {
        const revalidatedPage = await options.renderFreshPageForCache();
        const revalidateSeconds =
          revalidatedPage.cacheControl?.revalidate ?? options.revalidateSeconds;
        const expireSeconds = revalidatedPage.cacheControl?.expire ?? options.expireSeconds;
        const writes = [
          options.isrSet(
            options.isrRscKey(
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
              options.isrHtmlKey(options.cleanPathname),
              buildAppPageCacheValue(
                revalidatedPage.html,
                undefined,
                200,
                revalidatedPage.htmlRenderObservation,
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
    // HTML Server Components can access request APIs while the stream is being
    // consumed. Until that late dynamic check finishes, downstream shared caches
    // must not cache a response whose ISR policy was known before streaming.
    clientHeaders.set("Cache-Control", NO_STORE_CACHE_CONTROL);
    setCacheStateHeaders(clientHeaders, "MISS");
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

      const cachePolicy = resolveAppPageCacheWritePolicy({
        expireSeconds: options.expireSeconds,
        requestCacheLife: options.getRequestCacheLife?.(),
        revalidateSeconds: options.revalidateSeconds,
      });
      if (!cachePolicy) {
        options.isrDebug?.("HTML cache write skipped (no cache policy)", htmlKey);
        return;
      }

      const pageTags = options.getPageTags();
      // This continuation is scheduled while the request ALS scope is active.
      // It intentionally consumes observation state only after the HTML stream
      // drains, so late Server Component request API usage is included.
      // Consume once: HTML and captured RSC artifacts come from the same render
      // pass, so both cache artifacts share the same observation snapshot.
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
      const writes = [
        options.isrSet(
          htmlKey,
          buildAppPageCacheValue(cachedHtml, undefined, 200, htmlRenderObservation),
          cachePolicy.revalidateSeconds,
          pageTags,
          cachePolicy.expireSeconds,
        ),
      ];

      if (options.capturedRscDataPromise) {
        writes.push(
          options.capturedRscDataPromise.then((rscData) =>
            options.isrSet(
              rscKey,
              buildAppPageCacheValue("", rscData, 200, rscRenderObservation),
              cachePolicy.revalidateSeconds,
              pageTags,
              cachePolicy.expireSeconds,
            ),
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
  // RSC payloads are also streamed lazily. Until the captured stream proves no
  // late request API was used, the client-facing MISS response must not enter a
  // shared cache when the ISR policy was known before streaming.
  clientHeaders.set("Cache-Control", NO_STORE_CACHE_CONTROL);
  setCacheStateHeaders(clientHeaders, "MISS");

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
  if (!capturedRscDataPromise || options.dynamicUsedDuringBuild) {
    return false;
  }

  const rscKey = options.isrRscKey(
    options.cleanPathname,
    options.mountedSlotsHeader,
    options.renderMode,
    options.interceptionContext,
  );
  const cachePromise = (async () => {
    try {
      const rscData = await capturedRscDataPromise;

      // Two-phase dynamic detection:
      // 1. dynamicUsedDuringBuild catches searchParams-driven opt-in before the
      //    RSC response is sent.
      // 2. consumeDynamicUsage() here catches APIs that fire while the RSC
      //    stream is consumed (headers(), cookies(), noStore()).
      if (options.consumeDynamicUsage()) {
        options.isrDebug?.("RSC cache write skipped (dynamic usage during render)", rscKey);
        return;
      }

      const cachePolicy = resolveAppPageCacheWritePolicy({
        expireSeconds: options.expireSeconds,
        requestCacheLife: options.getRequestCacheLife?.(),
        revalidateSeconds: options.revalidateSeconds,
      });
      if (!cachePolicy) {
        options.isrDebug?.("RSC cache write skipped (no cache policy)", rscKey);
        return;
      }

      const pageTags = options.getPageTags();
      // This continuation is scheduled while the request ALS scope is active.
      // It intentionally consumes observation state only after the captured RSC
      // stream resolves, so late Server Component request API usage is included.
      const observationState =
        options.consumeRenderObservationState?.() ?? createEmptyAppPageRenderObservationState();
      const rscRenderObservation = options.createRscRenderObservation?.({
        cacheTags: pageTags,
        state: observationState,
      });
      await options.isrSet(
        rscKey,
        buildAppPageCacheValue("", rscData, 200, rscRenderObservation),
        cachePolicy.revalidateSeconds,
        pageTags,
        cachePolicy.expireSeconds,
      );
      options.isrDebug?.("RSC cache written", rscKey);
    } catch (cacheError) {
      console.error("[vinext] ISR RSC cache write error:", cacheError);
    }
  })();

  options.waitUntil?.(cachePromise);
  return true;
}
