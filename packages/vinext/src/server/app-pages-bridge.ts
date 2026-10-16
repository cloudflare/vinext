import type { AppMiddlewareContext } from "./app-middleware.js";
import type { EdgeApiExecutionRuntime } from "./edge-api-runtime.js";
import type { MiddlewareResponseMergeOptions } from "./middleware-response-headers.js";
import { beginRouteCacheability } from "vinext/shims/cacheability-classification";
import { getRequestExecutionContext } from "vinext/shims/request-context";
import { pagesRouteHasPriorityOverAppRoute } from "./hybrid-route-priority.js";
import { cloneRequestWithHeaders, cloneRequestWithUrl } from "./request-pipeline.js";
import { mergeHeaders } from "./worker-utils.js";

export type PagesEntry = {
  handleApiRoute?: (
    request: Request,
    url: string,
    ctx: unknown,
    trustedRevalidateOrigin: string | undefined,
    edgeRuntime: EdgeApiExecutionRuntime,
    initialResponseHeaders?: Headers,
  ) => Promise<Response> | Response;
  matchApiRoute?: (url: string, request: Request) => PagesRouteMatch | null;
  matchPageRoute?: (url: string, request: Request) => PagesRouteMatch | null;
  renderPage?: (
    request: Request,
    url: string,
    query: Record<string, unknown>,
    parsedUrl: unknown,
    middlewareRequestHeaders?: Headers | null,
    options?: { isDataReq?: boolean },
    initialResponseHeaders?: Headers,
  ) => Promise<Response> | Response;
};

type PagesRouteMatch = {
  route: {
    isDynamic: boolean;
    pattern: string;
  };
};

type AppRouteMatch = {
  route: {
    isDynamic: boolean;
    pattern: string;
  };
};

type RenderPagesFallbackDependencies = {
  loadPagesEntry: () => Promise<PagesEntry> | PagesEntry;
  buildRequestHeaders: (
    requestHeaders: Headers,
    middlewareRequestHeaders: Headers,
  ) => Headers | null;
  applyRouteHandlerMiddlewareContext: (
    response: Response,
    middlewareContext: AppMiddlewareContext,
    options?: MiddlewareResponseMergeOptions,
  ) => Response;
  /**
   * Returns the `__prerender_bypass` Set-Cookie header emitted by a
   * `draftMode().enable()`/`disable()` call inside middleware, if any. Reading
   * it clears it. Mirrors how App Router route handlers and page renders surface
   * the middleware-enabled draft cookie so the same flow works when the request
   * falls through to a Pages Router route.
   *
   * Note: this closes the draft-mode flow for production (Cloudflare Workers /
   * Node), where middleware runs inline in the same RSC handler context that
   * builds this fallback. In hybrid *dev*, middleware runs in a separate Vite
   * Pages SSR runner and `draftMode()` inside middleware is not yet permitted
   * there (it throws a scope error before any cookie is set), so this getter
   * returns `null` and no cookie is appended. That dev limitation is pre-existing
   * and tracked separately from #1520.
   */
  getDraftModeCookieHeader: () => string | null | undefined;
};

type RenderPagesFallbackOptions = {
  allowRscDocumentFallback?: boolean;
  appRouteMatch?: AppRouteMatch | null;
  isDataRequest?: boolean;
  isRscRequest: boolean;
  initialResponseHeaders?: Headers;
  matchKind?: "dynamic" | "static";
  middlewareContext: AppMiddlewareContext;
  /** Raw (still percent-encoded) Pages route URL; defaults to `url.pathname`. */
  pathname?: string;
  pagesDataRequest?: Request | null;
  request: Request;
  url: URL;
};

function applyPagesMiddlewareContext(
  response: Response,
  middlewareContext: AppMiddlewareContext,
): Response {
  if (!middlewareContext.headers && middlewareContext.status === null) {
    return response;
  }

  const middlewareHeaders: Record<string, string | string[]> = {};
  if (middlewareContext.headers) {
    for (const [key, value] of middlewareContext.headers) {
      if (key.toLowerCase() !== "set-cookie") {
        middlewareHeaders[key] = value;
      }
    }
    const cookies = middlewareContext.headers.getSetCookie();
    if (cookies.length > 0) {
      middlewareHeaders["set-cookie"] = cookies;
    }
  }

  return mergeHeaders(response, middlewareHeaders, middlewareContext.status ?? undefined);
}

/**
 * Fallback handler to route App Router requests to the Pages Router when no App Router route matches.
 */
export async function renderPagesFallback(
  options: RenderPagesFallbackOptions,
  dependencies: RenderPagesFallbackDependencies,
): Promise<Response | null> {
  const {
    allowRscDocumentFallback = false,
    appRouteMatch = null,
    isDataRequest = false,
    isRscRequest,
    initialResponseHeaders,
    matchKind,
    middlewareContext,
    pathname = options.url.pathname,
    pagesDataRequest = null,
    request,
    url,
  } = options;
  const {
    loadPagesEntry,
    buildRequestHeaders,
    applyRouteHandlerMiddlewareContext,
    getDraftModeCookieHeader,
  } = dependencies;

  if (isRscRequest && !allowRscDocumentFallback) return null;

  const pagesEntry = await loadPagesEntry();

  const pagesRequestHeaders = middlewareContext.requestHeaders
    ? buildRequestHeaders(request.headers, middlewareContext.requestHeaders)
    : null;

  // Matching only reads headers. Moving the body into a header-overriding
  // clone before a Pages route claims the request would leave it unusable for
  // the App Router when no Pages route matches.
  const matchRequest = pagesRequestHeaders
    ? new Request(request.url, { headers: pagesRequestHeaders, method: request.method })
    : request;
  const claimPagesRequest = () =>
    pagesRequestHeaders ? cloneRequestWithHeaders(request, pagesRequestHeaders) : request;

  const queryIndex = pathname.indexOf("?");
  const pagesPathname = queryIndex === -1 ? pathname : pathname.slice(0, queryIndex);
  const pagesSearch = queryIndex === -1 ? url.search || "" : pathname.slice(queryIndex);
  // `pathname` is the raw Pages route identity, as in the Pages-only pipeline:
  // the route trie decodes dynamic captures once. Decoding it here would let
  // `/%66r/...` select the `fr` locale (and `/%61bout` select `/about`) after
  // middleware matched the encoded spelling, and decode dynamic params twice.
  const pagesUrl = pagesPathname + pagesSearch;
  if (pagesPathname.startsWith("/api/") || pagesPathname === "/api") {
    if (typeof pagesEntry.handleApiRoute !== "function") return null;
    const hasApiMatcher = typeof pagesEntry.matchApiRoute === "function";
    const apiMatch = hasApiMatcher
      ? (pagesEntry.matchApiRoute?.(pagesUrl, matchRequest) ?? null)
      : null;
    if (hasApiMatcher && apiMatch === null) return null;
    if (apiMatch !== null && matchKind === "static" && apiMatch.route.isDynamic) return null;
    if (apiMatch !== null && matchKind === "dynamic" && !apiMatch.route.isDynamic) return null;
    if (appRouteMatch !== null) {
      if (
        apiMatch === null ||
        !pagesRouteHasPriorityOverAppRoute(apiMatch.route, appRouteMatch.route)
      ) {
        return null;
      }
    }
    if (apiMatch !== null) {
      beginRouteCacheability("pages-api", apiMatch.route.pattern);
    }
    const executionContext = getRequestExecutionContext();
    const pagesRequest = claimPagesRequest();
    const apiArgs = [
      pagesRequest,
      pagesUrl,
      executionContext ?? undefined,
      executionContext?.trustedRevalidateOrigin ?? new URL(pagesRequest.url).origin,
      executionContext?.hostRuntime ?? "node",
    ] as const;
    const pagesApiResponse = await (initialResponseHeaders
      ? pagesEntry.handleApiRoute(...apiArgs, initialResponseHeaders)
      : pagesEntry.handleApiRoute(...apiArgs));
    const draftCookie = getDraftModeCookieHeader();
    return applyDraftModeCookie(
      // A Node-runtime Pages API handler in Next.js writes to the response that
      // already holds middleware's headers, so its challenges replace
      // middleware's rather than joining them.
      applyRouteHandlerMiddlewareContext(pagesApiResponse, middlewareContext, {
        appendResponseChallenges: false,
      }),
      draftCookie,
    );
  }

  if (typeof pagesEntry.renderPage !== "function") return null;
  const hasPageMatcher = typeof pagesEntry.matchPageRoute === "function";
  const pageMatch = hasPageMatcher
    ? (pagesEntry.matchPageRoute?.(pagesUrl, matchRequest) ?? null)
    : null;
  if (hasPageMatcher && pageMatch === null) return null;
  if (pageMatch !== null && matchKind === "static" && pageMatch.route.isDynamic) return null;
  if (pageMatch !== null && matchKind === "dynamic" && !pageMatch.route.isDynamic) return null;
  if (
    appRouteMatch !== null &&
    (pageMatch === null || !pagesRouteHasPriorityOverAppRoute(pageMatch.route, appRouteMatch.route))
  ) {
    return null;
  }
  if (pageMatch !== null) {
    // The bridge runs in the App request environment, while the Pages renderer
    // can use a separate module graph. Register ownership here so the outer
    // admission finalizer can apply the Pages manifest decision.
    beginRouteCacheability("pages-page", pageMatch.route.pattern);
  }
  const pagesRequest = claimPagesRequest();
  const renderRequest = pagesDataRequest
    ? cloneRequestWithUrl(pagesRequest, pagesDataRequest.url)
    : pagesRequest;
  const renderArgs = [
    renderRequest,
    pagesUrl,
    {},
    getRequestExecutionContext() ?? undefined,
    middlewareContext.requestHeaders,
  ] as const;
  const pagesRes = isDataRequest
    ? await (initialResponseHeaders
        ? pagesEntry.renderPage(...renderArgs, { isDataReq: true }, initialResponseHeaders)
        : pagesEntry.renderPage(...renderArgs, { isDataReq: true }))
    : await (initialResponseHeaders
        ? pagesEntry.renderPage(...renderArgs, undefined, initialResponseHeaders)
        : pagesEntry.renderPage(...renderArgs));
  if (pagesRes.status === 404 && pageMatch === null) return null;
  return applyDraftModeCookie(
    applyPagesMiddlewareContext(pagesRes, middlewareContext),
    getDraftModeCookieHeader(),
  );
}

/**
 * Append a middleware-emitted `__prerender_bypass` Set-Cookie header to a Pages
 * Router fallback response. Returns the response unchanged when there is no
 * draft cookie to add. App Router route handlers/page renders surface this same
 * cookie via `finalizeRouteHandlerResponse`/the page response builder; this
 * keeps draft-mode parity for requests that fall through to the Pages Router.
 */
function applyDraftModeCookie(
  response: Response,
  draftCookie: string | null | undefined,
): Response {
  if (!draftCookie) return response;
  const headers = new Headers(response.headers);
  headers.append("Set-Cookie", draftCookie);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
