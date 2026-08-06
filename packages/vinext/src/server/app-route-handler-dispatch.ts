import type { NextI18nConfig } from "../config/next-config.js";
import {
  getCollectedFetchTags,
  ensureFetchPatch,
  setCurrentFetchCacheMode,
  setCurrentFetchSoftTags,
  setCurrentForceDynamicFetchDefault,
  type FetchCacheMode,
} from "vinext/shims/fetch-cache";
import { _drainPendingRevalidations } from "vinext/shims/cache-request-state";
import {
  consumeDynamicUsage,
  getActiveDraftModeState,
  getAndClearPendingCookies,
  getDraftModeCookieHeader,
  isDraftModeRequest,
  markDynamicUsage,
  setHeadersAccessPhase,
} from "vinext/shims/headers";
import { setNavigationContext } from "vinext/shims/navigation";
import { getRequestExecutionContext } from "vinext/shims/request-context";
import {
  closeAfterResponse,
  createRequestContext,
  runWithRequestContext,
} from "vinext/shims/unified-request-context";
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
  applyDraftModeCachePolicy,
  executeAppRouteHandler,
  type AppRouteDebugLogger,
  type AppRouteHandlerFunction,
  type AppRouteParams,
  type RouteHandlerCacheSetter,
} from "./app-route-handler-execution.js";
import { isKnownDynamicAppRoute, isValidHTTPMethod } from "./app-route-handler-runtime.js";
import {
  applyRouteHandlerMiddlewareContext,
  finalizeRouteHandlerResponse,
  type RouteHandlerMiddlewareContext,
} from "./app-route-handler-response.js";
import { resolveAppRouteHandlerFetchCacheMode } from "./app-segment-config.js";
import { createStaticGenerationHeadersContext } from "./app-static-generation.js";
import { buildPageCacheTags } from "./implicit-tags.js";
import { makeThenableParams } from "vinext/shims/thenable-params";
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
  draftModeSecret: string;
  expireSeconds?: number;
  i18n?: NextI18nConfig | null;
  isDevelopment?: boolean;
  isProduction?: boolean;
  isrDebug?: AppRouteDebugLogger;
  isrGet: RouteHandlerCacheGetter;
  isrRouteKey: (pathname: string) => string;
  isrSet: RouteHandlerCacheSetter;
  trailingSlash?: boolean;
  middlewareContext: RouteHandlerMiddlewareContext;
  middlewareRequestHeaders?: Headers | null;
  /**
   * `null` for non-dynamic routes, matching Next.js semantics. The dispatch
   * layer threads this through to the handler context unchanged so user code
   * (`params ? await params : null`) resolves to `null`.
   */
  params: AppRouteParams | null;
  request: Request;
  route: AppRouteHandlerDispatchRoute;
  scheduleBackgroundRegeneration: RouteHandlerBackgroundRegenerator;
  searchParams: URLSearchParams;
};

function isAppRouteHandlerFunction(value: unknown): value is AppRouteHandlerFunction {
  return typeof value === "function";
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
    draftModeSecret: string;
    dynamicConfig?: string;
    fetchCacheMode: FetchCacheMode | null;
    routePattern: string;
    routeSegments: string[];
  },
  renderFn: () => Promise<void>,
): Promise<void> {
  const headersContext = createStaticGenerationHeadersContext({
    draftModeEnabled: false,
    draftModeSecret: options.draftModeSecret,
    dynamicConfig: options.dynamicConfig,
    routeKind: "route",
    routePattern: options.routePattern,
  });
  const requestContext = createRequestContext({
    headersContext,
    executionContext: getRequestExecutionContext(),
    unstableCacheRevalidation: "foreground",
  });

  const revalidation = runWithRequestContext(requestContext, async () => {
    ensureFetchPatch();
    setCurrentFetchSoftTags(
      buildRouteHandlerPageCacheTags(options.cleanPathname, [], options.routeSegments),
    );
    // The revalidation render runs in a fresh request context, so the fetch
    // defaults applied by `dispatchAppRouteHandler` must be re-applied here.
    setCurrentFetchCacheMode(options.fetchCacheMode);
    setCurrentForceDynamicFetchDefault(options.dynamicConfig === "force-dynamic");
    try {
      await renderFn();
    } finally {
      // Stale ISR regeneration invokes the route handler directly instead of
      // going through executeAppRouteHandler(), so its fresh request context
      // owns and drains any synchronous next/cache invalidations here.
      await _drainPendingRevalidations();
    }
  });
  try {
    await revalidation;
  } finally {
    await closeAfterResponse(requestContext);
  }
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
  // Middleware may enable or disable draft mode before dispatch. Prefer the
  // live headers context over the original request cookie, and retain the
  // pending transition now so a force-static context replacement or cache HIT
  // cannot discard the Set-Cookie side effect.
  const isDraftMode =
    getActiveDraftModeState() ?? isDraftModeRequest(options.request, options.draftModeSecret);
  const initialDraftModeCookie = getDraftModeCookieHeader();
  const hasDraftModeTransition = initialDraftModeCookie != null;

  const finalizeFrameworkResponse = (response: Response, isHead = false): Response => {
    const finalized = finalizeRouteHandlerResponse(response, {
      pendingCookies: getAndClearPendingCookies(),
      draftCookie: initialDraftModeCookie,
      isHead,
    });
    options.clearRequestContext();
    return applyDraftModeCachePolicy(
      applyRouteHandlerMiddlewareContext(finalized, options.middlewareContext),
      isDraftMode || hasDraftModeTransition,
    );
  };

  if (hasAppRouteHandlerDefaultExport(handler) && isDevelopment) {
    console.error(
      "[vinext] Detected default export in route handler " +
        route.pattern +
        ". Export a named export for each HTTP method instead.",
    );
  }

  // Reject non-standard HTTP methods before any auto-OPTIONS/405 logic.
  // Next.js returns 400 for invalid methods; vinext mirrors that behavior.
  // https://github.com/vercel/next.js/blob/canary/packages/next/src/server/route-modules/app-route/module.ts#L390-L392
  if (!isValidHTTPMethod(method)) {
    return finalizeFrameworkResponse(new Response(null, { status: 400 }));
  }

  const { allowHeaderForOptions, handlerFn, isAutoHead, shouldAutoRespondToOptions } =
    resolveAppRouteHandlerMethod(handler, method);

  if (shouldAutoRespondToOptions) {
    return finalizeFrameworkResponse(
      new Response(null, {
        status: 204,
        headers: { Allow: allowHeaderForOptions },
      }),
    );
  }

  const resolvedHandlerFn = isAppRouteHandlerFunction(handlerFn) ? handlerFn : undefined;

  // Route handler fetches observe the handler's segment config the same way
  // page fetches do: upstream's app-route module copies `userland.fetchCache`
  // into the work store and sets `forceDynamic` for `dynamic = "force-dynamic"`,
  // which patch-fetch turns into a no-store default for fetches without
  // explicit cache config. Both setters are new wiring for the route-handler
  // path (dispatch previously only set fetch soft tags), closing the gap
  // where handlers ignored their `fetchCache`/`force-dynamic` segment config.
  const fetchCacheMode = resolveAppRouteHandlerFetchCacheMode(handler);
  setCurrentFetchCacheMode(fetchCacheMode);
  setCurrentForceDynamicFetchDefault(handler.dynamic === "force-dynamic");

  if (
    revalidateSeconds !== null &&
    shouldReadAppRouteHandlerCache({
      dynamicConfig: handler.dynamic,
      handlerFn: resolvedHandlerFn,
      isAutoHead,
      isKnownDynamic: isKnownDynamicAppRoute(route.pattern),
      isDraftMode: isDraftMode || hasDraftModeTransition,
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
      trailingSlash: options.trailingSlash,
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
      expireSeconds: options.expireSeconds,
      revalidateSeconds,
      routePattern: route.pattern,
      runInRevalidationContext(renderFn) {
        return runInRouteHandlerRevalidationContext(
          {
            cleanPathname: options.cleanPathname,
            draftModeSecret: options.draftModeSecret,
            dynamicConfig: handler.dynamic,
            fetchCacheMode,
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
      draftModeSecret: options.draftModeSecret,
      executionContext: getRequestExecutionContext(),
      getAndClearPendingCookies,
      getCollectedFetchTags,
      getActiveDraftModeState,
      getDraftModeCookieHeader,
      handler,
      handlerFn: resolvedHandlerFn,
      i18n: options.i18n,
      trailingSlash: options.trailingSlash,
      isAutoHead,
      initialDraftModeCookie,
      isDraftMode,
      isProduction,
      isrDebug: options.isrDebug,
      isrRouteKey: options.isrRouteKey,
      isrSet: options.isrSet,
      markDynamicUsage,
      method,
      middlewareContext: options.middlewareContext,
      middlewareRequestHeaders: options.middlewareRequestHeaders,
      params: options.params === null ? null : makeThenableParams(options.params),
      reportRequestError(error, request, context) {
        void reportRequestError(error, request, context);
      },
      request: options.request,
      expireSeconds: options.expireSeconds,
      revalidateSeconds,
      routePattern: route.pattern,
      setHeadersAccessPhase,
    });
  }

  return finalizeFrameworkResponse(new Response(null, { status: 405 }));
}
