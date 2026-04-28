import type { ReactNode } from "react";
import type { Route } from "../routing/pages-router.js";
import type { CachedPagesValue } from "../shims/cache.js";
import { buildPagesCacheValue, type ISRCacheEntry } from "./isr-cache.js";
import {
  buildPagesIsrCacheControl,
  buildPagesNextDataScript,
  PAGES_INDEFINITE_REVALIDATE_SECONDS,
  type PagesGsspResponse,
  type PagesI18nRenderContext,
} from "./pages-page-response.js";

type PagesRedirectResult = {
  destination: string;
  permanent?: boolean;
  statusCode?: number;
};

type PagesStaticPathsEntry =
  | {
      params: Record<string, unknown>;
    }
  | string;

type PagesStaticPathsResult = {
  fallback?: boolean | "blocking";
  paths?: PagesStaticPathsEntry[];
};

type PagesPagePropsResult = {
  props?: Record<string, unknown> | Promise<Record<string, unknown>>;
  redirect?: PagesRedirectResult;
  notFound?: boolean;
  revalidate?: number | false;
};

export type PagesRevalidateReason = "on-demand" | "build" | "stale";

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
  getServerSideProps?: (context: {
    params?: Record<string, unknown>;
    req: unknown;
    res: PagesMutableGsspResponse;
    query: Record<string, unknown>;
    resolvedUrl: string;
    locale?: string;
    locales?: string[];
    defaultLocale?: string;
  }) => Promise<PagesPagePropsResult> | PagesPagePropsResult;
  getStaticProps?: (context: {
    params: Record<string, unknown>;
    locale?: string;
    locales?: string[];
    defaultLocale?: string;
    revalidateReason?: PagesRevalidateReason;
  }) => Promise<PagesPagePropsResult> | PagesPagePropsResult;
};

type PagesComponentWithInitialProps = {
  getInitialProps?: (context: {
    pathname: string;
    query: Record<string, unknown>;
    asPath: string;
    req: unknown;
    res: PagesMutableGsspResponse;
    locale?: string;
    locales?: string[];
    defaultLocale?: string;
  }) => Promise<Record<string, unknown> | undefined> | Record<string, unknown> | undefined;
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
};

export type ResolvePagesPageDataOptions = {
  applyRequestContexts: () => void;
  buildId: string | null;
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
  ) => Promise<void>;
  pageModule: PagesPageModule;
  params: Record<string, unknown>;
  query: Record<string, unknown>;
  resolvedUrl: string;
  route: Pick<Route, "isDynamic">;
  routePattern: string;
  routeUrl: string;
  hasGeneratedFallbackPath?: boolean;
  isCrawlerRequest?: boolean;
  runInFreshUnifiedContext: <T>(callback: () => Promise<T>) => Promise<T>;
  safeJsonStringify: (value: unknown) => string;
  sanitizeDestination: (destination: string) => string;
  scriptNonce?: string;
  isDataRequest?: boolean;
  revalidateReason?: PagesRevalidateReason;
  triggerBackgroundRegeneration: (key: string, renderFn: () => Promise<void>) => void;
  renderIsrPassToStringAsync: (element: ReactNode) => Promise<string>;
};

type ResolvePagesPageDataRenderResult = {
  kind: "render";
  gsspRes: PagesGsspResponse | null;
  isFallback?: boolean;
  isrRevalidateSeconds: number | null;
  pageProps: Record<string, unknown>;
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

function buildPagesNotFoundResponse(): Response {
  return new Response(
    "<!DOCTYPE html><html><body><h1>404 - Page not found</h1><p>This page could not be found.</p></body></html>",
    {
      status: 404,
      headers: { "Content-Type": "text/html" },
    },
  );
}

function buildPagesDataNotFoundResponse(): Response {
  return buildPagesNotFoundResponse();
}

function resolvePagesRedirectStatus(redirect: PagesRedirectResult): number {
  return redirect.statusCode != null ? redirect.statusCode : redirect.permanent ? 308 : 307;
}

function matchesPagesStaticPath(
  pathEntry: PagesStaticPathsEntry,
  params: Record<string, unknown>,
  routePattern: string,
  routeUrl: string,
): boolean {
  const normalizePath = (value: string) => {
    const pathname = value.split("?")[0] || "/";
    return pathname === "/" ? pathname : pathname.replace(/\/$/, "");
  };

  if (typeof pathEntry === "string") {
    if (normalizePath(pathEntry) === normalizePath(routeUrl)) {
      return true;
    }

    const replaceParam = (_match: string, key: string, modifier?: string) => {
      const value = params[key];
      if (Array.isArray(value)) {
        return value.map((part) => encodeURIComponent(String(part))).join("/");
      }
      if (value == null && modifier === "*") {
        return "";
      }
      return encodeURIComponent(String(value ?? ""));
    };
    const expectedPath = routePattern
      .replace(/\[\[\.\.\.([\w-]+)\]\]/g, replaceParam)
      .replace(/\[\.\.\.([\w-]+)\]/g, replaceParam)
      .replace(/\[([\w-]+)\]/g, replaceParam)
      .replace(/:([\w-]+)([+*])?/g, replaceParam);
    return normalizePath(pathEntry) === normalizePath(expectedPath);
  }

  return Object.entries(pathEntry.params).every(([key, value]) => {
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
): Response {
  const headers: Record<string, string> = {
    "Content-Type": "text/html",
    "X-Vinext-Cache": cacheState,
    "Cache-Control": buildPagesIsrCacheControl(revalidateSeconds, cacheState),
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
  // Pages responses with scriptNonce are excluded from ISR writes, so cached
  // HTML should never contain nonce-prefixed __NEXT_DATA__ scripts here.
  let nextDataStart = cachedHtml.indexOf('<script id="__NEXT_DATA__"');
  if (nextDataStart < 0) {
    nextDataStart = cachedHtml.indexOf("<script>window.__NEXT_DATA__");
  }

  if (contentStart >= 0 && nextDataStart >= 0) {
    const region = cachedHtml.slice(contentStart, nextDataStart);
    const lastCloseDiv = region.lastIndexOf("</div>");
    const gap = lastCloseDiv >= 0 ? region.slice(lastCloseDiv + 6) : "";
    let nextDataEnd = cachedHtml.indexOf("</script>", nextDataStart) + 9;
    const afterFirstScript = cachedHtml.slice(nextDataEnd);
    const assignmentMatch = afterFirstScript.match(/^\s*<script>window\.__NEXT_DATA__/);
    if (assignmentMatch) {
      const assignmentStart = nextDataEnd + (assignmentMatch.index ?? 0);
      const assignmentEnd = cachedHtml.indexOf("</script>", assignmentStart);
      if (assignmentEnd >= 0) {
        nextDataEnd = assignmentEnd + 9;
      }
    }
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
    isGsp: true,
    pageProps: options.pageProps,
    params: options.params,
    routePattern: options.routePattern,
    safeJsonStringify: options.safeJsonStringify,
  });

  return rewritePagesCachedHtml(options.cachedHtml, freshBody, nextDataScript);
}

function resolvePagesRevalidateSeconds(
  revalidate: PagesPagePropsResult["revalidate"],
): number | null {
  if (revalidate === false) {
    return PAGES_INDEFINITE_REVALIDATE_SECONDS;
  }

  if (typeof revalidate === "number" && revalidate > 0) {
    return revalidate;
  }

  return null;
}

export async function resolvePagesPageData(
  options: ResolvePagesPageDataOptions,
): Promise<ResolvePagesPageDataResult> {
  let shouldRenderFallbackShell = false;

  if (typeof options.pageModule.getStaticPaths === "function" && options.route.isDynamic) {
    const pathsResult = await options.pageModule.getStaticPaths({
      locales: options.i18n.locales ?? [],
      defaultLocale: options.i18n.defaultLocale ?? "",
    });
    const fallback = pathsResult?.fallback ?? false;

    if (fallback === false) {
      const paths = pathsResult?.paths ?? [];
      const isValidPath = paths.some((pathEntry) =>
        matchesPagesStaticPath(pathEntry, options.params, options.routePattern, options.routeUrl),
      );

      if (!isValidPath) {
        return {
          kind: "response",
          response: buildPagesNotFoundResponse(),
        };
      }
    } else if (fallback === true) {
      const paths = pathsResult?.paths ?? [];
      const isValidPath = paths.some((pathEntry) =>
        matchesPagesStaticPath(pathEntry, options.params, options.routePattern, options.routeUrl),
      );
      shouldRenderFallbackShell =
        !isValidPath &&
        !options.isDataRequest &&
        !options.hasGeneratedFallbackPath &&
        !options.isCrawlerRequest;
    }
  }

  let pageProps: Record<string, unknown> = {};
  let gsspRes: PagesMutableGsspResponse | null = null;

  if (typeof options.pageModule.getServerSideProps === "function") {
    const { req, res, responsePromise } = options.createGsspReqRes();
    const result = await options.pageModule.getServerSideProps({
      params: options.route.isDynamic ? options.params : undefined,
      req,
      res,
      query: options.query,
      resolvedUrl: options.resolvedUrl,
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
      pageProps = await result.props;
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
      if (!options.isDataRequest) {
        return {
          kind: "notFound",
        };
      }
      return {
        kind: "response",
        response: buildPagesDataNotFoundResponse(),
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
    const isOnDemandRevalidate = options.revalidateReason === "on-demand";

    if (
      !isOnDemandRevalidate &&
      cachedValue?.kind === "PAGES" &&
      cached &&
      !cached.isStale &&
      !options.scriptNonce
    ) {
      if (options.isDataRequest) {
        return {
          kind: "render",
          gsspRes: null,
          isrRevalidateSeconds,
          pageProps: cachedValue.pageData as Record<string, unknown>,
        };
      }

      if (options.route.isDynamic && options.routeUrl.includes("?")) {
        return {
          kind: "render",
          gsspRes: null,
          isrRevalidateSeconds,
          pageProps: cachedValue.pageData as Record<string, unknown>,
        };
      }

      return {
        kind: "response",
        response: buildPagesCacheResponse(
          cachedValue.html,
          "HIT",
          options.fontLinkHeader,
          (cachedValue as CachedPagesValue & { revalidate?: number }).revalidate,
        ),
      };
    }

    if (
      !isOnDemandRevalidate &&
      cachedValue?.kind === "PAGES" &&
      cached &&
      cached.isStale &&
      !options.scriptNonce
    ) {
      options.triggerBackgroundRegeneration(cacheKey, async function () {
        return options.runInFreshUnifiedContext(async () => {
          const freshResult = await options.pageModule.getStaticProps?.({
            params: options.params,
            locale: options.i18n.locale,
            locales: options.i18n.locales,
            defaultLocale: options.i18n.defaultLocale,
            revalidateReason: "stale",
          });

          const freshRevalidateSeconds = resolvePagesRevalidateSeconds(freshResult?.revalidate);
          if (freshResult?.props && freshRevalidateSeconds !== null) {
            const freshPageProps = await freshResult.props;
            options.applyRequestContexts();
            const freshHtml = await renderPagesIsrHtml({
              buildId: options.buildId,
              cachedHtml: cachedValue.html,
              createPageElement: options.createPageElement,
              i18n: options.i18n,
              pageProps: freshPageProps,
              params: options.params,
              renderIsrPassToStringAsync: options.renderIsrPassToStringAsync,
              routePattern: options.routePattern,
              safeJsonStringify: options.safeJsonStringify,
            });

            await options.isrSet(
              cacheKey,
              buildPagesCacheValue(freshHtml, freshPageProps),
              freshRevalidateSeconds,
            );
          }
        });
      });

      if (options.isDataRequest) {
        return {
          kind: "render",
          gsspRes: null,
          isrRevalidateSeconds,
          pageProps: cachedValue.pageData as Record<string, unknown>,
        };
      }

      return {
        kind: "response",
        response: buildPagesCacheResponse(cachedValue.html, "STALE", options.fontLinkHeader),
      };
    }

    if (shouldRenderFallbackShell) {
      return {
        kind: "render",
        gsspRes: null,
        isFallback: true,
        isrRevalidateSeconds: null,
        pageProps: {},
      };
    }

    const result = await options.pageModule.getStaticProps({
      params: options.params,
      locale: options.i18n.locale,
      locales: options.i18n.locales,
      defaultLocale: options.i18n.defaultLocale,
      revalidateReason: options.revalidateReason,
    });

    if (result?.props) {
      pageProps = await result.props;
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
      if (!options.isDataRequest) {
        return {
          kind: "notFound",
        };
      }
      return {
        kind: "response",
        response: buildPagesDataNotFoundResponse(),
      };
    }

    isrRevalidateSeconds = resolvePagesRevalidateSeconds(result?.revalidate);
  }

  const PageComponent = options.pageModule.default as PagesComponentWithInitialProps | undefined;
  if (
    typeof options.pageModule.getServerSideProps !== "function" &&
    typeof options.pageModule.getStaticProps !== "function" &&
    typeof PageComponent?.getInitialProps === "function"
  ) {
    const { req, res, responsePromise } = options.createGsspReqRes();
    const result = await PageComponent.getInitialProps({
      pathname: options.routePattern,
      query: options.query,
      asPath: options.resolvedUrl,
      req,
      res,
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

    if (result && typeof result === "object") {
      pageProps = result;
    }
  }

  return {
    kind: "render",
    gsspRes,
    isrRevalidateSeconds,
    pageProps,
  };
}
