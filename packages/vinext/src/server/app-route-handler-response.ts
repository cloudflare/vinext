import type { CachedRouteValue } from "../shims/cache.js";

export type RouteHandlerMiddlewareContext = {
  headers: Headers | null;
  status: number | null;
};

export type BuildRouteHandlerCachedResponseOptions = {
  cacheState: "HIT" | "STALE";
  isHead: boolean;
  revalidateSeconds: number;
};

export type FinalizeRouteHandlerResponseOptions = {
  pendingCookies: string[];
  draftCookie?: string | null;
  isHead: boolean;
};

function buildRouteHandlerCacheControl(
  cacheState: BuildRouteHandlerCachedResponseOptions["cacheState"],
  revalidateSeconds: number,
): string {
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
  if (middlewareContext.headers) {
    for (const [key, value] of middlewareContext.headers) {
      responseHeaders.append(key, value);
    }
  }

  return new Response(response.body, {
    status: middlewareContext.status ?? response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  });
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
    if (key === "set-cookie" || key === "x-vinext-cache" || key === "cache-control") return;
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
  if (pendingCookies.length === 0 && !draftCookie && !isHead) {
    return response;
  }

  const headers = new Headers(response.headers);
  for (const cookie of pendingCookies) {
    headers.append("Set-Cookie", cookie);
  }
  if (draftCookie) {
    headers.append("Set-Cookie", draftCookie);
  }

  return new Response(isHead ? null : response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
