import type { ReactNode } from "react";
import type { Route } from "../routing/pages-router.js";
import type { CachedPagesValue } from "../shims/cache.js";
import { buildPagesCacheValue, type ISRCacheEntry } from "./isr-cache.js";
import {
  buildPagesNextDataScript,
  type PagesGsspResponse,
  type PagesI18nRenderContext,
} from "./pages-page-response.js";

type PagesRedirectResult = {
  destination: string;
  permanent?: boolean;
  statusCode?: number;
};

type PagesStaticPathsEntry = {
  params: Record<string, unknown>;
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
    params: Record<string, unknown>;
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
  route: Pick<Route, "isDynamic">;
  routePattern: string;
  routeUrl: string;
  runInFreshUnifiedContext: <T>(callback: () => Promise<T>) => Promise<T>;
  safeJsonStringify: (value: unknown) => string;
  sanitizeDestination: (destination: string) => string;
  scriptNonce?: string;
  triggerBackgroundRegeneration: (key: string, renderFn: () => Promise<void>) => void;
  renderIsrPassToStringAsync: (element: ReactNode) => Promise<string>;
};

type ResolvePagesPageDataRenderResult = {
  kind: "render";
  gsspRes: PagesGsspResponse | null;
  isrRevalidateSeconds: number | null;
  pageProps: Record<string, unknown>;
};

type ResolvePagesPageDataResponseResult = {
  kind: "response";
  response: Response;
};

type ResolvePagesPageDataResult =
  | ResolvePagesPageDataRenderResult
  | ResolvePagesPageDataResponseResult;

function buildPagesNotFoundResponse(): Response {
  return new Response("<!DOCTYPE html><html><body><h1>404 - Page not found</h1></body></html>", {
    status: 404,
    headers: { "Content-Type": "text/html" },
  });
}

function buildPagesDataNotFoundResponse(): Response {
  return new Response("404", { status: 404 });
}

function resolvePagesRedirectStatus(redirect: PagesRedirectResult): number {
  return redirect.statusCode != null ? redirect.statusCode : redirect.permanent ? 308 : 307;
}

function matchesPagesStaticPath(
  pathEntry: PagesStaticPathsEntry,
  params: Record<string, unknown>,
): boolean {
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
    "Cache-Control":
      cacheState === "HIT"
        ? `s-maxage=${revalidateSeconds ?? 60}, stale-while-revalidate`
        : "s-maxage=0, stale-while-revalidate",
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
  });

  return rewritePagesCachedHtml(options.cachedHtml, freshBody, nextDataScript);
}

export async function resolvePagesPageData(
  options: ResolvePagesPageDataOptions,
): Promise<ResolvePagesPageDataResult> {
  if (typeof options.pageModule.getStaticPaths === "function" && options.route.isDynamic) {
    const pathsResult = await options.pageModule.getStaticPaths({
      locales: options.i18n.locales ?? [],
      defaultLocale: options.i18n.defaultLocale ?? "",
    });
    const fallback = pathsResult?.fallback ?? false;

    if (fallback === false) {
      const paths = pathsResult?.paths ?? [];
      const isValidPath = paths.some((pathEntry) =>
        matchesPagesStaticPath(pathEntry, options.params),
      );

      if (!isValidPath) {
        return {
          kind: "response",
          response: buildPagesNotFoundResponse(),
        };
      }
    }
  }

  let pageProps: Record<string, unknown> = {};
  let gsspRes: PagesMutableGsspResponse | null = null;

  if (typeof options.pageModule.getServerSideProps === "function") {
    const { req, res, responsePromise } = options.createGsspReqRes();
    const result = await options.pageModule.getServerSideProps({
      params: options.params,
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

    if (cachedValue?.kind === "PAGES" && cached && !cached.isStale && !options.scriptNonce) {
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

    if (cachedValue?.kind === "PAGES" && cached && cached.isStale && !options.scriptNonce) {
      options.triggerBackgroundRegeneration(cacheKey, async function () {
        return options.runInFreshUnifiedContext(async () => {
          const freshResult = await options.pageModule.getStaticProps?.({
            params: options.params,
            locale: options.i18n.locale,
            locales: options.i18n.locales,
            defaultLocale: options.i18n.defaultLocale,
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
            });

            await options.isrSet(
              cacheKey,
              buildPagesCacheValue(freshHtml, freshResult.props),
              freshResult.revalidate,
            );
          }
        });
      });

      return {
        kind: "response",
        response: buildPagesCacheResponse(cachedValue.html, "STALE", options.fontLinkHeader),
      };
    }

    const result = await options.pageModule.getStaticProps({
      params: options.params,
      locale: options.i18n.locale,
      locales: options.i18n.locales,
      defaultLocale: options.i18n.defaultLocale,
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
        response: buildPagesDataNotFoundResponse(),
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
  };
}
