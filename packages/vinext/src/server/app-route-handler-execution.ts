import type { NextI18nConfig } from "../config/next-config.js";
import {
  isDraftModeRequest,
  setHeadersContext,
  type HeadersAccessPhase,
} from "vinext/shims/headers";
import type { ExecutionContextLike } from "vinext/shims/request-context";
import type { CachedRouteValue } from "vinext/shims/cache-handler";
import {
  runWithProspectiveDataCache,
  waitForProspectiveCacheFills,
} from "vinext/shims/cache-handler";
import { consumeDynamicFetchObservations } from "vinext/shims/fetch-observations";
import type { NextRequest } from "vinext/shims/server";
import {
  _drainPendingRevalidations,
  _peekRequestScopedCacheLife,
} from "vinext/shims/cache-request-state";
import { runWithRootParamsUsage } from "vinext/shims/root-params";
import { applyCdnResponseHeaders, NEVER_CACHE_CONTROL } from "./cache-control.js";
import { isrCacheControl, type IsrWritePolicy } from "./isr-cache.js";
import {
  createStaticGenerationHeadersContext,
  getAppRouteStaticGenerationErrorMessage,
} from "./app-static-generation.js";
import {
  isPossibleAppRouteActionRequest,
  hasNonStaticAppRouteHandlerMethods,
  resolveAppRouteHandlerSpecialError,
  shouldApplyAppRouteHandlerRevalidateHeader,
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
  captureResponseBodyBounded,
  isRouteCacheabilityProbe,
  recordRouteCacheabilityCapturedBody,
  recordRouteCacheabilityClassificationFailure,
  recordRouteCacheability,
  type CapturedResponseBody,
} from "./cacheability-request.js";

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
  cacheComponents?: boolean;
  captureThrown?: boolean;
  consumeDynamicUsage: AppRouteDynamicUsageFn;
  draftModeSecret?: string;
  dynamicConfig?: string;
  handlerFn: AppRouteHandlerFunction;
  i18n?: NextI18nConfig | null;
  isCacheabilityProbe?: boolean;
  isDraftMode?: boolean;
  trailingSlash?: boolean;
  markDynamicUsage: MarkAppRouteDynamicUsageFn;
  middlewareRequestHeaders?: Headers | null;
  /** Keep Cache Components task tracking active until the bounded body is collected. */
  observeCompletedBody?: boolean;
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
  crossedTaskBoundary: boolean;
  dynamicUsedInHandler: boolean;
  response: Response;
};

type CapturedAppRouteHandlerResult =
  | RunAppRouteHandlerResult
  | {
      crossedTaskBoundary: boolean;
      dynamicUsedInHandler: boolean;
      thrown: unknown;
    };

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
  observeCompletedBody?: boolean;
  /** Regeneration owns the cache write and must not release its per-key lock early. */
  awaitCacheWrite?: boolean;
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

export function runAppRouteHandler(
  options: RunAppRouteHandlerOptions & { captureThrown: true },
): Promise<CapturedAppRouteHandlerResult>;
export function runAppRouteHandler(
  options: RunAppRouteHandlerOptions,
): Promise<RunAppRouteHandlerResult>;
export async function runAppRouteHandler(
  options: RunAppRouteHandlerOptions,
): Promise<CapturedAppRouteHandlerResult> {
  const runPass = async (
    trackTaskBoundary: boolean,
    awaitHandler = true,
  ): Promise<CapturedAppRouteHandlerResult> => {
    options.consumeDynamicUsage();
    consumeDynamicFetchObservations();
    configureAppRouteStaticGenerationContext(options);
    const probeAbortController =
      trackTaskBoundary && options.isCacheabilityProbe ? new AbortController() : null;
    const passRequest = probeAbortController
      ? new Request(options.request, { signal: probeAbortController.signal })
      : options.request;
    const trackedRequest = createTrackedAppRouteRequest(passRequest, {
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
    let crossedTaskBoundary = false;
    let reachResponseBoundary: (() => void) | undefined;
    const responseBoundaryReached = trackTaskBoundary
      ? new Promise<void>((resolve) => {
          reachResponseBoundary = resolve;
        })
      : undefined;
    const taskBoundaryTimer = trackTaskBoundary
      ? setTimeout(() => {
          crossedTaskBoundary = true;
          probeAbortController?.abort();
          reachResponseBoundary?.();
        }, 0)
      : undefined;
    let response: Response | undefined;
    let thrown: unknown;
    try {
      const invocation = runWithRootParamsUsage(
        {
          kind: "route-handler",
          routePattern: options.routePattern ?? new URL(options.request.url).pathname,
        },
        () =>
          options.handlerFn(trackedRequest.request, {
            params: options.params,
          }),
      );
      if (awaitHandler) {
        if (options.isCacheabilityProbe && responseBoundaryReached) {
          const settled = Promise.resolve(invocation).then(
            (value) => ({ kind: "response" as const, value }),
            (error) => ({ error, kind: "error" as const }),
          );
          const outcome = await Promise.race([
            settled,
            responseBoundaryReached.then(() => ({ kind: "boundary" as const })),
          ]);
          if (outcome.kind === "response") response = outcome.value;
          else if (outcome.kind === "error") thrown = outcome.error;
          else {
            // The staged probe only needs the dynamic classification. Detach
            // user work after aborting its Request signal instead of waiting
            // for a long or never-settling handler promise.
            void settled;
            response = new Response(null);
          }
        } else {
          response = await invocation;
        }
      } else {
        // Match Next.js's prospective Cache Components pass: invoke user code
        // and observe synchronous dynamic access, but do not await its response.
        void Promise.resolve(invocation).catch(() => {});
      }
    } catch (error) {
      thrown = error;
    } finally {
      if (taskBoundaryTimer !== undefined && !crossedTaskBoundary) clearTimeout(taskBoundaryTimer);
    }

    const result = {
      crossedTaskBoundary,
      dynamicUsedInHandler:
        options.consumeDynamicUsage() || consumeDynamicFetchObservations().length > 0,
    };
    return response ? { ...result, response } : { ...result, thrown };
  };

  let result: CapturedAppRouteHandlerResult;
  if (options.cacheComponents && (options.isCacheabilityProbe || options.observeCompletedBody)) {
    result = await runWithProspectiveDataCache(async () => {
      const prospective = await runPass(false, false);
      if (prospective.dynamicUsedInHandler) {
        if (options.isCacheabilityProbe) {
          return {
            crossedTaskBoundary: prospective.crossedTaskBoundary,
            dynamicUsedInHandler: true,
            response: new Response(null),
          };
        }
        return runPass(false);
      }
      // Next's prospective pass waits for cache fills started by the handler,
      // but neither awaits nor pulls the returned response.
      await waitForProspectiveCacheFills();
      await _drainPendingRevalidations();
      prospective.dynamicUsedInHandler =
        options.consumeDynamicUsage() || consumeDynamicFetchObservations().length > 0;
      if (prospective.dynamicUsedInHandler) {
        if (options.isCacheabilityProbe) {
          return {
            crossedTaskBoundary: prospective.crossedTaskBoundary,
            dynamicUsedInHandler: true,
            response: new Response(null),
          };
        }
        return runPass(false);
      }
      return runPass(true);
    });
  } else {
    result = await runPass(options.cacheComponents === true);
  }

  if ("thrown" in result && !options.captureThrown) throw result.thrown;
  return result;
}

export async function executeAppRouteHandler(
  options: ExecuteAppRouteHandlerOptions,
): Promise<Response> {
  if (
    options.cacheComponents &&
    (options.method === "GET" || options.isAutoHead) &&
    !hasNonStaticAppRouteHandlerMethods(options.handler)
  ) {
    const { runWithCacheComponentsPlatformIoTracking } =
      await import("./cache-components-platform-io.js");
    return runWithCacheComponentsPlatformIoTracking(() => executeAppRouteHandlerInner(options));
  }
  return executeAppRouteHandlerInner(options);
}

async function executeAppRouteHandlerInner(
  options: ExecuteAppRouteHandlerOptions,
): Promise<Response> {
  const hasNonStaticMethods =
    options.cacheComponents && hasNonStaticAppRouteHandlerMethods(options.handler);
  const isCacheEligibleMethod =
    (options.method === "GET" || options.isAutoHead) && !hasNonStaticMethods;
  const previousHeadersPhase = options.setHeadersAccessPhase("route-handler");
  const middlewareMergeOptions = {
    appendResponseLink:
      options.handler.runtime === "edge" || options.handler.runtime === "experimental-edge",
  };

  try {
    let handlerResult: CapturedAppRouteHandlerResult;
    try {
      handlerResult = await runAppRouteHandler({
        ...options,
        captureThrown: true,
        dynamicConfig: options.handler.dynamic,
        isCacheabilityProbe: options.isCacheabilityProbe ?? isRouteCacheabilityProbe(),
      });
    } finally {
      // Route Handlers expose synchronous revalidation APIs; their async cache
      // work belongs to the request lifecycle and must settle before response
      // finalization clears the request context.
      await _drainPendingRevalidations();
    }
    let { dynamicUsedInHandler } = handlerResult;
    let { crossedTaskBoundary } = handlerResult;
    let response: Response;
    let specialResponseKind: "redirect" | "status" | null = null;
    if ("thrown" in handlerResult) {
      const specialError = resolveAppRouteHandlerSpecialError(
        handlerResult.thrown,
        options.request.url,
        { isAction: isPossibleAppRouteActionRequest(options.request) },
      );
      if (!specialError) throw handlerResult.thrown;
      specialResponseKind = specialError.kind;
      response =
        specialError.kind === "redirect"
          ? new Response(null, {
              status: specialError.statusCode,
              headers: { Location: specialError.location },
            })
          : new Response(null, { status: specialError.statusCode });
    } else {
      response = handlerResult.response;
    }
    assertSupportedAppRouteHandlerResponse(response);
    const handlerSetCacheControl = response.headers.has("cache-control");

    let completedRouteCacheValue: CachedRouteValue | null = null;
    let completedBodyFailure: string | null = null;
    let completedBodyClassificationFailure = false;
    if (options.observeCompletedBody) {
      const contentType = response.headers.get("content-type")?.toLowerCase();
      const streamingOnly =
        response.status === 101 ||
        response.headers.has("upgrade") ||
        Reflect.get(response, "webSocket") != null ||
        contentType?.startsWith("text/event-stream");
      if (streamingOnly) {
        completedBodyFailure = contentType?.startsWith("text/event-stream")
          ? "route handler returned an event stream"
          : "route handler returned an upgrade response";
      } else {
        let bodyCrossedTaskBoundary = false;
        let reachBodyBoundary: (() => void) | undefined;
        const bodyBoundaryReached = new Promise<void>((resolve) => {
          reachBodyBoundary = resolve;
        });
        const cacheabilityProbe = options.isCacheabilityProbe ?? isRouteCacheabilityProbe();
        const probeBodyAbortController = cacheabilityProbe ? new AbortController() : null;
        let bodyBoundaryTimer: ReturnType<typeof setTimeout> | undefined;
        const capturePromise = captureResponseBodyBounded(response, {
          onCaptureStart() {
            bodyBoundaryTimer = setTimeout(() => {
              bodyCrossedTaskBoundary = true;
              probeBodyAbortController?.abort(
                new Error("Cache Components body crossed task boundary"),
              );
              reachBodyBoundary?.();
            }, 0);
          },
          signal: probeBodyAbortController?.signal,
          waitForCapacity: cacheabilityProbe || undefined,
        });
        let captured: CapturedResponseBody | null;
        if (cacheabilityProbe) {
          const captureOutcome = await Promise.race([
            capturePromise.then((value) => ({ kind: "captured" as const, value })),
            bodyBoundaryReached.then(() => ({ kind: "boundary" as const })),
          ]);
          if (captureOutcome.kind === "boundary") {
            crossedTaskBoundary = true;
            completedBodyFailure = "Cache Components route handler completed in a new task";
            void capturePromise
              .then(async (lateCapture) => {
                await lateCapture.fallback?.cancel().catch(() => {});
                if (!lateCapture.failClosed) lateCapture.release();
              })
              .catch(() => {});
            response = new Response(null, {
              headers: response.headers,
              status: response.status,
              statusText: response.statusText,
            });
            captured = null;
          } else {
            captured = captureOutcome.value;
          }
        } else {
          captured = await capturePromise;
        }
        if (bodyBoundaryTimer !== undefined) clearTimeout(bodyBoundaryTimer);
        if (bodyCrossedTaskBoundary) crossedTaskBoundary = true;
        if (captured === null) {
          // The task-bound probe outcome is finalized below without waiting for
          // detached user work or its response body.
        } else {
          let transferredCapture = false;
          try {
            // Stream pulls can also enqueue cache invalidations, uncached fetches,
            // or dynamic API reads. Include all of them before cache admission.
            await _drainPendingRevalidations();
            dynamicUsedInHandler =
              dynamicUsedInHandler ||
              options.consumeDynamicUsage() ||
              consumeDynamicFetchObservations().length > 0;
            if (captured.failClosed) {
              completedBodyFailure = captured.reason;
              completedBodyClassificationFailure = true;
              response = new Response(captured.fallback, {
                headers: response.headers,
                status: response.status,
                statusText: response.statusText,
              });
            } else {
              completedRouteCacheValue = await buildAppRouteCacheValue(response, captured.body, {
                preserveCacheControl: handlerSetCacheControl,
              });
              transferredCapture = recordRouteCacheabilityCapturedBody(
                captured.body,
                captured.release,
              );
              if (captured.body !== null) {
                response = new Response(captured.body, {
                  headers: response.headers,
                  status: response.status,
                  statusText: response.statusText,
                });
              }
              await captured.fallback?.cancel().catch(() => {});
            }
          } finally {
            if (!captured.failClosed && !transferredCapture) captured.release();
          }
        }
      }
    }
    if (crossedTaskBoundary) dynamicUsedInHandler = true;

    if (dynamicUsedInHandler && isCacheEligibleMethod) {
      markKnownDynamicAppRoute(options.routePattern);
      recordRouteCacheability({
        cacheable: false,
        dynamicUsage: true,
        reason: crossedTaskBoundary
          ? "Cache Components route handler completed in a new task"
          : "dynamic API used by route handler",
      });
    } else if (completedBodyFailure && isCacheEligibleMethod) {
      if (completedBodyClassificationFailure) {
        recordRouteCacheabilityClassificationFailure(completedBodyFailure);
      } else {
        recordRouteCacheability({
          cacheable: false,
          dynamicUsage: true,
          reason: completedBodyFailure,
        });
      }
    }

    const cacheabilityBlocked =
      hasNonStaticMethods || dynamicUsedInHandler || completedBodyFailure !== null;

    const pendingCookies = options.getAndClearPendingCookies();
    const handlerDraftCookie = options.getDraftModeCookieHeader();
    const draftCookie = handlerDraftCookie ?? options.initialDraftModeCookie;
    const activeDraftMode = options.getActiveDraftModeState?.() ?? options.isDraftMode === true;
    const shouldApplyDraftPolicy = activeDraftMode || draftCookie != null;

    // Unlike force-static request reads, draft-mode mutations are dynamic in
    // Next.js. Remember the route when the handler itself crossed the draft
    // boundary so a pre-existing ISR entry cannot be replayed later.
    if (handlerDraftCookie != null && isCacheEligibleMethod) {
      markKnownDynamicAppRoute(options.routePattern);
    }

    // The route's cache tags, shared by the adapter's response policy (so edge
    // adapters can purge by tag) and the ISR write below. Cheap + side-effect free.
    const routeTags = options.buildPageCacheTags(
      options.cleanPathname,
      options.getCollectedFetchTags(),
    );
    const requestCacheLife = _peekRequestScopedCacheLife();
    const effectiveRevalidateSeconds =
      requestCacheLife?.revalidate === undefined
        ? options.revalidateSeconds
        : options.revalidateSeconds === null
          ? requestCacheLife.revalidate
          : Math.min(options.revalidateSeconds, requestCacheLife.revalidate);
    const effectiveExpireSeconds = requestCacheLife?.expire ?? options.expireSeconds;

    if (
      shouldApplyAppRouteHandlerRevalidateHeader({
        dynamicUsedInHandler: cacheabilityBlocked,
        handlerSetCacheControl,
        isAutoHead: options.isAutoHead,
        isDraftMode: shouldApplyDraftPolicy,
        method: options.method,
        revalidateSeconds: effectiveRevalidateSeconds,
        responseStatus: response.status,
      })
    ) {
      const revalidateSeconds = effectiveRevalidateSeconds;
      if (revalidateSeconds == null) {
        throw new Error("Expected route handler revalidate seconds");
      }
      applyRouteHandlerRevalidateHeader(
        response,
        revalidateSeconds,
        effectiveExpireSeconds,
        routeTags,
      );
    }

    if (
      shouldWriteAppRouteHandlerCache({
        dynamicConfig: options.handler.dynamic,
        dynamicUsedInHandler: cacheabilityBlocked,
        handlerSetCacheControl,
        isAutoHead: options.isAutoHead,
        isDraftMode: shouldApplyDraftPolicy,
        isProduction: options.isProduction,
        method: options.method,
        revalidateSeconds: effectiveRevalidateSeconds,
        responseStatus: response.status,
      })
    ) {
      markRouteHandlerCacheMiss(response);
      const routeKey = options.isrRouteKey(options.cleanPathname);
      const revalidateSeconds = effectiveRevalidateSeconds;
      if (revalidateSeconds == null) {
        throw new Error("Expected route handler cache revalidate seconds");
      }
      const routeWritePromise = (async () => {
        const routeCacheValue =
          completedRouteCacheValue ??
          (await buildAppRouteCacheValue(response.clone(), undefined, {
            preserveCacheControl: handlerSetCacheControl,
          }));
        await options.isrSet(routeKey, routeCacheValue, {
          cacheControl: isrCacheControl(revalidateSeconds, {
            expireSeconds: effectiveExpireSeconds,
          }),
          tags: routeTags,
        });
        options.isrDebug?.("route cache written", routeKey);
      })();
      if (options.awaitCacheWrite) {
        await routeWritePromise;
      } else {
        const reportedWrite = routeWritePromise.catch((cacheErr) => {
          console.error("[vinext] ISR route cache write error:", cacheErr);
        });
        if (options.executionContext) {
          options.executionContext.waitUntil(reportedWrite);
        } else {
          void reportedWrite;
        }
      }
    }

    options.clearRequestContext();

    return applyDraftModeCachePolicy(
      applyRouteHandlerMiddlewareContext(
        finalizeRouteHandlerResponse(response, {
          pendingCookies: specialResponseKind === "status" ? [] : pendingCookies,
          draftCookie: specialResponseKind === "status" ? null : draftCookie,
          isHead: options.isAutoHead,
        }),
        options.middlewareContext,
        middlewareMergeOptions,
      ),
      shouldApplyDraftPolicy,
    );
  } catch (error) {
    const pendingCookies = options.getAndClearPendingCookies();
    const handlerDraftCookie = options.getDraftModeCookieHeader();
    const draftCookie = handlerDraftCookie ?? options.initialDraftModeCookie;
    const activeDraftMode = options.getActiveDraftModeState?.() ?? options.isDraftMode === true;
    const shouldApplyDraftPolicy = activeDraftMode || draftCookie != null;
    if (handlerDraftCookie != null && isCacheEligibleMethod) {
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
    options.setHeadersAccessPhase(previousHeadersPhase);
  }
}
