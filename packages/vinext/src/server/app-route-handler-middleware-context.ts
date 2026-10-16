import {
  mergeMiddlewareResponseHeadersOntoResponse,
  type MiddlewareResponseMergeOptions,
} from "./middleware-response-headers.js";

export type RouteHandlerMiddlewareContext = {
  headers: Headers | null;
  status: number | null;
};

/** Apply request-stage middleware response metadata to a route-handler response. */
export function applyRouteHandlerMiddlewareContext(
  response: Response,
  middlewareContext: RouteHandlerMiddlewareContext,
  options: MiddlewareResponseMergeOptions = {},
): Response {
  if (!middlewareContext.headers && middlewareContext.status == null) {
    return response;
  }

  const responseHeaders = new Headers(response.headers);
  mergeMiddlewareResponseHeadersOntoResponse(responseHeaders, middlewareContext.headers, options);

  return new Response(response.body, {
    status: middlewareContext.status ?? response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  });
}
