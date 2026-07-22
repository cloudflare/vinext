import type { AppMiddlewareContext } from "./app-middleware.js";
import { getRequestExecutionContext } from "vinext/shims/request-context";
import { pagesRouteHasPriorityOverAppRoute } from "./hybrid-route-priority.js";
import { cloneRequestWithHeaders, cloneRequestWithUrl } from "./request-pipeline.js";

export type PagesEntry = {
  handleApiRoute?: (
    request: Request,
    url: string,
    ctx?: unknown,
    trustedRevalidateOrigin?: string,
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
  decodePathParams: (pathname: string) => string;
  applyRouteHandlerMiddlewareContext: (
    response: Response,
    middlewareContext: AppMiddlewareContext,
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
  matchKind?: "dynamic" | "static";
  middlewareContext: AppMiddlewareContext;
  pathname?: string;
  pagesDataRequest?: Request | null;
  request: Request;
  url: URL;
};

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
    decodePathParams,
    applyRouteHandlerMiddlewareContext,
    getDraftModeCookieHeader,
  } = dependencies;

  if (isRscRequest && !allowRscDocumentFallback) return null;

  const pagesEntry = await loadPagesEntry();

  const pagesRequestHeaders = middlewareContext.requestHeaders
    ? buildRequestHeaders(request.headers, middlewareContext.requestHeaders)
    : null;

  let pagesRequest = request;
  if (pagesRequestHeaders) {
    pagesRequest = cloneRequestWithHeaders(request, pagesRequestHeaders);
  }

  const queryIndex = pathname.indexOf("?");
  const pagesPathname = queryIndex === -1 ? pathname : pathname.slice(0, queryIndex);
  const pagesSearch = queryIndex === -1 ? url.search || "" : pathname.slice(queryIndex);
  const pagesUrl = decodePathParams(pagesPathname) + pagesSearch;
  if (pagesPathname.startsWith("/api/") || pagesPathname === "/api") {
    if (typeof pagesEntry.handleApiRoute !== "function") return null;
    const hasApiMatcher = typeof pagesEntry.matchApiRoute === "function";
    const apiMatch = hasApiMatcher
      ? (pagesEntry.matchApiRoute?.(pagesUrl, pagesRequest) ?? null)
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
    const pagesApiResponse = await pagesEntry.handleApiRoute(
      pagesRequest,
      pagesUrl,
      undefined,
      getRequestExecutionContext()?.trustedRevalidateOrigin ?? new URL(pagesRequest.url).origin,
    );
    const draftCookie = getDraftModeCookieHeader();
    return applyDraftModeCookie(
      applyRouteHandlerMiddlewareContext(pagesApiResponse, middlewareContext),
      draftCookie,
    );
  }

  if (typeof pagesEntry.renderPage !== "function") return null;
  const hasPageMatcher = typeof pagesEntry.matchPageRoute === "function";
  const pageMatch = hasPageMatcher
    ? (pagesEntry.matchPageRoute?.(pagesUrl, pagesRequest) ?? null)
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
  const renderRequest = pagesDataRequest
    ? cloneRequestWithUrl(pagesRequest, pagesDataRequest.url)
    : pagesRequest;
  const pagesRes = isDataRequest
    ? await pagesEntry.renderPage(
        renderRequest,
        pagesUrl,
        {},
        undefined,
        middlewareContext.requestHeaders,
        { isDataReq: true },
      )
    : await pagesEntry.renderPage(
        renderRequest,
        pagesUrl,
        {},
        undefined,
        middlewareContext.requestHeaders,
      );
  if (pagesRes.status === 404 && pageMatch === null) return null;
  return applyDraftModeCookie(pagesRes, getDraftModeCookieHeader());
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
