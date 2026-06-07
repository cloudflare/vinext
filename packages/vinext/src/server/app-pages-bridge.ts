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
    return applyRouteHandlerMiddlewareContext(pagesApiResponse, middlewareContext);
  }

  if (typeof pagesEntry.renderPage !== "function") return null;
  const pagesRes = await pagesEntry.renderPage(
    pagesRequest,
    pagesUrl,
    {},
    undefined,
    middlewareContext.requestHeaders,
  );
  return pagesRes.status !== 404 ? pagesRes : null;
}
