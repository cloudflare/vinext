/**
 * Helpers for the Pages Router `/_next/data/{buildId}/{...page}.json` endpoint.
 *
 * Next.js uses this endpoint for client-side navigations in the Pages Router:
 * `next/link` and `router.push()` fetch `pageProps` from this URL instead of
 * doing a full HTML navigation. The server must:
 *   1. Match the URL pattern and extract the page pathname (with the buildId
 *      and `.json` extension removed, locale prefix preserved).
 *   2. Normalize the URL BEFORE middleware runs so middleware sees the page
 *      path (e.g. `/about`) rather than the raw `/_next/data/.../about.json`.
 *   3. Invoke the same `getServerSideProps` / `getStaticProps` machinery as
 *      the HTML page and serialize the resulting props as a JSON envelope:
 *      `{ pageProps: ... }` with `Content-Type: application/json`.
 *
 * Ported from Next.js:
 *   - `packages/next/src/server/normalizers/request/next-data.ts` — prefix/suffix matcher.
 *   - `packages/next/src/server/base-server.ts` (`handleNextDataRequest`) — pipeline normalization.
 *   - `packages/next/src/server/render.tsx` — JSON envelope emission (`isNextDataRequest`).
 */

import { NEXTJS_DEPLOYMENT_ID_HEADER } from "./headers.js";
import { addBasePathToPathname, hasBasePath, stripBasePath } from "../utils/base-path.js";
import { MIDDLEWARE_SKIP_HEADER } from "../utils/protocol-headers.js";

const NEXT_DATA_PREFIX = "/_next/data/";
const NEXT_DATA_SUFFIX = ".json";

type NextDataMatch = {
  /**
   * The normalized page pathname (with leading slash, no trailing slash,
   * `.json` stripped, buildId stripped). For locale-prefixed requests like
   * `/_next/data/<buildId>/en/about.json` this is `/en/about` — locale
   * handling is done downstream by the existing `resolvePagesI18nRequest`
   * pipeline so this helper does not need to know about i18n config.
   */
  pagePathname: string;
};

/**
 * Returns true if the pathname looks like a `_next/data` request, regardless
 * of buildId. Used by the request pipeline to short-circuit before middleware
 * even when the buildId is wrong (so we can still return a 404 JSON response).
 */
export function isNextDataPathname(pathname: string): boolean {
  return pathname.startsWith(NEXT_DATA_PREFIX) && pathname.endsWith(NEXT_DATA_SUFFIX);
}

/**
 * WHATWG URL parsing removes TAB, LF, and CR characters. Reject paths where
 * that normalization would manufacture the internal Pages data namespace.
 */
export function urlParserCreatesPagesDataPath(pathname: string): boolean {
  const parsedPathname = pathname.replaceAll("\t", "").replaceAll("\n", "").replaceAll("\r", "");
  return (
    pathname !== parsedPathname &&
    !isNextDataPathname(pathname) &&
    isNextDataPathname(parsedPathname)
  );
}

/**
 * Keep URL-parser-ignored characters encoded until route matching decodes the
 * captured parameter. Passing them literally to `new URL()` would remove them.
 */
export function encodeUrlParserIgnoredCharacters(pathname: string): string {
  return pathname.replaceAll("\t", "%09").replaceAll("\n", "%0A").replaceAll("\r", "%0D");
}

/**
 * Parse `/_next/data/<buildId>/<...page>.json` and return the normalized page
 * pathname. Returns `null` if the pathname does not match the pattern or if
 * the buildId segment does not match the server's buildId.
 *
 * The returned `pagePathname` is the page route path Next.js would render for
 * the equivalent HTML navigation — including any locale prefix, which is then
 * stripped by `resolvePagesI18nRequest` downstream.
 *
 * `/_next/data/<buildId>/about.json`         → `/about`
 * `/_next/data/<buildId>/en/about.json`      → `/en/about`
 * `/_next/data/<buildId>/index.json`         → `/`
 * `/_next/data/<buildId>/blog/index.json`    → `/blog/index`
 * `/_next/data/<buildId>/en.json`            → `/en`
 * `/_next/data/<wrong-id>/about.json`        → null
 * `/_next/data/<buildId>/about`              → null  (missing .json suffix)
 */
export function parseNextDataPathname(pathname: string, buildId: string): NextDataMatch | null {
  if (!buildId) return null;
  if (!isNextDataPathname(pathname)) return null;

  const expectedPrefix = `${NEXT_DATA_PREFIX}${buildId}/`;
  // `/_next/data/<buildId>.json` (no trailing slash) is not a valid data req.
  if (!pathname.startsWith(expectedPrefix)) return null;

  return pageFromNextDataRest(pathname.slice(expectedPrefix.length, -NEXT_DATA_SUFFIX.length));
}

/**
 * The page pathname a `_next/data` URL addresses, whatever its buildId. Next.js
 * compiles every middleware matcher with an optional `/_next/data/<buildId>`
 * prefix and `.json` suffix, so a matcher written for `/admin` also guards that
 * page's data URL, even one with a stale buildId. Middleware matching uses this
 * when the request reaches middleware with its raw data URL
 * (`skipProxyUrlNormalize`).
 * https://github.com/vercel/next.js/blob/v16.2.7/packages/next/src/build/analysis/get-page-static-info.ts
 */
export function nextDataMiddlewareMatchPathname(pathname: string): string | null {
  if (!isNextDataPathname(pathname)) return null;
  const buildIdEnd = pathname.indexOf("/", NEXT_DATA_PREFIX.length);
  if (buildIdEnd <= NEXT_DATA_PREFIX.length) return null;
  const rest = pathname.slice(buildIdEnd + 1, -NEXT_DATA_SUFFIX.length);
  return pageFromNextDataRest(rest)?.pagePathname ?? null;
}

/**
 * The pathname Next.js's NextURL gives middleware for a data URL it did not
 * normalize first (a stale buildId) when proxy URL normalization is on: the
 * `_next/data/<buildId>` prefix and `.json` suffix are removed whatever the
 * buildId, and a page path starting with `index` becomes `/`.
 * https://github.com/vercel/next.js/blob/v16.2.7/packages/next/src/shared/lib/router/utils/get-next-pathname-info.ts
 */
export function nextUrlDataPagePathname(pathname: string): string | null {
  if (!isNextDataPathname(pathname)) return null;
  const segments = pathname.slice(NEXT_DATA_PREFIX.length, -NEXT_DATA_SUFFIX.length).split("/");
  return segments[1] !== "index" ? `/${segments.slice(1).join("/")}` : "/";
}

function pageFromNextDataRest(rest: string): NextDataMatch | null {
  const pagePathname = pagePathnameFromNextDataAsset(rest);
  return pagePathname === null ? null : { pagePathname };
}

// Next.js's strict `isDynamicRoute` test.
const DYNAMIC_ROUTE_SEGMENT = /\/\[[^/]+\](?=\/|$)/;
const INTERCEPTION_ROUTE_MARKERS = ["(..)(..)", "(.)", "(..)", "(...)"] as const;

/**
 * The page pathname for a data URL's asset path (between the buildId and
 * `.json`). Ports Next.js's `denormalizePagePath`: `index` is the root page,
 * and the encoder's extra leading `index/` segment is removed, so an explicit
 * `pages/index/foo.tsx` (route `/index/foo`) round-trips via `index/index/foo`.
 * Any other `index` segment is part of the page path: `blog/index` addresses
 * `/blog/index` (e.g. `/blog/[slug]` with `slug: "index"`), not `/blog`.
 * https://github.com/vercel/next.js/blob/v16.2.7/packages/next/src/shared/lib/page-path/denormalize-page-path.ts
 */
export function pagePathnameFromNextDataAsset(assetPath: string): string | null {
  // Empty rest (`/_next/data/<buildId>/.json`) is not a valid page path.
  if (assetPath.length === 0) return null;
  const page = `/${assetPath}`;
  if (page.startsWith("/index/")) {
    const isDynamic = isStrictDynamicRoute(page);
    // Next.js throws on an invalid interception route and answers 500.
    if (isDynamic === null) return null;
    if (!isDynamic) return page.slice(6);
  }
  return page === "/index" ? "/" : page;
}

/**
 * Next.js's strict `isDynamicRoute`, which tests the intercepted route when the
 * path has an interception marker: `/index/(.)[slug]` is dynamic because it
 * resolves to `/index/[slug]`. Returns null where Next.js throws.
 * https://github.com/vercel/next.js/blob/v16.2.7/packages/next/src/shared/lib/router/utils/is-dynamic.ts
 */
function isStrictDynamicRoute(route: string): boolean | null {
  const marker = interceptionRouteMarker(route);
  if (marker === undefined) return DYNAMIC_ROUTE_SEGMENT.test(route);
  const interceptedRoute = resolveInterceptedRoute(route, marker);
  return interceptedRoute === null ? null : DYNAMIC_ROUTE_SEGMENT.test(interceptedRoute);
}

function interceptionRouteMarker(path: string): string | undefined {
  for (const segment of path.split("/")) {
    const marker = INTERCEPTION_ROUTE_MARKERS.find((m) => segment.startsWith(m));
    if (marker) return marker;
  }
  return undefined;
}

/**
 * The intercepted route from Next.js's `extractInterceptionRouteInformation`,
 * or null where it throws.
 * https://github.com/vercel/next.js/blob/v16.2.7/packages/next/src/shared/lib/router/utils/interception-routes.ts
 */
function resolveInterceptedRoute(path: string, marker: string): string | null {
  const [rawInterceptingRoute, interceptedRoute] = path.split(marker, 2);
  if (!rawInterceptingRoute || !interceptedRoute) return null;
  const interceptingRoute = normalizeAppPath(rawInterceptingRoute);
  switch (marker) {
    case "(.)":
      return interceptingRoute === "/"
        ? `/${interceptedRoute}`
        : `${interceptingRoute}/${interceptedRoute}`;
    case "(..)":
      if (interceptingRoute === "/") return null;
      return interceptingRoute.split("/").slice(0, -1).concat(interceptedRoute).join("/");
    case "(...)":
      return `/${interceptedRoute}`;
    default: {
      const segments = interceptingRoute.split("/");
      if (segments.length <= 2) return null;
      return segments.slice(0, -2).concat(interceptedRoute).join("/");
    }
  }
}

// Next.js's `normalizeAppPath`: drops route groups, parallel slots and a
// trailing `page`/`route` leaf.
function normalizeAppPath(route: string): string {
  const segments = route.split("/");
  let pathname = "";
  segments.forEach((segment, index) => {
    if (!segment) return;
    if (segment[0] === "(" && segment.endsWith(")")) return;
    if (segment[0] === "@") return;
    if ((segment === "page" || segment === "route") && index === segments.length - 1) return;
    pathname += `/${segment}`;
  });
  return pathname || "/";
}

export function normalizeNextDataPagePathname(pagePathname: string, trailingSlash = false): string {
  if (!trailingSlash || pagePathname === "/" || pagePathname.endsWith("/")) return pagePathname;
  return `${pagePathname}/`;
}

/**
 * Next.js only applies `trailingSlash` while normalizing a data URL for
 * middleware when proxy URL normalization is enabled. With
 * `skipProxyUrlNormalize`, the data route must retain the page's canonical
 * pathname without adding a slash.
 */
export function shouldAddTrailingSlashToPagesDataPath(
  hasMiddleware: boolean,
  trailingSlash: boolean,
  skipProxyUrlNormalize: boolean,
): boolean {
  return hasMiddleware && trailingSlash && !skipProxyUrlNormalize;
}

/**
 * Build a `_next/data` JSON response from the full Pages props object returned
 * through `_app.getInitialProps`. Next.js serializes the same outer props
 * object that would be passed to `<App />`, so custom app-level props remain
 * siblings of `pageProps` in the data envelope.
 */
export function buildNextDataPropsJsonResponse(
  props: Record<string, unknown>,
  safeJsonStringify: (value: unknown) => string,
  init?: ResponseInit,
): Response {
  const body = safeJsonStringify(props);
  const headers = new Headers(init?.headers);
  headers.set("Content-Type", "application/json");
  return new Response(body, {
    status: init?.status ?? 200,
    statusText: init?.statusText,
    headers,
  });
}

/**
 * Build the 404 response Next.js returns for an unknown `_next/data` page.
 * Next.js renders this as a normal 404 page, but the body shape that clients
 * see for a missing page-data endpoint is the literal string `"{ }"` for the
 * body and a 404 status with `application/json` so client-side hard-navigation
 * fallback fires (see `__N_SSP` handling in `router.ts`).
 *
 * We match Next.js' behavior: 404 status + JSON content type. The body is an
 * empty JSON object so clients that blindly call `res.json()` do not throw
 * before checking the status code.
 */
export function buildNextDataNotFoundResponse(): Response {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  // Mirror Next.js pages-handler.ts: always include x-nextjs-deployment-id so
  // the client router can detect a new deployment and trigger a hard navigation
  // instead of silently rendering stale data (deployment-skew protection).
  // Fixes #1829.
  const deploymentId = process.env.__VINEXT_DEPLOYMENT_ID || process.env.NEXT_DEPLOYMENT_ID;
  if (deploymentId) {
    headers[NEXTJS_DEPLOYMENT_ID_HEADER] = deploymentId;
  }
  return new Response("{}", { status: 404, headers });
}

export function buildMiddlewarePrefetchSkipResponse(matchedPathname: string): Response {
  return new Response("{}", {
    headers: {
      "Content-Type": "application/json",
      "x-matched-path": matchedPathname,
      [MIDDLEWARE_SKIP_HEADER]: "1",
      "Cache-Control": "private, no-cache, no-store, max-age=0, must-revalidate",
    },
  });
}

// ---------------------------------------------------------------------------
// normalizePagesDataRequest
// ---------------------------------------------------------------------------

type NormalizePagesDataRequestResult =
  | {
      isDataReq: false;
      request: Request;
      normalizedPathname: null;
      search: "";
      notFoundResponse: null;
    }
  | {
      isDataReq: true;
      request: Request;
      normalizedPathname: null;
      search: string;
      notFoundResponse: Response;
    }
  | {
      isDataReq: true;
      request: Request;
      normalizedPathname: string;
      search: string;
      notFoundResponse: null;
    };

/**
 * Detect and normalize `/_next/data/<buildId>/<page>.json` requests in one
 * place so the Pages Router pipeline and middleware shim do not need to know
 * about the data-endpoint protocol.
 *
 * Returns:
 * - `isDataReq: false, notFoundResponse: null` — not a data request.
 * - `isDataReq: true, normalizedPathname: null` — looks like a data URL but
 *   the buildId does not match. Callers may defer `notFoundResponse` until
 *   after middleware so `skipProxyUrlNormalize` middleware can intercept the
 *   original URL.
 * - `isDataReq: true` — valid data request; `request` is re-pointed at the
 *   normalized page path, `normalizedPathname` carries the bare page path, and
 *   `search` carries the original query string for callers that need to
 *   preserve it.
 *
 * Extracted from `entries/pages-server-entry.ts` so both `renderPage` and
 * `runMiddleware` share a single implementation.
 */
export function normalizePagesDataRequest(
  request: Request,
  buildId: string | null,
  basePath = "",
  trailingSlash = false,
): NormalizePagesDataRequestResult {
  const reqUrl = new URL(request.url);
  const hadBasePath = !!basePath && hasBasePath(reqUrl.pathname, basePath);
  const dataPathname = basePath ? stripBasePath(reqUrl.pathname, basePath) : reqUrl.pathname;
  if (!isNextDataPathname(dataPathname)) {
    return {
      isDataReq: false,
      request,
      normalizedPathname: null,
      search: "",
      notFoundResponse: null,
    };
  }
  const dataMatch = buildId ? parseNextDataPathname(dataPathname, buildId) : null;
  if (!dataMatch) {
    return {
      isDataReq: true,
      request,
      normalizedPathname: null,
      search: reqUrl.search,
      notFoundResponse: buildNextDataNotFoundResponse(),
    };
  }
  const pagePathname = normalizeNextDataPagePathname(dataMatch.pagePathname, trailingSlash);
  const normalizedUrl = new URL(reqUrl);
  normalizedUrl.pathname = hadBasePath
    ? addBasePathToPathname(pagePathname, basePath)
    : pagePathname;
  return {
    isDataReq: true,
    request: new Request(normalizedUrl, request),
    normalizedPathname: pagePathname,
    search: reqUrl.search,
    notFoundResponse: null,
  };
}
