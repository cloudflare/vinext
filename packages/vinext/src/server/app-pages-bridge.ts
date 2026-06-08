import type { AppMiddlewareContext } from "./app-middleware.js";

export type PagesEntry = {
  handleApiRoute?: (request: Request, url: string) => Promise<Response> | Response;
  renderPage?: (
    request: Request,
    url: string,
    query: Record<string, unknown>,
    parsedUrl: unknown,
    middlewareRequestHeaders?: Headers | null,
  ) => Promise<Response> | Response;
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
  isRscRequest: boolean;
  middlewareContext: AppMiddlewareContext;
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
  const { isRscRequest, middlewareContext, request, url } = options;
  const {
    loadPagesEntry,
    buildRequestHeaders,
    decodePathParams,
    applyRouteHandlerMiddlewareContext,
    getDraftModeCookieHeader,
  } = dependencies;

  if (isRscRequest) return null;

  const pagesEntry = await loadPagesEntry();

  const pagesRequestHeaders = middlewareContext.requestHeaders
    ? buildRequestHeaders(request.headers, middlewareContext.requestHeaders)
    : null;

  let pagesRequest = request;
  if (pagesRequestHeaders) {
    const pagesRequestInit: RequestInit & { duplex?: string } = {
      method: request.method,
      headers: pagesRequestHeaders,
    };
    if (request.method !== "GET" && request.method !== "HEAD") {
      pagesRequestInit.body = request.body;
      pagesRequestInit.duplex = "half";
    }
    pagesRequest = new Request(request.url, pagesRequestInit);
  }

  const pagesUrl = decodePathParams(url.pathname) + (url.search || "");
  const pagesPathname = url.pathname;
  if (pagesPathname.startsWith("/api/") || pagesPathname === "/api") {
    if (typeof pagesEntry.handleApiRoute !== "function") return null;
    const pagesApiResponse = await pagesEntry.handleApiRoute(pagesRequest, pagesUrl);
    const draftCookie = getDraftModeCookieHeader();
    return applyDraftModeCookie(
      applyRouteHandlerMiddlewareContext(pagesApiResponse, middlewareContext),
      draftCookie,
    );
  }

  if (typeof pagesEntry.renderPage !== "function") return null;
  const pagesRes = await pagesEntry.renderPage(
    pagesRequest,
    pagesUrl,
    {},
    undefined,
    middlewareContext.requestHeaders,
  );
  if (pagesRes.status === 404) return null;
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
