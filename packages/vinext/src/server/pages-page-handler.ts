/**
 * Pages Router render orchestrator.
 *
 * Extracted from `entries/pages-server-entry.ts` so the request lifecycle
 * lives in a typed, unit-testable module rather than inside a codegen template
 * string — mirroring how `server/app-rsc-handler.ts` contains the App Router
 * handler while `entries/app-rsc-entry.ts` stays thin wiring.
 *
 * `createPagesPageHandler` returns the async render function (`renderPage`)
 * that the entry delegates to. All `next/*`-derived values are passed in as
 * closures so this module stays importable in the test environment (the root
 * vite.config.ts only aliases `vinext/shims/*`, not `next/*`).
 */

import type { ComponentType, ReactNode } from "react";
import { mergeRouteParamsIntoQuery, parseQueryString as parseQuery } from "../utils/query.js";
import { patternToNextFormat } from "../routing/route-validation.js";
import { resolvePagesI18nRequest } from "./pages-i18n.js";
import { createPagesReqRes } from "./pages-node-compat.js";
import { resolvePagesPageData } from "./pages-page-data.js";
import type { PagesPageModule } from "./pages-page-data.js";
import { resolvePagesPageMethodResponse } from "./pages-page-method.js";
import { renderPagesPageResponse } from "./pages-page-response.js";
import type { PagesI18nRenderContext } from "./pages-page-response.js";
import type { RenderPageEnhancers } from "./pages-document-initial-props.js";
import {
  buildNextDataJsonResponse,
  buildNextDataNotFoundResponse,
  normalizePagesDataRequest,
} from "./pages-data-route.js";
import { buildDefaultPagesNotFoundResponse } from "./pages-default-404.js";
import {
  isrGet,
  isrSet,
  isrCacheKey,
  triggerBackgroundRegeneration,
  PRERENDER_REVALIDATE_HEADER,
  isOnDemandRevalidateRequest,
} from "./isr-cache.js";
import { getScriptNonceFromHeaderSources } from "./csp.js";
import { reportRequestError } from "./instrumentation.js";
import { createRequestContext, runWithRequestContext } from "vinext/shims/unified-request-context";
import { getRequestExecutionContext } from "vinext/shims/request-context";
import { ensureFetchPatch } from "vinext/shims/fetch-cache";
import { collectAssetTags, resolveClientModuleUrl } from "./pages-asset-tags.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type PageRoute = {
  pattern: string;
  patternParts: string[];
  isDynamic: boolean;
  params: string[];
  module: PagesPageModule;
  filePath: string;
};

type PageRouteMatch = {
  route: PageRoute;
  params: Record<string, string | string[]>;
};

type I18nConfig = {
  locales: string[];
  defaultLocale: string;
  localeDetection?: boolean;
  domains?: Array<{
    domain: string;
    defaultLocale: string;
    locales?: string[];
    http?: boolean;
  }>;
} | null;

type VinextConfigSubset = {
  basePath: string;
  trailingSlash: boolean;
  expireTime?: number;
  clientTraceMetadata?: readonly string[];
  disableOptimizedLoading: boolean;
};

/**
 * Options accepted by `createPagesPageHandler`.
 *
 * All `next/*`-derived functions are passed as closures from the generated
 * entry so this module avoids `next/*` imports and stays unit-testable.
 */
export type CreatePagesPageHandlerOptions = {
  /** Full page route table (built by the generated entry). */
  pageRoutes: PageRoute[];
  /** The `_error` route when present; null otherwise. */
  errorPageRoute: PageRoute | null;
  /** Route matcher — same function the entry uses for `matchRoute`. */
  matchRoute: (url: string, routes: PageRoute[]) => PageRouteMatch | null;
  /** i18n config from next.config.js, or null when i18n is not configured. */
  i18nConfig: I18nConfig;
  /** Subset of embedded vinextConfig used by the render pipeline. */
  vinextConfig: VinextConfigSubset;
  /** Build ID embedded at build time (or null in dev). */
  buildId: string | null;
  /** Whether the app has user-defined middleware. */
  hasMiddleware: boolean;
  /** Absolute file path of `pages/_app` (or null). Used for manifest lookup. */
  appAssetPath: string | null;

  // ── next/*-derived closures ──────────────────────────────────────────────

  /** `setSSRContext` from `next/router`. */
  setSSRContext: ((ctx: Record<string, unknown> | null) => void) | null;
  /** `setI18nContext` from `vinext/i18n-context`. */
  setI18nContext: ((ctx: Record<string, unknown>) => void) | null;
  /** `wrapWithRouterContext` from `next/router`. */
  wrapWithRouterContext: ((element: ReactNode) => ReactNode) | null;
  /** `resetSSRHead` from `next/head`. */
  resetSSRHead: (() => void) | undefined;
  /** `getSSRHeadHTML` from `next/head`. */
  getSSRHeadHTML: (() => string) | undefined;
  /** `setDocumentInitialHead` from `next/head`. */
  setDocumentInitialHead: ((head: ReactNode[]) => void) | undefined;
  /** `flushPreloads` from `next/dynamic`. */
  flushPreloads: (() => Promise<void> | void) | undefined;
  /** `getSSRFontLinks` from `next/font/google`. */
  getFontLinks: () => string[];
  /** Combined styles from `next/font/google` + `next/font/local`. */
  getFontStyles: () => string[];
  /** Combined font preloads. */
  getFontPreloads: () => Array<{ href: string; type: string }>;
  /** `renderToReadableStream` from `react-dom/server.edge`. */
  renderToReadableStream: (element: ReactNode) => Promise<ReadableStream<Uint8Array>>;
  /** Render a second ISR pass to a string (wraps renderToReadableStream). */
  renderIsrPassToStringAsync: (element: ReactNode) => Promise<string>;
  /** `safeJsonStringify` from `vinext/html`. */
  safeJsonStringify: (value: unknown) => string;
  /** `sanitizeDestination` from the config-matchers module. */
  sanitizeDestination: (dest: string) => string;
  /** Build the React page element for a given set of page props. */
  createPageElement: (
    PageComponent: ComponentType,
    AppComponent: ComponentType | null,
    pageProps: Record<string, unknown>,
  ) => ReactNode;
  /** Build the element with optional App/Component enhancers (for _document). */
  enhancePageElement: (
    PageComponent: ComponentType,
    AppComponent: ComponentType | null,
    pageProps: Record<string, unknown>,
    opts: RenderPageEnhancers,
  ) => ReactNode;
  /** The `_app` page component (or null). */
  AppComponent: ComponentType | null;
  /** The `_document` page component (or null). */
  DocumentComponent: ComponentType | null;
};

// Internal render options (mirrors the options shape passed to `renderPage`).
type RenderPageOptions = {
  isDataReq?: boolean;
  statusCode?: number;
  asPath?: string;
  renderErrorPageOnMiss?: boolean;
  __isInternalErrorRender?: boolean;
  __forcedRoute?: PageRoute;
  err?: unknown;
};

// ---------------------------------------------------------------------------
// Helper: build i18n render context for resolvePagesPageData / renderPagesPageResponse
// ---------------------------------------------------------------------------

function buildI18nRenderContext(
  i18nConfig: I18nConfig,
  locale: string | undefined,
  currentDefaultLocale: string | undefined,
  domainLocales: I18nConfig extends null ? never : NonNullable<I18nConfig>["domains"],
): PagesI18nRenderContext {
  return {
    locale,
    locales: i18nConfig ? i18nConfig.locales : undefined,
    defaultLocale: currentDefaultLocale,
    domainLocales,
  };
}

// ---------------------------------------------------------------------------
// createPagesPageHandler
// ---------------------------------------------------------------------------

/**
 * Create the Pages Router render function (`_renderPage`).
 *
 * The returned function is self-recursive for 404/500 fallback renders and
 * accepts the same options shape the generated entry always passed inline.
 */
export function createPagesPageHandler(
  opts: CreatePagesPageHandlerOptions,
): (
  request: Request,
  url: string,
  manifest: Record<string, string[]> | null | undefined,
  middlewareHeaders: Headers | null | undefined,
  options: RenderPageOptions | null | undefined,
) => Promise<Response> {
  const {
    pageRoutes,
    errorPageRoute,
    matchRoute,
    i18nConfig,
    vinextConfig,
    buildId,
    hasMiddleware,
    appAssetPath,
    setSSRContext,
    setI18nContext,
    wrapWithRouterContext,
    resetSSRHead,
    getSSRHeadHTML,
    setDocumentInitialHead,
    flushPreloads,
    getFontLinks,
    getFontStyles,
    getFontPreloads,
    renderToReadableStream,
    renderIsrPassToStringAsync,
    safeJsonStringify,
    sanitizeDestination,
    createPageElement,
    enhancePageElement,
    AppComponent,
    DocumentComponent,
  } = opts;

  function renderToStringAsync(element: ReactNode): Promise<string> {
    return renderToReadableStream(element).then((stream) => new Response(stream).text());
  }

  function findNotFoundRoute(): PageRoute | null {
    for (let i = 0; i < pageRoutes.length; i++) {
      if (pageRoutes[i].pattern === "/404") return pageRoutes[i];
    }
    return errorPageRoute;
  }

  function isrCacheKeyForRequest(
    i18nCacheVariant: string | null,
  ): (router: string, pathname: string) => string {
    if (!i18nCacheVariant) {
      return (router, pathname) => isrCacheKey(router, pathname, buildId ?? undefined);
    }
    return (router, pathname) =>
      isrCacheKey(
        router,
        pathname + "::i18n=" + encodeURIComponent(i18nCacheVariant),
        buildId ?? undefined,
      );
  }

  // The recursive render function — defined inside so it can self-call for
  // fallback/error renders without leaking the `opts` closure to callers.
  async function renderPage(
    request: Request,
    url: string,
    manifest: Record<string, string[]> | null | undefined,
    middlewareHeaders: Headers | null | undefined,
    options: RenderPageOptions | null | undefined,
  ): Promise<Response> {
    let isDataReq = !!(options && options.isDataReq);

    // Auto-detect /_next/data/... requests by inspecting the incoming URL.
    // When the worker pipeline forwards an unrewritten data URL as the `url`
    // arg, normalize it to the page path here.
    if (!isDataReq) {
      const dataNorm = normalizePagesDataRequest(request, buildId);
      if (dataNorm.notFoundResponse) return dataNorm.notFoundResponse;
      if (dataNorm.isDataReq) {
        isDataReq = true;
        if (url && url.startsWith("/_next/data/")) {
          const qs = url.includes("?") ? url.slice(url.indexOf("?")) : "";
          url = dataNorm.normalizedPathname + qs;
        }
      }
    }

    const statusCode =
      options && typeof options.statusCode === "number" ? options.statusCode : undefined;
    const asPath = options && typeof options.asPath === "string" ? options.asPath : undefined;
    const renderErrorPageOnMiss = !(options && options.renderErrorPageOnMiss === false);
    // Guard against infinite recursion when the user's custom 500/error page
    // itself throws during render. When this flag is set, the catch block
    // returns a plain "Internal Server Error" text response instead of trying
    // to render an error page again. Fixes #1458.
    const isInternalErrorRender = !!(options && options.__isInternalErrorRender);
    const err = options && options.err;

    const localeInfo = i18nConfig
      ? resolvePagesI18nRequest(
          url,
          i18nConfig,
          request.headers,
          new URL(request.url).hostname,
          vinextConfig.basePath,
          vinextConfig.trailingSlash,
        )
      : {
          locale: undefined,
          url,
          hadPrefix: false,
          domainLocale: undefined,
          redirectUrl: undefined,
        };

    const locale = localeInfo.locale;
    const routeUrl = localeInfo.url;
    const currentDefaultLocale = i18nConfig
      ? localeInfo.domainLocale
        ? localeInfo.domainLocale.defaultLocale
        : i18nConfig.defaultLocale
      : undefined;
    const domainLocales = i18nConfig ? i18nConfig.domains : undefined;
    const i18nCacheVariant = i18nConfig
      ? localeInfo.domainLocale
        ? "domain:" + String(localeInfo.domainLocale.domain).toLowerCase()
        : "locale:" + String(locale)
      : null;
    const pageIsrCacheKey = isrCacheKeyForRequest(i18nCacheVariant);

    if (localeInfo.redirectUrl) {
      return new Response(null, { status: 307, headers: { Location: localeInfo.redirectUrl } });
    }

    // Internal error render path: caller has pinned a specific route to render.
    // Skip route matching so we don't accidentally double-route. Fixes #1458.
    let match =
      options && options.__forcedRoute
        ? { route: options.__forcedRoute, params: {} as Record<string, string | string[]> }
        : matchRoute(routeUrl, pageRoutes);

    let renderStatusCodeOverride = statusCode;
    let renderAsPath = asPath;

    if (!match) {
      if (isDataReq) {
        return buildNextDataNotFoundResponse();
      }
      if (!renderErrorPageOnMiss) {
        return buildDefaultPagesNotFoundResponse();
      }
      const notFoundRoute = findNotFoundRoute();
      if (notFoundRoute) {
        match = { route: notFoundRoute, params: {} };
        renderStatusCodeOverride = 404;
        renderAsPath = routeUrl;
      } else {
        return buildDefaultPagesNotFoundResponse();
      }
    }

    const { route, params } = match;
    const uCtx = createRequestContext({
      executionContext: getRequestExecutionContext(),
    });

    return runWithRequestContext(uCtx, async () => {
      ensureFetchPatch();
      try {
        const routePattern = patternToNextFormat(route.pattern);
        const renderStatusCode =
          renderStatusCodeOverride ?? (routePattern === "/404" ? 404 : undefined);
        const query = mergeRouteParamsIntoQuery(parseQuery(routeUrl), params);

        function applySSRContext(): void {
          if (typeof setSSRContext === "function") {
            setSSRContext({
              pathname: routePattern,
              query,
              asPath: renderAsPath ?? routeUrl,
              locale,
              locales: i18nConfig ? i18nConfig.locales : undefined,
              defaultLocale: currentDefaultLocale,
              domainLocales,
            });
          }
          if (i18nConfig && typeof setI18nContext === "function") {
            setI18nContext({
              locale,
              locales: i18nConfig.locales,
              defaultLocale: currentDefaultLocale,
              domainLocales,
              hostname: new URL(request.url).hostname,
            });
          }
        }

        applySSRContext();

        const pageModule = route.module;
        const PageComponent = pageModule.default as ComponentType | undefined;
        if (!PageComponent) {
          return new Response("Page has no default export", { status: 500 });
        }

        // Reject non-GET/HEAD on static (no getServerSideProps) routes with
        // 405 + Allow: GET, HEAD. Skip for error/status pages, data requests,
        // and override renders. Mirrors Next.js base-server.ts L2277 carve-outs.
        if (
          !isDataReq &&
          routePattern !== "/_error" &&
          routePattern !== "/404" &&
          routePattern !== "/500" &&
          renderStatusCodeOverride === undefined
        ) {
          const methodResponse = resolvePagesPageMethodResponse({
            hasGetServerSideProps: typeof pageModule.getServerSideProps === "function",
            method: request.method,
          });
          if (methodResponse) return methodResponse;
        }

        const pageModuleUrl = resolveClientModuleUrl(manifest, route.filePath);
        const appModuleUrl = resolveClientModuleUrl(manifest, appAssetPath);
        const scriptNonce = getScriptNonceFromHeaderSources(request.headers, middlewareHeaders);

        // Build font Link header early — available for ISR cached responses too.
        let fontLinkHeader = "";
        let allFontPreloads: Array<{ href: string; type: string }> = [];
        try {
          allFontPreloads = getFontPreloads();
          if (allFontPreloads.length > 0) {
            fontLinkHeader = allFontPreloads
              .map(
                (p) => "<" + p.href + ">; rel=preload; as=font; type=" + p.type + "; crossorigin",
              )
              .join(", ");
          }
        } catch {
          /* font preloads not available */
        }

        const pageDataResult = await resolvePagesPageData({
          isDataReq,
          err,
          applyRequestContexts: applySSRContext,
          buildId,
          createGsspReqRes() {
            return createPagesReqRes({ body: undefined, query, request, url: routeUrl });
          },
          createPageElement(currentPageProps) {
            const el = createPageElement(PageComponent, AppComponent, currentPageProps);
            return typeof wrapWithRouterContext === "function" ? wrapWithRouterContext(el) : el;
          },
          fontLinkHeader,
          i18n: buildI18nRenderContext(i18nConfig, locale, currentDefaultLocale, domainLocales),
          isrCacheKey: pageIsrCacheKey,
          isrGet,
          isrSet,
          expireSeconds: vinextConfig.expireTime,
          isBuildTimePrerendering:
            typeof process !== "undefined" && process.env && process.env.VINEXT_PRERENDER === "1",
          // `res.revalidate()` issues an internal request carrying the
          // `x-prerender-revalidate` header set to the process revalidate
          // secret; treat it as an on-demand revalidation so getStaticProps
          // sees `revalidateReason: "on-demand"` and the cache entry is
          // regenerated synchronously. SECURITY: authorized by *equality*
          // against the secret (never presence) — `isOnDemandRevalidateRequest`
          // mirrors Next.js's `checkIsOnDemandRevalidate`, preventing an
          // external client from forcing synchronous regeneration via an
          // arbitrary header value (cache-stampede/DoS vector).
          isOnDemandRevalidate: isOnDemandRevalidateRequest(
            request.headers.get(PRERENDER_REVALIDATE_HEADER),
          ),
          pageModule,
          params,
          query,
          asPath: renderAsPath ?? routeUrl,
          renderIsrPassToStringAsync,
          route: { isDynamic: route.isDynamic },
          routePattern,
          routeUrl,
          runInFreshUnifiedContext(callback) {
            const revalCtx = createRequestContext({
              executionContext: getRequestExecutionContext(),
            });
            return runWithRequestContext(revalCtx, async () => {
              ensureFetchPatch();
              return callback();
            });
          },
          safeJsonStringify,
          sanitizeDestination,
          scriptNonce,
          statusCode: renderStatusCode,
          triggerBackgroundRegeneration,
          vinext: { pageModuleUrl, appModuleUrl, hasMiddleware },
        });

        if (pageDataResult.kind === "notFound") {
          const notFoundRoute = findNotFoundRoute();
          if (notFoundRoute && routePattern !== "/404" && routePattern !== "/_error") {
            return renderPage(request, url, manifest, middlewareHeaders, {
              statusCode: 404,
              asPath: renderAsPath ?? routeUrl,
              renderErrorPageOnMiss: false,
              __forcedRoute: notFoundRoute,
            });
          }
          return buildDefaultPagesNotFoundResponse();
        }
        if (pageDataResult.kind === "response") {
          return pageDataResult.response;
        }

        let pageProps = pageDataResult.pageProps;
        if (routePattern === "/_error" && typeof renderStatusCode === "number") {
          pageProps = { ...pageProps, statusCode: renderStatusCode };
        }
        const gsspRes = pageDataResult.gsspRes;
        const isrRevalidateSeconds = pageDataResult.isrRevalidateSeconds;
        const isFallbackRender = pageDataResult.isFallback === true;

        // Republish SSR context with isFallback flipped on so `useRouter().isFallback`
        // returns true during render, matching Next.js render.tsx fallback shell.
        if (isFallbackRender && typeof setSSRContext === "function") {
          setSSRContext({
            pathname: routePattern,
            query,
            asPath: renderAsPath ?? routeUrl,
            locale,
            locales: i18nConfig ? i18nConfig.locales : undefined,
            defaultLocale: currentDefaultLocale,
            domainLocales,
            isFallback: true,
          });
        }

        // ── _next/data JSON envelope short-circuit ─────────────────────────
        // For client-side navigations Next.js fetches /_next/data/<buildId>/<page>.json
        // and expects { pageProps } as JSON instead of the full HTML page.
        if (isDataReq) {
          const init: ResponseInit & { headers: Record<string, string> } = { headers: {} };
          if (gsspRes && typeof gsspRes.getHeaders === "function") {
            const gsspHeaders = gsspRes.getHeaders();
            for (const k of Object.keys(gsspHeaders)) {
              const v = gsspHeaders[k];
              if (v === undefined || v === null) continue;
              init.headers[k] = Array.isArray(v) ? v.join(", ") : String(v);
            }
          }
          if (gsspRes) {
            // Default Cache-Control for gSSP-driven _next/data responses —
            // skip when gSSP already set one via res.setHeader. Fixes #1461.
            let hasUserCacheControl = false;
            for (const headerKey of Object.keys(init.headers)) {
              if (headerKey.toLowerCase() === "cache-control") {
                hasUserCacheControl = true;
                break;
              }
            }
            if (!hasUserCacheControl) {
              init.headers["Cache-Control"] =
                "private, no-cache, no-store, max-age=0, must-revalidate";
            }
          }
          return buildNextDataJsonResponse(pageProps, safeJsonStringify, init);
        }

        // Include both the matched page module and the global _app module.
        // _app is wrapped around every page and any CSS/JS it imports must
        // be linked from the rendered HTML (LHF-5 symptom).
        const pageModuleIds: (string | null | undefined)[] = [];
        if (route.filePath) pageModuleIds.push(route.filePath);
        if (appAssetPath) pageModuleIds.push(appAssetPath);
        const assetTags = collectAssetTags({
          manifest,
          moduleIds: pageModuleIds,
          scriptNonce,
          disableOptimizedLoading: vinextConfig.disableOptimizedLoading,
        });

        return await renderPagesPageResponse({
          assetTags,
          buildId,
          clearSsrContext() {
            if (typeof setSSRContext === "function") setSSRContext(null);
          },
          createPageElement(currentPageProps) {
            const el = createPageElement(PageComponent, AppComponent, currentPageProps);
            return typeof wrapWithRouterContext === "function" ? wrapWithRouterContext(el) : el;
          },
          enhancePageElement(renderPageOpts) {
            const el = enhancePageElement(PageComponent, AppComponent, pageProps, renderPageOpts);
            return typeof wrapWithRouterContext === "function" ? wrapWithRouterContext(el) : el;
          },
          DocumentComponent,
          flushPreloads: typeof flushPreloads === "function" ? flushPreloads : undefined,
          fontLinkHeader,
          fontPreloads: allFontPreloads,
          getFontLinks,
          getFontStyles,
          getSSRHeadHTML: typeof getSSRHeadHTML === "function" ? getSSRHeadHTML : undefined,
          clientTraceMetadata: vinextConfig.clientTraceMetadata,
          gsspRes,
          isrCacheKey: pageIsrCacheKey,
          expireSeconds: vinextConfig.expireTime,
          isrRevalidateSeconds,
          isrSet,
          i18n: buildI18nRenderContext(i18nConfig, locale, currentDefaultLocale, domainLocales),
          isFallback: isFallbackRender,
          pageProps,
          params,
          renderDocumentToString(element) {
            return renderToStringAsync(element);
          },
          renderToReadableStream,
          resetSSRHead: typeof resetSSRHead === "function" ? resetSSRHead : undefined,
          setDocumentInitialHead:
            typeof setDocumentInitialHead === "function" ? setDocumentInitialHead : undefined,
          routePattern,
          routeUrl,
          safeJsonStringify,
          scriptNonce,
          statusCode: renderStatusCode,
          vinext: { pageModuleUrl, appModuleUrl, hasMiddleware },
        });
      } catch (e) {
        console.error("[vinext] SSR error:", e);
        reportRequestError(
          e instanceof Error ? e : new Error(String(e)),
          {
            path: url,
            method: request.method,
            headers: Object.fromEntries(request.headers.entries()),
          },
          {
            routerKind: "Pages Router",
            routePath: route.pattern,
            routeType: "render",
          },
        ).catch(() => {
          /* ignore reporting errors */
        });

        // Data requests can't render HTML; avoid recursion if already rendering
        // the error page. Mirrors Next.js base-server.ts: render /500 or _error
        // when SSR throws. Fixes #1458.
        if (!isInternalErrorRender && !isDataReq) {
          let errorRoute: PageRoute | null = null;
          for (let i = 0; i < pageRoutes.length; i++) {
            if (pageRoutes[i].pattern === "/500") {
              errorRoute = pageRoutes[i];
              break;
            }
          }
          if (!errorRoute && errorPageRoute) {
            errorRoute = errorPageRoute;
          }
          if (errorRoute) {
            try {
              return await renderPage(request, url, manifest, middlewareHeaders, {
                statusCode: 500,
                asPath: url,
                renderErrorPageOnMiss: false,
                __isInternalErrorRender: true,
                __forcedRoute: errorRoute,
                err: e instanceof Error ? e : new Error(String(e)),
              });
            } catch (errorPageErr) {
              console.error("[vinext] Error page render failed:", errorPageErr);
            }
          }
        }
        return new Response("Internal Server Error", { status: 500 });
      }
    });
  }

  return renderPage;
}
