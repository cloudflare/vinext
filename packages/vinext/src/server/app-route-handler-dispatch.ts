import type { NextI18nConfig } from "../config/next-config.js";
import {
  getCollectedFetchTags,
  ensureFetchPatch,
  setCurrentFetchSoftTags,
} from "vinext/shims/fetch-cache";
import {
  consumeDynamicUsage,
  getAndClearPendingCookies,
  getDraftModeCookieHeader,
  markDynamicUsage,
  setHeadersAccessPhase,
} from "vinext/shims/headers";
import { setNavigationContext } from "vinext/shims/navigation";
import { getRequestExecutionContext } from "vinext/shims/request-context";
import { createRequestContext, runWithRequestContext } from "vinext/shims/unified-request-context";
import type { ISRCacheEntry } from "./isr-cache.js";
import {
  getAppRouteHandlerRevalidateSeconds,
  hasAppRouteHandlerDefaultExport,
  resolveAppRouteHandlerMethod,
  shouldReadAppRouteHandlerCache,
  type AppRouteHandlerModule,
} from "./app-route-handler-policy.js";
import { readAppRouteHandlerCacheResponse } from "./app-route-handler-cache.js";
import {
  executeAppRouteHandler,
  type AppRouteDebugLogger,
  type AppRouteHandlerFunction,
  type AppRouteParams,
  type RouteHandlerCacheSetter,
} from "./app-route-handler-execution.js";
import { isKnownDynamicAppRoute } from "./app-route-handler-runtime.js";
import {
  applyRouteHandlerMiddlewareContext,
  type RouteHandlerMiddlewareContext,
} from "./app-route-handler-response.js";
import { createStaticGenerationHeadersContext } from "./app-static-generation.js";
import { buildPageCacheTags } from "./implicit-tags.js";
import { reportRequestError } from "./instrumentation.js";

type AppRouteHandlerDispatchRoute = {
  pattern: string;
  routeHandler: AppRouteHandlerModule;
  routeSegments: string[];
};

type RouteHandlerCacheGetter = (key: string) => Promise<ISRCacheEntry | null>;
type RouteHandlerBackgroundRegenerationErrorContext = {
  routerKind: "App Router";
  routePath: string;
  routeType: "route";
};
type RouteHandlerBackgroundRegenerator = (
  key: string,
  renderFn: () => Promise<void>,
  errorContext?: RouteHandlerBackgroundRegenerationErrorContext,
) => void;

type DispatchAppRouteHandlerOptions = {
  basePath?: string;
  cleanPathname: string;
  clearRequestContext: () => void;
  i18n?: NextI18nConfig | null;
  isDevelopment?: boolean;
  isProduction?: boolean;
  isrDebug?: AppRouteDebugLogger;
  isrGet: RouteHandlerCacheGetter;
  isrRouteKey: (pathname: string) => string;
  isrSet: RouteHandlerCacheSetter;
  middlewareContext: RouteHandlerMiddlewareContext;
  middlewareRequestHeaders?: Headers | null;
  params: AppRouteParams;
  request: Request;
  route: AppRouteHandlerDispatchRoute;
  scheduleBackgroundRegeneration: RouteHandlerBackgroundRegenerator;
  searchParams: URLSearchParams;
};

function isAppRouteHandlerFunction(value: unknown): value is AppRouteHandlerFunction {
  return typeof value === "function";
}

function makeThenableParams<T extends AppRouteParams>(params: T): Promise<T> & T {
  const plain = { ...params };
  return Object.assign(Promise.resolve(plain), plain);
}

function buildRouteHandlerPageCacheTags(
  pathname: string,
  extraTags: string[],
  routeSegments: string[],
): string[] {
  return buildPageCacheTags(pathname, extraTags, routeSegments, "route");
}

async function runInRouteHandlerRevalidationContext(
  options: {
    cleanPathname: string;
    dynamicConfig?: string;
    routePattern: string;
    routeSegments: string[];
  },
  renderFn: () => Promise<void>,
): Promise<void> {
  const headersContext = createStaticGenerationHeadersContext({
    dynamicConfig: options.dynamicConfig,
    routeKind: "route",
    routePattern: options.routePattern,
  });
  const requestContext = createRequestContext({
    headersContext,
    executionContext: getRequestExecutionContext(),
    unstableCacheRevalidation: "foreground",
  });

  await runWithRequestContext(requestContext, async () => {
    ensureFetchPatch();
    setCurrentFetchSoftTags(
      buildRouteHandlerPageCacheTags(options.cleanPathname, [], options.routeSegments),
    );
    await renderFn();
  });
}

export async function dispatchAppRouteHandler(
  options: DispatchAppRouteHandlerOptions,
): Promise<Response> {
  const { route } = options;
  const handler = route.routeHandler;
  const method = options.request.method.toUpperCase();
  const revalidateSeconds = getAppRouteHandlerRevalidateSeconds(handler);
  const isDevelopment = options.isDevelopment ?? process.env.NODE_ENV === "development";
  const isProduction = options.isProduction ?? process.env.NODE_ENV === "production";

  if (hasAppRouteHandlerDefaultExport(handler) && isDevelopment) {
    console.error(
      "[vinext] Detected default export in route handler " +
        route.pattern +
        ". Export a named export for each HTTP method instead.",
    );
  }

  const { allowHeaderForOptions, handlerFn, isAutoHead, shouldAutoRespondToOptions } =
    resolveAppRouteHandlerMethod(handler, method);

  if (shouldAutoRespondToOptions) {
    options.clearRequestContext();
    return applyRouteHandlerMiddlewareContext(
      new Response(null, {
        status: 204,
        headers: { Allow: allowHeaderForOptions },
      }),
      options.middlewareContext,
    );
  }

  const resolvedHandlerFn = isAppRouteHandlerFunction(handlerFn) ? handlerFn : undefined;

  if (
    revalidateSeconds !== null &&
    shouldReadAppRouteHandlerCache({
      dynamicConfig: handler.dynamic,
      handlerFn: resolvedHandlerFn,
      isAutoHead,
      isKnownDynamic: isKnownDynamicAppRoute(route.pattern),
      isProduction,
      method,
      revalidateSeconds,
    }) &&
    resolvedHandlerFn
  ) {
    const cachedRouteResponse = await readAppRouteHandlerCacheResponse({
      basePath: options.basePath,
      buildPageCacheTags(pathname, extraTags) {
        return buildRouteHandlerPageCacheTags(pathname, extraTags, route.routeSegments);
      },
      cleanPathname: options.cleanPathname,
      clearRequestContext: options.clearRequestContext,
      consumeDynamicUsage,
      dynamicConfig: handler.dynamic,
      getCollectedFetchTags,
      handlerFn: resolvedHandlerFn,
      i18n: options.i18n,
      isAutoHead,
      isrDebug: options.isrDebug,
      isrGet: options.isrGet,
      isrRouteKey: options.isrRouteKey,
      isrSet: options.isrSet,
      markDynamicUsage,
      middlewareContext: options.middlewareContext,
      params: options.params,
      requestUrl: options.request.url,
      revalidateSearchParams: options.searchParams,
      revalidateSeconds,
      routePattern: route.pattern,
      runInRevalidationContext(renderFn) {
        return runInRouteHandlerRevalidationContext(
          {
            cleanPathname: options.cleanPathname,
            dynamicConfig: handler.dynamic,
            routePattern: route.pattern,
            routeSegments: route.routeSegments,
          },
          renderFn,
        );
      },
      scheduleBackgroundRegeneration(key, renderFn) {
        options.scheduleBackgroundRegeneration(key, renderFn, {
          routerKind: "App Router",
          routePath: route.pattern,
          routeType: "route",
        });
      },
      setHeadersAccessPhase,
      setNavigationContext,
    });
    if (cachedRouteResponse) {
      return cachedRouteResponse;
    }
  }

  if (resolvedHandlerFn) {
    return executeAppRouteHandler({
      basePath: options.basePath,
      buildPageCacheTags(pathname, extraTags) {
        return buildRouteHandlerPageCacheTags(pathname, extraTags, route.routeSegments);
      },
      cleanPathname: options.cleanPathname,
      clearRequestContext: options.clearRequestContext,
      consumeDynamicUsage,
      executionContext: getRequestExecutionContext(),
      getAndClearPendingCookies,
      getCollectedFetchTags,
      getDraftModeCookieHeader,
      handler,
      handlerFn: resolvedHandlerFn,
      i18n: options.i18n,
      isAutoHead,
      isProduction,
      isrDebug: options.isrDebug,
      isrRouteKey: options.isrRouteKey,
      isrSet: options.isrSet,
      markDynamicUsage,
      method,
      middlewareContext: options.middlewareContext,
      middlewareRequestHeaders: options.middlewareRequestHeaders,
      params: makeThenableParams(options.params),
      reportRequestError,
      request: options.request,
      revalidateSeconds,
      routePattern: route.pattern,
      setHeadersAccessPhase,
    });
  }

  options.clearRequestContext();
  return applyRouteHandlerMiddlewareContext(
    new Response(null, {
      status: 405,
    }),
    options.middlewareContext,
  );
}
