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

export type AppPageResponsePolicy = {
  cacheControl?: string;
  cacheState?: "MISS" | "STATIC";
};

type ResolveAppPageResponsePolicyBaseOptions = {
  isDynamicError: boolean;
  isForceDynamic: boolean;
  isForceStatic: boolean;
  isProduction: boolean;
  revalidateSeconds: number | null;
};

export type ResolveAppPageRscResponsePolicyOptions = {
  dynamicUsedDuringBuild: boolean;
} & ResolveAppPageResponsePolicyBaseOptions;

export type ResolveAppPageHtmlResponsePolicyOptions = {
  dynamicUsedDuringRender: boolean;
} & ResolveAppPageResponsePolicyBaseOptions;

export type AppPageHtmlResponsePolicy = {
  shouldWriteToCache: boolean;
} & AppPageResponsePolicy;

export type BuildAppPageRscResponseOptions = {
  middlewareContext: AppPageMiddlewareContext;
  params?: Record<string, unknown>;
  policy: AppPageResponsePolicy;
  timing?: AppPageResponseTiming;
};

export type BuildAppPageHtmlResponseOptions = {
  draftCookie?: string | null;
  fontLinkHeader?: string;
  middlewareContext: AppPageMiddlewareContext;
  policy: AppPageResponsePolicy;
  timing?: AppPageResponseTiming;
};

const STATIC_CACHE_CONTROL = "s-maxage=31536000, stale-while-revalidate";
const NO_STORE_CACHE_CONTROL = "no-store, must-revalidate";

function buildRevalidateCacheControl(revalidateSeconds: number): string {
  return `s-maxage=${revalidateSeconds}, stale-while-revalidate`;
}

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

  headers.set("x-vinext-timing", `${handlerStart},${compileMs},${renderMs}`);
}

export function resolveAppPageRscResponsePolicy(
  options: ResolveAppPageRscResponsePolicyOptions,
): AppPageResponsePolicy {
  if (options.isForceDynamic || options.dynamicUsedDuringBuild) {
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
      cacheControl: buildRevalidateCacheControl(options.revalidateSeconds),
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
  if (options.isForceDynamic) {
    return {
      cacheControl: NO_STORE_CACHE_CONTROL,
      shouldWriteToCache: false,
    };
  }

  if (
    (options.isForceStatic || options.isDynamicError) &&
    (options.revalidateSeconds === null || options.revalidateSeconds === 0)
  ) {
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
      cacheControl: buildRevalidateCacheControl(options.revalidateSeconds),
      cacheState: options.isProduction ? "MISS" : undefined,
      shouldWriteToCache: options.isProduction,
    };
  }

  if (options.revalidateSeconds === Infinity) {
    return {
      cacheControl: STATIC_CACHE_CONTROL,
      cacheState: "STATIC",
      shouldWriteToCache: false,
    };
  }

  return { shouldWriteToCache: false };
}

/**
 * Merge middleware response headers into a target Headers object.
 *
 * Set-Cookie and Vary are accumulated (append) since multiple sources can
 * contribute values. All other headers use set() so middleware owns singular
 * response headers like Cache-Control.
 *
 * Used by buildAppPageRscResponse and the generated entry for intercepting
 * route and server action responses that bypass the normal page render path.
 */
export function mergeMiddlewareResponseHeaders(
  target: Headers,
  middlewareHeaders: Headers | null,
): void {
  if (!middlewareHeaders) {
    return;
  }

  for (const [key, value] of middlewareHeaders) {
    const lowerKey = key.toLowerCase();
    if (lowerKey === "set-cookie" || lowerKey === "vary") {
      target.append(key, value);
    } else {
      target.set(key, value);
    }
  }
}

export function buildAppPageRscResponse(
  body: ReadableStream,
  options: BuildAppPageRscResponseOptions,
): Response {
  const headers = new Headers({
    "Content-Type": "text/x-component; charset=utf-8",
    Vary: "RSC, Accept",
  });

  if (options.params && Object.keys(options.params).length > 0) {
    // encodeURIComponent so non-ASCII params (e.g. Korean slugs) survive the
    // HTTP ByteString constraint — Headers.set() rejects chars above U+00FF.
    headers.set("X-Vinext-Params", encodeURIComponent(JSON.stringify(options.params)));
  }
  if (options.policy.cacheControl) {
    headers.set("Cache-Control", options.policy.cacheControl);
  }
  if (options.policy.cacheState) {
    headers.set("X-Vinext-Cache", options.policy.cacheState);
  }

  mergeMiddlewareResponseHeaders(headers, options.middlewareContext.headers);

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
    Vary: "RSC, Accept",
  });

  if (options.policy.cacheControl) {
    headers.set("Cache-Control", options.policy.cacheControl);
  }
  if (options.policy.cacheState) {
    headers.set("X-Vinext-Cache", options.policy.cacheState);
  }
  if (options.draftCookie) {
    headers.append("Set-Cookie", options.draftCookie);
  }
  if (options.fontLinkHeader) {
    headers.set("Link", options.fontLinkHeader);
  }

  if (options.middlewareContext.headers) {
    for (const [key, value] of options.middlewareContext.headers) {
      headers.append(key, value);
    }
  }

  applyTimingHeader(headers, options.timing);

  return new Response(body, {
    status: options.middlewareContext.status ?? 200,
    headers,
  });
}
