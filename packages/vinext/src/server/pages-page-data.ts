import type { ReactNode } from "react";
import type { Route } from "../routing/pages-router.js";
import type { VinextNextData } from "../client/vinext-next-data.js";
import { normalizeStaticPathname } from "../routing/route-pattern.js";
import type { CachedPagesValue, CacheControlMetadata } from "vinext/shims/cache";
import { buildCachedRevalidateCacheControl } from "./cache-control.js";
import { buildCacheStateHeaders } from "./cache-headers.js";
import { buildPagesCacheValue, type ISRCacheEntry } from "./isr-cache.js";
import {
  buildPagesNextDataScript,
  type PagesGsspResponse,
  type PagesI18nRenderContext,
} from "./pages-page-response.js";
import { buildDefaultPagesNotFoundResponse } from "./pages-default-404.js";

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
type PagesStaticPathsEntry = string | { params?: Record<string, unknown>; locale?: string };

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

export type PagesMutableGsspResponse = {
  headersSent: boolean;
} & PagesGsspResponse;

export type PagesGsspContextResponse = {
  req: unknown;
  res: PagesMutableGsspResponse;
  responsePromise: Promise<Response>;
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
  }) => Promise<PagesPagePropsResult> | PagesPagePropsResult;
  getStaticProps?: (context: {
    params: Record<string, unknown> | null;
    locale?: string;
    locales?: string[];
    defaultLocale?: string;
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
  createPageElement: (pageProps: Record<string, unknown>) => ReactNode;
  i18n: PagesI18nRenderContext;
  pageProps: Record<string, unknown>;
  params: Record<string, unknown>;
  renderIsrPassToStringAsync: (element: ReactNode) => Promise<string>;
  routePattern: string;
  safeJsonStringify: (value: unknown) => string;
  vinext?: VinextNextData["__vinext"];
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
  createGsspReqRes: () => PagesGsspContextResponse;
  createPageElement: (pageProps: Record<string, unknown>) => ReactNode;
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
  /**
   * When true, this dispatch was triggered by an on-demand revalidation
   * request (e.g. `res.revalidate()` in a Pages Router API route, or an
   * equivalent webhook). Maps to `revalidateReason: "on-demand"` when
   * `getStaticProps` is invoked. Mirrors Next.js's
   * `renderOpts.isOnDemandRevalidate` flag — see
   * `.nextjs-ref/packages/next/src/server/render.tsx`.
   *
   * Forward-looking plumbing: no caller currently sets this — `res.revalidate()`
   * is not yet implemented in vinext. The `"on-demand"` branch in the
   * `revalidateReason` resolver is intentionally unreachable today; keeping the
   * typed contract here means wiring it up will be a one-line change once the
   * trigger lands.
   */
  isOnDemandRevalidate?: boolean;
  pageModule: PagesPageModule;
  params: Record<string, unknown>;
  query: Record<string, unknown>;
  route: Pick<Route, "isDynamic">;
  routePattern: string;
  routeUrl: string;
  runInFreshUnifiedContext: <T>(callback: () => Promise<T>) => Promise<T>;
  safeJsonStringify: (value: unknown) => string;
  sanitizeDestination: (destination: string) => string;
  scriptNonce?: string;
  vinext?: VinextNextData["__vinext"];
  triggerBackgroundRegeneration: (
    key: string,
    renderFn: () => Promise<void>,
    errorContext?: { routerKind: "Pages Router"; routePath: string; routeType: "render" },
  ) => void;
  renderIsrPassToStringAsync: (element: ReactNode) => Promise<string>;
};

type ResolvePagesPageDataRenderResult = {
  kind: "render";
  gsspRes: PagesGsspResponse | null;
  isrRevalidateSeconds: number | null;
  pageProps: Record<string, unknown>;
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

type ResolvePagesPageDataResult =
  | ResolvePagesPageDataRenderResult
  | ResolvePagesPageDataResponseResult;

function buildPagesNotFoundResponse(): Response {
  return buildDefaultPagesNotFoundResponse();
}

function buildPagesDataNotFoundResponse(): Response {
  // Matches Next.js: `/_next/data/<buildId>/<page>.json` 404 responses use
  // application/json with an empty object body so clients can call
  // `res.json()` without throwing before inspecting the status code.
  return new Response("{}", {
    status: 404,
    headers: { "Content-Type": "application/json" },
  });
}

function resolvePagesRedirectStatus(redirect: PagesRedirectResult): number {
  return redirect.statusCode != null ? redirect.statusCode : redirect.permanent ? 308 : 307;
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
function matchesPagesStaticPath(
  pathEntry: PagesStaticPathsEntry,
  params: Record<string, unknown>,
  routeUrl: string,
): boolean {
  if (typeof pathEntry === "string") {
    return normalizeStaticPathname(pathEntry) === normalizeStaticPathname(routeUrl);
  }
  const entryParams = pathEntry.params;
  if (entryParams === undefined || entryParams === null) {
    return false;
  }
  return Object.entries(entryParams).every(([key, value]) => {
    const actual = params[key];
    if (Array.isArray(value)) {
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
): Response {
  // Legacy cache entries written before cacheControl metadata existed can still
  // hit this path without a persisted revalidate value; keep the historic
  // 60-second fallback for that migration window.
  const effectiveRevalidateSeconds = cacheControl?.revalidate ?? revalidateSeconds ?? 60;
  const effectiveExpireSeconds =
    cacheControl === undefined ? undefined : (cacheControl.expire ?? expireSeconds);
  const headers: Record<string, string> = {
    "Content-Type": "text/html",
    ...buildCacheStateHeaders(cacheState),
    "Cache-Control": buildCachedRevalidateCacheControl(
      cacheState,
      effectiveRevalidateSeconds,
      effectiveExpireSeconds,
    ),
  };

  if (fontLinkHeader) {
    headers.Link = fontLinkHeader;
  }

  return new Response(html, {
    status: 200,
    headers,
  });
}

function rewritePagesCachedHtml(
  cachedHtml: string,
  freshBody: string,
  nextDataScript: string,
): string {
  const bodyMarker = '<div id="__next">';
  const bodyStart = cachedHtml.indexOf(bodyMarker);
  const contentStart = bodyStart >= 0 ? bodyStart + bodyMarker.length : -1;
  // This intentionally looks for the bare inline __NEXT_DATA__ marker.
  // Pages responses with scriptNonce are excluded from ISR writes, so cached
  // HTML should never contain nonce-prefixed __NEXT_DATA__ scripts here.
  const nextDataMarker = "<script>window.__NEXT_DATA__";
  const nextDataStart = cachedHtml.indexOf(nextDataMarker);

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
  const freshBody = await options.renderIsrPassToStringAsync(
    options.createPageElement(options.pageProps),
  );
  const nextDataScript = buildPagesNextDataScript({
    buildId: options.buildId,
    i18n: options.i18n,
    pageProps: options.pageProps,
    params: options.params,
    routePattern: options.routePattern,
    safeJsonStringify: options.safeJsonStringify,
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

  if (typeof options.pageModule.getStaticPaths === "function" && options.route.isDynamic) {
    const pathsResult = await options.pageModule.getStaticPaths({
      locales: options.i18n.locales ?? [],
      defaultLocale: options.i18n.defaultLocale ?? "",
    });
    const fallback = pathsResult?.fallback ?? false;
    const paths = pathsResult?.paths ?? [];
    const isValidPath = paths.some((pathEntry) =>
      matchesPagesStaticPath(pathEntry, options.params, options.routeUrl),
    );

    if (fallback === false && !isValidPath) {
      // For data requests (`/_next/data/...json`), return a JSON-shaped 404
      // so the client router can `res.json()` without blowing up — matches
      // Next.js' behavior. HTML navigations still get the HTML 404 page.
      return {
        kind: "response",
        response: options.isDataReq
          ? buildPagesDataNotFoundResponse()
          : buildPagesNotFoundResponse(),
      };
    }

    // Render the fallback shell for unlisted paths under `fallback: true`.
    // Data requests resolve props normally so the client can fill in after
    // the loading shell ships (`fallback: 'blocking'` keeps SSRing as before).
    if (fallback === true && !isValidPath && !options.isDataReq) {
      isFallback = true;
    }
  }

  let pageProps: Record<string, unknown> = {};
  let gsspRes: PagesMutableGsspResponse | null = null;

  if (isFallback) {
    return {
      kind: "render",
      gsspRes: null,
      isrRevalidateSeconds: null,
      pageProps,
      isFallback: true,
    };
  }

  if (typeof options.pageModule.getServerSideProps === "function") {
    const { req, res, responsePromise } = options.createGsspReqRes();
    const result = await options.pageModule.getServerSideProps({
      params: userFacingParams,
      req,
      res,
      query: options.query,
      resolvedUrl: options.routeUrl,
      locale: options.i18n.locale,
      locales: options.i18n.locales,
      defaultLocale: options.i18n.defaultLocale,
    });

    if (res.headersSent) {
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
      pageProps = (await Promise.resolve(result.props)) as Record<string, unknown>;
    }

    if (result?.redirect) {
      return {
        kind: "response",
        response: new Response(null, {
          status: resolvePagesRedirectStatus(result.redirect),
          headers: { Location: options.sanitizeDestination(result.redirect.destination) },
        }),
      };
    }

    if (result?.notFound) {
      return {
        kind: "response",
        response: options.isDataReq
          ? buildPagesDataNotFoundResponse()
          : buildPagesNotFoundResponse(),
      };
    }

    gsspRes = res;
  }

  let isrRevalidateSeconds: number | null = null;

  if (typeof options.pageModule.getStaticProps === "function") {
    const pathname = options.routeUrl.split("?")[0];
    const cacheKey = options.isrCacheKey("pages", pathname);
    const cached = await options.isrGet(cacheKey);
    const cachedValue = cached?.value.value;

    if (
      cachedValue?.kind === "PAGES" &&
      cached &&
      !cached.isStale &&
      !options.scriptNonce &&
      !options.isDataReq
    ) {
      return {
        kind: "response",
        response: buildPagesCacheResponse(
          cachedValue.html,
          "HIT",
          options.fontLinkHeader,
          undefined,
          options.expireSeconds,
          cached.value.cacheControl,
        ),
      };
    }

    if (
      cachedValue?.kind === "PAGES" &&
      cached &&
      cached.isStale &&
      !options.scriptNonce &&
      !options.isDataReq
    ) {
      options.triggerBackgroundRegeneration(
        cacheKey,
        async function () {
          return options.runInFreshUnifiedContext(async () => {
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

            if (
              freshResult?.props &&
              typeof freshResult.revalidate === "number" &&
              freshResult.revalidate > 0
            ) {
              options.applyRequestContexts();
              const freshHtml = await renderPagesIsrHtml({
                buildId: options.buildId,
                cachedHtml: cachedValue.html,
                createPageElement: options.createPageElement,
                i18n: options.i18n,
                pageProps: freshResult.props,
                params: options.params,
                renderIsrPassToStringAsync: options.renderIsrPassToStringAsync,
                routePattern: options.routePattern,
                safeJsonStringify: options.safeJsonStringify,
                vinext: options.vinext,
              });

              await options.isrSet(
                cacheKey,
                buildPagesCacheValue(freshHtml, freshResult.props),
                freshResult.revalidate,
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

      return {
        kind: "response",
        response: buildPagesCacheResponse(
          cachedValue.html,
          "STALE",
          options.fontLinkHeader,
          undefined,
          options.expireSeconds,
          cached.value.cacheControl,
        ),
      };
    }

    const result = await options.pageModule.getStaticProps({
      params: userFacingParams,
      locale: options.i18n.locale,
      locales: options.i18n.locales,
      defaultLocale: options.i18n.defaultLocale,
      // Maps Next.js's resolution in `render.tsx`:
      //   isOnDemandRevalidate ? "on-demand"
      //     : isBuildTimeSSG    ? "build"
      //                         : "stale"
      // We pick "stale" as the default at runtime so existing-but-missing
      // (cache evicted) entries surface as a regeneration rather than a build.
      revalidateReason: options.isOnDemandRevalidate
        ? "on-demand"
        : options.isBuildTimePrerendering
          ? "build"
          : "stale",
    });

    if (result?.props) {
      pageProps = result.props;
    }

    if (result?.redirect) {
      return {
        kind: "response",
        response: new Response(null, {
          status: resolvePagesRedirectStatus(result.redirect),
          headers: { Location: options.sanitizeDestination(result.redirect.destination) },
        }),
      };
    }

    if (result?.notFound) {
      return {
        kind: "response",
        response: options.isDataReq
          ? buildPagesDataNotFoundResponse()
          : buildPagesNotFoundResponse(),
      };
    }

    if (typeof result?.revalidate === "number" && result.revalidate > 0) {
      isrRevalidateSeconds = result.revalidate;
    }
  }

  return {
    kind: "render",
    gsspRes,
    isrRevalidateSeconds,
    pageProps,
    isFallback: false,
  };
}
