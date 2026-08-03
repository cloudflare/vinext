import type { NextHeader, NextI18nConfig } from "../config/next-config.js";
import type { RequestContext } from "../config/request-context.js";
import { NEXT_URL_HEADER, RSC_HEADER, VINEXT_STATIC_FILE_HEADER } from "./headers.js";
import { applyCdnResponseHeaders } from "./cache-control.js";
import {
  VINEXT_RSC_CACHE_BUSTING_REDIRECT_HEADER,
  VINEXT_RSC_NON_CONTEXTUAL_VARY_HEADER,
  VINEXT_RSC_VARY_HEADER,
} from "./app-rsc-cache-busting.js";
import { mergeVaryHeader } from "./middleware-response-headers.js";
import { hasBasePath, stripBasePath } from "../utils/base-path.js";
import { normalizeDefaultLocalePathname } from "./pages-i18n.js";
import { sanitizeMethodNotAllowedHeaders } from "./http-error-responses.js";

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
  /** Whether the resolved route matches any interception target topology. */
  pathCouldBeIntercepted?: boolean;
  /** Preserve a Next-Url Vary token explicitly contributed by middleware. */
  preserveNextUrlVary?: boolean;
};

const HAS_CONFIG_HEADERS = process.env.__VINEXT_HAS_CONFIG_HEADERS !== "false";
const configHeadersAlreadyApplied = new WeakSet<Response>();
const preserveAppliedNextUrlVary = new WeakSet<Response>();

/** Mark a response whose final target pipeline has already applied config headers. */
export function markAppRscResponseConfigHeadersApplied(response: Response): Response {
  configHeadersAlreadyApplied.add(response);
  // The response crossed an internal target dispatch whose config/middleware
  // provenance is no longer available to the outer source handler. Preserve
  // its already-finalized Next-Url token rather than treating it as a source
  // route framework default and accidentally stripping an explicit target rule.
  preserveAppliedNextUrlVary.add(response);
  return response;
}

/** Apply only the matching next.config headers for an App Router request. */
export async function applyAppRscConfigHeaders(
  headers: Headers,
  request: Request,
  options: FinalizeAppRscResponseOptions,
): Promise<void> {
  if (!HAS_CONFIG_HEADERS || !options.configHeaders.length) return;

  const url = new URL(request.url);
  let pathname = url.pathname;
  const hadBasePath = !options.basePath || hasBasePath(pathname, options.basePath);
  pathname = stripBasePath(pathname, options.basePath);
  const matchPathname = options.i18nConfig
    ? normalizeDefaultLocalePathname(pathname, options.i18nConfig, { hostname: url.hostname })
    : pathname;

  const { applyConfigHeadersToResponse } = await import("./config-headers.js");
  applyConfigHeadersToResponse(headers, {
    configHeaders: options.configHeaders,
    pathname: matchPathname,
    requestContext: options.requestContext,
    basePathState: { basePath: options.basePath, hadBasePath },
  });
}

function reapplyNonCacheableCdnPolicy(headers: Headers): void {
  const cacheControl = headers.get("Cache-Control");
  if (cacheControl && /\b(?:no-store|no-cache|private)\b/i.test(cacheControl)) {
    applyCdnResponseHeaders(headers, { cacheControl });
  }
}

function applyAppRscVaryHeader(
  headers: Headers,
  options: { pathCouldBeIntercepted: boolean; preserveNextUrlVary: boolean },
): void {
  if (!options.pathCouldBeIntercepted && !options.preserveNextUrlVary) {
    const current = headers.get("Vary");
    if (current !== null && current !== "*") {
      const withoutNextUrl = current
        .split(",")
        .map((token) => token.trim())
        .filter(
          (token) => token.length > 0 && token.toLowerCase() !== NEXT_URL_HEADER.toLowerCase(),
        );
      if (withoutNextUrl.length === 0) {
        headers.delete("Vary");
      } else {
        headers.set("Vary", withoutNextUrl.join(", "));
      }
    }
  }

  mergeVaryHeader(
    headers,
    options.pathCouldBeIntercepted ? VINEXT_RSC_VARY_HEADER : VINEXT_RSC_NON_CONTEXTUAL_VARY_HEADER,
  );
}

/**
 * Apply App Router response finalization that must happen outside individual
 * route dispatchers.
 *
 * Called once per request in the outer handler() wrapper, after all route
 * handling, so that every response path (page, route handler, server action,
 * metadata, not-found) gets headers applied consistently.
 *
 * Skips config-header matching for 3xx redirects. RSC redirects are cloned so
 * immutable `Response.redirect()` headers can still receive the framework's
 * `Vary` and authoritative no-store policy.
 */
export async function finalizeAppRscResponse(
  response: Response,
  request: Request,
  options: FinalizeAppRscResponseOptions,
): Promise<Response> {
  const varyOptions = {
    pathCouldBeIntercepted: options.pathCouldBeIntercepted === true,
    preserveNextUrlVary:
      options.preserveNextUrlVary === true || preserveAppliedNextUrlVary.has(response),
  };
  // 3xx responses: Response.redirect() headers are immutable (throws on write),
  // and Next.js deliberately excludes config headers from redirect responses.
  if (response.status >= 300 && response.status < 400) {
    const isCacheBustingRedirect =
      response.headers.get(VINEXT_RSC_CACHE_BUSTING_REDIRECT_HEADER) === "1";
    if (request.headers.get(RSC_HEADER) !== "1" && !isCacheBustingRedirect) return response;

    const headers = new Headers(response.headers);
    headers.delete(VINEXT_RSC_CACHE_BUSTING_REDIRECT_HEADER);
    applyAppRscVaryHeader(headers, varyOptions);
    applyCdnResponseHeaders(headers, { cacheControl: "no-store" });
    return new Response(response.body, {
      headers,
      status: response.status,
      statusText: response.statusText,
    });
  }

  if (!response.headers.has(VINEXT_STATIC_FILE_HEADER)) {
    applyAppRscVaryHeader(response.headers, varyOptions);
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

  if (configHeadersAlreadyApplied.has(response)) {
    reapplyNonCacheableCdnPolicy(response.headers);
    return response;
  }
  await applyAppRscConfigHeaders(response.headers, request, options);

  // Config headers run after framework response shaping and may explicitly
  // contribute Next-Url. Do not strip that user-owned token on this second
  // pass; only append/dedupe the framework topology fields.
  if (!response.headers.has(VINEXT_STATIC_FILE_HEADER)) {
    applyAppRscVaryHeader(response.headers, {
      ...varyOptions,
      preserveNextUrlVary: true,
    });
  }

  // A route/runtime no-store decision is authoritative over next.config
  // headers. Re-run that generic policy through the active adapter after
  // config headers so an adapter can remove provider-owned cache directives
  // that would otherwise re-enable shared caching. Cacheable responses are not
  // re-applied because their browser-facing Cache-Control does not retain the
  // original shared-cache lifetime.
  reapplyNonCacheableCdnPolicy(response.headers);

  // Static-file 405 responses are synthesized before config headers run.
  // Reassert their body metadata afterward so a matching headers() rule cannot
  // describe a different body or replace the canonical Allow value.
  if (response.status === 405 && response.headers.get("Allow") === "GET, HEAD") {
    sanitizeMethodNotAllowedHeaders(response.headers, "GET, HEAD");
  }

  return response;
}
