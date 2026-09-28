import { isPossibleAppRouteActionRequest } from "./app-action-request.js";
import { mergeMiddlewareResponseHeaders } from "./middleware-response-headers.js";
import { methodNotAllowedResponse } from "./http-error-responses.js";

type ResolveAppPageMethodResponseOptions = {
  /** `isAppPageStaticEligible` for the route. */
  isStaticEligible: boolean;
  middlewareHeaders?: Headers | null;
  request: Pick<Request, "headers" | "method">;
};

function isNonGetOrHead(method: string): boolean {
  const normalizedMethod = method.toUpperCase();
  return normalizedMethod !== "GET" && normalizedMethod !== "HEAD";
}

export function resolveAppPageMethodResponse(
  options: ResolveAppPageMethodResponseOptions,
): Response | null {
  if (!isNonGetOrHead(options.request.method)) {
    return null;
  }

  if (isPossibleAppRouteActionRequest(options.request)) {
    return null;
  }

  // Next.js answers non-GET/HEAD requests to static and SSG pages with 405.
  // Dynamic pages render for every method.
  if (!options.isStaticEligible) {
    return null;
  }

  const headers = new Headers();
  mergeMiddlewareResponseHeaders(headers, options.middlewareHeaders ?? null);

  return methodNotAllowedResponse("GET, HEAD", { headers });
}
