import { VINEXT_PRERENDER_CACHE_IDENTITY_HEADER } from "./headers.js";
import { normalizePregeneratedPathname } from "./pregenerated-concrete-paths.js";

const REWRITE_MARKER = "?__vinext_rewrite=";

/**
 * Cache pathname of an App request that a rewrite resolved to another page.
 *
 * Next.js keys App ISR by the resolved pathname:
 * packages/next/src/build/templates/app-route.ts
 * Keep that resolved identity while also partitioning by the public source
 * pathname that user code observes through usePathname().
 *
 * The request handler and the prerender must agree on this value, or a seeded
 * entry is never read. This module is the only owner of its format.
 */
export function appRewriteCachePathname(sourcePathname: string, resolvedPathname: string): string {
  return `${sourcePathname}${REWRITE_MARKER}${encodeURIComponent(resolvedPathname)}`;
}

/** A trailing slash does not change which page a pathname names. */
function pageIdentityPathname(pathname: string): string {
  const normalized = normalizePregeneratedPathname(pathname);
  return normalized.length > 1 && normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

/**
 * Whether `cachePathname` is the identity that the request handler gives a
 * request for `requestPathname` that a rewrite resolved to the page at
 * `pagePathname`.
 *
 * The handler keeps the percent-encoding of the request and the trailing slash
 * of the rewrite destination in the resolved part. The parts are therefore
 * compared in normalized form. A caller that accepts the value must store the
 * handler's own spelling: that spelling is the key that a runtime request reads.
 */
export function isRewriteCachePathnameOf(
  cachePathname: string,
  requestPathname: string,
  pagePathname: string,
): boolean {
  const markerIndex = cachePathname.indexOf(REWRITE_MARKER);
  if (markerIndex === -1) return false;
  let resolvedPathname: string;
  try {
    resolvedPathname = decodeURIComponent(cachePathname.slice(markerIndex + REWRITE_MARKER.length));
  } catch {
    return false;
  }
  return (
    cachePathname.slice(0, markerIndex) === normalizePregeneratedPathname(requestPathname) &&
    pageIdentityPathname(resolvedPathname) === pageIdentityPathname(pagePathname)
  );
}

// ── The rewrite source probe of the prerender ──────────────────────────────────
//
// The prerender requests a public URL that it expects a rewrite to resolve to a
// prerendered page. Only the request handler knows how redirects, middleware,
// routes and the rewrite phases resolve a URL, so the build asks instead of
// predicting: the request names the page that the build expects, and the
// response confirms the cache pathname of the render.
//
// The request is a probe. When the URL does not resolve to that page, the
// handler must not run what does own the URL: a route handler, a Pages Router
// data function, a metadata route, or a request to another origin.

/** The page that a rewrite source probe expects a rewrite to resolve its URL to. */
export type RewriteSourceProbe = {
  /** Pattern of the App route that the prerender renders the page from. */
  routePattern: string;
  /** Pathname of the prerendered page. */
  pagePathname: string;
};

/** Mark a build request as a probe that expects `probe`. */
export function applyRewriteSourceProbeHeader(headers: Headers, probe: RewriteSourceProbe): void {
  // A pathname can hold characters that a header value cannot.
  headers.set(
    VINEXT_PRERENDER_CACHE_IDENTITY_HEADER,
    encodeURIComponent(JSON.stringify([probe.routePattern, probe.pagePathname])),
  );
}

/**
 * The page that a rewrite source probe expects, or null for any other request.
 * Only the prerender server reads the header. A value that the prerender did
 * not write does not make a request a probe.
 */
export function readRewriteSourceProbe(requestHeaders: Headers): RewriteSourceProbe | null {
  if (typeof process === "undefined" || process.env?.VINEXT_PRERENDER !== "1") return null;
  const raw = requestHeaders.get(VINEXT_PRERENDER_CACHE_IDENTITY_HEADER);
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(decodeURIComponent(raw));
  } catch {
    return null;
  }
  if (!Array.isArray(value) || value.length !== 2) return null;
  const [routePattern, pagePathname]: unknown[] = value;
  if (typeof routePattern !== "string" || typeof pagePathname !== "string") return null;
  return { routePattern, pagePathname };
}

/**
 * Whether a probe resolved to the page that it expects.
 *
 * The pathname alone does not name the page. The route that the handler
 * matches for a rewritten pathname can be another route than the one that the
 * prerender renders the page from, for example a route handler.
 */
export function isRewriteSourceProbePage(
  probe: RewriteSourceProbe,
  matchedRoutePattern: string,
  resolvedPathname: string,
): boolean {
  return (
    matchedRoutePattern === probe.routePattern &&
    pageIdentityPathname(resolvedPathname) === pageIdentityPathname(probe.pagePathname)
  );
}

/** The answer to a probe whose URL does not resolve to the page that it expects. */
export function refusedRewriteSourceProbe(): Response {
  return new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });
}

/** Confirm to the prerender the cache pathname of the render of a probe. */
export function applyPrerenderCacheIdentityHeader(headers: Headers, cachePathname: string): void {
  // A pathname can hold characters that a header value cannot.
  headers.set(VINEXT_PRERENDER_CACHE_IDENTITY_HEADER, encodeURIComponent(cachePathname));
}

export function readPrerenderCacheIdentityHeader(headers: Headers): string | null {
  const raw = headers.get(VINEXT_PRERENDER_CACHE_IDENTITY_HEADER);
  if (raw === null) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}
