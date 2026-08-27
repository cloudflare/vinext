import type { NextI18nConfig } from "../config/next-config.js";
import {
  isDraftModeRequest,
  setHeadersContext,
  type HeadersAccessPhase,
} from "vinext/shims/headers";
import type { ExecutionContextLike } from "vinext/shims/request-context";
import type { CachedRouteValue } from "vinext/shims/cache-handler";
import type { NextRequest } from "vinext/shims/server";
import { _drainPendingRevalidations } from "vinext/shims/cache-request-state";
import { runWithRootParamsUsage } from "vinext/shims/root-params";
import {
  applyCdnResponseHeaders,
  hasExplicitNonCacheableResponsePolicy,
  NEVER_CACHE_CONTROL,
} from "./cache-control.js";
import { isrCacheControl, type IsrWritePolicy } from "./isr-cache.js";
import {
  createStaticGenerationHeadersContext,
  getAppRouteStaticGenerationErrorMessage,
} from "./app-static-generation.js";
import {
  isPossibleAppRouteActionRequest,
  resolveAppRouteHandlerSpecialError,
  shouldApplyAppRouteHandlerRevalidateHeader,
  shouldCompleteAppRouteHandlerResponse,
  shouldWriteAppRouteHandlerCache,
  type AppRouteHandlerModule,
} from "./app-route-handler-policy.js";
import { copyLinkHeaderProvenance } from "./app-response-header-provenance.js";
import {
  applyRouteHandlerMiddlewareContext,
  applyRouteHandlerRevalidateHeader,
  assertSupportedAppRouteHandlerResponse,
  buildAppRouteCacheValue,
  finalizeRouteHandlerResponse,
  markRouteHandlerCacheMiss,
  type RouteHandlerMiddlewareContext,
} from "./app-route-handler-response.js";
import {
  createTrackedAppRouteRequest,
  markKnownDynamicAppRoute,
} from "./app-route-handler-runtime.js";
import {
  getRouteCacheabilityCaptureOptions,
  getRouteCacheabilityDynamicReason,
  CACHEABILITY_POLICY_HEADERS,
  isRouteCacheabilityEvaluation,
  markRouteCacheabilityExplicitResponsePolicy,
  markRouteCacheabilityResponseBodyComplete,
} from "vinext/shims/cacheability-classification";
import {
  CACHEABILITY_ADMISSION_RESPONSE_BODY_LIMIT,
  CACHEABILITY_PROBE_TIMEOUT_MS,
} from "./cacheability-limits.js";

export type AppRouteParams = Record<string, string | string[]>;
export type AppRouteDynamicUsageFn = () => boolean;
export type MarkAppRouteDynamicUsageFn = () => void;
/**
 * Route handler context.
 *
 * `params` is `null` for non-dynamic routes (no `[param]` segments) so that
 * user code like `params ? await params : null` resolves to `null`, matching
 * Next.js behavior. For dynamic routes it's a thenable that resolves to the
 * matched params object.
 *
 * See: test/e2e/app-dir/app-routes/app-custom-routes.test.ts in Next.js for
 * the authoritative assertion (`expect(meta.params).toEqual(null)`).
 */
export type AppRouteHandlerFunction = (
  request: NextRequest,
  context: { params: AppRouteParams | null },
) => Response | Promise<Response>;
export type RouteHandlerCacheSetter = (
  key: string,
  data: CachedRouteValue,
  policy: IsrWritePolicy,
) => Promise<void>;
type AppRouteErrorReporter = (
  error: Error,
  request: { path: string; method: string; headers: Record<string, string> },
  route: { routerKind: "App Router"; routePath: string; routeType: "route" },
) => void;
export type AppRouteDebugLogger = (event: string, detail: string) => void;

type RunAppRouteHandlerOptions = {
  basePath?: string;
  consumeDynamicUsage: AppRouteDynamicUsageFn;
  draftModeSecret?: string;
  dynamicConfig?: string;
  handlerFn: AppRouteHandlerFunction;
  i18n?: NextI18nConfig | null;
  isDraftMode?: boolean;
  trailingSlash?: boolean;
  markDynamicUsage: MarkAppRouteDynamicUsageFn;
  middlewareRequestHeaders?: Headers | null;
  /**
   * `null` for non-dynamic routes. Passed through to the handler context
   * unchanged — callers are expected to compute this from `route.isDynamic`.
   */
  params: AppRouteParams | null;
  request: Request;
  routePattern?: string;
  setHeadersAccessPhase?: (phase: HeadersAccessPhase) => HeadersAccessPhase;
};

type RunAppRouteHandlerResult = {
  didAccessDynamicRequest: () => boolean;
  dynamicUsedInHandler: boolean;
  response: Response;
};

type CompletedAppRouteHandlerResponse = {
  completed: boolean;
  response: Response;
};

function hasExplicitCacheableResponsePolicy(headers: Headers): boolean {
  return (
    !hasExplicitNonCacheableResponsePolicy(headers) &&
    CACHEABILITY_POLICY_HEADERS.some((name) => headers.has(name))
  );
}

async function completeAppRouteHandlerResponse(
  response: Response,
): Promise<CompletedAppRouteHandlerResponse> {
  // Match Next.js static App Route generation: resolve only after clean EOF,
  // then rebuild the response from the completed body. Besides making the ISR
  // artifact deterministic, this keeps request tracking active for stream
  // pulls and turns a late body failure into the normal Route Handler error
  // path before cacheable response headers are applied.
  // Reuse admission's bounded capture envelope and fall back to private
  // streaming when the response exceeds the memory or completion deadline.
  const { captureCacheabilityAdmissionBody } = await import("./cacheability-request.js");
  const captureOptions = getRouteCacheabilityCaptureOptions();
  const captured = await captureCacheabilityAdmissionBody(
    response.body,
    captureOptions?.captureDeadlineAt ?? Date.now() + CACHEABILITY_PROBE_TIMEOUT_MS,
    CACHEABILITY_ADMISSION_RESPONSE_BODY_LIMIT,
    captureOptions?.captureBudget,
  );
  const completed = new Response(captured.body, {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  });
  copyLinkHeaderProvenance(response.headers, completed.headers);
  return { completed: captured.kind === "captured", response: completed };
}

function deferAppRouteHandlerCleanup(response: Response, cleanup: () => Promise<void>): Response {
  if (!response.body) {
    void cleanup();
    return response;
  }

  const reader = response.body.getReader();
  let cleaned = false;
  const cleanOnce = async () => {
    if (cleaned) return;
    cleaned = true;
    reader.releaseLock();
    await cleanup();
  };
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const result = await reader.read();
          if (result.done) {
            await cleanOnce();
            controller.close();
          } else {
            controller.enqueue(result.value);
          }
        } catch (error) {
          await cleanOnce();
          controller.error(error);
        }
      },
      async cancel(reason) {
        try {
          await reader.cancel(reason);
        } finally {
          await cleanOnce();
        }
      },
    },
    { highWaterMark: 0 },
  );
  const deferred = new Response(body, {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  });
  copyLinkHeaderProvenance(response.headers, deferred.headers);
  return deferred;
}

export function applyDraftModeCachePolicy(response: Response, isDraftMode: boolean): Response {
  if (!isDraftMode) return response;

  const headers = new Headers(response.headers);
  applyCdnResponseHeaders(headers, { cacheControl: NEVER_CACHE_CONTROL });
  const result = new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
  copyLinkHeaderProvenance(response.headers, result.headers);
  return result;
}

type ExecuteAppRouteHandlerOptions = {
  buildPageCacheTags: (pathname: string, extraTags: string[]) => string[];
  clearRequestContext: () => void;
  cleanPathname: string;
  executionContext: ExecutionContextLike | null;
  getAndClearPendingCookies: () => string[];
  getCollectedFetchTags: () => string[];
  getActiveDraftModeState?: () => boolean | null;
  getDraftModeCookieHeader: () => string | null | undefined;
  handler: AppRouteHandlerModule;
  isAutoHead: boolean;
  initialDraftModeCookie?: string | null;
  isDraftMode?: boolean;
  isProduction: boolean;
  isrDebug?: AppRouteDebugLogger;
  isrRouteKey: (pathname: string) => string;
  isrSet: RouteHandlerCacheSetter;
  method: string;
  middlewareContext: RouteHandlerMiddlewareContext;
  reportRequestError: AppRouteErrorReporter;
  expireSeconds?: number;
  revalidateSeconds: number | null;
  routePattern: string;
  setHeadersAccessPhase: (phase: HeadersAccessPhase) => HeadersAccessPhase;
} & RunAppRouteHandlerOptions;

function configureAppRouteStaticGenerationContext(options: RunAppRouteHandlerOptions): void {
  if (options.dynamicConfig === "force-static" || options.dynamicConfig === "error") {
    const isDraftMode =
      options.isDraftMode ??
      (options.draftModeSecret !== undefined &&
        isDraftModeRequest(options.request, options.draftModeSecret));
    setHeadersContext(
      createStaticGenerationHeadersContext({
        draftModeEnabled: isDraftMode,
        draftModeSecret: options.draftModeSecret,
        dynamicConfig: options.dynamicConfig,
        routeKind: "route",
        routePattern: options.routePattern,
      }),
    );
    options.setHeadersAccessPhase?.("route-handler");
  }
}

export async function runAppRouteHandler(
  options: RunAppRouteHandlerOptions,
): Promise<RunAppRouteHandlerResult> {
  options.consumeDynamicUsage();
  configureAppRouteStaticGenerationContext(options);
  const trackedRequest = createTrackedAppRouteRequest(options.request, {
    basePath: options.basePath,
    i18n: options.i18n,
    trailingSlash: options.trailingSlash,
    middlewareHeaders: options.middlewareRequestHeaders,
    onDynamicAccess() {
      options.markDynamicUsage();
    },
    requestMode:
      options.dynamicConfig === "force-static" || options.dynamicConfig === "error"
        ? options.dynamicConfig
        : "auto",
    staticGenerationErrorMessage(expression) {
      return getAppRouteStaticGenerationErrorMessage(options.routePattern, expression);
    },
  });
  const response = await runWithRootParamsUsage(
    {
      kind: "route-handler",
      routePattern: options.routePattern ?? new URL(options.request.url).pathname,
    },
    () =>
      options.handlerFn(trackedRequest.request, {
        params: options.params,
      }),
  );

  const dynamicUsedInContext = options.consumeDynamicUsage();
  return {
    didAccessDynamicRequest: () => trackedRequest.didAccessDynamicRequest(),
    dynamicUsedInHandler: trackedRequest.didAccessDynamicRequest() || dynamicUsedInContext,
    response,
  };
}

export async function executeAppRouteHandler(
  options: ExecuteAppRouteHandlerOptions,
): Promise<Response> {
  const previousHeadersPhase = options.setHeadersAccessPhase("route-handler");
  let cleanupDeferredToBody = false;
  const middlewareMergeOptions = {
    appendResponseLink:
      options.handler.runtime === "edge" || options.handler.runtime === "experimental-edge",
  };

  try {
    let handlerResult: RunAppRouteHandlerResult;
    try {
      handlerResult = await runAppRouteHandler({
        ...options,
        dynamicConfig: options.handler.dynamic,
      });
    } finally {
      // Route Handlers expose synchronous revalidation APIs; their async cache
      // work belongs to the request lifecycle and must settle before response
      // finalization clears the request context.
      await _drainPendingRevalidations();
    }
    let { dynamicUsedInHandler, response } = handlerResult;
    assertSupportedAppRouteHandlerResponse(response);
    const handlerSetCachePolicy = CACHEABILITY_POLICY_HEADERS.some((name) =>
      response.headers.has(name),
    );
    const hasExplicitCacheablePolicy = hasExplicitCacheableResponsePolicy(response.headers);
    if (hasExplicitCacheablePolicy) {
      markRouteCacheabilityExplicitResponsePolicy();
    }

    const draftModeBeforeCompletion =
      options.getActiveDraftModeState?.() ?? options.isDraftMode === true;
    const handlerDraftCookieBeforeCompletion =
      options.getDraftModeCookieHeader() ?? options.initialDraftModeCookie;
    if (
      shouldCompleteAppRouteHandlerResponse({
        dynamicConfig: options.handler.dynamic,
        dynamicUsedInHandler,
        hasExplicitCacheablePolicy,
        handlerSetCachePolicy,
        isAutoHead: options.isAutoHead,
        isDraftMode: draftModeBeforeCompletion || handlerDraftCookieBeforeCompletion != null,
        isProduction: options.isProduction,
        method: options.method,
        revalidateSeconds: options.revalidateSeconds,
        requiresCompletedResponseAdmission: isRouteCacheabilityEvaluation(),
      })
    ) {
      const completed = await completeAppRouteHandlerResponse(response);
      response = completed.response;
      cleanupDeferredToBody = !completed.completed;
      if (completed.completed) markRouteCacheabilityResponseBodyComplete();
      const dynamicUsedDuringCompletion = options.consumeDynamicUsage();
      dynamicUsedInHandler =
        handlerResult.didAccessDynamicRequest() ||
        dynamicUsedDuringCompletion ||
        dynamicUsedInHandler;
    }

    const requestCacheabilityVeto = getRouteCacheabilityDynamicReason();
    const responseMustStayPrivate = Boolean(
      options.handler.dynamic === "force-dynamic" ||
      dynamicUsedInHandler ||
      requestCacheabilityVeto ||
      cleanupDeferredToBody,
    );
    if (dynamicUsedInHandler) {
      markKnownDynamicAppRoute(options.routePattern);
    }

    const pendingCookies = options.getAndClearPendingCookies();
    const handlerDraftCookie =
      options.getDraftModeCookieHeader() ?? handlerDraftCookieBeforeCompletion;
    const draftCookie = handlerDraftCookie ?? options.initialDraftModeCookie;
    const activeDraftMode = options.getActiveDraftModeState?.() ?? options.isDraftMode === true;
    const shouldApplyDraftPolicy = activeDraftMode || draftCookie != null;

    // Unlike force-static request reads, draft-mode mutations are dynamic in
    // Next.js. Remember the route when the handler itself crossed the draft
    // boundary so a pre-existing ISR entry cannot be replayed later.
    if (handlerDraftCookie != null) {
      markKnownDynamicAppRoute(options.routePattern);
    }

    // The route's cache tags, shared by the adapter's response policy (so edge
    // adapters can purge by tag) and the ISR write below. Cheap + side-effect free.
    const routeTags = options.buildPageCacheTags(
      options.cleanPathname,
      options.getCollectedFetchTags(),
    );

    if (
      shouldApplyAppRouteHandlerRevalidateHeader({
        dynamicUsedInHandler: responseMustStayPrivate,
        handlerSetCachePolicy,
        isAutoHead: options.isAutoHead,
        isDraftMode: shouldApplyDraftPolicy,
        method: options.method,
        revalidateSeconds: options.revalidateSeconds,
      })
    ) {
      const revalidateSeconds = options.revalidateSeconds;
      if (revalidateSeconds == null) {
        throw new Error("Expected route handler revalidate seconds");
      }
      applyRouteHandlerRevalidateHeader(
        response,
        revalidateSeconds,
        options.expireSeconds,
        routeTags,
      );
    }

    if (
      shouldWriteAppRouteHandlerCache({
        dynamicConfig: options.handler.dynamic,
        dynamicUsedInHandler: responseMustStayPrivate,
        handlerSetCachePolicy,
        isAutoHead: options.isAutoHead,
        isDraftMode: shouldApplyDraftPolicy,
        isProduction: options.isProduction,
        method: options.method,
        revalidateSeconds: options.revalidateSeconds,
      })
    ) {
      markRouteHandlerCacheMiss(response);
      const routeClone = response.clone();
      const routeKey = options.isrRouteKey(options.cleanPathname);
      const revalidateSeconds = options.revalidateSeconds;
      if (revalidateSeconds == null) {
        throw new Error("Expected route handler cache revalidate seconds");
      }
      const routeWritePromise = (async () => {
        try {
          const routeCacheValue = await buildAppRouteCacheValue(routeClone);
          await options.isrSet(routeKey, routeCacheValue, {
            cacheControl: isrCacheControl(revalidateSeconds, {
              expireSeconds: options.expireSeconds,
            }),
            tags: routeTags,
          });
          options.isrDebug?.("route cache written", routeKey);
        } catch (cacheErr) {
          console.error("[vinext] ISR route cache write error:", cacheErr);
        }
      })();
      options.executionContext?.waitUntil(routeWritePromise);
    }

    let finalized = applyDraftModeCachePolicy(
      applyRouteHandlerMiddlewareContext(
        finalizeRouteHandlerResponse(response, {
          pendingCookies,
          draftCookie,
          isHead: options.isAutoHead,
        }),
        options.middlewareContext,
        middlewareMergeOptions,
      ),
      shouldApplyDraftPolicy,
    );
    // Next.js preserves a Route Handler's explicit Cache-Control even when the
    // handler used request data. During CDN probe/admission the adapter still
    // owns fail-closed policy until the completed response is authorized.
    const preserveHandlerPolicy = isRouteCacheabilityEvaluation()
      ? hasExplicitCacheablePolicy
      : handlerSetCachePolicy;
    if (responseMustStayPrivate && !preserveHandlerPolicy) {
      const headers = new Headers(finalized.headers);
      applyCdnResponseHeaders(headers, { cacheControl: NEVER_CACHE_CONTROL });
      finalized = new Response(finalized.body, {
        headers,
        status: finalized.status,
        statusText: finalized.statusText,
      });
      copyLinkHeaderProvenance(response.headers, finalized.headers);
    }

    if (!cleanupDeferredToBody) {
      options.clearRequestContext();
      return finalized;
    }

    return deferAppRouteHandlerCleanup(finalized, async () => {
      try {
        await _drainPendingRevalidations();
        options.consumeDynamicUsage();
      } finally {
        options.clearRequestContext();
        options.setHeadersAccessPhase(previousHeadersPhase);
      }
    });
  } catch (error) {
    const pendingCookies = options.getAndClearPendingCookies();
    const handlerDraftCookie = options.getDraftModeCookieHeader();
    const draftCookie = handlerDraftCookie ?? options.initialDraftModeCookie;
    const activeDraftMode = options.getActiveDraftModeState?.() ?? options.isDraftMode === true;
    const shouldApplyDraftPolicy = activeDraftMode || draftCookie != null;
    if (handlerDraftCookie != null) {
      markKnownDynamicAppRoute(options.routePattern);
    }
    const specialError = resolveAppRouteHandlerSpecialError(error, options.request.url, {
      isAction: isPossibleAppRouteActionRequest(options.request),
    });
    options.clearRequestContext();

    if (specialError) {
      if (specialError.kind === "redirect") {
        return applyDraftModeCachePolicy(
          applyRouteHandlerMiddlewareContext(
            finalizeRouteHandlerResponse(
              new Response(null, {
                status: specialError.statusCode,
                headers: { Location: specialError.location },
              }),
              {
                pendingCookies,
                draftCookie,
                isHead: options.isAutoHead,
              },
            ),
            options.middlewareContext,
            middlewareMergeOptions,
          ),
          shouldApplyDraftPolicy,
        );
      }

      return applyDraftModeCachePolicy(
        applyRouteHandlerMiddlewareContext(
          new Response(null, { status: specialError.statusCode }),
          options.middlewareContext,
          middlewareMergeOptions,
        ),
        shouldApplyDraftPolicy,
      );
    }

    console.error("[vinext] Route handler error:", error);
    options.reportRequestError(
      error instanceof Error ? error : new Error(String(error)),
      {
        path: options.cleanPathname,
        method: options.request.method,
        headers: Object.fromEntries(options.request.headers.entries()),
      },
      {
        routerKind: "App Router",
        routePath: options.routePattern,
        routeType: "route",
      },
    );

    return applyDraftModeCachePolicy(
      applyRouteHandlerMiddlewareContext(
        new Response(null, { status: 500 }),
        options.middlewareContext,
        middlewareMergeOptions,
      ),
      shouldApplyDraftPolicy,
    );
  } finally {
    if (!cleanupDeferredToBody) options.setHeadersAccessPhase(previousHeadersPhase);
  }
}
