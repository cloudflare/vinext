import type { ReactNode } from "react";
import type { VinextNextData } from "../client/vinext-next-data.js";
import type { Route } from "../routing/pages-router.js";
import { normalizeStaticPathname } from "../routing/route-pattern.js";
import type { CachedPagesValue, CacheControlMetadata } from "vinext/shims/cache-handler";
import { applyCdnResponseHeaders } from "./cache-control.js";
import { decideIsr } from "./isr-decision.js";
import { buildCacheStateHeaders } from "./cache-headers.js";
import { buildPagesCacheValue, type ISRCacheEntry } from "./isr-cache.js";
import type { PagesPreviewData } from "./pages-preview.js";
import {
  buildPagesNextDataScript,
  etagMatches,
  generatePagesETag,
  isPagesStreamingBot,
  requestsNoCache,
  type PagesGsspResponse,
  type PagesI18nRenderContext,
  type PagesNextDataExtras,
} from "./pages-page-response.js";
import {
  hasPagesGetInitialProps,
  isResponseSent,
  loadPagesGetInitialProps,
} from "./pages-get-initial-props.js";
import { buildNextDataPropsJsonResponse } from "./pages-data-route.js";
import { NEXTJS_DEPLOYMENT_ID_HEADER } from "./headers.js";
import { isSerializableProps } from "./pages-serializable-props.js";
import { isBotUserAgent } from "../utils/html-limited-bots.js";
import { isUnknownRecord } from "../utils/record.js";

type PagesRedirectResult = {
  destination: string;
  permanent?: boolean;
  statusCode?: number;
};

// Next.js allows `paths` entries to be either an object with a `params` key
// or a raw string path. We keep a local variant of `StaticPathsEntry` here
// because at request time we compare against the actual request `params`
// (whose value type is `unknown` from the route matcher) rather than the
// `string | string[]` shape used at build time. The shared
// `normalizeStaticPathname` helper from `../routing/route-pattern.js` is used
// to canonicalize the string-entry comparison.
export type PagesStaticPathsEntry =
  | string
  | {
      params?: Record<string, unknown>;
      locale?: string;
    };

type PagesStaticPathsResult = {
  fallback?: boolean | "blocking";
  paths?: PagesStaticPathsEntry[];
};

type PagesPagePropsResult = {
  props?: Record<string, unknown>;
  redirect?: PagesRedirectResult;
  notFound?: boolean;
  revalidate?: number;
};

type PagesMutableGsspResponse = {
  headersSent: boolean;
} & PagesGsspResponse;

type PagesGsspContextResponse = {
  req: unknown;
  res: PagesMutableGsspResponse;
  responsePromise: Promise<Response>;
};

type PagesRenderProps = Record<string, unknown> & {
  pageProps: unknown;
};

export type PagesPageModule = {
  default?: unknown;
  getStaticPaths?: (context: {
    locales: string[];
    defaultLocale: string;
  }) => Promise<PagesStaticPathsResult> | PagesStaticPathsResult;
  /**
   * Pages Router data-fetching context.
   *
   * `params` is `null` for non-dynamic routes (no `[param]` segments) to
   * match Next.js. User code typically falls back via `params || null`, so
   * passing `null` (rather than `{}`) is required for the value to be
   * observable as `null` once the data flows through to the page props.
   *
   * See: test/e2e/edge-pages-support/index.test.ts in Next.js for the
   * authoritative assertion (`expect(props.params).toBe(null)`).
   */
  getServerSideProps?: (context: {
    params: Record<string, unknown> | null;
    req: unknown;
    res: PagesMutableGsspResponse;
    query: Record<string, unknown>;
    resolvedUrl: string;
    locale?: string;
    locales?: string[];
    defaultLocale?: string;
    draftMode?: true;
    preview?: true;
    previewData?: PagesPreviewData;
  }) => Promise<PagesPagePropsResult> | PagesPagePropsResult;
  getStaticProps?: (context: {
    params: Record<string, unknown> | null;
    locale?: string;
    locales?: string[];
    defaultLocale?: string;
    draftMode?: true;
    preview?: true;
    previewData?: PagesPreviewData;
    /**
     * Indicates why `getStaticProps` was invoked.
     *
     * - `"build"`: initial build-time prerender (before runtime traffic).
     * - `"on-demand"`: triggered by `res.revalidate()` from an API route.
     * - `"stale"`: stale-while-revalidate background regeneration.
     *
     * Mirrors Next.js `render.tsx`'s `revalidateReason` on the
     * `GetStaticPropsContext` type — see
     * `.nextjs-ref/packages/next/src/types.ts`.
     */
    revalidateReason?: "build" | "on-demand" | "stale";
  }) => Promise<PagesPagePropsResult> | PagesPagePropsResult;
};

type RenderPagesIsrHtmlOptions = {
  buildId: string | null;
  cachedHtml: string;
  createPageElement: (props: Record<string, unknown>) => ReactNode;
  i18n: PagesI18nRenderContext;
  pageProps: Record<string, unknown>;
  props?: Record<string, unknown>;
  params: Record<string, unknown>;
  renderIsrPassToStringAsync: (element: ReactNode) => Promise<string>;
  routePattern: string;
  safeJsonStringify: (value: unknown) => string;
  vinext?: VinextNextData["__vinext"];
  nextData?: PagesNextDataExtras;
};

export type ResolvePagesPageDataOptions = {
  applyRequestContexts: () => void;
  buildId: string | null;
  /**
   * When true, this is a `/_next/data/<buildId>/<page>.json` request. Callers
   * that respond with a JSON envelope (`{ pageProps }`) instead of HTML must
   * bypass the HTML ISR cache: a cached HTML body cannot be reshaped into the
   * expected JSON shape, and storing JSON in the HTML cache would corrupt
   * subsequent HTML hits. Next.js handles this the same way — see
   * `isNextDataRequest` checks in `packages/next/src/server/base-server.ts`.
   */
  isDataReq?: boolean;
  err?: unknown;
  createGsspReqRes: () => PagesGsspContextResponse;
  createAppTree?: (props: Record<string, unknown>) => ReactNode;
  createPageElement: (props: Record<string, unknown>) => ReactNode;
  fontLinkHeader: string;
  i18n: PagesI18nRenderContext;
  isrCacheKey: (router: string, pathname: string) => string;
  isrGet: (key: string) => Promise<ISRCacheEntry | null>;
  isrSet: (
    key: string,
    data: CachedPagesValue,
    revalidateSeconds: number,
    tags?: string[],
    expireSeconds?: number,
  ) => Promise<void>;
  expireSeconds?: number;
  /**
   * When true, this dispatch corresponds to a build-time prerender (the
   * `vinext` build phase fetches each statically generated page through the
   * production server). Maps to `revalidateReason: "build"` when
   * `getStaticProps` is invoked. Mirrors Next.js's
   * `renderOpts.isBuildTimePrerendering` flag — see
   * `.nextjs-ref/packages/next/src/server/render.tsx`.
   */
  isBuildTimePrerendering?: boolean;
  validatePropsSerialization?: boolean;
  /**
   * When true, this dispatch was triggered by an on-demand revalidation
   * request (e.g. `res.revalidate()` in a Pages Router API route, or an
   * equivalent webhook). Maps to `revalidateReason: "on-demand"` when
   * `getStaticProps` is invoked, and bypasses the fresh/stale cache-hit
   * short-circuits so the entry is regenerated synchronously. Mirrors Next.js's
   * `renderOpts.isOnDemandRevalidate` flag — see
   * `.nextjs-ref/packages/next/src/server/render.tsx`.
   *
   * The page handler sets this only when the incoming request's
   * `x-prerender-revalidate` header (`PRERENDER_REVALIDATE_HEADER`) *equals* the
   * process revalidate secret that `res.revalidate()` attaches to its internal
   * request (`isOnDemandRevalidateRequest`). It is never set on mere header
   * presence — see the security note in `isr-cache.ts`.
   */
  isOnDemandRevalidate?: boolean;
  previewData?: PagesPreviewData | false;
  /**
   * The deployment ID used for deployment-skew protection. When set, it is
   * included as `x-nextjs-deployment-id` on all `_next/data` responses
   * (success, redirect, notFound). Mirrors Next.js pages-handler.ts behavior.
   * Typically sourced from `process.env.__VINEXT_DEPLOYMENT_ID || process.env.NEXT_DEPLOYMENT_ID`.
   */
  deploymentId?: string;
  htmlLimitedBots?: string;
  pageModule: PagesPageModule;
  AppComponent?: unknown;
  params: Record<string, unknown>;
  query: Record<string, unknown>;
  asPath?: string;
  resolvedUrl?: string;
  route: Pick<Route, "isDynamic">;
  routePattern: string;
  routeUrl: string;
  runInFreshUnifiedContext: <T>(callback: () => Promise<T>) => Promise<T>;
  safeJsonStringify: (value: unknown) => string;
  sanitizeDestination: (destination: string) => string;
  scriptNonce?: string;
  statusCode?: number;
  triggerBackgroundRegeneration: (
    key: string,
    renderFn: () => Promise<void>,
    errorContext?: { routerKind: "Pages Router"; routePath: string; routeType: "render" },
  ) => void;
  renderIsrPassToStringAsync: (element: ReactNode) => Promise<string>;
  vinext?: VinextNextData["__vinext"];
  nextData?: PagesNextDataExtras;
  /**
   * The request's User-Agent string. When this matches a known crawler/bot
   * pattern, ISR cache-HIT and cache-STALE responses receive an ETag header
   * for consistency with the fresh-MISS path (which also attaches an ETag for
   * bot UAs via `renderPagesPageResponse`). See the divergence note in
   * `pages-page-response.ts` for why UA-gating is used instead of Next.js's
   * `isDynamic` check.
   */
  userAgent?: string;
  /**
   * The incoming request's `If-None-Match` header value. When the cached HTML
   * ETag matches (weak-ETag semantics), the ISR cache-HIT or cache-STALE
   * response is a `304 Not Modified` with no body.
   */
  ifNoneMatch?: string;
  /**
   * The incoming request's `Cache-Control` header value. When it contains
   * `no-cache`, the 304 short-circuit is skipped and a full response is
   * returned — mirroring the `fresh` package used by Next.js.
   */
  requestCacheControl?: string;
};

type ResolvePagesPageDataRenderResult = {
  kind: "render";
  documentReqRes: PagesGsspContextResponse | null;
  gsspRes: PagesGsspResponse | null;
  isrRevalidateSeconds: number | null;
  pageProps: Record<string, unknown>;
  props: PagesRenderProps;
  /**
   * True when `getStaticPaths` returned `fallback: true` AND the requested path
   * is not in the pre-rendered list. The caller renders a loading shell with
   * empty props and `useRouter().isFallback === true` (matching Next.js's
   * `render.tsx` — `getStaticProps` is skipped on the fallback render).
   */
  isFallback: boolean;
};

type ResolvePagesPageDataResponseResult = {
  kind: "response";
  response: Response;
};

type ResolvePagesPageDataNotFoundResult = {
  kind: "notFound";
};

type ResolvePagesPageDataResult =
  | ResolvePagesPageDataRenderResult
  | ResolvePagesPageDataResponseResult
  | ResolvePagesPageDataNotFoundResult;

function buildPagesDataNotFoundResponse(deploymentId?: string): Response {
  // Matches Next.js: `/_next/data/<buildId>/<page>.json` 404 responses use
  // application/json with an empty object body so clients can call
  // `res.json()` without throwing before inspecting the status code.
  // Mirror Next.js pages-handler.ts: set x-nextjs-deployment-id on all
  // `_next/data` notFound exits so the client can detect a new deployment.
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (deploymentId) {
    headers[NEXTJS_DEPLOYMENT_ID_HEADER] = deploymentId;
  }
  return new Response("{}", {
    status: 404,
    headers,
  });
}

function buildPagesNotFoundResult(
  options: Pick<ResolvePagesPageDataOptions, "isDataReq" | "deploymentId">,
): ResolvePagesPageDataResponseResult | ResolvePagesPageDataNotFoundResult {
  if (options.isDataReq) {
    return {
      kind: "response",
      response: buildPagesDataNotFoundResponse(options.deploymentId),
    };
  }

  return { kind: "notFound" };
}

function resolvePagesRedirectStatus(redirect: PagesRedirectResult): number {
  return redirect.statusCode != null ? redirect.statusCode : redirect.permanent ? 308 : 307;
}

function normalizePagesRenderProps(props: Record<string, unknown>): PagesRenderProps {
  return {
    ...props,
    pageProps: props.pageProps,
  };
}

type PagesAppInitialPropsResult =
  | { kind: "props"; pageProps: Record<string, unknown>; renderProps: PagesRenderProps }
  | { kind: "response"; response: Promise<Response> };

/**
 * Load `_app.getInitialProps` and return the normalized render props and the
 * extracted `pageProps`. This is shared between the foreground render path and
 * the stale-while-revalidate background regeneration path so both produce the
 * same full props envelope (app-level props plus the page's `pageProps`).
 *
 * `getSharedReqRes` lets callers share the same mock req/res with other
 * data-fetching steps (e.g. `getServerSideProps`) when they run in the same
 * request context.
 */
async function loadPagesAppInitialRenderProps(
  options: Pick<
    ResolvePagesPageDataOptions,
    | "AppComponent"
    | "createAppTree"
    | "createPageElement"
    | "err"
    | "i18n"
    | "pageModule"
    | "query"
    | "routePattern"
    | "routeUrl"
    | "asPath"
  >,
  getSharedReqRes: () => PagesGsspContextResponse,
): Promise<PagesAppInitialPropsResult> {
  let pageProps: Record<string, unknown> = {};
  let renderProps: PagesRenderProps = { pageProps };

  if (!hasPagesGetInitialProps(options.AppComponent)) {
    return { kind: "props", pageProps, renderProps };
  }

  const { req, res, responsePromise } = getSharedReqRes();
  const initialProps = await loadPagesGetInitialProps(options.AppComponent, {
    AppTree: options.createAppTree ?? options.createPageElement,
    Component: options.pageModule.default,
    router: {
      pathname: options.routePattern,
      query: options.query,
      asPath: options.asPath ?? options.routeUrl,
    },
    ctx: {
      req,
      res,
      err: options.err,
      pathname: options.routePattern,
      query: options.query,
      asPath: options.asPath ?? options.routeUrl,
      locale: options.i18n.locale,
      locales: options.i18n.locales,
      defaultLocale: options.i18n.defaultLocale,
    },
  });

  if (isResponseSent(res)) {
    return { kind: "response", response: responsePromise };
  }

  if (initialProps) {
    renderProps = normalizePagesRenderProps(initialProps);
    pageProps = isUnknownRecord(renderProps.pageProps) ? renderProps.pageProps : {};
  }

  return { kind: "props", pageProps, renderProps };
}

/**
 * Build the response for a `getServerSideProps` / `getStaticProps`
 * `{ redirect }` result.
 *
 * For an HTML page request we emit a real HTTP redirect (`Location` header) so
 * a hard navigation lands on the destination.
 *
 * For a `/_next/data/<buildId>/<page>.json` request (a client-side navigation)
 * we must NOT emit an HTTP redirect: the client's `fetch()` would transparently
 * follow it to the destination's HTML, which is not a valid data envelope and
 * would force a hard reload (and console error noise). Instead we mirror
 * Next.js and return a 200 JSON envelope carrying `__N_REDIRECT` /
 * `__N_REDIRECT_STATUS` inside `pageProps`. The client router detects these
 * markers and performs a fresh client navigation to the destination, which
 * supersedes (cancels) the in-flight navigation.
 *
 * Ported from Next.js: `packages/next/src/server/render.tsx` — the
 * `__N_REDIRECT` / `__N_REDIRECT_STATUS` props assignment for gSSP/gSP
 * redirects (search `__N_REDIRECT`), consumed in
 * `packages/next/src/shared/lib/router/router.ts` (`pageProps.__N_REDIRECT`).
 */
function buildPagesRedirectResponse(
  redirect: PagesRedirectResult,
  options: Pick<
    ResolvePagesPageDataOptions,
    "isDataReq" | "sanitizeDestination" | "safeJsonStringify" | "deploymentId"
  >,
  props: PagesRenderProps = { pageProps: {} },
): Response {
  const destination = options.sanitizeDestination(redirect.destination);

  if (options.isDataReq) {
    // Mirror Next.js pages-handler.ts: set x-nextjs-deployment-id on all
    // `_next/data` redirect exits for deployment-skew protection.
    const init: ResponseInit & { headers: Record<string, string> } = { headers: {} };
    if (options.deploymentId) {
      init.headers[NEXTJS_DEPLOYMENT_ID_HEADER] = options.deploymentId;
    }
    return buildNextDataPropsJsonResponse(
      {
        ...props,
        pageProps: {
          ...(isUnknownRecord(props.pageProps) ? props.pageProps : {}),
          __N_REDIRECT: destination,
          __N_REDIRECT_STATUS: resolvePagesRedirectStatus(redirect),
        },
      },
      options.safeJsonStringify,
      init,
    );
  }

  return new Response(null, {
    status: resolvePagesRedirectStatus(redirect),
    headers: { Location: destination },
  });
}

/**
 * Compare a `getStaticPaths` entry against the actual request params.
 *
 * Handles both shapes Next.js allows:
 *   - { params: { ... } }
 *   - "string-path"
 *
 * For a string entry, compare the entry against the current request URL using
 * the shared `normalizeStaticPathname` helper from
 * `../routing/route-pattern.ts` (which mirrors the Next.js
 * `removeTrailingSlash` behaviour in
 * `.nextjs-ref/packages/next/src/build/static-paths/pages.ts`). For an object
 * entry with a missing `params` key, return false rather than throwing — the
 * caller will respond with a 404 just like Next.js does for unlisted paths.
 */
export type PagesRouteParam = {
  key: string;
  repeat: boolean;
  optional: boolean;
};

export function getPagesRouteParams(routePattern: string): PagesRouteParam[] {
  return routePattern
    .split("/")
    .map((segment) => {
      const optionalCatchAll = segment.match(/^\[\[\.\.\.(.+)\]\]$/);
      if (optionalCatchAll) {
        return { key: optionalCatchAll[1], repeat: true, optional: true };
      }
      const requiredCatchAll = segment.match(/^\[\.\.\.(.+)\]$/);
      if (requiredCatchAll) {
        return { key: requiredCatchAll[1], repeat: true, optional: false };
      }
      const dynamic = segment.match(/^\[(.+)\]$/);
      if (dynamic) {
        return { key: dynamic[1], repeat: false, optional: false };
      }
      return null;
    })
    .filter((param): param is PagesRouteParam => param !== null);
}

export function matchesPagesStaticPath(
  pathEntry: PagesStaticPathsEntry,
  params: Record<string, unknown>,
  routeParams: PagesRouteParam[],
  routeUrl: string,
): boolean {
  if (typeof pathEntry === "string") {
    return normalizeStaticPathname(pathEntry) === normalizeStaticPathname(routeUrl);
  }
  const entryParams = pathEntry.params;
  if (entryParams === undefined || entryParams === null) {
    return false;
  }

  return routeParams.every(({ key, repeat, optional }) => {
    if (!Object.hasOwn(entryParams, key)) {
      return false;
    }

    let value = entryParams[key];
    // Mirrors Next.js build/static-paths/pages.ts: optional catch-all values
    // explicitly returned as null, undefined, or false normalize to [].
    if (optional && (value === null || value === undefined || value === false)) {
      value = [];
    }

    if (repeat) {
      if (!Array.isArray(value) || (!optional && value.length === 0)) {
        return false;
      }
    } else if (typeof value !== "string") {
      return false;
    }

    const actual = params[key];
    if (Array.isArray(value)) {
      if (optional && value.length === 0 && actual === undefined) {
        return true;
      }
      return Array.isArray(actual) && value.join("/") === actual.join("/");
    }
    return String(value) === String(actual);
  });
}

function buildPagesCacheResponse(
  html: string,
  cacheState: "HIT" | "STALE",
  fontLinkHeader: string,
  revalidateSeconds?: number,
  expireSeconds?: number,
  cacheControl?: CacheControlMetadata,
  status?: number,
): Response {
  // Legacy cache entries written before cacheControl metadata existed can still
  // hit this path without a persisted revalidate value; keep the historic
  // 60-second fallback for that migration window.
  const effectiveRevalidateSeconds = revalidateSeconds ?? 60;
  // HIT/STALE served from the origin store: route the cache header through the
  // CDN adapter (default: identical single Cache-Control). Edge adapters never
  // reach this path because their get() returns null.
  const { cacheControl: cacheControlHeader } = decideIsr({
    cacheState,
    kind: "pages",
    revalidateSeconds: effectiveRevalidateSeconds,
    expireSeconds,
    cacheControlMeta: cacheControl,
  });
  const headers = new Headers({
    "Content-Type": "text/html; charset=utf-8",
    ...buildCacheStateHeaders(cacheState),
  });
  applyCdnResponseHeaders(headers, { cacheControl: cacheControlHeader });

  if (fontLinkHeader) {
    headers.set("Link", fontLinkHeader);
  }

  return new Response(html, {
    status: status ?? 200,
    headers,
  });
}

/**
 * For bot / crawler UAs, attach an ETag to a cached ISR response (HIT or
 * STALE) so it is consistent with the fresh-MISS path, then check for a
 * matching `If-None-Match`. When the check passes — and the request did NOT
 * carry `Cache-Control: no-cache` — returns a 304 response; otherwise returns
 * `null` so the caller can return the full response.
 *
 * Extracted to avoid duplicating the same three-line block across the HIT and
 * STALE branches.
 */
function applyBotETagAndCheck(
  cachedResponse: Response,
  html: string,
  options: Pick<ResolvePagesPageDataOptions, "userAgent" | "ifNoneMatch" | "requestCacheControl">,
): ResolvePagesPageDataResponseResult | null {
  if (!options.userAgent || !isPagesStreamingBot(options.userAgent)) {
    return null;
  }
  const etag = generatePagesETag(html);
  cachedResponse.headers.set("ETag", etag);
  const noCacheRequested = requestsNoCache(options.requestCacheControl);
  if (!noCacheRequested && options.ifNoneMatch && etagMatches(etag, options.ifNoneMatch)) {
    return {
      kind: "response",
      response: new Response(null, {
        status: 304,
        headers: cachedResponse.headers,
      }),
    };
  }
  return null;
}

function rewritePagesCachedHtml(
  cachedHtml: string,
  freshBody: string,
  nextDataScript: string,
): string {
  const bodyMarker = '<div id="__next">';
  const bodyStart = cachedHtml.indexOf(bodyMarker);
  const contentStart = bodyStart >= 0 ? bodyStart + bodyMarker.length : -1;
  const canonicalNextDataStart = cachedHtml.search(
    /<script\b(?=[^>]*\bid=["']__NEXT_DATA__["'])(?=[^>]*\btype=["']application\/json["'])[^>]*>/,
  );
  const legacyNextDataStart = cachedHtml.indexOf("<script>window.__NEXT_DATA__");
  const nextDataStart = canonicalNextDataStart >= 0 ? canonicalNextDataStart : legacyNextDataStart;

  if (contentStart >= 0 && nextDataStart >= 0) {
    const region = cachedHtml.slice(contentStart, nextDataStart);
    const lastCloseDiv = region.lastIndexOf("</div>");
    const gap = lastCloseDiv >= 0 ? region.slice(lastCloseDiv + 6) : "";
    const nextDataEnd = cachedHtml.indexOf("</script>", nextDataStart) + 9;
    const tail = cachedHtml.slice(nextDataEnd);

    return cachedHtml.slice(0, contentStart) + freshBody + "</div>" + gap + nextDataScript + tail;
  }

  return (
    '<!DOCTYPE html>\n<html>\n<head>\n</head>\n<body>\n  <div id="__next">' +
    freshBody +
    "</div>\n  " +
    nextDataScript +
    "\n</body>\n</html>"
  );
}

export async function renderPagesIsrHtml(options: RenderPagesIsrHtmlOptions): Promise<string> {
  const renderProps = options.props ?? { pageProps: options.pageProps };
  const freshBody = await options.renderIsrPassToStringAsync(
    options.createPageElement(renderProps),
  );
  const nextDataScript = buildPagesNextDataScript({
    buildId: options.buildId,
    i18n: options.i18n,
    pageProps: options.pageProps,
    props: renderProps,
    params: options.params,
    routePattern: options.routePattern,
    safeJsonStringify: options.safeJsonStringify,
    // Serialize the same readiness flags (gssp/gsp/autoExport/…) the initial
    // render emits, so the regenerated HTML hydrates with the identical initial
    // `router.isReady` the server computed instead of a flag-less fallback.
    nextData: options.nextData,
    vinext: options.vinext,
  });

  return rewritePagesCachedHtml(options.cachedHtml, freshBody, nextDataScript);
}

export async function resolvePagesPageData(
  options: ResolvePagesPageDataOptions,
): Promise<ResolvePagesPageDataResult> {
  // Next.js passes `params: null` (effectively) to gSSP/gSP context for
  // non-dynamic routes — see render.tsx's `...(pageIsDynamic ? { params } : undefined)`.
  // Internal bookkeeping (route param hydration, ISR HTML, getStaticPaths
  // validation) still uses the matched-but-empty object — only user-facing
  // data-fetching contexts surface `null`.
  const userFacingParams: Record<string, unknown> | null = options.route.isDynamic
    ? options.params
    : null;

  // Set when `getStaticPaths: { fallback: true }` is configured and the
  // requested path is NOT in the pre-rendered list. When true, we render the
  // loading shell with empty props and `useRouter().isFallback === true`,
  // skipping `getStaticProps`. Matches Next.js `render.tsx`'s
  // `if (isSSG && !isFallback)` gate around `getStaticProps`. Data requests
  // (`/_next/data/...json`) still call `getStaticProps` so the client can
  // hydrate the page after the fallback shell ships.
  let isFallback = false;
  let shouldPersistFallbackData = false;
  const previewData = options.isOnDemandRevalidate ? false : (options.previewData ?? false);

  if (typeof options.pageModule.getStaticPaths === "function" && options.route.isDynamic) {
    const pathsResult = await options.pageModule.getStaticPaths({
      locales: options.i18n.locales ?? [],
      defaultLocale: options.i18n.defaultLocale ?? "",
    });
    const fallback = pathsResult?.fallback ?? false;
    const paths = pathsResult?.paths ?? [];
    const routeParams = getPagesRouteParams(options.routePattern);
    const isValidPath = paths.some((pathEntry) =>
      matchesPagesStaticPath(pathEntry, options.params, routeParams, options.routeUrl),
    );

    if (fallback === false && !isValidPath && previewData === false) {
      // For data requests (`/_next/data/...json`), return a JSON-shaped 404
      // so the client router can `res.json()` without blowing up — matches
      // Next.js' behavior. HTML navigations still get the configured 404 page.
      return buildPagesNotFoundResult(options);
    }

    // Render the fallback shell for unlisted paths under `fallback: true`.
    // Data requests resolve props normally so the client can fill in after
    // the loading shell ships (`fallback: 'blocking'` keeps SSRing as before).
    const isBotRequest =
      !!options.userAgent && isBotUserAgent(options.userAgent, options.htmlLimitedBots);
    if (
      fallback === true &&
      !isValidPath &&
      !options.isDataReq &&
      !isBotRequest &&
      previewData === false
    ) {
      isFallback = true;
    }
    shouldPersistFallbackData = fallback === true && !isValidPath && options.isDataReq === true;
  }

  let pageProps: Record<string, unknown> = {};
  let gsspRes: PagesMutableGsspResponse | null = null;
  const previewContext =
    previewData === false
      ? {}
      : {
          draftMode: true as const,
          preview: true as const,
          previewData,
        };

  let sharedReqRes: PagesGsspContextResponse | null = null;
  function getSharedReqRes(): PagesGsspContextResponse {
    sharedReqRes ??= options.createGsspReqRes();
    return sharedReqRes;
  }

  let renderProps: PagesRenderProps = { pageProps };
  if (previewData !== false) renderProps.__N_PREVIEW = true;

  async function loadForegroundAppInitialRenderProps(): Promise<ResolvePagesPageDataResult | null> {
    const result = await loadPagesAppInitialRenderProps(options, getSharedReqRes);
    if (result.kind === "response") {
      return {
        kind: "response",
        response: await result.response,
      };
    }
    renderProps = result.renderProps;
    pageProps = result.pageProps;
    return null;
  }

  if (isFallback) {
    const pathname = options.routeUrl.split("?")[0];
    const cached = await options.isrGet(options.isrCacheKey("pages", pathname));
    if (cached?.value.value?.kind !== "PAGES") {
      const appShortCircuit = await loadForegroundAppInitialRenderProps();
      if (appShortCircuit) return appShortCircuit;
      pageProps = {};
      renderProps = { ...renderProps, pageProps };
      return {
        kind: "render",
        documentReqRes: sharedReqRes,
        gsspRes: null,
        isrRevalidateSeconds: null,
        pageProps,
        props: renderProps,
        isFallback: true,
      };
    }
  }

  if (typeof options.pageModule.getServerSideProps === "function") {
    const shortCircuit = await loadForegroundAppInitialRenderProps();
    if (shortCircuit) {
      return shortCircuit;
    }
    renderProps = { ...renderProps, __N_SSP: true };
    const { req, res, responsePromise } = getSharedReqRes();
    const result = await options.pageModule.getServerSideProps({
      params: userFacingParams,
      req,
      res,
      query: options.query,
      resolvedUrl: options.resolvedUrl ?? options.routeUrl,
      locale: options.i18n.locale,
      locales: options.i18n.locales,
      defaultLocale: options.i18n.defaultLocale,
      ...previewContext,
    });

    if (isResponseSent(res)) {
      return {
        kind: "response",
        response: await responsePromise,
      };
    }

    if (result?.props) {
      // Next.js explicitly supports a Promise value for `props`. Await it
      // before serialising; otherwise pageProps would be a Promise and the
      // rendered page would receive empty props. See
      // packages/next/src/server/render.tsx (deferredContent).
      pageProps = {
        ...pageProps,
        ...((await Promise.resolve(result.props)) as Record<string, unknown>),
      };
      renderProps = { ...renderProps, pageProps };
    }

    if (result?.redirect) {
      return {
        kind: "response",
        response: buildPagesRedirectResponse(result.redirect, options, renderProps),
      };
    }

    if (result?.notFound) {
      return buildPagesNotFoundResult(options);
    }

    // Mirrors Next.js render.tsx's `isSerializableProps(pathname, "getServerSideProps", data.props)`
    // check, gated on `!metadata.isRedirect && !metadata.isNotFound` (both
    // short-circuit above). Throws a friendly `SerializableError` so the
    // caller's existing try/catch surfaces a clear 500 instead of rendering
    // an empty page. See
    // .nextjs-ref/packages/next/src/server/render.tsx (~line 1200) and
    // .nextjs-ref/packages/next/src/lib/is-serializable-props.ts. Tracked in
    // vinext#1478.
    if (result?.props !== undefined && options.validatePropsSerialization !== false) {
      isSerializableProps(options.routePattern, "getServerSideProps", pageProps);
    }

    gsspRes = res;
  }

  let isrRevalidateSeconds: number | null = null;

  if (typeof options.pageModule.getStaticProps === "function") {
    const pathname = options.routeUrl.split("?")[0];
    const cacheKey = options.isrCacheKey("pages", pathname);
    const cached = await options.isrGet(cacheKey);
    const cachedValue = cached?.value.value;

    // On-demand revalidation (`res.revalidate()`) must regenerate the entry
    // synchronously with `revalidateReason: "on-demand"`, so the fresh/stale
    // cache-hit short-circuits below are bypassed and execution falls through
    // to the regeneration path. Mirrors Next.js's `isOnDemandRevalidate`
    // handling in render.tsx / base-server.ts.
    if (
      !options.isOnDemandRevalidate &&
      cached?.isStale === false &&
      cachedValue?.kind === "PAGES" &&
      !cachedValue.generatedFromDataRequest &&
      cached &&
      !cached.isStale &&
      !options.scriptNonce &&
      !options.isDataReq &&
      previewData === false
    ) {
      const hitResponse = buildPagesCacheResponse(
        cachedValue.html,
        "HIT",
        options.fontLinkHeader,
        undefined,
        options.expireSeconds,
        cached.value.cacheControl,
        cachedValue.status,
      );
      // Bot / crawler ETag consistency: attach an ETag to cache-HIT responses
      // for bot UAs so they are consistent with fresh-MISS bot responses (which
      // also carry an ETag via `renderPagesPageResponse`). When the incoming
      // `If-None-Match` matches (and no `Cache-Control: no-cache`), return 304.
      const hitBotResult = applyBotETagAndCheck(hitResponse, cachedValue.html, options);
      if (hitBotResult) return hitBotResult;
      return {
        kind: "response",
        response: hitResponse,
      };
    }

    if (
      !options.isOnDemandRevalidate &&
      cachedValue?.kind === "PAGES" &&
      !cachedValue.generatedFromDataRequest &&
      cached &&
      cached.isStale &&
      !options.scriptNonce &&
      !options.isDataReq &&
      previewData === false
    ) {
      options.triggerBackgroundRegeneration(
        cacheKey,
        async function () {
          return options.runInFreshUnifiedContext(async () => {
            options.applyRequestContexts();
            // Rebuild the full App render props before re-running getStaticProps
            // so the regenerated HTML / __NEXT_DATA__ still contains app-level
            // props from _app.getInitialProps. Mirrors the foreground path.
            const freshAppResult = await loadPagesAppInitialRenderProps(options, () =>
              options.createGsspReqRes(),
            );
            if (freshAppResult.kind === "response") {
              // _app.getInitialProps short-circuited the request during background
              // regeneration. We cannot turn that into an HTTP response here, so
              // skip the cache write and let the stale entry remain.
              return;
            }
            let freshPageProps = freshAppResult.pageProps;
            let freshRenderProps = freshAppResult.renderProps;

            const freshResult = await options.pageModule.getStaticProps?.({
              params: userFacingParams,
              locale: options.i18n.locale,
              locales: options.i18n.locales,
              defaultLocale: options.i18n.defaultLocale,
              // Background regeneration for an entry that is already in the
              // cache is always a stale-while-revalidate refresh — mirrors
              // Next.js `render.tsx` (`isBuildTimeSSG ? "build" : "stale"`,
              // and we're not at build time here).
              revalidateReason: "stale",
            });

            if (freshResult?.props) {
              freshPageProps = { ...freshPageProps, ...freshResult.props };
              freshRenderProps = { ...freshRenderProps, pageProps: freshPageProps };
            }

            const freshRevalidateSeconds =
              typeof freshResult?.revalidate === "number" && freshResult.revalidate > 0
                ? freshResult.revalidate
                : cached.value.cacheControl?.revalidate;

            if (freshResult?.props && freshRevalidateSeconds && freshRevalidateSeconds > 0) {
              const freshHtml = await renderPagesIsrHtml({
                buildId: options.buildId,
                cachedHtml: cachedValue.html,
                createPageElement: options.createPageElement,
                i18n: options.i18n,
                pageProps: freshPageProps,
                props: freshRenderProps,
                params: options.params,
                renderIsrPassToStringAsync: options.renderIsrPassToStringAsync,
                routePattern: options.routePattern,
                safeJsonStringify: options.safeJsonStringify,
                nextData: options.nextData,
                vinext: options.vinext,
              });

              await options.isrSet(
                cacheKey,
                buildPagesCacheValue(freshHtml, freshRenderProps, options.statusCode),
                freshRevalidateSeconds,
                undefined,
                options.expireSeconds,
              );
            }
          });
        },
        {
          routerKind: "Pages Router",
          routePath: options.routePattern,
          routeType: "render",
        },
      );

      const staleResponse = buildPagesCacheResponse(
        cachedValue.html,
        "STALE",
        options.fontLinkHeader,
        undefined,
        options.expireSeconds,
        cached.value.cacheControl,
        cachedValue.status,
      );
      // Bot / crawler ETag consistency: same as the HIT branch — attach an
      // ETag to STALE responses for bot UAs and honour If-None-Match / 304.
      const staleBotResult = applyBotETagAndCheck(staleResponse, cachedValue.html, options);
      if (staleBotResult) return staleBotResult;
      return {
        kind: "response",
        response: staleResponse,
      };
    }

    const generatedPageData =
      !options.isOnDemandRevalidate &&
      previewData === false &&
      cached?.isStale === false &&
      cachedValue?.kind === "PAGES" &&
      cachedValue.generatedFromDataRequest &&
      isUnknownRecord(cachedValue.pageData)
        ? cachedValue.pageData
        : null;
    if (!generatedPageData) {
      const shortCircuit = await loadForegroundAppInitialRenderProps();
      if (shortCircuit) return shortCircuit;
    }
    const result = generatedPageData
      ? null
      : await options.pageModule.getStaticProps({
          params: userFacingParams,
          locale: options.i18n.locale,
          locales: options.i18n.locales,
          defaultLocale: options.i18n.defaultLocale,
          ...previewContext,
          revalidateReason: options.isOnDemandRevalidate
            ? "on-demand"
            : options.isBuildTimePrerendering
              ? "build"
              : "stale",
        });

    if (generatedPageData) {
      renderProps = generatedPageData as PagesRenderProps;
      pageProps = isUnknownRecord(renderProps.pageProps) ? renderProps.pageProps : {};
    }

    if (result?.props) {
      pageProps = { ...pageProps, ...result.props };
      renderProps = { ...renderProps, pageProps };
    }

    if (result?.redirect) {
      return {
        kind: "response",
        response: buildPagesRedirectResponse(result.redirect, options, renderProps),
      };
    }

    if (result?.notFound) {
      return buildPagesNotFoundResult(options);
    }

    // Mirrors Next.js render.tsx's `isSerializableProps(pathname, "getStaticProps", data.props)`
    // check, gated on `!metadata.isNotFound` (notFound + redirect both
    // short-circuit above). Throws a friendly `SerializableError` so the
    // caller's existing try/catch surfaces a clear 500 instead of rendering
    // an empty page. See
    // .nextjs-ref/packages/next/src/server/render.tsx (~line 982) and
    // .nextjs-ref/packages/next/src/lib/is-serializable-props.ts. Tracked in
    // vinext#1478.
    if (result?.props !== undefined && options.validatePropsSerialization !== false) {
      isSerializableProps(options.routePattern, "getStaticProps", pageProps);
    }

    if (previewData === false && typeof result?.revalidate === "number" && result.revalidate > 0) {
      isrRevalidateSeconds = result.revalidate;
    } else if (
      previewData === false &&
      cachedValue?.kind === "PAGES" &&
      cachedValue.generatedFromDataRequest
    ) {
      isrRevalidateSeconds = cached?.value.cacheControl?.revalidate ?? 31_536_000;
    }

    if (shouldPersistFallbackData && previewData === false) {
      const revalidateSeconds = isrRevalidateSeconds ?? 31_536_000;
      await options.isrSet(
        cacheKey,
        {
          kind: "PAGES",
          html: "",
          pageData: renderProps,
          generatedFromDataRequest: true,
          headers: undefined,
          status: undefined,
        },
        revalidateSeconds,
        undefined,
        options.expireSeconds,
      );
    }
  }

  if (
    typeof options.pageModule.getServerSideProps !== "function" &&
    typeof options.pageModule.getStaticProps !== "function" &&
    hasPagesGetInitialProps(options.AppComponent)
  ) {
    const shortCircuit = await loadForegroundAppInitialRenderProps();
    if (shortCircuit) {
      return shortCircuit;
    }
  }

  if (
    typeof options.pageModule.getServerSideProps !== "function" &&
    typeof options.pageModule.getStaticProps !== "function" &&
    !hasPagesGetInitialProps(options.AppComponent) &&
    hasPagesGetInitialProps(options.pageModule.default)
  ) {
    const { req, res, responsePromise } = getSharedReqRes();
    const initialProps = await loadPagesGetInitialProps(options.pageModule.default, {
      req,
      res,
      err: options.err,
      pathname: options.routePattern,
      query: options.query,
      asPath: options.asPath ?? options.routeUrl,
      locale: options.i18n.locale,
      locales: options.i18n.locales,
      defaultLocale: options.i18n.defaultLocale,
    });

    if (isResponseSent(res)) {
      return {
        kind: "response",
        response: await responsePromise,
      };
    }

    if (initialProps) {
      pageProps = { ...pageProps, ...initialProps };
      renderProps = { ...renderProps, pageProps };
    }
  }

  return {
    kind: "render",
    documentReqRes: sharedReqRes,
    gsspRes,
    isrRevalidateSeconds,
    pageProps,
    props: renderProps,
    isFallback: false,
  };
}
