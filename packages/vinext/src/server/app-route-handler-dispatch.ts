import type { NextI18nConfig } from "../config/next-config.js";
import {
  getCollectedFetchTags,
  ensureFetchPatch,
  setCurrentFetchCacheMode,
  setCurrentFetchRevalidate,
  setCurrentFetchSoftTags,
  setCurrentForceDynamicFetchDefault,
  type FetchCacheMode,
} from "vinext/shims/fetch-cache";
import { runInWorkStoreScope } from "vinext/shims/internal/work-store-scope";
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
  getRequestContext,
  runWithRequestContext,
  runWithUnifiedStateMutation,
} from "vinext/shims/unified-request-context";
import { coalesceOnDemandResponse, type ISRCacheEntry } from "./isr-cache.js";
import { notFoundResponse } from "./http-error-responses.js";
import {
  getAppRouteHandlerRevalidateSeconds,
  hasAppRouteHandlerDefaultExport,
  hasNonStaticAppRouteHandlerMethods,
  resolveAppRouteHandlerMethod,
  resolveAppRouteHandlerStaticParamsEnforcement,
  shouldReadAppRouteHandlerCache,
  type AppRouteHandlerModule,
} from "./app-route-handler-policy.js";
import type { ValidateAppPageDynamicParamsOptions } from "./app-page-request.js";
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
  beginRouteCacheability,
  getRouteCacheabilityDynamicReason,
} from "vinext/shims/cacheability-classification";
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
import { applyCdnResponseBuildIdentityHeaders } from "./cache-control.js";
import { markRouteMissResponse } from "./route-miss-response.js";
import {
  isOnDemandRevalidateRequest,
  PRERENDER_REVALIDATE_HEADER,
} from "./revalidation-request.js";
import { traceResponseStart } from "./response-start-tracing.js";

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
  bypassSharedCache?: boolean;
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
  skipTrailingSlashRedirect?: boolean;
  middlewareContext: RouteHandlerMiddlewareContext;
  middlewareRequestHeaders?: Headers | null;
  /**
   * `null` for non-dynamic routes, matching Next.js semantics. The dispatch
   * layer threads this through to the handler context unchanged so user code
   * (`params ? await params : null`) resolves to `null`.
   */
  params: AppRouteParams | null;
  /** Routing already admitted these params. */
  skipStaticParamsValidation?: boolean;
  /** Render the not-found page Next.js serves for an unmatched URL. */
  renderNotFound?: () => Promise<Response>;
  request: Request;
  route: AppRouteHandlerDispatchRoute;
  scheduleBackgroundRegeneration: RouteHandlerBackgroundRegenerator;
  searchParams: URLSearchParams;
};

function isAppRouteHandlerFunction(value: unknown): value is AppRouteHandlerFunction {
  return typeof value === "function";
}

function encodeAppRouteParams(params: AppRouteParams): AppRouteParams {
  // A null prototype keeps a param named `__proto__` as an own key.
  const encoded: AppRouteParams = Object.create(null);
  for (const [key, value] of Object.entries(params)) {
    encoded[key] = Array.isArray(value)
      ? value.map((item) => encodeURIComponent(item))
      : encodeURIComponent(value);
  }
  return encoded;
}

/**
 * Runs a route's generateStaticParams as Next.js does, in a work store of its
 * own: root params come only from parent params, which a route handler's
 * generator has none of, request APIs throw because there is no request, and
 * its fetches leave the request's tags, revalidate and dynamic-usage
 * observations alone.
 * https://github.com/vercel/next.js/blob/v16.2.7/packages/next/src/build/static-paths/app.ts
 */
function runStaticParamsGeneration<T>(
  handler: AppRouteHandlerModule,
  pattern: string,
  fn: () => Promise<T>,
): Promise<T> {
  return runWithUnifiedStateMutation((ctx) => {
    ctx.rootParams = {};
    ctx.currentRequestTags = [];
    ctx.dynamicFetchUrls = new Set<string>();
    ctx.headersContext = {
      headers: new Headers(),
      cookies: new Map(),
      noRequest: true,
      accessError: new Error(
        `Route ${pattern} used a request API such as \`headers()\`, \`cookies()\`, \`connection()\` or \`draftMode()\` inside \`generateStaticParams\`. ` +
          "This is not supported because `generateStaticParams` runs at build time without an HTTP request. " +
          "Read more: https://nextjs.org/docs/messages/next-dynamic-api-wrong-context",
      ),
    };
    ctx.dynamicUsageDetected = false;
    ctx.renderDynamicLatch = { dynamic: false, listeners: new Set() };
    ctx.renderRequestApiUsage = new Set();
    // Next.js applies only the segment's fetchCache to the generator.
    ctx.currentFetchCacheMode = resolveAppRouteHandlerFetchCacheMode(handler);
    ctx.currentFetchRevalidate = null;
    ctx.currentForceDynamicFetchDefault = false;
  }, fn);
}

/**
 * Whether a route handler rejects these params under `dynamicParams = false`,
 * where Next.js throws `NoFallbackError` and resumes routing. Draft mode skips
 * the check, so the caller decides whether to run it.
 * https://github.com/vercel/next.js/blob/v16.2.7/packages/next/src/build/templates/app-route.ts
 */
export async function isAppRouteHandlerParamsMiss(options: {
  handler: AppRouteHandlerModule;
  isProduction: boolean;
  params: AppRouteParams;
  pattern: string;
}): Promise<boolean> {
  const { handler } = options;
  const enforcement = resolveAppRouteHandlerStaticParamsEnforcement(handler, options.isProduction);
  if (enforcement === "skip") return false;
  const patternParts = options.pattern.split("/");
  if (enforcement === "enforce-when-none-generated") {
    const generated = await runStaticParamsGeneration(handler, options.pattern, async () =>
      (handler.generateStaticParams as (context: { params: object }) => unknown)({ params: {} }),
    );
    // A route listed without params rejects every param.
    return !hasPrerenderedStaticParams(patternParts, generated);
  }
  const {
    routePatternOptionalCatchAllParamNames,
    routePatternParamNames,
    validateAppPageDynamicParams,
  } = await import("./app-page-request.js");
  const notFound = await runStaticParamsGeneration(handler, options.pattern, () =>
    validateAppPageDynamicParams({
      enforceStaticParamsOnly: true,
      generateStaticParams:
        handler.generateStaticParams as ValidateAppPageDynamicParamsOptions["generateStaticParams"],
      isDynamicRoute: true,
      optionalCatchAllParamNames: routePatternOptionalCatchAllParamNames(patternParts),
      // Route handlers receive decoded params. Next.js admits the decoded
      // value, which matches the encoded form pages compare.
      params: encodeAppRouteParams(options.params),
      requiredParamNames: routePatternParamNames(patternParts),
    }),
  );
  return notFound !== null;
}

/**
 * Whether generated params list any concrete path. Next.js prerenders none
 * unless every row fills every pathname param, and skips a row with an empty
 * required segment.
 * https://github.com/vercel/next.js/blob/v16.2.7/packages/next/src/build/static-paths/app.ts
 */
function hasPrerenderedStaticParams(patternParts: readonly string[], generated: unknown): boolean {
  if (!Array.isArray(generated)) return false;
  const paramParts = patternParts.filter((part) => part.startsWith(":"));
  const isCatchAll = (part: string) => part.endsWith("+") || part.endsWith("*");
  const names = paramParts.map((part) => part.slice(1, isCatchAll(part) ? -1 : undefined));
  const singleNames = paramParts.filter((part) => !isCatchAll(part)).map((part) => part.slice(1));
  const rows = generated.filter(
    (row): row is Record<string, unknown> => typeof row === "object" && row !== null,
  );
  if (rows.length !== generated.length) return false;
  if (rows.some((row) => names.some((name) => !Object.hasOwn(row, name)))) return false;
  return rows.some((row) => singleNames.every((name) => row[name] !== ""));
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
    revalidateSeconds: number | null;
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
    // Regeneration runs the handler directly, so it needs the phase that
    // executeAppRouteHandler() would have set for a live request.
    phase: "route-handler",
    unstableCacheRevalidation: "foreground",
  });

  const revalidation = runWithRequestContext(requestContext, () =>
    runInWorkStoreScope(async () => {
      ensureFetchPatch();
      setCurrentFetchSoftTags(
        buildRouteHandlerPageCacheTags(options.cleanPathname, [], options.routeSegments),
      );
      // The revalidation render runs in a fresh request context, so the fetch
      // defaults applied by `dispatchAppRouteHandler` must be re-applied here.
      setCurrentFetchCacheMode(options.fetchCacheMode);
      setCurrentFetchRevalidate(options.revalidateSeconds);
      setCurrentForceDynamicFetchDefault(options.dynamicConfig === "force-dynamic");
      try {
        await renderFn();
      } finally {
        // Stale ISR regeneration invokes the route handler directly instead of
        // going through executeAppRouteHandler(), so its fresh request context
        // owns and drains any synchronous next/cache invalidations here.
        await _drainPendingRevalidations();
      }
    }),
  );
  try {
    await revalidation;
  } finally {
    await closeAfterResponse(requestContext);
  }
}

export async function dispatchAppRouteHandler(
  options: DispatchAppRouteHandlerOptions,
): Promise<Response> {
  return traceResponseStart(await dispatchAppRouteHandlerImpl(options));
}

async function dispatchAppRouteHandlerImpl(
  options: DispatchAppRouteHandlerOptions,
): Promise<Response> {
  const { route } = options;
  const handler = route.routeHandler;
  const method = options.request.method.toUpperCase();
  if (method === "GET" || method === "HEAD") {
    beginRouteCacheability("app-route", route.pattern);
  }
  const configuredRevalidateSeconds = getAppRouteHandlerRevalidateSeconds(handler);
  // Next.js bails out of static generation when any mutating method is
  // exported. Keep segment revalidation available to inner fetches, but do
  // not read/write ISR or generate a public route-response policy.
  const revalidateSeconds = hasNonStaticAppRouteHandlerMethods(handler)
    ? null
    : configuredRevalidateSeconds;
  const isDevelopment = options.isDevelopment ?? process.env.NODE_ENV === "development";
  const isProduction = options.isProduction ?? process.env.NODE_ENV === "production";
  const appendResponseLink = handler.runtime === "edge" || handler.runtime === "experimental-edge";
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
    return applyCdnResponseBuildIdentityHeaders(
      applyDraftModeCachePolicy(
        applyRouteHandlerMiddlewareContext(finalized, options.middlewareContext, {
          appendResponseLink,
        }),
        isDraftMode || hasDraftModeTransition,
      ),
    );
  };

  // Next.js rejects params outside generateStaticParams before it resolves
  // the method, and falls through to the unmatched-URL 404. Draft mode
  // skips the check. This build only caches admitted params, so a cache read
  // runs first and spares a hit the generateStaticParams call, unless routing
  // already ran it for the app's fallback rewrites. An entry a
  // previous deploy stored under a pinned build ID is served without the
  // check, as docs/reference/differences.mdx notes.
  const rejectUnlistedParams = async (): Promise<Response | null> => {
    const params = options.params;
    if (params === null || isDraftMode || options.skipStaticParamsValidation) return null;
    const isMiss = await isAppRouteHandlerParamsMiss({
      handler,
      isProduction,
      params,
      pattern: route.pattern,
    });
    if (!isMiss) return null;
    // Render the 404 as for an unmatched URL, without this route's fetch
    // defaults or tags.
    setCurrentFetchSoftTags([]);
    setCurrentFetchCacheMode(null);
    setCurrentFetchRevalidate(null);
    setCurrentForceDynamicFetchDefault(false);
    return markRouteMissResponse(
      options.renderNotFound
        ? await options.renderNotFound()
        : finalizeFrameworkResponse(notFoundResponse()),
    );
  };

  if (hasAppRouteHandlerDefaultExport(handler) && isDevelopment) {
    console.error(
      "[vinext] Detected default export in route handler " +
        route.pattern +
        ". Export a named export for each HTTP method instead.",
    );
  }

  // Route handler fetches observe the handler's segment config the same way
  // page fetches do: upstream's app-route module copies `userland.fetchCache`
  // into the work store and sets `forceDynamic` for `dynamic = "force-dynamic"`,
  // which patch-fetch turns into a no-store default for fetches without
  // explicit cache config. Both setters are new wiring for the route-handler
  // path (dispatch previously only set fetch soft tags), closing the gap
  // where handlers ignored their `fetchCache`/`force-dynamic` segment config.
  // Installed before any generateStaticParams call, which Next.js runs with
  // the segment's fetchCache too.
  const fetchCacheMode = resolveAppRouteHandlerFetchCacheMode(handler);
  setCurrentFetchCacheMode(fetchCacheMode);
  setCurrentFetchRevalidate(configuredRevalidateSeconds);
  setCurrentForceDynamicFetchDefault(handler.dynamic === "force-dynamic");

  // Reject non-standard HTTP methods before any auto-OPTIONS/405 logic.
  // Next.js returns 400 for invalid methods; vinext mirrors that behavior.
  // https://github.com/vercel/next.js/blob/canary/packages/next/src/server/route-modules/app-route/module.ts#L390-L392
  if (!isValidHTTPMethod(method)) {
    return (
      (await rejectUnlistedParams()) ??
      finalizeFrameworkResponse(new Response(null, { status: 400 }))
    );
  }

  const { allowHeaderForOptions, handlerFn, isAutoHead, shouldAutoRespondToOptions } =
    resolveAppRouteHandlerMethod(handler, method);

  if (shouldAutoRespondToOptions) {
    return (
      (await rejectUnlistedParams()) ??
      finalizeFrameworkResponse(
        new Response(null, {
          status: 204,
          headers: { Allow: allowHeaderForOptions },
        }),
      )
    );
  }

  const resolvedHandlerFn = isAppRouteHandlerFunction(handlerFn) ? handlerFn : undefined;
  const isOnDemandRevalidate = isOnDemandRevalidateRequest(
    options.request.headers.get(PRERENDER_REVALIDATE_HEADER),
  );
  // Like Next.js's ResponseCache, an authorized on-demand revalidation never
  // serves the stored entry: it runs the handler in the foreground and stores
  // that.
  const isStoredRoute =
    options.bypassSharedCache !== true &&
    revalidateSeconds !== null &&
    !getRouteCacheabilityDynamicReason() &&
    shouldReadAppRouteHandlerCache({
      dynamicConfig: handler.dynamic,
      handlerFn: resolvedHandlerFn,
      isAutoHead,
      isKnownDynamic: isKnownDynamicAppRoute(route.pattern),
      isDraftMode: isDraftMode || hasDraftModeTransition,
      isProduction,
      method,
      revalidateSeconds,
    });
  const shouldReadRouteCache = isStoredRoute && !isOnDemandRevalidate;
  const revalidateReason = isOnDemandRevalidate
    ? "on-demand"
    : shouldReadRouteCache && revalidateSeconds !== Infinity
      ? "stale"
      : undefined;

  // An on-demand revalidation replaces the stored entry whatever its status,
  // as one regenerating a read entry does.
  let isRevalidation = isStoredRoute && isOnDemandRevalidate;
  if (shouldReadRouteCache && resolvedHandlerFn) {
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
      skipTrailingSlashRedirect: options.skipTrailingSlashRedirect,
      isAutoHead,
      appendResponseLink,
      isrDebug: options.isrDebug,
      async isrGet(key) {
        const entry = await options.isrGet(key);
        isRevalidation = entry?.value.value?.kind === "APP_ROUTE";
        return entry;
      },
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
            revalidateSeconds,
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
      return applyCdnResponseBuildIdentityHeaders(cachedRouteResponse);
    }
  }

  const unlistedParamsResponse = await rejectUnlistedParams();
  if (unlistedParamsResponse) return unlistedParamsResponse;

  if (resolvedHandlerFn) {
    const handlerOptions: Parameters<typeof executeAppRouteHandler>[0] = {
      isRevalidation,
      basePath: options.basePath,
      bypassSharedCache: options.bypassSharedCache,
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
      skipTrailingSlashRedirect: options.skipTrailingSlashRedirect,
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
        return reportRequestError(error, request, context);
      },
      request: options.request,
      requestSignal: getRequestContext().requestSignal ?? undefined,
      expireSeconds: options.expireSeconds,
      revalidateSeconds,
      revalidateReason,
      routePattern: route.pattern,
      setHeadersAccessPhase,
    };
    const runHandler = async () =>
      applyCdnResponseBuildIdentityHeaders(await executeAppRouteHandler(handlerOptions));
    // Concurrent on-demand revalidations of one stored entry share a single
    // run, as Next.js batches ResponseCache work by its key and
    // isOnDemandRevalidate.
    if (isOnDemandRevalidate && isStoredRoute) {
      return coalesceOnDemandResponse(
        `${method}:${options.isrRouteKey(options.cleanPathname)}`,
        method,
        runHandler,
      );
    }
    return runHandler();
  }

  return finalizeFrameworkResponse(new Response(null, { status: 405 }));
}
