import type { CachedRouteValue } from "../shims/cache.js";

export interface RouteHandlerMiddlewareContext {
  headers: Headers | null;
  status: number | null;
}

export interface BuildRouteHandlerCachedResponseOptions {
  cacheState: "HIT" | "STALE";
  isHead: boolean;
  revalidateSeconds: number;
}

export interface ApplyRouteHandlerMiddlewareContextOptions {
  applyRewriteStatus?: boolean;
}

export interface FinalizeRouteHandlerResponseOptions {
  isHead: boolean;
  renderHeaders?: Record<string, string | string[]>;
}

type ResponseHeaderSource = Headers | Record<string, string | string[]>;
type ResponseHeaderMergeMode = "fallback" | "override";

function buildRouteHandlerCacheControl(
  cacheState: BuildRouteHandlerCachedResponseOptions["cacheState"],
  revalidateSeconds: number,
): string {
  if (cacheState === "STALE") {
    return "s-maxage=0, stale-while-revalidate";
  }

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

export function applyRouteHandlerMiddlewareContext(
  response: Response,
  middlewareContext: RouteHandlerMiddlewareContext,
  options?: ApplyRouteHandlerMiddlewareContextOptions,
): Response {
  const rewriteStatus = options?.applyRewriteStatus === false ? null : middlewareContext.status;

  if (!middlewareContext.headers && rewriteStatus == null) {
    return response;
  }

  const responseHeaders = new Headers(response.headers);
  mergeResponseHeaders(responseHeaders, middlewareContext.headers, "override");

  const status = rewriteStatus ?? response.status;
  const responseInit: ResponseInit = {
    status,
    headers: responseHeaders,
  };

  if (status === response.status && response.statusText) {
    responseInit.statusText = response.statusText;
  }

  return new Response(response.body, responseInit);
}

export function buildRouteHandlerCachedResponse(
  cachedValue: CachedRouteValue,
  options: BuildRouteHandlerCachedResponseOptions,
): Response {
  const headers = new Headers();
  for (const [key, value] of Object.entries(cachedValue.headers)) {
    if (Array.isArray(value)) {
      for (const entry of value) {
        headers.append(key, entry);
      }
    } else {
      headers.set(key, value);
    }
  }
  headers.set("X-Vinext-Cache", options.cacheState);
  headers.set(
    "Cache-Control",
    buildRouteHandlerCacheControl(options.cacheState, options.revalidateSeconds),
  );

  return new Response(options.isHead ? null : cachedValue.body, {
    status: cachedValue.status,
    headers,
  });
}

export function applyRouteHandlerRevalidateHeader(
  response: Response,
  revalidateSeconds: number,
): void {
  response.headers.set("cache-control", buildRouteHandlerCacheControl("HIT", revalidateSeconds));
}

export function markRouteHandlerCacheMiss(response: Response): void {
  response.headers.set("X-Vinext-Cache", "MISS");
}

export async function buildAppRouteCacheValue(response: Response): Promise<CachedRouteValue> {
  const body = await response.arrayBuffer();
  const headers: CachedRouteValue["headers"] = {};

  response.headers.forEach((value, key) => {
    if (key !== "x-vinext-cache" && key !== "cache-control") {
      headers[key] = value;
    }
  });

  return {
    kind: "APP_ROUTE",
    body,
    status: response.status,
    headers,
  };
}

export function finalizeRouteHandlerResponse(
  response: Response,
  options: FinalizeRouteHandlerResponseOptions,
): Response {
  const { isHead, renderHeaders } = options;
  if (!renderHeaders && !isHead) {
    return response;
  }

  const headers = headersWithRenderResponseHeaders(response.headers, renderHeaders);
  const responseInit: ResponseInit = {
    status: response.status,
    headers,
  };

  if (response.statusText) {
    responseInit.statusText = response.statusText;
  }

  return new Response(isHead ? null : response.body, responseInit);
}
