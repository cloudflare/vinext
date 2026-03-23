export interface AppPageMiddlewareContext {
  headers: Headers | null;
  status: number | null;
}

export interface AppPageResponseTiming {
  compileEnd?: number;
  handlerStart: number;
  renderEnd?: number;
  responseKind: "html" | "rsc";
}

export interface AppPageResponsePolicy {
  cacheControl?: string;
  cacheState?: "MISS" | "STATIC";
}

interface ResolveAppPageResponsePolicyBaseOptions {
  isDynamicError: boolean;
  isForceDynamic: boolean;
  isForceStatic: boolean;
  isProduction: boolean;
  revalidateSeconds: number | null;
}

export interface ResolveAppPageRscResponsePolicyOptions extends ResolveAppPageResponsePolicyBaseOptions {
  dynamicUsedDuringBuild: boolean;
}

export interface ResolveAppPageHtmlResponsePolicyOptions extends ResolveAppPageResponsePolicyBaseOptions {
  dynamicUsedDuringRender: boolean;
}

export interface AppPageHtmlResponsePolicy extends AppPageResponsePolicy {
  shouldWriteToCache: boolean;
}

export interface BuildAppPageRscResponseOptions {
  middlewareContext: AppPageMiddlewareContext;
  params?: Record<string, unknown>;
  policy: AppPageResponsePolicy;
  timing?: AppPageResponseTiming;
}

export interface BuildAppPageHtmlResponseOptions {
  draftCookie?: string | null;
  fontLinkHeader?: string;
  middlewareContext: AppPageMiddlewareContext;
  policy: AppPageResponsePolicy;
  timing?: AppPageResponseTiming;
}

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

export function buildAppPageRscResponse(
  body: ReadableStream,
  options: BuildAppPageRscResponseOptions,
): Response {
  const headers = new Headers({
    "Content-Type": "text/x-component; charset=utf-8",
    Vary: "RSC, Accept",
  });

  if (options.params && Object.keys(options.params).length > 0) {
    headers.set("X-Vinext-Params", JSON.stringify(options.params));
  }
  if (options.policy.cacheControl) {
    headers.set("Cache-Control", options.policy.cacheControl);
  }
  if (options.policy.cacheState) {
    headers.set("X-Vinext-Cache", options.policy.cacheState);
  }

  if (options.middlewareContext.headers) {
    for (const [key, value] of options.middlewareContext.headers) {
      const lowerKey = key.toLowerCase();
      if (lowerKey === "set-cookie" || lowerKey === "vary") {
        headers.append(key, value);
      } else {
        // Keep parity with the old inline RSC path: middleware owns singular
        // response headers like Cache-Control here, while Set-Cookie and Vary
        // are accumulated. The HTML helper intentionally keeps its legacy
        // append-for-everything behavior below.
        headers.set(key, value);
      }
    }
  }

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
