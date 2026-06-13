import type { CachedRouteValue, CacheControlMetadata } from "vinext/shims/cache";
import { applyCdnResponseHeaders } from "./cache-control.js";
import { decideIsr, buildAppRouteMissIsrCacheControl } from "./isr-decision.js";
import {
  MIDDLEWARE_HEADER_PREFIX,
  MIDDLEWARE_NEXT_HEADER,
  MIDDLEWARE_REWRITE_HEADER,
  NEXTJS_CACHE_HEADER,
  VINEXT_CACHE_HEADER,
} from "./headers.js";
import { setCacheStateHeaders } from "./cache-headers.js";
import { mergeMiddlewareResponseHeaders } from "./middleware-response-headers.js";
import { processMiddlewareHeaders } from "./request-pipeline.js";
import { getSetCookieName } from "./cookie-utils.js";

export type RouteHandlerMiddlewareContext = {
  headers: Headers | null;
  status: number | null;
};

type BuildRouteHandlerCachedResponseOptions = {
  cacheControl?: CacheControlMetadata;
  cacheState: "HIT" | "STALE";
  expireSeconds?: number;
  isHead: boolean;
  revalidateSeconds: number;
};

type FinalizeRouteHandlerResponseOptions = {
  pendingCookies: string[];
  draftCookie?: string | null;
  isHead: boolean;
};

const APP_ROUTE_REWRITE_ERROR =
  "NextResponse.rewrite() was used in a app route handler, this is not currently supported. Please remove the invocation to continue.";
const APP_ROUTE_NEXT_ERROR =
  "NextResponse.next() was used in a app route handler, this is not supported. See here for more info: https://nextjs.org/docs/messages/next-response-next-in-app-route-handler";

function hasMiddlewareHeader(headers: Headers): boolean {
  for (const key of headers.keys()) {
    if (key.startsWith(MIDDLEWARE_HEADER_PREFIX)) return true;
  }
  return false;
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
  if (response.headers.has(MIDDLEWARE_REWRITE_HEADER)) {
    throw new Error(APP_ROUTE_REWRITE_ERROR);
  }

  if (response.headers.get(MIDDLEWARE_NEXT_HEADER) === "1") {
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
  setCacheStateHeaders(headers, options.cacheState);
  // HIT/STALE served from the origin store: route the cache header through the
  // CDN adapter (default: identical single Cache-Control). Edge adapters never
  // reach this path because their get() returns null.
  const { cacheControl } = decideIsr({
    cacheState: options.cacheState,
    kind: "app-route",
    revalidateSeconds: options.revalidateSeconds,
    expireSeconds: options.expireSeconds,
    cacheControlMeta: options.cacheControl,
  });
  applyCdnResponseHeaders(headers, { cacheControl });

  return new Response(options.isHead ? null : cachedValue.body, {
    status: cachedValue.status,
    headers,
  });
}

export function applyRouteHandlerRevalidateHeader(
  response: Response,
  revalidateSeconds: number,
  expireSeconds?: number,
  tags?: readonly string[],
): void {
  // Fresh (MISS) response: route through the CDN adapter so edge adapters emit
  // CDN-Cache-Control + Cache-Tag while the default emits a single Cache-Control.
  // Uses buildAppRouteMissIsrCacheControl so the revalidate=0→NEVER and
  // Infinity→STATIC gates apply, and expireSeconds is used as the direct route
  // config ceiling (not a per-entry metadata fallback).
  applyCdnResponseHeaders(response.headers, {
    cacheControl: buildAppRouteMissIsrCacheControl(revalidateSeconds, expireSeconds),
    tags,
  });
}

export function markRouteHandlerCacheMiss(response: Response): void {
  setCacheStateHeaders(response.headers, "MISS");
}

/**
 * Returns true when the given Set-Cookie string already declares any of the
 * attributes that follow the first `;` (case-insensitively). Used to detect
 * whether a user-emitted Set-Cookie line already carries an explicit `Path=`,
 * matching Next.js's `appendMutableCookies` which re-runs every cookie through
 * `ResponseCookies.set` (and therefore picks up the `Path=/` default for any
 * cookie that didn't supply one).
 */
function hasCookieAttribute(cookie: string, attributeName: string): boolean {
  const target = attributeName.toLowerCase();
  // Skip past the first '=' (the cookie value separator) so we don't match
  // `attributeName=` inside the cookie value itself.
  let i = cookie.indexOf(";");
  while (i !== -1) {
    // Trim leading whitespace after the ';'
    let start = i + 1;
    while (start < cookie.length && cookie[start] === " ") start++;
    const next = cookie.indexOf(";", start);
    const end = next === -1 ? cookie.length : next;
    const eq = cookie.indexOf("=", start);
    const attrEnd = eq === -1 || eq > end ? end : eq;
    const attr = cookie.slice(start, attrEnd).trim().toLowerCase();
    if (attr === target) {
      return true;
    }
    i = next;
  }
  return false;
}

/**
 * Ensure each Set-Cookie line carries `Path=/` by default — Next.js's
 * `appendMutableCookies` re-runs every returned cookie through
 * `ResponseCookies.set`, which normalises a missing `path` to `/`. Without
 * this, a raw `new Response(..., { headers: [['Set-Cookie', 'bar=bar2']] })`
 * lands without `Path=/` and tests that assert on the full attribute set
 * (e.g. Next.js's `app-action.test.ts` route-handler-overrides case, see
 * issue #1484) break.
 */
function normalizeReturnedCookie(cookie: string): string {
  if (hasCookieAttribute(cookie, "Path")) {
    return cookie;
  }
  const trimmed = cookie.replace(/;\s*$/, "");
  return `${trimmed}; Path=/`;
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
    headers.append("Set-Cookie", normalizeReturnedCookie(cookie));
  }
}

export async function buildAppRouteCacheValue(response: Response): Promise<CachedRouteValue> {
  const body = await response.arrayBuffer();
  const headers: CachedRouteValue["headers"] = {};

  response.headers.forEach((value, key) => {
    if (
      key === "set-cookie" ||
      key === VINEXT_CACHE_HEADER.toLowerCase() ||
      key === NEXTJS_CACHE_HEADER.toLowerCase() ||
      key === "cache-control" ||
      key.startsWith(MIDDLEWARE_HEADER_PREFIX)
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
