import type { CachedRouteValue } from "../shims/cache.js";
import { mergeMiddlewareResponseHeaders } from "./middleware-response-headers.js";
import { processMiddlewareHeaders } from "./request-pipeline.js";

export type RouteHandlerMiddlewareContext = {
  headers: Headers | null;
  status: number | null;
};

type BuildRouteHandlerCachedResponseOptions = {
  cacheState: "HIT" | "STALE";
  isHead: boolean;
  revalidateSeconds: number;
};

type FinalizeRouteHandlerResponseOptions = {
  pendingCookies: string[];
  draftCookie?: string | null;
  isHead: boolean;
};

// Matches Next.js's getCacheControlHeader for revalidate === 0.
// See .nextjs-ref/packages/next/src/server/lib/cache-control.ts.
const NEVER_CACHE_CONTROL = "private, no-cache, no-store, max-age=0, must-revalidate";

const APP_ROUTE_REWRITE_ERROR =
  "NextResponse.rewrite() was used in a app route handler, this is not currently supported. Please remove the invocation to continue.";
const APP_ROUTE_NEXT_ERROR =
  "NextResponse.next() was used in a app route handler, this is not supported. See here for more info: https://nextjs.org/docs/messages/next-response-next-in-app-route-handler";

function hasMiddlewareHeader(headers: Headers): boolean {
  for (const key of headers.keys()) {
    if (key.startsWith("x-middleware-")) return true;
  }
  return false;
}

function buildRouteHandlerCacheControl(
  cacheState: BuildRouteHandlerCachedResponseOptions["cacheState"],
  revalidateSeconds: number,
): string {
  if (revalidateSeconds === 0) {
    // A cached response is never produced for revalidate = 0 (the ISR write
    // path skips it), so only the HIT/STALE->fresh rewrite can arrive here
    // with a 0 value, via applyRouteHandlerRevalidateHeader. In all such
    // cases the author opted out of caching entirely.
    return NEVER_CACHE_CONTROL;
  }

  if (cacheState === "STALE") {
    return "s-maxage=0, stale-while-revalidate";
  }

  return `s-maxage=${revalidateSeconds}, stale-while-revalidate`;
}

export function applyRouteHandlerMiddlewareContext(
  response: Response,
  middlewareContext: RouteHandlerMiddlewareContext,
): Response {
  if (!middlewareContext.headers && middlewareContext.status == null) {
    return response;
  }

  const responseHeaders = new Headers(response.headers);
  mergeMiddlewareResponseHeaders(responseHeaders, middlewareContext.headers);

  return new Response(response.body, {
    status: middlewareContext.status ?? response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  });
}

export function assertSupportedAppRouteHandlerResponse(response: Response): void {
  // NextResponse.next() and rewrite() are middleware control-flow signals.
  // Once an App Route handler has returned, Next.js rejects those responses.
  if (response.headers.has("x-middleware-rewrite")) {
    throw new Error(APP_ROUTE_REWRITE_ERROR);
  }

  if (response.headers.get("x-middleware-next") === "1") {
    throw new Error(APP_ROUTE_NEXT_ERROR);
  }
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

function getSetCookieName(cookie: string): string | null {
  const equalsIndex = cookie.indexOf("=");
  if (equalsIndex <= 0) {
    return null;
  }
  return cookie.slice(0, equalsIndex);
}

function applyMutableCookieFallbacks(headers: Headers, pendingCookies: string[]): void {
  if (pendingCookies.length === 0) {
    return;
  }

  const returnedCookies = headers.getSetCookie();
  const returnedCookieNames = new Set<string>();
  for (const cookie of returnedCookies) {
    const name = getSetCookieName(cookie);
    if (name) {
      returnedCookieNames.add(name);
    }
  }

  const fallbackCookies = new Map<string, string>();
  const unkeyedFallbackCookies: string[] = [];
  for (const cookie of pendingCookies) {
    const name = getSetCookieName(cookie);
    if (!name) {
      unkeyedFallbackCookies.push(cookie);
      continue;
    }

    if (!returnedCookieNames.has(name)) {
      fallbackCookies.set(name, cookie);
    }
  }

  headers.delete("Set-Cookie");
  for (const cookie of unkeyedFallbackCookies) {
    headers.append("Set-Cookie", cookie);
  }
  for (const cookie of fallbackCookies.values()) {
    headers.append("Set-Cookie", cookie);
  }
  for (const cookie of returnedCookies) {
    headers.append("Set-Cookie", cookie);
  }
}

export async function buildAppRouteCacheValue(response: Response): Promise<CachedRouteValue> {
  const body = await response.arrayBuffer();
  const headers: CachedRouteValue["headers"] = {};

  response.headers.forEach((value, key) => {
    if (
      key === "set-cookie" ||
      key === "x-vinext-cache" ||
      key === "cache-control" ||
      key.startsWith("x-middleware-")
    ) {
      return;
    }
    headers[key] = value;
  });
  const setCookies = response.headers.getSetCookie?.() ?? [];
  if (setCookies.length > 0) {
    headers["set-cookie"] = setCookies;
  }

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
  const { pendingCookies, draftCookie, isHead } = options;
  if (
    pendingCookies.length === 0 &&
    !draftCookie &&
    !isHead &&
    !hasMiddlewareHeader(response.headers)
  ) {
    return response;
  }

  const headers = new Headers(response.headers);
  processMiddlewareHeaders(headers);
  applyMutableCookieFallbacks(headers, pendingCookies);
  if (draftCookie) {
    headers.append("Set-Cookie", draftCookie);
  }

  return new Response(isHead ? null : response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
