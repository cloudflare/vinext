import {
  buildRevalidateCacheControl,
  NO_STORE_CACHE_CONTROL,
  STATIC_CACHE_CONTROL,
} from "./cache-control.js";
import {
  VINEXT_DYNAMIC_STALE_TIME_HEADER,
  VINEXT_MOUNTED_SLOTS_HEADER,
  VINEXT_PARAMS_HEADER,
  VINEXT_PRERENDER_CACHE_LIFE_HEADER,
  VINEXT_TIMING_HEADER,
} from "./headers.js";
import { setCacheStateHeaders } from "./cache-headers.js";
import { mergeMiddlewareResponseHeaders } from "./middleware-response-headers.js";
import {
  VINEXT_RSC_CONTENT_TYPE,
  VINEXT_RSC_VARY_HEADER,
  applyRscCompatibilityIdHeader,
} from "./app-rsc-cache-busting.js";

export type AppPageMiddlewareContext = {
  headers: Headers | null;
  status: number | null;
};

export type AppPageResponseTiming = {
  compileEnd?: number;
  handlerStart: number;
  renderEnd?: number;
  responseKind: "html" | "rsc";
};

type AppPageResponsePolicy = {
  cacheControl?: string;
  cacheState?: "MISS" | "STATIC";
};

type AppPagePrerenderCacheLife = {
  expire?: number;
  revalidate?: number;
};

type ResolveAppPageResponsePolicyBaseOptions = {
  isDraftMode: boolean;
  isDynamicError: boolean;
  isForceDynamic: boolean;
  isForceStatic: boolean;
  isProduction: boolean;
  expireSeconds?: number;
  revalidateSeconds: number | null;
};

type ResolveAppPageRscResponsePolicyOptions = {
  dynamicUsedDuringBuild: boolean;
} & ResolveAppPageResponsePolicyBaseOptions;

type ResolveAppPageHtmlResponsePolicyOptions = {
  dynamicUsedDuringRender: boolean;
  isProgressiveActionRender?: boolean;
  hasScriptNonce: boolean;
} & ResolveAppPageResponsePolicyBaseOptions;

type AppPageHtmlResponsePolicy = {
  shouldWriteToCache: boolean;
} & AppPageResponsePolicy;

type BuildAppPageRscResponseOptions = {
  dynamicStaleTimeSeconds?: number;
  isEdgeRuntime?: boolean;
  middlewareContext: AppPageMiddlewareContext;
  mountedSlotsHeader?: string | null;
  params?: Record<string, unknown>;
  policy: AppPageResponsePolicy;
  requestCacheLife?: AppPagePrerenderCacheLife | null;
  timing?: AppPageResponseTiming;
};

type BuildAppPageHtmlResponseOptions = {
  draftCookie?: string | null;
  /** Combined preload `Link` header value (React hints + font preloads), already capped. */
  linkHeader?: string;
  isEdgeRuntime?: boolean;
  middlewareContext: AppPageMiddlewareContext;
  policy: AppPageResponsePolicy;
  requestCacheLife?: AppPagePrerenderCacheLife | null;
  timing?: AppPageResponseTiming;
};

function applyTimingHeader(headers: Headers, timing?: AppPageResponseTiming): void {
  if (!timing) {
    return;
  }

  const handlerStart = Math.round(timing.handlerStart);
  const compileMs =
    timing.compileEnd !== undefined ? Math.round(timing.compileEnd - timing.handlerStart) : -1;
  const renderMs =
    timing.responseKind === "html" &&
    timing.renderEnd !== undefined &&
    timing.compileEnd !== undefined
      ? Math.round(timing.renderEnd - timing.compileEnd)
      : -1;

  headers.set(VINEXT_TIMING_HEADER, `${handlerStart},${compileMs},${renderMs}`);
}

function applyDynamicStaleTimeHeader(headers: Headers, dynamicStaleTimeSeconds?: number): void {
  if (
    dynamicStaleTimeSeconds !== undefined &&
    Number.isInteger(dynamicStaleTimeSeconds) &&
    dynamicStaleTimeSeconds >= 0
  ) {
    headers.set(VINEXT_DYNAMIC_STALE_TIME_HEADER, String(dynamicStaleTimeSeconds));
  }
}

function applyPrerenderCacheLifeHeader(
  headers: Headers,
  requestCacheLife: AppPagePrerenderCacheLife | null | undefined,
): void {
  if (!requestCacheLife) return;
  const payload: AppPagePrerenderCacheLife = {};
  if (
    typeof requestCacheLife.revalidate === "number" &&
    Number.isFinite(requestCacheLife.revalidate)
  ) {
    payload.revalidate = requestCacheLife.revalidate;
  }
  if (typeof requestCacheLife.expire === "number" && Number.isFinite(requestCacheLife.expire)) {
    payload.expire = requestCacheLife.expire;
  }
  if (payload.revalidate === undefined && payload.expire === undefined) return;
  headers.set(VINEXT_PRERENDER_CACHE_LIFE_HEADER, JSON.stringify(payload));
}

export function resolveAppPageRscResponsePolicy(
  options: ResolveAppPageRscResponsePolicyOptions,
): AppPageResponsePolicy {
  if (options.isDraftMode) {
    return { cacheControl: NO_STORE_CACHE_CONTROL };
  }

  if (options.isForceDynamic || options.dynamicUsedDuringBuild) {
    return { cacheControl: NO_STORE_CACHE_CONTROL };
  }

  // revalidate = 0 means "always dynamic, never cache" — equivalent to
  // force-dynamic for caching purposes. Must be checked before the
  // isForceStatic/isDynamicError branch below, which uses !revalidateSeconds
  // and would incorrectly catch 0 as a falsy value.
  if (options.revalidateSeconds === 0) {
    return { cacheControl: NO_STORE_CACHE_CONTROL };
  }

  if (
    ((options.isForceStatic || options.isDynamicError) && !options.revalidateSeconds) ||
    options.revalidateSeconds === Infinity
  ) {
    return {
      cacheControl: STATIC_CACHE_CONTROL,
      cacheState: "STATIC",
    };
  }

  if (options.revalidateSeconds) {
    return {
      cacheControl: buildRevalidateCacheControl(options.revalidateSeconds, options.expireSeconds),
      // Emit MISS as part of the initial RSC response shape rather than bolting
      // it on later in the cache-write block so response construction stays
      // centralized in this helper. This matches the eventual write path: the
      // first ISR-eligible production response is a cache miss.
      cacheState: options.isProduction ? "MISS" : undefined,
    };
  }

  return {};
}

export function resolveAppPageHtmlResponsePolicy(
  options: ResolveAppPageHtmlResponsePolicyOptions,
): AppPageHtmlResponsePolicy {
  if (options.isDraftMode) {
    return {
      cacheControl: NO_STORE_CACHE_CONTROL,
      shouldWriteToCache: false,
    };
  }

  if (options.isForceDynamic) {
    return {
      cacheControl: NO_STORE_CACHE_CONTROL,
      shouldWriteToCache: false,
    };
  }

  if (options.hasScriptNonce) {
    return {
      cacheControl: NO_STORE_CACHE_CONTROL,
      shouldWriteToCache: false,
    };
  }

  if (options.isProgressiveActionRender) {
    return {
      cacheControl: NO_STORE_CACHE_CONTROL,
      shouldWriteToCache: false,
    };
  }

  // revalidate = 0 means "always dynamic, never cache" — equivalent to
  // force-dynamic for caching purposes. Must be checked before the
  // isForceStatic/isDynamicError branch below, which matches revalidateSeconds
  // === 0 and would incorrectly return a static Cache-Control.
  if (options.revalidateSeconds === 0) {
    return {
      cacheControl: NO_STORE_CACHE_CONTROL,
      shouldWriteToCache: false,
    };
  }

  if ((options.isForceStatic || options.isDynamicError) && options.revalidateSeconds === null) {
    return {
      cacheControl: STATIC_CACHE_CONTROL,
      cacheState: "STATIC",
      shouldWriteToCache: false,
    };
  }

  if (options.dynamicUsedDuringRender) {
    return {
      cacheControl: NO_STORE_CACHE_CONTROL,
      shouldWriteToCache: false,
    };
  }

  if (
    options.revalidateSeconds !== null &&
    options.revalidateSeconds > 0 &&
    options.revalidateSeconds !== Infinity
  ) {
    return {
      cacheControl: buildRevalidateCacheControl(options.revalidateSeconds, options.expireSeconds),
      cacheState: options.isProduction ? "MISS" : undefined,
      shouldWriteToCache: options.isProduction,
    };
  }

  if (options.revalidateSeconds === Infinity) {
    // `revalidate = false` / `revalidate = Infinity` ask for indefinite caching.
    // The downstream Cache-Control header remains STATIC (1y s-maxage), but we
    // also write to the ISR cache so repeated requests inside the same vinext
    // process return identical bytes instead of re-rendering on every hit.
    // This matches Next.js: indefinite-revalidate pages cache their rendered
    // output and only re-render when their tags are explicitly invalidated.
    return {
      cacheControl: STATIC_CACHE_CONTROL,
      cacheState: options.isProduction ? "MISS" : "STATIC",
      shouldWriteToCache: options.isProduction,
    };
  }

  return { shouldWriteToCache: false };
}

export { mergeMiddlewareResponseHeaders };

/**
 * Mirror Next.js' edge-runtime marker (set in edge-ssr-app.ts). Only routes
 * whose resolved segment config is `runtime = "edge"` should advertise it —
 * nodejs-runtime routes must not, otherwise downstream consumers can't tell
 * the configured runtime from the response. Centralized so every response
 * construction site can opt in without re-deriving the header name.
 */
export function applyEdgeRuntimeHeader(headers: Headers, isEdgeRuntime: boolean | undefined): void {
  if (isEdgeRuntime) {
    headers.set("x-edge-runtime", "1");
  }
}

export function buildAppPageRscResponse(
  body: ReadableStream,
  options: BuildAppPageRscResponseOptions,
): Response {
  const headers = new Headers({
    "Content-Type": VINEXT_RSC_CONTENT_TYPE,
    Vary: VINEXT_RSC_VARY_HEADER,
  });

  applyEdgeRuntimeHeader(headers, options.isEdgeRuntime);

  if (options.params && Object.keys(options.params).length > 0) {
    // encodeURIComponent so non-ASCII params (e.g. Korean slugs) survive the
    // HTTP ByteString constraint — Headers.set() rejects chars above U+00FF.
    headers.set(VINEXT_PARAMS_HEADER, encodeURIComponent(JSON.stringify(options.params)));
  }
  if (options.mountedSlotsHeader) {
    headers.set(VINEXT_MOUNTED_SLOTS_HEADER, options.mountedSlotsHeader);
  }
  applyDynamicStaleTimeHeader(headers, options.dynamicStaleTimeSeconds);
  if (options.policy.cacheControl) {
    headers.set("Cache-Control", options.policy.cacheControl);
  }
  if (options.policy.cacheState) {
    setCacheStateHeaders(headers, options.policy.cacheState);
  }
  mergeMiddlewareResponseHeaders(headers, options.middlewareContext.headers);
  applyRscCompatibilityIdHeader(headers);
  applyPrerenderCacheLifeHeader(headers, options.requestCacheLife);

  applyTimingHeader(headers, options.timing);

  return new Response(body, {
    status: options.middlewareContext.status ?? 200,
    headers,
  });
}

export function buildAppPageHtmlResponse(
  body: ReadableStream,
  options: BuildAppPageHtmlResponseOptions,
): Response {
  const headers = new Headers({
    "Content-Type": "text/html; charset=utf-8",
    Vary: VINEXT_RSC_VARY_HEADER,
  });

  applyEdgeRuntimeHeader(headers, options.isEdgeRuntime);

  if (options.policy.cacheControl) {
    headers.set("Cache-Control", options.policy.cacheControl);
  }
  if (options.policy.cacheState) {
    setCacheStateHeaders(headers, options.policy.cacheState);
  }
  if (options.draftCookie) {
    headers.append("Set-Cookie", options.draftCookie);
  }
  if (options.linkHeader) {
    headers.set("Link", options.linkHeader);
  }

  mergeMiddlewareResponseHeaders(headers, options.middlewareContext.headers);
  applyPrerenderCacheLifeHeader(headers, options.requestCacheLife);

  applyTimingHeader(headers, options.timing);

  return new Response(body, {
    status: options.middlewareContext.status ?? 200,
    headers,
  });
}
