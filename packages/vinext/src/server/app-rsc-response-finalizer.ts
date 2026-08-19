import type { NextHeader, NextI18nConfig } from "../config/next-config.js";
import type { RequestContext } from "../config/request-context.js";
import { NEXT_URL_HEADER, RSC_HEADER, VINEXT_STATIC_FILE_HEADER } from "./headers.js";
import { applyCdnResponseHeaders, hasExplicitNonCacheableResponsePolicy } from "./cache-control.js";
import {
  VINEXT_APP_NON_CONTEXTUAL_VARY_HEADER,
  VINEXT_APP_VARY_HEADER,
  VINEXT_RSC_CACHE_BUSTING_REDIRECT_HEADER,
  VINEXT_RSC_NON_CONTEXTUAL_VARY_HEADER,
  VINEXT_RSC_VARY_HEADER,
} from "./app-rsc-cache-busting.js";
import { mergeVaryHeader } from "./middleware-response-headers.js";
import { hasBasePath, stripBasePath } from "../utils/base-path.js";
import { normalizeDefaultLocalePathname } from "./pages-i18n.js";
import { sanitizeMethodNotAllowedHeaders } from "./http-error-responses.js";
import { hasPostConfigLinkHeaders } from "./app-response-header-provenance.js";

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
  /** Response headers emitted by middleware after config matching. */
  middlewareHeaders?: Headers | null;
};

const HAS_CONFIG_HEADERS = process.env.__VINEXT_HAS_CONFIG_HEADERS !== "false";
const configHeadersAlreadyApplied = new WeakSet<Response>();
const preserveAppliedNextUrlVary = new WeakSet<Response>();
const userlandExplicitNextUrlVary = new WeakSet<Response>();
const cdnAdapterBoundaryResponses = new WeakSet<Response>();

function varyIncludesHeader(vary: string | null, headerName: string): boolean {
  if (vary === null) return false;
  return vary.split(",").some((token) => token.trim().toLowerCase() === headerName.toLowerCase());
}

/**
 * Preserve a Next-Url Vary token that came from an App Route Handler or Pages
 * Router response. Next.js establishes the framework Vary value before
 * dispatch/render and then preserves response headers contributed by userland,
 * so userland can explicitly add Next-Url even when interception topology did
 * not require it.
 */
export function markAppUserlandResponseVaryProvenance(response: Response): Response {
  if (varyIncludesHeader(response.headers.get("Vary"), NEXT_URL_HEADER)) {
    userlandExplicitNextUrlVary.add(response);
  }
  return response;
}

/** Mark a middleware- or upstream-owned response so its policy crosses the active CDN adapter. */
export function markAppCdnAdapterBoundaryResponse(response: Response): Response {
  cdnAdapterBoundaryResponses.add(response);
  return response;
}

/** Backward-compatible name for external rewrite call sites. */
export const markAppExternalRewriteResponse = markAppCdnAdapterBoundaryResponse;

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
    appendToPostConfigLink: hasPostConfigLinkHeaders(headers),
    middlewareHeaders: options.middlewareHeaders,
  });
}

function reapplyNonCacheableCdnPolicy(
  headers: Headers,
  hadExplicitNonCacheablePolicy = false,
  originalNonCacheableCacheControl: string | null = null,
): void {
  if (headers.has("Set-Cookie")) {
    applyCdnResponseHeaders(headers, { cacheControl: "no-store" });
    return;
  }
  if (hadExplicitNonCacheablePolicy) {
    // Preserve the framework/userland generic policy byte-for-byte when it was
    // itself non-cacheable (`no-cache`, `private`, `must-revalidate`, etc.).
    // Fall back to no-store only when provider-owned headers were the sole
    // adapter-specific denial signal.
    applyCdnResponseHeaders(headers, {
      cacheControl: originalNonCacheableCacheControl ?? "no-store",
    });
    return;
  }
  const cacheControl = headers.get("Cache-Control");
  if (cacheControl && /\b(?:no-store|no-cache|private)\b/i.test(cacheControl)) {
    applyCdnResponseHeaders(headers, { cacheControl });
  }
}

function applyBoundaryResponseCdnPolicy(headers: Headers): void {
  applyCdnResponseHeaders(headers, {
    cacheControl: headers.has("Set-Cookie") ? "no-store" : (headers.get("Cache-Control") ?? ""),
  });
}

function applyAppRscVaryHeader(
  headers: Headers,
  options: {
    isRscRequest: boolean;
    pathCouldBeIntercepted: boolean;
    preserveNextUrlVary: boolean;
  },
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
    options.isRscRequest
      ? options.pathCouldBeIntercepted
        ? VINEXT_RSC_VARY_HEADER
        : VINEXT_RSC_NON_CONTEXTUAL_VARY_HEADER
      : options.pathCouldBeIntercepted
        ? VINEXT_APP_VARY_HEADER
        : VINEXT_APP_NON_CONTEXTUAL_VARY_HEADER,
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
    isRscRequest: request.headers.get(RSC_HEADER) === "1",
    pathCouldBeIntercepted: options.pathCouldBeIntercepted === true,
    preserveNextUrlVary:
      options.preserveNextUrlVary === true ||
      preserveAppliedNextUrlVary.has(response) ||
      userlandExplicitNextUrlVary.has(response),
  };
  // 3xx responses: Response.redirect() headers are immutable (throws on write),
  // and Next.js deliberately excludes config headers from redirect responses.
  if (response.status >= 300 && response.status < 400) {
    const isCacheBustingRedirect =
      response.headers.get(VINEXT_RSC_CACHE_BUSTING_REDIRECT_HEADER) === "1";
    const isRscRequest = request.headers.get(RSC_HEADER) === "1";
    const crossesCdnAdapterBoundary = cdnAdapterBoundaryResponses.has(response);
    if (!isRscRequest && !isCacheBustingRedirect && !crossesCdnAdapterBoundary) return response;

    const headers = new Headers(response.headers);
    if (isRscRequest || isCacheBustingRedirect) {
      headers.delete(VINEXT_RSC_CACHE_BUSTING_REDIRECT_HEADER);
      applyAppRscVaryHeader(headers, varyOptions);
      applyCdnResponseHeaders(headers, { cacheControl: "no-store" });
    } else {
      applyBoundaryResponseCdnPolicy(headers);
    }
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
  // already applied. Redirects are already skipped above.
  if (cdnAdapterBoundaryResponses.has(response)) {
    applyBoundaryResponseCdnPolicy(response.headers);
  } else if (!response.headers.has("Cache-Control")) {
    applyCdnResponseHeaders(response.headers, { cacheControl: "" });
  }
  // Snapshot the adapter-aware decision before next.config headers can
  // overwrite either generic or provider-owned no-store policy. Once a
  // request variant has been rejected for shared caching, later user config
  // must not be able to promote it back into the CDN cache.
  const hadExplicitNonCacheablePolicy = hasExplicitNonCacheableResponsePolicy(response.headers);
  const cacheControlBeforeConfig = response.headers.get("Cache-Control");
  const originalNonCacheableCacheControl =
    cacheControlBeforeConfig && /\b(?:no-store|no-cache|private)\b/i.test(cacheControlBeforeConfig)
      ? cacheControlBeforeConfig
      : null;

  if (configHeadersAlreadyApplied.has(response)) {
    reapplyNonCacheableCdnPolicy(
      response.headers,
      hadExplicitNonCacheablePolicy,
      originalNonCacheableCacheControl,
    );
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
  reapplyNonCacheableCdnPolicy(
    response.headers,
    hadExplicitNonCacheablePolicy,
    originalNonCacheableCacheControl,
  );

  // Static-file 405 responses are synthesized before config headers run.
  // Reassert their body metadata afterward so a matching headers() rule cannot
  // describe a different body or replace the canonical Allow value.
  if (response.status === 405 && response.headers.get("Allow") === "GET, HEAD") {
    sanitizeMethodNotAllowedHeaders(response.headers, "GET, HEAD");
  }

  return response;
}
