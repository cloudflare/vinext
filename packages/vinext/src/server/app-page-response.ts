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
  renderHeaders?: Record<string, string | string[]>;
  timing?: AppPageResponseTiming;
}

export interface BuildAppPageHtmlResponseOptions {
  draftCookie?: string | null;
  fontLinkHeader?: string;
  middlewareContext: AppPageMiddlewareContext;
  policy: AppPageResponsePolicy;
  renderHeaders?: Record<string, string | string[]>;
  timing?: AppPageResponseTiming;
}

const STATIC_CACHE_CONTROL = "s-maxage=31536000, stale-while-revalidate";
const NO_STORE_CACHE_CONTROL = "no-store, must-revalidate";

type ResponseHeaderSource = Headers | Record<string, string | string[]>;
type ResponseHeaderMergeMode = "fallback" | "override";

function buildRevalidateCacheControl(revalidateSeconds: number): string {
  return `s-maxage=${revalidateSeconds}, stale-while-revalidate`;
}

function isAppendOnlyResponseHeader(lowerKey: string): boolean {
  return (
    lowerKey === "set-cookie" ||
    lowerKey === "vary" ||
    lowerKey === "www-authenticate" ||
    lowerKey === "proxy-authenticate"
  );
}

function mergeResponseHeaderValues(
  targetHeaders: Headers,
  key: string,
  value: string | string[],
  mode: ResponseHeaderMergeMode,
): void {
  const lowerKey = key.toLowerCase();
  const values = Array.isArray(value) ? value : [value];

  if (isAppendOnlyResponseHeader(lowerKey)) {
    for (const item of values) {
      targetHeaders.append(key, item);
    }
    return;
  }

  if (mode === "fallback" && targetHeaders.has(key)) {
    return;
  }

  targetHeaders.delete(key);
  if (values.length === 1) {
    targetHeaders.set(key, values[0]!);
    return;
  }

  for (const item of values) {
    targetHeaders.append(key, item);
  }
}

function mergeResponseHeaders(
  targetHeaders: Headers,
  sourceHeaders: ResponseHeaderSource | null | undefined,
  mode: ResponseHeaderMergeMode,
): void {
  if (!sourceHeaders) {
    return;
  }

  if (sourceHeaders instanceof Headers) {
    const setCookies = sourceHeaders.getSetCookie();
    for (const [key, value] of sourceHeaders) {
      if (key.toLowerCase() === "set-cookie") {
        continue;
      }
      mergeResponseHeaderValues(targetHeaders, key, value, mode);
    }
    for (const cookie of setCookies) {
      targetHeaders.append("Set-Cookie", cookie);
    }
    return;
  }

  for (const [key, value] of Object.entries(sourceHeaders)) {
    mergeResponseHeaderValues(targetHeaders, key, value, mode);
  }
}

function headersWithRenderResponseHeaders(
  baseHeaders: ResponseHeaderSource,
  renderHeaders: Record<string, string | string[]> | undefined,
): Headers {
  const headers = new Headers();
  mergeResponseHeaders(headers, renderHeaders, "fallback");
  mergeResponseHeaders(headers, baseHeaders, "override");
  return headers;
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
  const baseHeaders = new Headers({
    "Content-Type": "text/x-component; charset=utf-8",
    Vary: "RSC, Accept",
  });

  if (options.params && Object.keys(options.params).length > 0) {
    baseHeaders.set("X-Vinext-Params", JSON.stringify(options.params));
  }
  if (options.policy.cacheControl) {
    baseHeaders.set("Cache-Control", options.policy.cacheControl);
  }
  if (options.policy.cacheState) {
    baseHeaders.set("X-Vinext-Cache", options.policy.cacheState);
  }

  const headers = headersWithRenderResponseHeaders(baseHeaders, options.renderHeaders);
  mergeResponseHeaders(headers, options.middlewareContext.headers, "override");

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
  const baseHeaders = new Headers({
    "Content-Type": "text/html; charset=utf-8",
    Vary: "RSC, Accept",
  });

  if (options.policy.cacheControl) {
    baseHeaders.set("Cache-Control", options.policy.cacheControl);
  }
  if (options.policy.cacheState) {
    baseHeaders.set("X-Vinext-Cache", options.policy.cacheState);
  }
  if (options.draftCookie) {
    baseHeaders.append("Set-Cookie", options.draftCookie);
  }
  if (options.fontLinkHeader) {
    baseHeaders.set("Link", options.fontLinkHeader);
  }

  const headers = headersWithRenderResponseHeaders(baseHeaders, options.renderHeaders);
  mergeResponseHeaders(headers, options.middlewareContext.headers, "override");

  applyTimingHeader(headers, options.timing);

  return new Response(body, {
    status: options.middlewareContext.status ?? 200,
    headers,
  });
}
