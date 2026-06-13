import type { NextHeader, NextI18nConfig } from "../config/next-config.js";
import type { RequestContext } from "../config/config-matchers.js";
import { VINEXT_STATIC_FILE_HEADER } from "./headers.js";
import { applyCdnResponseHeaders } from "./cache-control.js";
import { applyConfigHeadersToResponse } from "./request-pipeline.js";
import { VINEXT_RSC_VARY_HEADER } from "./app-rsc-cache-busting.js";
import { mergeVaryHeader } from "./middleware-response-headers.js";
import { hasBasePath, stripBasePath } from "../utils/base-path.js";
import { normalizePath } from "./normalize-path.js";
import { normalizePathnameForRouteMatch } from "../routing/utils.js";
import { normalizeDefaultLocalePathname } from "./pages-i18n.js";

type FinalizeAppRscResponseOptions = {
  basePath: string;
  configHeaders: NextHeader[];
  /**
   * i18n config used to splice the default locale into unprefixed paths
   * before config header matching, so locale-aware `has`/`missing` rules
   * with `:locale` placeholders or `locale: false` overrides still match
   * default-locale URLs (issue #1336, item 4).
   */
  i18nConfig: NextI18nConfig | null;
  /**
   * Original pre-middleware request context.
   * Next.js evaluates config header has/missing conditions against the
   * unmodified incoming request, so callers must pass the snapshot taken
   * before middleware runs.
   */
  requestContext: RequestContext;
};

/**
 * Apply App Router response finalization that must happen outside individual
 * route dispatchers.
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

  if (!response.headers.has(VINEXT_STATIC_FILE_HEADER)) {
    mergeVaryHeader(response.headers, VINEXT_RSC_VARY_HEADER);
  }

  // The CDN cache adapter owns the *default* Cache-Control. If no route path
  // stamped one (e.g. a dynamic page whose policy produced no cacheable value),
  // let the adapter decide the default: the edge adapter emits `no-store` (so an
  // unspecified response is never accidentally edge-cached), while the default
  // origin-managed adapter leaves it absent (unchanged behavior). This runs only
  // when Cache-Control is absent, so it never clobbers a policy a renderer
  // already applied — including a real `CDN-Cache-Control`. Redirects are
  // already skipped above.
  if (!response.headers.has("Cache-Control")) {
    applyCdnResponseHeaders(response.headers, { cacheControl: "" });
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
  const hadBasePath = !options.basePath || hasBasePath(pathname, options.basePath);
  pathname = stripBasePath(pathname, options.basePath);

  // Default-locale path normalisation (issue #1336, item 4). Splice in the
  // (domain-aware) default locale on unprefixed paths so locale-aware
  // `has`/`missing` rules with `:locale` placeholders or `locale: false`
  // overrides still match default-locale URLs. Mirrors the call sites in
  // `prod-server.ts`, `deploy.ts`, and `app-rsc-handler.ts`.
  const matchPathname = options.i18nConfig
    ? normalizeDefaultLocalePathname(pathname, options.i18nConfig, { hostname: url.hostname })
    : pathname;

  applyConfigHeadersToResponse(response.headers, {
    configHeaders: options.configHeaders,
    pathname: matchPathname,
    requestContext: options.requestContext,
    basePathState: { basePath: options.basePath, hadBasePath },
  });

  return response;
}
