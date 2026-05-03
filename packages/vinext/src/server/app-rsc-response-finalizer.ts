import type { NextHeader } from "../config/next-config.js";
import type { RequestContext } from "../config/config-matchers.js";
import { applyConfigHeadersToResponse } from "./request-pipeline.js";
import { stripBasePath } from "../utils/base-path.js";
import { normalizePath } from "./normalize-path.js";
import { normalizePathnameForRouteMatch } from "../routing/utils.js";

type FinalizeAppRscResponseOptions = {
  basePath: string;
  configHeaders: NextHeader[];
  /**
   * Original pre-middleware request context.
   * Next.js evaluates config header has/missing conditions against the
   * unmodified incoming request, so callers must pass the snapshot taken
   * before middleware runs.
   */
  requestContext: RequestContext;
};

/**
 * Apply next.config.js response headers to an App Router response.
 *
 * Called once per request in the outer handler() wrapper, after all route
 * handling, so that every response path (page, route handler, server action,
 * metadata, not-found) gets headers applied consistently.
 *
 * Skips 3xx redirect responses. Response.redirect() creates immutable
 * headers that throw on mutation, and Next.js does not apply config headers
 * to redirects regardless.
 */
export function finalizeAppRscResponse(
  response: Response,
  request: Request,
  options: FinalizeAppRscResponseOptions,
): Response {
  // 3xx responses: Response.redirect() headers are immutable (throws on write),
  // and Next.js deliberately excludes config headers from redirect responses.
  if (response.status >= 300 && response.status < 400) {
    return response;
  }

  if (!options.configHeaders.length) {
    return response;
  }

  const url = new URL(request.url);
  let pathname: string;
  try {
    pathname = normalizePath(normalizePathnameForRouteMatch(url.pathname));
  } catch {
    // Malformed percent-encoding. The request reached this point only because
    // normalizePathnameForRouteMatchStrict ran earlier and returned 400 for
    // truly-malformed paths. This catch exists as a safety net for edge cases;
    // keep the historical raw-path fallback rather than crashing the response.
    pathname = url.pathname;
  }

  // Config header sources are defined without basePath prefix. Strip basePath
  // at a segment boundary (not a string prefix) so /app2/page with basePath
  // /app is not incorrectly treated as /app with suffix /2/page.
  pathname = stripBasePath(pathname, options.basePath);

  applyConfigHeadersToResponse(response.headers, {
    configHeaders: options.configHeaders,
    pathname,
    requestContext: options.requestContext,
  });

  return response;
}
