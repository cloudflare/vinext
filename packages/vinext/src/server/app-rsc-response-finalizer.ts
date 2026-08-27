import type { NextHeader, NextI18nConfig } from "../config/next-config.js";
import type { RequestContext } from "../config/request-context.js";
import { isStaticFileSignal } from "./static-file-signal.js";
import {
  applyCdnResponseHeaders,
  hasExplicitNonCacheableResponsePolicy,
  isNonCacheableCacheControl,
  NO_STORE_CACHE_CONTROL,
} from "./cache-control.js";
import { VINEXT_RSC_VARY_HEADER } from "./app-rsc-cache-busting.js";
import { mergeVaryHeader } from "./middleware-response-headers.js";
import { hasBasePath, stripBasePath } from "../utils/base-path.js";
import { normalizeDefaultLocalePathname } from "./pages-i18n.js";
import { sanitizeMethodNotAllowedHeaders } from "./http-error-responses.js";
import { hasPostConfigLinkHeaders } from "./app-response-header-provenance.js";
import {
  CACHEABILITY_POLICY_HEADERS,
  captureRouteCacheabilityResponsePolicy,
} from "vinext/shims/cacheability-classification";

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
  /** Response headers emitted by middleware after config matching. */
  middlewareHeaders?: Headers | null;
};

const HAS_CONFIG_HEADERS = process.env.__VINEXT_HAS_CONFIG_HEADERS !== "false";
const configHeadersAlreadyApplied = new WeakSet<Response>();
const CONFIG_CACHE_POLICY_HEADERS = new Set<string>(CACHEABILITY_POLICY_HEADERS);

function normalizeExplicitNonCacheablePolicy(headers: Headers): void {
  if (!hasExplicitNonCacheableResponsePolicy(headers)) return;
  const cacheControl = headers.get("Cache-Control");
  applyCdnResponseHeaders(headers, {
    cacheControl:
      cacheControl && isNonCacheableCacheControl(cacheControl)
        ? cacheControl
        : NO_STORE_CACHE_CONTROL,
  });
}

/** Mark a response whose final target pipeline has already applied config headers. */
export function markAppRscResponseConfigHeadersApplied(response: Response): Response {
  configHeadersAlreadyApplied.add(response);
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
    // Next.js next.config headers override its renderer-owned Cache-Control,
    // including for force-dynamic App Pages. Other response headers retain
    // the existing merge precedence.
    // test/e2e/app-dir/custom-cache-control/custom-cache-control.test.ts
    overwriteExisting: CONFIG_CACHE_POLICY_HEADERS,
  });
}

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
export async function finalizeAppRscResponse(
  response: Response,
  request: Request,
  options: FinalizeAppRscResponseOptions,
): Promise<Response> {
  // 3xx responses: Response.redirect() headers are immutable (throws on write),
  // and Next.js deliberately excludes config headers from redirect responses.
  if (response.status >= 300 && response.status < 400) {
    return response;
  }

  if (!isStaticFileSignal(response)) {
    const varyHeader = response.headers.get("Vary");
    if (varyHeader === null) {
      response.headers.set("Vary", VINEXT_RSC_VARY_HEADER);
    } else if (varyHeader !== VINEXT_RSC_VARY_HEADER) {
      mergeVaryHeader(response.headers, VINEXT_RSC_VARY_HEADER);
    }
  }

  // The CDN cache adapter owns the *default* Cache-Control. If no route path
  // stamped one (e.g. a dynamic page whose policy produced no cacheable value),
  // let the adapter decide the default: the edge adapter emits `no-store` (so an
  // unspecified response is never accidentally edge-cached), while the default
  // origin-managed adapter leaves it absent (unchanged behavior). This runs only
  // when Cache-Control is absent, so it never clobbers a policy a renderer
  // already applied. Redirects are already skipped above.
  if (!response.headers.has("Cache-Control")) {
    applyCdnResponseHeaders(response.headers, { cacheControl: "" });
    // This is the adapter's fail-closed provisional policy, not an
    // application opt-out. Admission may replace it only after the body has
    // completed and the render has proved reusable. Capture before config
    // headers run so any later private/no-store override still vetoes.
    captureRouteCacheabilityResponsePolicy(response.headers);
  }

  if (configHeadersAlreadyApplied.has(response)) {
    normalizeExplicitNonCacheablePolicy(response.headers);
    return response;
  }
  await applyAppRscConfigHeaders(response.headers, request, options);
  normalizeExplicitNonCacheablePolicy(response.headers);

  // Static-file 405 responses are synthesized before config headers run.
  // Reassert their body metadata afterward so a matching headers() rule cannot
  // describe a different body or replace the canonical Allow value.
  if (response.status === 405 && response.headers.get("Allow") === "GET, HEAD") {
    sanitizeMethodNotAllowedHeaders(response.headers, "GET, HEAD");
  }

  return response;
}
