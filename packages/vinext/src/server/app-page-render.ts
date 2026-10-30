import type { ReactNode } from "react";
import type { ReactFormState } from "react-dom/client";
import type { NavigationContext } from "vinext/shims/navigation";
import type { AppPageCacheSetter } from "./isr-cache.js";
import type { RootParams } from "vinext/shims/root-params";
import { runWithFetchDedupe } from "vinext/shims/fetch-cache";
import { getRequestExecutionContext } from "vinext/shims/request-context";
import { getCdnCacheAdapter } from "vinext/shims/cdn-cache";
import { resolveClientStaleTimeSeconds } from "../utils/cache-control-metadata.js";
import { AppElementsWire, isAppElementsRecord, type AppOutgoingElements } from "./app-elements.js";
import { getAppPageLayoutGate } from "./app-page-layout-gate.js";
import { hasDigest } from "./app-rsc-errors.js";
import { internalServerErrorResponse } from "./http-error-responses.js";
import { mergeMiddlewareResponseHeaders } from "./middleware-response-headers.js";
import { isBailoutToCSRError } from "vinext/shims/navigation-errors";
import {
  finalizeAppPageCacheabilityEvaluationResponse,
  finalizeAppPageHtmlCacheResponse,
  finalizeAppPageRscCacheResponse,
} from "./app-page-cache-finalizer.js";
import {
  buildAppPageFontLinkHeader,
  readAppPageBinaryStream,
  resolveAppPageCaughtNotFoundBoundaries,
  resolveAppPageShellSpecialError,
  resolveAppPageSpecialError,
  resolveAppPageSpecialErrorStoredHeaders,
  teeAppPageRscStreamForCapture,
  type AppPageFontPreload,
  type AppPageSpecialError,
} from "./app-page-execution.js";
import { createAppPageRscRenderStatusResolver } from "./app-page-rsc-render-status.js";
import {
  applyClientStaleTimeHeader,
  applyEdgeRuntimeHeader,
  buildAppPageHtmlResponse,
  buildAppPageRscResponse,
  resolveAppPageHtmlResponsePolicy,
  resolveAppPageRscResponsePolicy,
  resolveUncacheableCacheControl,
  type AppPageMiddlewareContext,
  type AppPageResponseTiming,
} from "./app-page-response.js";
import {
  buildAppPageHtmlDocumentResponse,
  buildAppPageLinkHeader,
  createAppPageFontData,
  createAppPageRscErrorTracker,
  createAppPageSsrErrorHandler,
  deferUntilStreamConsumed,
  renderAppPageHtmlStream,
  renderAppPageHtmlStreamWithRecovery,
  type AppPageSsrHandler,
} from "./app-page-stream.js";
import { APP_RSC_RENDER_MODE_NAVIGATION, type AppRscRenderMode } from "./app-rsc-render-mode.js";
import type { InitialNavigationCacheMetadata } from "./app-ssr-stream.js";
import {
  createArtifactCompatibilityEnvelope,
  createArtifactCompatibilityGraphVersion,
  type ArtifactCompatibilityEnvelope,
} from "./artifact-compatibility.js";
import {
  applyCdnResponseHeaders,
  isCdnResponsePolicyHeader,
  NEVER_CACHE_CONTROL,
  NO_STORE_CACHE_CONTROL,
} from "./cache-control.js";
import {
  createAppPageHtmlOutputScope,
  createAppPageRenderObservation,
  createAppPageRscOutputScope,
  type AppPageRenderObservationState,
} from "./app-page-render-observation.js";
import { isRenderDynamicLatched, peekDynamicUsage } from "vinext/shims/headers";
import {
  bindRequestContext,
  preserveFullyBufferedBodyMetadata,
} from "vinext/shims/unified-request-context";
import { setCacheStateHeaders } from "./cache-headers.js";
import {
  VINEXT_DYNAMIC_STALE_TIME_HEADER,
  VINEXT_RSC_COMPLETION_METADATA_HEADER,
  VINEXT_RSC_REDIRECT_HEADER,
} from "./headers.js";
import {
  applyPrerenderCacheLifeHeader,
  applyPrerenderCacheTagsHeader,
} from "./prerender-cache-life-header.js";
import { appendRscCompletionMetadata } from "./rsc-completion-metadata.js";
import type { AppRenderErrorContextOverrides } from "./app-rsc-error-handler.js";
import { recordAppPageRenderError, traceAppPageRender } from "./app-page-tracing.js";
import type { FrameworkSpan } from "./framework-tracer.js";
import { traceResponseStartWithCompletion } from "./response-start-tracing.js";
import {
  copyLinkHeaderProvenance,
  getFrameworkLinkHeader,
} from "./app-response-header-provenance.js";
import {
  getRouteCacheabilityCaptureOptions,
  isRouteCacheabilityEvaluation,
  recordRouteCacheabilityClientTraceMetadataMarker,
} from "vinext/shims/cacheability-classification";

type AppPageBoundaryOnError = (
  error: unknown,
  requestInfo: unknown,
  errorContext: unknown,
) => unknown;
type AppPageDebugLogger = (event: string, detail: string) => void;

type AppPageRequestCacheLife = {
  revalidate?: number;
  expire?: number;
  stale?: number;
};

type AppPageRenderableElement = ReactNode | Readonly<Record<string, ReactNode>>;

type AppPageSpecialErrorRenderOptions = {
  /**
   * The document may be stored in place of the page's, so like a cache
   * candidate's render it must not carry the request's query.
   */
  isCacheCandidate?: boolean;
  /**
   * The page's own document, in which parallel slot boundaries caught the
   * error, to send in place of a fallback page.
   */
  caughtDocument?: Response;
};

type PreparedAppPageElement =
  | { element: AppPageRenderableElement; response?: never }
  | { element?: never; response: Response };

type RenderAppPageLifecycleOptionsBase = {
  basePath?: string;
  bypassInterceptionContextCache?: boolean;
  /**
   * Allow-list of OpenTelemetry propagation keys to emit as `<meta>` tags in
   * the SSR head. From `experimental.clientTraceMetadata` in `next.config`.
   * Undefined or empty disables emission.
   */
  clientTraceMetadata?: readonly string[];
  /**
   * Maximum total length (in characters) of the preload `Link` header emitted
   * during SSR. `0` disables emission. From `reactMaxHeadersLength` in
   * `next.config`.
   */
  reactMaxHeadersLength?: number;
  cleanPathname: string;
  clearRequestContext: () => void;
  consumeDynamicUsage: () => boolean;
  peekDynamicUsage?: () => boolean;
  consumeRenderObservationState?: () => AppPageRenderObservationState;
  /** Read and clear any invalid dynamic usage error recorded during render (dev-only). */
  consumeInvalidDynamicUsageError?: () => unknown;
  createRscOnErrorHandler: (
    pathname: string,
    routePath: string,
    overrides?: AppRenderErrorContextOverrides,
  ) => AppPageBoundaryOnError;
  getFontLinks: () => string[];
  getFontPreloads: () => AppPageFontPreload[];
  getFontStyles: () => string[];
  getNavigationContext: () => NavigationContext | null;
  getPageTags: () => string[];
  getRequestCacheLife: () => AppPageRequestCacheLife | null;
  peekRequestCacheLife?: () => AppPageRequestCacheLife | null;
  getDraftModeCookieHeader: () => string | null | undefined;
  handlerStart: number;
  hasCustomGlobalError?: boolean;
  dynamicStaleTimeSeconds?: number;
  isDynamicError: boolean;
  isDraftMode: boolean;
  isEdgeRuntime?: boolean;
  isForceDynamic: boolean;
  isForceStatic: boolean;
  /**
   * Whether Next.js would classify the route as static or SSG from its config
   * (`isAppPageStaticEligible`). Other routes are never full-page cached.
   */
  isStaticEligible: boolean;
  /**
   * Production render that may be stored under a query-free key: SSR
   * `useSearchParams()` waits until the render is known to be dynamic, and
   * bails out to client rendering otherwise.
   */
  isCacheCandidate?: boolean;
  isProgressiveActionRender?: boolean;
  isPrerender?: boolean;
  /** PPR routes send every RSC response as a 200. */
  isRoutePPREnabled?: boolean;
  isSpeculativePrerender?: boolean;
  /** Wait for the whole document before its first byte, as a prerender does. */
  renderWholeDocument?: boolean;
  isProduction: boolean;
  omitPendingDynamicCacheState?: boolean;
  isRscRequest: boolean;
  traceOperation?: "prerender" | "render";
  onRenderComplete?: (completion: Promise<void>) => void;
  isrDebug?: AppPageDebugLogger;
  isrHtmlKey: (pathname: string) => string;
  isrRscKey: (
    pathname: string,
    mountedSlotsHeader?: string | null,
    renderMode?: AppRscRenderMode,
    interceptionContext?: string | null,
    interceptionId?: string | null,
  ) => string;
  isrSet: AppPageCacheSetter;
  interceptionContext?: string | null;
  interceptionId?: string | null;
  loadSsrHandler: () => Promise<AppPageSsrHandler>;
  middlewareContext: AppPageMiddlewareContext;
  navigationParams: Record<string, unknown>;
  params: Record<string, unknown>;
  pprFallbackShellSignal?: AbortSignal;
  pprFallbackShellReactSignal?: AbortSignal;
  abortPprFallbackShell?: () => void;
  rootParams?: RootParams;
  peekRenderObservationState?: () => AppPageRenderObservationState;
  expireSeconds?: number;
  formState?: ReactFormState | null;
  revalidateSeconds: number | null;
  renderErrorBoundaryResponse: (
    error: unknown,
    errorOrigin: "rsc" | "ssr",
  ) => Promise<Response | null>;
  renderPageSpecialError: (
    specialError: AppPageSpecialError,
    renderOptions?: AppPageSpecialErrorRenderOptions,
  ) => Promise<Response>;
  renderToReadableStream: (
    element: ReactNode | AppOutgoingElements,
    options: { onError: AppPageBoundaryOnError; signal?: AbortSignal },
  ) => ReadableStream<Uint8Array>;
  prerenderToReadableStream?: (
    element: ReactNode | AppOutgoingElements,
    options: { onError: AppPageBoundaryOnError; signal?: AbortSignal },
  ) => Promise<{ prelude: ReadableStream<Uint8Array> }>;
  routePattern: string;
  scriptNonce?: string;
  mountedSlotsHeader?: string | null;
  renderedPathAndSearch?: string | null;
  renderMode?: AppRscRenderMode;
  waitUntil?: (promise: Promise<void>) => void;
};

type RenderAppPageLifecycleOptions = RenderAppPageLifecycleOptionsBase &
  (
    | { element: AppPageRenderableElement; prepareElement?: never }
    | { element?: never; prepareElement: () => Promise<PreparedAppPageElement> }
  );

type ResolvedRenderAppPageLifecycleOptions = RenderAppPageLifecycleOptionsBase & {
  element: AppPageRenderableElement;
};

function buildResponseTiming(
  options: Pick<RenderAppPageLifecycleOptions, "handlerStart" | "isProduction"> & {
    compileEnd?: number;
    renderEnd?: number;
    responseKind: AppPageResponseTiming["responseKind"];
  },
): AppPageResponseTiming | undefined {
  if (options.isProduction) {
    return undefined;
  }

  return {
    compileEnd: options.compileEnd,
    handlerStart: options.handlerStart,
    renderEnd: options.renderEnd,
    responseKind: options.responseKind,
  };
}

function readRequestCacheLifeForPrerender(
  options: Pick<
    RenderAppPageLifecycleOptions,
    "getRequestCacheLife" | "isEdgeRuntime" | "peekRequestCacheLife" | "revalidateSeconds"
  >,
): AppPageRequestCacheLife | null {
  if (options.isEdgeRuntime && options.revalidateSeconds === null) {
    const requestCacheLife = options.peekRequestCacheLife?.() ?? options.getRequestCacheLife();
    return requestCacheLife?.revalidate !== undefined ? { revalidate: 0 } : null;
  }
  // Prefer the non-destructive reader so prerender.ts can consume metadata
  // after the handler returns. The consume fallback supports older entry glue
  // and is only safe because this path reads at most once per prerender.
  return options.peekRequestCacheLife?.() ?? options.getRequestCacheLife();
}

function resolveConfiguredDynamicStaleTimeSeconds(): number {
  const seconds = Number(process.env.__NEXT_CLIENT_ROUTER_DYNAMIC_STALETIME);
  return Number.isInteger(seconds) && seconds >= 0 ? seconds : 0;
}

function readRequestCacheLifeForCachePolicy(
  options: Pick<
    RenderAppPageLifecycleOptions,
    "getRequestCacheLife" | "isEdgeRuntime" | "revalidateSeconds"
  >,
): AppPageRequestCacheLife | null {
  const requestCacheLife = options.getRequestCacheLife();
  if (options.isEdgeRuntime && options.revalidateSeconds === null) {
    return null;
  }
  return requestCacheLife;
}

function applyRequestCacheLife(options: {
  expireSeconds?: number;
  requestCacheLife: AppPageRequestCacheLife | null;
  revalidateSeconds: number | null;
}): { expireSeconds?: number; revalidateSeconds: number | null } {
  let revalidateSeconds = options.revalidateSeconds;
  let expireSeconds = options.expireSeconds;
  const requestCacheLife = options.requestCacheLife;

  if (requestCacheLife?.revalidate !== undefined) {
    revalidateSeconds =
      revalidateSeconds === null
        ? requestCacheLife.revalidate
        : Math.min(revalidateSeconds, requestCacheLife.revalidate);
  }
  if (requestCacheLife?.expire !== undefined) {
    // cacheLife() supplies the effective hard-expire ceiling for this render,
    // so it replaces the config fallback instead of min-merging with it.
    expireSeconds = requestCacheLife.expire;
  }

  // `stale` is deliberately absent: it is the client-router dimension and must
  // not leak into `Cache-Control`. It travels on the cache entry instead (see
  // resolveAppPageCacheControl).
  return { expireSeconds, revalidateSeconds };
}

/**
 * A render that is known dynamic is never cacheable: a route Next.js can't make
 * static, draft mode, `force-dynamic`, `revalidate = 0`, or a dynamic API read
 * before the response left the render. Responses that leave the render before
 * its response policy, such as error boundaries and special errors, get the
 * same header as the normal render.
 */
export function applyIneligibleRouteCachePolicy(
  response: Response,
  options: Pick<
    RenderAppPageLifecycleOptions,
    | "dynamicStaleTimeSeconds"
    | "isDraftMode"
    | "isDynamicError"
    | "isForceDynamic"
    | "isForceStatic"
    | "isProduction"
    | "isProgressiveActionRender"
    | "isRscRequest"
    | "isStaticEligible"
    | "middlewareContext"
    | "peekDynamicUsage"
    | "revalidateSeconds"
    | "scriptNonce"
  >,
  requestCacheLife: AppPageRequestCacheLife | null = null,
): Response {
  const cacheControl = resolveEarlyResponseCacheControl(options);
  const isRscRedirect = options.isRscRequest && response.headers.has(VINEXT_RSC_REDIRECT_HEADER);
  if (!cacheControl) {
    // A layout's redirect answers once the layouts above it rendered, so a
    // static RSC redirect carries their cacheLife stale bound like a
    // prerender. As in Next.js, a known-dynamic redirect carries only
    // `staleTimes.dynamic`.
    const staleTimeSeconds = isRscRedirect
      ? resolveClientStaleTimeSeconds(requestCacheLife)
      : undefined;
    if (staleTimeSeconds === undefined) return response;
    const stamped = cloneForStamping(response);
    applyClientStaleTimeHeader(stamped.headers, staleTimeSeconds);
    return stamped;
  }
  // A streamed RSC redirect from a known-dynamic render carries the
  // `staleTimes.dynamic` bound, so a prefetched redirect is not replayed past it.
  const dynamicStaleTimeSeconds = isRscRedirect
    ? (options.dynamicStaleTimeSeconds ?? resolveConfiguredDynamicStaleTimeSeconds())
    : undefined;
  // Middleware's own cache policy wins, as in the normal response builders.
  // Only keep what this response already carries from it.
  const middlewarePolicy = [...(options.middlewareContext.headers ?? [])].filter(
    ([name, value]) => isCdnResponsePolicyHeader(name) && response.headers.get(name) === value,
  );
  const keepsMiddlewareCacheControl = middlewarePolicy.some(([name]) => name === "cache-control");
  if (keepsMiddlewareCacheControl && dynamicStaleTimeSeconds === undefined) return response;
  const stamped = cloneForStamping(response);
  if (!keepsMiddlewareCacheControl) {
    applyCdnResponseHeaders(stamped.headers, { cacheControl });
    for (const [name, value] of middlewarePolicy) stamped.headers.set(name, value);
  }
  if (dynamicStaleTimeSeconds !== undefined) {
    stamped.headers.set(VINEXT_DYNAMIC_STALE_TIME_HEADER, String(dynamicStaleTimeSeconds));
  }
  return stamped;
}

/** Some early responses have immutable headers, so stamp a copy. */
function cloneForStamping(response: Response): Response {
  const stamped = preserveFullyBufferedBodyMetadata(
    response,
    new Response(response.body, response as ResponseInit),
  );
  copyLinkHeaderProvenance(response.headers, stamped.headers);
  return stamped;
}

/** The known-dynamic branches of the RSC and HTML response policies, in their order. */
function resolveEarlyResponseCacheControl(
  options: Parameters<typeof applyIneligibleRouteCachePolicy>[1],
): string | null {
  const uncacheable = resolveUncacheableCacheControl(options.isProduction);
  if (!options.isStaticEligible || options.isDraftMode || options.isForceDynamic) {
    return uncacheable;
  }
  // The HTML policy checks nonce-bearing and progressive action renders next,
  // and keeps them no-store whatever else they do.
  if (!options.isRscRequest && (options.scriptNonce || options.isProgressiveActionRender)) {
    return NO_STORE_CACHE_CONTROL;
  }
  // As in the HTML response policy, only force-static and dynamic = "error"
  // without a revalidate period stay static after a dynamic API read.
  const ignoresDynamicUsage =
    (options.isForceStatic || options.isDynamicError) &&
    (options.revalidateSeconds === null || options.revalidateSeconds === Infinity);
  const isKnownDynamic =
    options.revalidateSeconds === 0 ||
    (!ignoresDynamicUsage && (options.peekDynamicUsage?.() ?? peekDynamicUsage()));
  return isKnownDynamic ? uncacheable : null;
}

function resolveAppPageCacheWriteRevalidateSeconds(options: {
  isDynamicError: boolean;
  isForceStatic: boolean;
  isStaticEligible: boolean;
  revalidateSeconds: number | null;
}): number | null {
  if (!options.isStaticEligible) {
    return null;
  }

  if (options.revalidateSeconds === null && (options.isForceStatic || options.isDynamicError)) {
    return Infinity;
  }

  return options.revalidateSeconds;
}

function readRootBoundaryId(element: Readonly<Record<string, unknown>>): string | null {
  const rootLayoutTreePath = element[AppElementsWire.keys.rootLayout];
  return typeof rootLayoutTreePath === "string" ? rootLayoutTreePath : null;
}

function createAppPageArtifactCompatibility(
  element: ReactNode | Readonly<Record<string, ReactNode>>,
  routePattern: string,
): ArtifactCompatibilityEnvelope | undefined {
  if (!isAppElementsRecord(element)) {
    return undefined;
  }

  const rootBoundaryId = readRootBoundaryId(element);
  return createArtifactCompatibilityEnvelope({
    graphVersion: createArtifactCompatibilityGraphVersion({
      routePattern,
      rootBoundaryId,
    }),
    deploymentVersion: process.env.__VINEXT_BUILD_ID ?? null,
    rootBoundaryId,
  });
}

/**
 * Wraps an RSC response body to report invalid dynamic usage errors after the
 * stream is fully consumed. In dev mode, errors from cookies()/headers() inside
 * "use cache" may be caught by user try/catch and silently swallowed — this
 * wrapper waits for the stream to drain and surfaces any recorded error to the
 * terminal (and, via HMR, the browser dev overlay).
 *
 * Dedups against React's Flight error chunk: if the recorded error already
 * carries a `digest`, React's serverComponentsErrorHandler has already stamped
 * it and emitted it into the RSC stream. Skipping `console.error` prevents
 * double-logging. Caught cases (no digest) still surface here.
 *
 * Ported from Next.js:
 *   https://github.com/vercel/next.js/commit/f5e54c06726b571a042fce67417e40a29f6b8689
 *   https://github.com/vercel/next.js/pull/93706
 */
function wrapRscResponseForDevErrorReporting(
  response: Response,
  consumeInvalidDynamicUsageError: () => unknown,
): Response {
  const originalBody = response.body;
  if (!originalBody) return response;

  let consumed = false;
  const onConsumed = () => {
    if (consumed) return;
    consumed = true;
    const error = consumeInvalidDynamicUsageError();
    if (!error) return;
    // Dedup: React already emitted this error as a Flight error chunk.
    if (!hasDigest(error)) {
      console.error("[vinext] Invalid dynamic usage:", error);
    }
  };

  const cleanup = new TransformStream<Uint8Array, Uint8Array>({
    flush() {
      onConsumed();
    },
  });

  const piped = originalBody.pipeThrough(cleanup);
  const reader = piped.getReader();
  const wrappedStream = new ReadableStream<Uint8Array>({
    pull(controller) {
      return reader.read().then(
        ({ done, value }) => {
          if (done) {
            controller.close();
          } else {
            controller.enqueue(value);
          }
        },
        (streamError) => {
          onConsumed();
          controller.error(streamError);
        },
      );
    },
    cancel(reason) {
      onConsumed();
      return reader.cancel(reason);
    },
  });

  return new Response(wrappedStream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export async function renderAppPageLifecycle(
  options: RenderAppPageLifecycleOptions,
): Promise<Response> {
  if (options.isRscRequest) {
    const prepared = await prepareAppPageElement(options);
    return prepared instanceof Response
      ? applyIneligibleRouteCachePolicy(prepared, options)
      : renderAppPageLifecycleImpl(prepared);
  }

  const operation = options.traceOperation ?? (options.isPrerender ? "prerender" : "render");
  let resolveResponse!: (response: Response) => void;
  let rejectResponse!: (error: unknown) => void;
  let renderCompletion = Promise.resolve();
  const responsePromise = new Promise<Response>((resolve, reject) => {
    resolveResponse = resolve;
    rejectResponse = reject;
  });
  const tracedRender = traceAppPageRender(options.routePattern, operation, async (renderSpan) => {
    try {
      const prepared = await prepareAppPageElement(options);
      if (prepared instanceof Response) {
        const traced = traceResponseStartWithCompletion(
          applyIneligibleRouteCachePolicy(prepared, options),
        );
        resolveResponse(traced.response);
        await traced.started;
        return;
      }
      const traced = traceResponseStartWithCompletion(
        await renderAppPageLifecycleImpl(
          {
            ...prepared,
            onRenderComplete(completion) {
              renderCompletion = completion;
              void completion.catch(() => {});
              options.onRenderComplete?.(completion);
            },
          },
          renderSpan,
        ),
      );
      resolveResponse(traced.response);
      await Promise.all([renderCompletion, traced.started]);
    } catch (error) {
      rejectResponse(error);
      throw error;
    }
  });
  void tracedRender.catch(() => {});
  return responsePromise;
}

async function prepareAppPageElement(
  options: RenderAppPageLifecycleOptions,
): Promise<Response | ResolvedRenderAppPageLifecycleOptions> {
  if (!options.prepareElement) return options;
  const prepared = await options.prepareElement();
  return prepared.response ?? { ...options, element: prepared.element };
}

async function renderAppPageLifecycleImpl(
  options: ResolvedRenderAppPageLifecycleOptions,
  renderSpan?: FrameworkSpan,
): Promise<Response> {
  // Request dynamic state is consumptive, but both cache finalization and the
  // streamed client completion marker need the final answer. Keep the first
  // positive observation for this render so whichever branch drains first
  // cannot hide it from the other. A negative answer is never kept: the
  // client's branch can end before the render does, as when the client
  // disconnects, and the capture's render may still turn dynamic after that.
  let dynamicUsageObserved = false;
  const isCacheCandidateHtmlRender =
    options.isCacheCandidate === true && options.isPrerender !== true && !options.isRscRequest;
  // HTML renders that decide whether the page is static also read the
  // request's dynamic latch: a candidate's store decision, the Worker's probe
  // and admission, and the build prerender. The latch sees usage in child
  // scopes that never reach this render's flag, such as SSR, where a client
  // page reads its searchParams. A candidate's SSR useSearchParams()
  // gate also opens with the real query once the render latches dynamic.
  // PPR fallback shells discard their warmup render's usage and keep their
  // client page query untracked, so they don't read it.
  const readsRenderDynamicLatch =
    isCacheCandidateHtmlRender ||
    (!options.isRscRequest &&
      options.pprFallbackShellSignal === undefined &&
      (options.isPrerender === true || isRouteCacheabilityEvaluation()));
  // Some readers, such as the streamed completion marker, run in the response
  // stream's pull context rather than this render's request scope.
  const readDynamicUsage = bindRequestContext(
    (): boolean =>
      options.consumeDynamicUsage() || (readsRenderDynamicLatch && isRenderDynamicLatched()),
  );
  // Deferred finalization can also consume the render's observations from
  // outside its request scope, such as a disconnecting client's cancel.
  const consumeRenderObservationState =
    options.consumeRenderObservationState &&
    bindRequestContext(options.consumeRenderObservationState);
  const peekRenderDynamicUsage = (): boolean =>
    (options.peekDynamicUsage?.() ?? peekDynamicUsage()) ||
    (readsRenderDynamicLatch && isRenderDynamicLatched());
  const consumeRenderDynamicUsage = (): boolean => {
    if (!dynamicUsageObserved) dynamicUsageObserved = readDynamicUsage();
    return dynamicUsageObserved;
  };
  const artifactCompatibility = createAppPageArtifactCompatibility(
    options.element,
    options.routePattern,
  );
  const rootBoundaryId = artifactCompatibility?.rootBoundaryId ?? null;
  const renderEpoch = artifactCompatibility?.renderEpoch ?? null;
  const rscOutputScope = createAppPageRscOutputScope({
    element: options.element,
    mountedSlotsHeader: options.mountedSlotsHeader,
    renderEpoch,
    rootBoundaryId,
    routePattern: options.routePattern,
  });
  const htmlOutputScope = createAppPageHtmlOutputScope({
    element: options.element,
    renderEpoch,
    rootBoundaryId,
    routePattern: options.routePattern,
  });
  // A payload that leaves out the layouts its client holds is that client's
  // alone, so it's never stored or sent with shared cache headers.
  const isPartialPayload =
    options.isRscRequest &&
    isAppElementsRecord(options.element) &&
    Object.hasOwn(options.element, AppElementsWire.keys.skippedLayoutIds);
  const shouldBypassRscCache = options.bypassInterceptionContextCache === true || isPartialPayload;
  const dynamicStaleTimeSeconds =
    options.dynamicStaleTimeSeconds ?? resolveConfiguredDynamicStaleTimeSeconds();
  const outgoingElement = AppElementsWire.encodeOutgoingPayload({
    element: options.element,
    ...(dynamicStaleTimeSeconds !== undefined &&
    options.isPrerender !== true &&
    !options.isForceStatic
      ? { dynamicStaleTimeSeconds }
      : {}),
    ...(artifactCompatibility ? { artifactCompatibility } : {}),
  });

  const compileEnd = options.isProduction ? undefined : performance.now();
  const errorContextOverrides: AppRenderErrorContextOverrides = {
    ...(options.isProgressiveActionRender
      ? { renderSource: "react-server-components-payload", routeType: "action" }
      : {}),
    ...(options.isPrerender ? { revalidateReason: "stale" } : {}),
  };
  const baseOnError = options.createRscOnErrorHandler(
    options.cleanPathname,
    options.routePattern,
    errorContextOverrides,
  );
  // A client navigation's response waits for the layouts above the first
  // loading boundary, as their redirect() answers it through a header.
  const layoutGate =
    options.isRscRequest &&
    options.isPrerender !== true &&
    options.pprFallbackShellSignal === undefined
      ? getAppPageLayoutGate(options.element)
      : null;
  const rscErrorTracker = createAppPageRscErrorTracker((error, requestInfo, errorContext) => {
    if (renderSpan) recordAppPageRenderError(renderSpan, error);
    return baseOnError(error, requestInfo, errorContext);
  });
  // Defensive wrap for standalone callers. In the normal dispatch path this is
  // a no-op since dispatchAppPage already activated dedupe. Note that
  // renderToReadableStream returns synchronously — the actual fetch calls
  // happen later during async stream consumption — so the dedupe map a
  // standalone call would establish here is only effective if the caller has
  // an outer runWithRequestContext / runWithFetchDedupe scope keeping the ALS
  // store alive across that consumption.
  let rscStream = await runWithFetchDedupe(async () => {
    if (options.pprFallbackShellSignal && options.prerenderToReadableStream) {
      const reactSignal = options.pprFallbackShellReactSignal ?? options.pprFallbackShellSignal;
      const pendingResult = options.prerenderToReadableStream(outgoingElement, {
        onError: rscErrorTracker.onRenderError,
        signal: reactSignal,
      });
      if (options.abortPprFallbackShell) {
        setTimeout(options.abortPprFallbackShell, 0);
      }
      return (await pendingResult).prelude;
    }

    return options.renderToReadableStream(outgoingElement, {
      onError: rscErrorTracker.onRenderError,
    });
  });

  let pprFallbackShellRsc: Uint8Array | null = null;
  if (options.pprFallbackShellSignal) {
    pprFallbackShellRsc = new Uint8Array(await readAppPageBinaryStream(rscStream));
  }

  if (layoutGate) {
    // A branch read only while waiting tells the gate when the render ends,
    // completed or failed, before every held layout renders.
    const [heldStream, watchedStream] = rscStream.tee();
    rscStream = heldStream;
    const watchedReader = watchedStream.getReader();
    const renderEnded = (async () => {
      while (!(await watchedReader.read()).done);
    })();
    const layoutFailure = await layoutGate.wait(
      (layoutId) =>
        isAppElementsRecord(outgoingElement) && Object.hasOwn(outgoingElement, layoutId),
      renderEnded,
    );
    void watchedReader.cancel().catch(() => {});
    const layoutSpecialError = layoutFailure
      ? resolveAppPageSpecialError(layoutFailure.error)
      : null;
    if (layoutFailure && layoutSpecialError) {
      // This response replaces the render, which classifies it.
      void rscStream.cancel().catch(() => {});
      const response = await options.renderPageSpecialError(
        layoutSpecialError.kind === "http-access-fallback"
          ? { ...layoutSpecialError, layoutIndex: layoutFailure.layoutIndex }
          : layoutSpecialError,
      );
      return applyIneligibleRouteCachePolicy(
        response,
        options,
        options.peekRequestCacheLife?.() ?? options.getRequestCacheLife(),
      );
    }
  }

  let revalidateSeconds = options.revalidateSeconds;
  let expireSeconds = options.expireSeconds;
  const shouldWaitForAllReady =
    (options.isPrerender === true && options.isSpeculativePrerender !== true) ||
    options.renderWholeDocument === true;
  const shouldReadRequestCacheLifeForPrerender = options.isPrerender === true;
  // A cache candidate's cacheLife can still lower its lifetime after headers,
  // including under the default `revalidate = false`.
  const mayResolveCacheLifeAfterHeaders =
    options.isProgressiveActionRender !== true &&
    (revalidateSeconds === null || revalidateSeconds > 0) &&
    !options.isDraftMode &&
    !options.isForceDynamic &&
    !shouldBypassRscCache;
  // Only cache candidates capture the RSC payload. A dynamic route's payload is
  // never stored, even when a cacheLife resolves during its render.
  const shouldCaptureRscForCacheMetadata =
    (options.isProduction || options.isPrerender === true) &&
    mayResolveCacheLifeAfterHeaders &&
    options.isStaticEligible;
  const createBufferedRscStream = (close: boolean): ReadableStream<Uint8Array> =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        if (pprFallbackShellRsc) {
          controller.enqueue(pprFallbackShellRsc);
        }
        if (close) {
          controller.close();
        }
      },
    });
  const rscCapture = pprFallbackShellRsc
    ? {
        ssrStream: createBufferedRscStream(false),
        ...(shouldCaptureRscForCacheMetadata ? { sideStream: createBufferedRscStream(true) } : {}),
      }
    : teeAppPageRscStreamForCapture(rscStream, shouldCaptureRscForCacheMetadata);
  const rscForResponse = rscCapture.ssrStream;

  // When the fused tee (#981) is active, the sideStream carries both the embed
  // transform AND the raw RSC byte accumulation. For RSC requests, we consume
  // the sideStream directly. For HTML requests, handleSsr creates an embed
  // transform from it and fills capturedRscDataRef. The ref object is threaded
  // through so .value is read lazily after handleSsr completes.
  const capturedRscDataRef: { value: Promise<ArrayBuffer> | null } = { value: null };
  if (rscCapture.sideStream && options.isRscRequest) {
    capturedRscDataRef.value = readAppPageBinaryStream(rscCapture.sideStream);
  }

  // The navigation cache metadata of a document's done script. It runs after
  // the RSC embed drains, so its peeks observe the completed render's minimum.
  // Peek, not consume — the cache-write closure owns the consuming read.
  const resolveInitialNavigationCacheMetadata = (
    dynamicUsed: boolean,
    requestCacheLife: AppPageRequestCacheLife | null | undefined,
  ): InitialNavigationCacheMetadata => {
    let kind: "dynamic" | "static";
    if (options.isForceStatic) {
      kind = "static";
    } else if (options.isForceDynamic || dynamicUsed) {
      kind = "dynamic";
    } else {
      const observation = options.peekRenderObservationState?.();
      kind =
        observation && (observation.dynamicFetches.length > 0 || observation.requestApis.length > 0)
          ? "dynamic"
          : "static";
    }
    const staleTimeSeconds = resolveClientStaleTimeSeconds(requestCacheLife);
    return {
      kind,
      // Unlike the RSC header, the done script never emits the pending
      // marker, so there is no 30s floor to fall back on: a render that
      // turned dynamic must carry the config bound even when the
      // speculative capture was still armed, or the cacheLife claim
      // becomes the only bound on reusing dynamic output.
      ...(kind === "dynamic" &&
      dynamicStaleTimeSeconds !== undefined &&
      options.isPrerender !== true
        ? { dynamicStaleTimeSeconds }
        : {}),
      ...(staleTimeSeconds === undefined ? {} : { staleTimeSeconds: Math.floor(staleTimeSeconds) }),
    };
  };

  if (options.isRscRequest) {
    // A stored RSC render takes the status of its document's shell, as in
    // Next.js, which renders HTML beside RSC for a cache entry.
    const capturedRscData = capturedRscDataRef.value;
    const resolvesRscRenderStatus =
      options.isProduction &&
      shouldCaptureRscForCacheMetadata &&
      capturedRscData !== null &&
      options.isPrerender !== true &&
      options.isRoutePPREnabled !== true;
    // Next.js keeps a page's document and RSC payload in one entry, so an RSC
    // miss for a page's own payload renders the page's document from it, as an
    // HTML request whose render may be stored renders it. A variant's payload
    // (a prefetch shell, an interception) isn't the one an HTML request
    // stores, and a document with a nonce is never stored.
    const isPageDocumentRender =
      options.isCacheCandidate === true &&
      !options.scriptNonce &&
      !options.mountedSlotsHeader &&
      !options.interceptionContext &&
      !options.interceptionId &&
      (options.renderMode === undefined || options.renderMode === APP_RSC_RENDER_MODE_NAVIGATION);
    // An edge adapter keeps no origin page entries, so only one that stores
    // the document beside the completed response gets it.
    const cdnCacheAdapter = getCdnCacheAdapter();
    const captureAdmittedDocument =
      resolvesRscRenderStatus && isPageDocumentRender && !cdnCacheAdapter.ownsBackgroundRevalidation
        ? cdnCacheAdapter.captureAppPageDocument?.()
        : undefined;
    const rendersDocument =
      isPageDocumentRender &&
      (cdnCacheAdapter.ownsBackgroundRevalidation || captureAdmittedDocument !== undefined);
    const resolveRscRenderStatus = resolvesRscRenderStatus
      ? createAppPageRscRenderStatusResolver({
          basePath: options.basePath,
          capturedRscData,
          ...(rendersDocument
            ? {
                document: {
                  clientTraceMetadata: options.clientTraceMetadata,
                  // Admission waits for the document, so it gives it up at its
                  // own deadline.
                  ...(captureAdmittedDocument
                    ? { deadlineAt: getRouteCacheabilityCaptureOptions()?.captureDeadlineAt }
                    : {}),
                  getFontData: () =>
                    createAppPageFontData({
                      getLinks: options.getFontLinks,
                      getPreloads: options.getFontPreloads,
                      getStyles: options.getFontStyles,
                    }),
                  getInitialNavigationCacheMetadata: () =>
                    resolveInitialNavigationCacheMetadata(
                      peekDynamicUsage(),
                      options.peekRequestCacheLife?.(),
                    ),
                  mirrorNextFlight: () => rscErrorTracker.getCapturedSpecialError() !== null,
                  onSsrError: createAppPageSsrErrorHandler(
                    options.createRscOnErrorHandler(options.cleanPathname, options.routePattern, {
                      ...errorContextOverrides,
                      renderSource: "server-rendering",
                    }),
                    rscErrorTracker.isCapturedError,
                  ),
                  reactMaxHeadersLength: options.reactMaxHeadersLength,
                },
              }
            : {}),
          getCapturedSpecialError: rscErrorTracker.getCapturedSpecialError,
          getCapturedSpecialErrors: rscErrorTracker.getCapturedSpecialErrors,
          isForceStatic: options.isForceStatic,
          loadSsrHandler: options.loadSsrHandler,
          navigationContext: options.getNavigationContext(),
          rootParams: options.rootParams,
          routePattern: options.routePattern,
        })
      : undefined;
    let requestCacheLifeForPrerender: AppPageRequestCacheLife | null = null;
    if (shouldWaitForAllReady) {
      await settleCapturedRscRenderForCacheMetadata(capturedRscDataRef.value);
    }
    if (shouldReadRequestCacheLifeForPrerender) {
      requestCacheLifeForPrerender = readRequestCacheLifeForPrerender(options);
      ({ expireSeconds, revalidateSeconds } = applyRequestCacheLife({
        expireSeconds,
        requestCacheLife: requestCacheLifeForPrerender,
        revalidateSeconds,
      }));
    }

    const dynamicUsedDuringBuild = consumeRenderDynamicUsage();
    // An unverified interception context or a partial payload omits
    // cacheState, as the response is not a shared-cache MISS/HIT artifact. The
    // absence also keeps finalizeAppPageRscCacheResponse from overwriting
    // no-store. A partial payload only comes from a render that's never
    // stored, so it keeps that render's uncacheable header.
    const rscResponsePolicy = isPartialPayload
      ? { cacheControl: resolveUncacheableCacheControl(options.isProduction) }
      : shouldBypassRscCache
        ? { cacheControl: NO_STORE_CACHE_CONTROL }
        : resolveAppPageRscResponsePolicy({
            dynamicUsedDuringBuild,
            isDraftMode: options.isDraftMode,
            isDynamicError: options.isDynamicError,
            isForceDynamic: options.isForceDynamic,
            isForceStatic: options.isForceStatic,
            isProduction: options.isProduction,
            isStaticEligible: options.isStaticEligible,
            expireSeconds,
            revalidateSeconds,
          });
    if (shouldBypassRscCache) {
      options.isrDebug?.(
        isPartialPayload
          ? "RSC cache write skipped (partial payload)"
          : "RSC cache write skipped (unverified interception context)",
        options.cleanPathname,
      );
    }
    const shouldEmitDynamicStaleTime =
      dynamicStaleTimeSeconds !== undefined &&
      options.isPrerender !== true &&
      !options.isForceStatic &&
      (dynamicUsedDuringBuild || options.isForceDynamic);
    // The response streams before the captured render resolves its cacheLife
    // (#961) — mark the claim pending so the client bounds reuse. This is also
    // the conservative dev transport: dev does not persist ISR artifacts, but
    // nested `use cache` scopes still resolve only while the stream is read.
    // Known-dynamic renders carry the config bound instead, keeping the two
    // wire states mutually exclusive.
    const staleTimePending =
      options.isPrerender !== true && mayResolveCacheLifeAfterHeaders && !dynamicUsedDuringBuild;
    const rscResponse = buildAppPageRscResponse(rscForResponse, {
      cacheTags: options.isPrerender === true ? options.getPageTags() : undefined,
      staleTimePending,
      // Only on renders already known to be dynamic. A render that becomes
      // dynamic while streaming keeps the pending marker; its completed body
      // metadata carries this config bound so cache publication can tighten
      // the conservative pending expiry after decoding.
      dynamicStaleTimeSeconds: shouldEmitDynamicStaleTime ? dynamicStaleTimeSeconds : undefined,
      isEdgeRuntime: options.isEdgeRuntime,
      middlewareContext: options.middlewareContext,
      mountedSlotsHeader: options.mountedSlotsHeader,
      params: options.navigationParams,
      policy: rscResponsePolicy,
      renderedPathAndSearch: options.renderedPathAndSearch,
      requestCacheLife: requestCacheLifeForPrerender,
      timing: buildResponseTiming({
        compileEnd,
        handlerStart: options.handlerStart,
        isProduction: options.isProduction,
        responseKind: "rsc",
      }),
    });

    // In dev mode, wrap the RSC response body to forward invalid dynamic usage
    // errors after the stream is consumed. This mirrors Next.js behavior where
    // workStore.invalidDynamicUsageError is checked after the accumulated chunks
    // promise resolves (app-render.tsx generateDynamicFlightRenderResultWithStagesInDev).
    // Ported from Next.js: https://github.com/vercel/next.js/commit/f5e54c06726b571a042fce67417e40a29f6b8689
    //
    // Note: This only covers RSC responses (client-side navigations). The HTML path
    // (initial page loads) intentionally defers this coverage — the error is still
    // thrown through the RSC pipeline and captured by rscErrorTracker.onRenderError
    // if uncaught by user code. Full parity with Next.js would require checking
    // invalidDynamicUsageError after SSR rendering, which is deferred as out of scope
    // for this PR focused on client-side navigations.
    const completionHeaders = new Headers(rscResponse.headers);
    completionHeaders.set(VINEXT_RSC_COMPLETION_METADATA_HEADER, "1");
    const completionResponse =
      dynamicStaleTimeSeconds !== undefined &&
      options.isPrerender !== true &&
      !options.isForceStatic &&
      rscResponse.body
        ? new Response(
            appendRscCompletionMetadata(rscResponse.body, () => {
              if (!consumeRenderDynamicUsage()) return undefined;
              const completedServerStaleTimeSeconds = resolveClientStaleTimeSeconds(
                options.peekRequestCacheLife?.(),
              );
              // A known-dynamic response already carries its BFCache bound in
              // the header. Add a footer only when it has a distinct completed
              // cacheLife claim for runtime-prefetch expiry.
              if (shouldEmitDynamicStaleTime && completedServerStaleTimeSeconds === undefined) {
                return undefined;
              }
              return {
                dynamicStaleTimeSeconds,
                serverStaleTimeSeconds:
                  completedServerStaleTimeSeconds === undefined
                    ? null
                    : Math.floor(completedServerStaleTimeSeconds),
              };
            }),
            {
              status: rscResponse.status,
              statusText: rscResponse.statusText,
              headers: completionHeaders,
            },
          )
        : rscResponse;

    const devRscResponse =
      !options.isProduction && completionResponse.body && options.consumeInvalidDynamicUsageError
        ? wrapRscResponseForDevErrorReporting(
            completionResponse,
            options.consumeInvalidDynamicUsageError,
          )
        : completionResponse;

    return finalizeAppPageRscCacheResponse(devRscResponse, {
      capturedRscDataPromise:
        options.isProduction && shouldCaptureRscForCacheMetadata ? capturedRscDataRef.value : null,
      bypassInterceptionContextCache: options.bypassInterceptionContextCache,
      captureAdmittedDocument,
      cleanPathname: options.cleanPathname,
      consumeDynamicUsage: consumeRenderDynamicUsage,
      consumeRenderObservationState,
      createHtmlRenderObservation(input) {
        return createAppPageRenderObservation({
          boundaryOutcome: { kind: "success" },
          cacheability: "public",
          cacheTags: input.cacheTags,
          cleanPathname: options.cleanPathname,
          completeness: "complete",
          output: htmlOutputScope,
          params: options.navigationParams,
          state: input.state,
        });
      },
      createRscRenderObservation(input) {
        return createAppPageRenderObservation({
          boundaryOutcome: { kind: "success" },
          cacheability: "public",
          cacheTags: input.cacheTags,
          cleanPathname: options.cleanPathname,
          completeness: "complete",
          output: rscOutputScope,
          params: options.navigationParams,
          state: input.state,
        });
      },
      dynamicUsedDuringBuild,
      getPageTags() {
        return options.getPageTags();
      },
      getRequestCacheLife() {
        return readRequestCacheLifeForCachePolicy(options);
      },
      isrDebug: options.isrDebug,
      isrHtmlKey: options.isrHtmlKey,
      isrRscKey: options.isrRscKey,
      isrSet: options.isrSet,
      interceptionContext: options.interceptionContext,
      interceptionId: options.interceptionId,
      mountedSlotsHeader: options.mountedSlotsHeader,
      omitPendingDynamicCacheState: options.omitPendingDynamicCacheState,
      renderMode: options.renderMode,
      resolveRscRenderStatus,
      preserveClientResponseHeaders: rscResponsePolicy.cacheState !== "MISS",
      expireSeconds,
      isStaticEligible: options.isStaticEligible,
      revalidateSeconds: resolveAppPageCacheWriteRevalidateSeconds({
        isDynamicError: options.isDynamicError,
        isForceStatic: options.isForceStatic,
        isStaticEligible: options.isStaticEligible,
        revalidateSeconds,
      }),
      waitUntil(promise) {
        options.waitUntil?.(promise);
      },
    });
  }

  const fontData = createAppPageFontData({
    getLinks: options.getFontLinks,
    getPreloads: options.getFontPreloads,
    getStyles: options.getFontStyles,
  });
  const fontLinkHeader = buildAppPageFontLinkHeader(fontData.preloads);
  const clientTraceMetadataMarker =
    options.isProduction &&
    options.isPrerender !== true &&
    options.clientTraceMetadata &&
    options.clientTraceMetadata.length > 0
      ? crypto.randomUUID()
      : undefined;
  if (clientTraceMetadataMarker) {
    recordRouteCacheabilityClientTraceMetadataMarker(clientTraceMetadataMarker);
  }
  let requestCacheLifeForPrerender: AppPageRequestCacheLife | null = null;
  let dynamicUsedDuringHtmlRender = false;
  let renderEnd: number | undefined;
  let shellSpecialError: AppPageSpecialError | null = null;

  const resolveHtmlCacheWrite = (dynamicUsedDuringRender: boolean) => {
    const htmlResponsePolicy = resolveAppPageHtmlResponsePolicy({
      dynamicUsedDuringRender,
      isProgressiveActionRender: options.isProgressiveActionRender === true,
      hasScriptNonce: Boolean(options.scriptNonce),
      isDraftMode: options.isDraftMode,
      isDynamicError: options.isDynamicError,
      isForceDynamic: options.isForceDynamic,
      isForceStatic: options.isForceStatic,
      isProduction: options.isProduction,
      isStaticEligible: options.isStaticEligible,
      expireSeconds,
      revalidateSeconds,
    });
    const shouldSpeculativelyWriteCache =
      options.isProduction &&
      shouldCaptureRscForCacheMetadata &&
      !options.isEdgeRuntime &&
      revalidateSeconds === null &&
      !options.isDynamicError &&
      !options.isForceStatic &&
      !options.scriptNonce &&
      options.isProgressiveActionRender !== true &&
      !dynamicUsedDuringRender;
    return {
      htmlResponsePolicy,
      shouldWriteHtmlCache: htmlResponsePolicy.shouldWriteToCache || shouldSpeculativelyWriteCache,
    };
  };

  const finalizeHtmlCacheWrite = (
    response: Response,
    write: {
      capturedDynamicUsageBeforeContextCleanup: () => boolean;
      headers?: Record<string, string>;
      htmlResponsePolicy: ReturnType<typeof resolveAppPageHtmlResponsePolicy>;
      linkHeader: string | null;
      status?: number;
    },
  ): Response =>
    finalizeAppPageHtmlCacheResponse(response, {
      bypassInterceptionContextCache: options.bypassInterceptionContextCache,
      capturedDynamicUsageBeforeContextCleanup: write.capturedDynamicUsageBeforeContextCleanup,
      capturedRscDataPromise: capturedRscDataRef.value,
      cleanPathname: options.cleanPathname,
      clientTraceMetadataMarker,
      consumeDynamicUsage: consumeRenderDynamicUsage,
      consumeRenderObservationState,
      createHtmlRenderObservation(input) {
        return createAppPageRenderObservation({
          boundaryOutcome: { kind: "success" },
          cacheability: "public",
          cacheTags: input.cacheTags,
          cleanPathname: options.cleanPathname,
          completeness: "complete",
          output: htmlOutputScope,
          params: options.navigationParams,
          state: input.state,
        });
      },
      createRscRenderObservation(input) {
        return createAppPageRenderObservation({
          boundaryOutcome: { kind: "success" },
          cacheability: "public",
          cacheTags: input.cacheTags,
          cleanPathname: options.cleanPathname,
          completeness: "complete",
          output: rscOutputScope,
          params: options.navigationParams,
          state: input.state,
        });
      },
      getPageTags() {
        return options.getPageTags();
      },
      getRequestCacheLife() {
        return readRequestCacheLifeForCachePolicy(options);
      },
      headers: write.headers,
      isrDebug: options.isrDebug,
      isrHtmlKey: options.isrHtmlKey,
      isrRscKey: options.isrRscKey,
      isrSet: options.isrSet,
      interceptionContext: options.interceptionContext,
      interceptionId: options.interceptionId,
      omitPendingDynamicCacheState: options.omitPendingDynamicCacheState,
      preserveClientResponseHeaders: !write.htmlResponsePolicy.shouldWriteToCache,
      expireSeconds,
      isStaticEligible: options.isStaticEligible,
      revalidateSeconds: resolveAppPageCacheWriteRevalidateSeconds({
        isDynamicError: options.isDynamicError,
        isForceStatic: options.isForceStatic,
        isStaticEligible: options.isStaticEligible,
        revalidateSeconds,
      }),
      linkHeader: write.linkHeader,
      status: write.status,
      waitUntil(cachePromise) {
        options.waitUntil?.(cachePromise);
      },
    });

  // Whether a special error that escaped the shell may be stored, before its
  // response renders.
  const mayStoreShellSpecialError = (): boolean =>
    options.isProduction &&
    shouldCaptureRscForCacheMetadata &&
    options.isPrerender !== true &&
    capturedRscDataRef.value !== null &&
    resolveEarlyResponseCacheControl(options) === null;

  // Whether a prerender writes a special error that escaped the shell, as
  // Next.js's build does. A speculative or fallback-shell prerender doesn't.
  const mayPrerenderShellSpecialError = (): boolean =>
    options.isPrerender === true &&
    options.isSpeculativePrerender !== true &&
    options.pprFallbackShellSignal === undefined &&
    shouldCaptureRscForCacheMetadata &&
    capturedRscDataRef.value !== null &&
    resolveEarlyResponseCacheControl(options) === null;
  type PrerenderCacheMetadata = {
    cacheTags: string[];
    requestCacheLife: AppPageRequestCacheLife | null;
  };
  const readPrerenderCacheMetadata = (): PrerenderCacheMetadata => ({
    cacheTags: options.getPageTags(),
    requestCacheLife: readRequestCacheLifeForPrerender(options),
  });
  // A redirect's metadata is read while the request context is alive, since
  // its response clears it. A boundary's is read once it has rendered.
  let prerenderedSpecialError: {
    dynamicUsed: boolean;
    redirectMetadata: PrerenderCacheMetadata | null;
  } | null = null;

  // The special-error response replaces the page's document. prerender.ts
  // writes it with its status and `location` when the header marks it, and
  // the page's RSC payload from an RSC request.
  const finalizePrerenderedShellSpecialErrorResponse = async (
    response: Response,
    specialError: AppPageSpecialError,
    prerendered: NonNullable<typeof prerenderedSpecialError>,
  ): Promise<Response> => {
    if (response.status !== specialError.statusCode) {
      return applyIneligibleRouteCachePolicy(response, options);
    }
    // The boundary renders as its document streams, so its tagged fetches,
    // cacheLife() and dynamic API use are known once the document is read.
    const body = await response.arrayBuffer();
    const { cacheTags, requestCacheLife } =
      prerendered.redirectMetadata ?? readPrerenderCacheMetadata();
    ({ expireSeconds, revalidateSeconds } = applyRequestCacheLife({
      expireSeconds,
      requestCacheLife,
      revalidateSeconds,
    }));
    const { htmlResponsePolicy } = resolveHtmlCacheWrite(
      prerendered.dynamicUsed || consumeRenderDynamicUsage(),
    );
    const headers = new Headers(response.headers);
    // Middleware's merged policy wins, as on a normal response.
    if (htmlResponsePolicy.cacheControl && !headers.has("cache-control")) {
      headers.set("Cache-Control", htmlResponsePolicy.cacheControl);
    }
    applyPrerenderCacheLifeHeader(headers, requestCacheLife);
    applyPrerenderCacheTagsHeader(headers, cacheTags);
    // Recorded outside the response, which middleware can also produce, with
    // the redirect's own location. The prerender server marks the response.
    getRequestExecutionContext()?.recordPrerenderSpecialError?.({
      headers: resolveAppPageSpecialErrorStoredHeaders(specialError, options.basePath) ?? {},
      status: response.status,
    });
    const prerenderResponse = new Response(body, {
      headers,
      status: response.status,
      statusText: response.statusText,
    });
    copyLinkHeaderProvenance(response.headers, prerenderResponse.headers);
    return prerenderResponse;
  };

  // The special-error response replaces the page's document, and is stored as
  // a normal render would be, with its status and redirect `location`. The
  // RSC entry is the page's own payload, captured from the same render.
  const finalizeShellSpecialErrorResponse = (
    response: Response,
    specialError: AppPageSpecialError,
  ): Response => {
    // A response the boundary replaced, such as a 500 from a failing
    // not-found boundary, is not the special error's document. As in Next.js,
    // generateMetadata()'s special error, which rejects the shell only for a
    // request that blocks on metadata, is stored like the page's.
    if (response.status !== specialError.statusCode) {
      return applyIneligibleRouteCachePolicy(response, options);
    }
    const dynamicUsedDuringRender = consumeRenderDynamicUsage();
    const { htmlResponsePolicy, shouldWriteHtmlCache } =
      resolveHtmlCacheWrite(dynamicUsedDuringRender);

    const headers = new Headers(response.headers);
    // Middleware's merged policy wins, as on a normal response.
    if (htmlResponsePolicy.cacheControl && !headers.has("cache-control")) {
      headers.set("Cache-Control", htmlResponsePolicy.cacheControl);
    }
    if (htmlResponsePolicy.cacheState) {
      setCacheStateHeaders(headers, htmlResponsePolicy.cacheState);
    }
    const policyResponse = new Response(response.body, {
      headers,
      status: response.status,
      statusText: response.statusText,
    });
    copyLinkHeaderProvenance(response.headers, policyResponse.headers);
    if (!shouldWriteHtmlCache) return policyResponse;

    const clientResponse = finalizeHtmlCacheWrite(policyResponse, {
      capturedDynamicUsageBeforeContextCleanup: () => dynamicUsedDuringRender,
      // The response's headers carry this request's middleware headers, which
      // replay merges again, so only the page's own are stored.
      headers: resolveAppPageSpecialErrorStoredHeaders(specialError, options.basePath),
      htmlResponsePolicy,
      linkHeader: getFrameworkLinkHeader(response.headers),
      status: response.status,
    });
    copyLinkHeaderProvenance(response.headers, clientResponse.headers);
    return clientResponse;
  };

  const htmlRender = await renderAppPageHtmlStreamWithRecovery({
    onShellRendered() {
      if (!options.isProduction) {
        renderEnd = performance.now();
      }
    },
    renderErrorBoundaryResponse(error) {
      if (isCacheCandidateHtmlRender && isBailoutToCSRError(error)) {
        // A gated useSearchParams() outside Suspense. Next.js rethrows the
        // bail-out instead of rendering an error boundary, so the request
        // fails with a 500 and nothing is stored.
        console.error(
          `${error.reason} should be wrapped in a suspense boundary at page "${options.routePattern}". Read more: https://nextjs.org/docs/messages/missing-suspense-with-csr-bailout`,
        );
        options.clearRequestContext();
        const headers = new Headers();
        mergeMiddlewareResponseHeaders(headers, options.middlewareContext.headers);
        headers.set("Cache-Control", NEVER_CACHE_CONTROL);
        applyEdgeRuntimeHeader(headers, options.isEdgeRuntime);
        const response = internalServerErrorResponse(undefined, { headers });
        applyCdnResponseHeaders(response.headers, { cacheControl: NEVER_CACHE_CONTROL });
        return Promise.resolve(response);
      }
      const capturedRscError = rscErrorTracker.getCapturedError();
      return options.renderErrorBoundaryResponse(
        capturedRscError ?? error,
        capturedRscError === null ? "ssr" : "rsc",
      );
    },
    async renderHtmlStream() {
      const ssrHandler = await options.loadSsrHandler();
      const baseOnSsrError = options.createRscOnErrorHandler(
        options.cleanPathname,
        options.routePattern,
        {
          ...errorContextOverrides,
          renderSource: "server-rendering",
        },
      );
      const onSsrError: AppPageBoundaryOnError = (error, requestInfo, errorContext) => {
        if (renderSpan) recordAppPageRenderError(renderSpan, error);
        return baseOnSsrError(error, requestInfo, errorContext);
      };
      return renderAppPageHtmlStream({
        capturedRscDataRef,
        getInitialNavigationCacheMetadata: () =>
          resolveInitialNavigationCacheMetadata(
            dynamicUsedDuringHtmlRender || peekDynamicUsage(),
            // During prerendering the done-script callback can run immediately
            // after the RSC capture drains, before the outer lifecycle performs
            // its consuming cacheLife read. Use the live non-destructive peek in
            // that window, then reuse the captured value after the outer read;
            // peeking only after consumption would omit the client stale claim
            // even though the seeded cache entry retains it.
            // Runtime renders have not consumed the state yet and still use the
            // non-destructive peek so the cache-write closure remains its owner.
            options.isPrerender === true
              ? (requestCacheLifeForPrerender ?? options.peekRequestCacheLife?.())
              : options.peekRequestCacheLife?.(),
          ),
        fontData,
        hasCustomGlobalError: options.hasCustomGlobalError,
        navigationContext: options.getNavigationContext(),
        basePath: options.basePath,
        clientTraceMetadata: options.clientTraceMetadata,
        clientTraceMetadataMarker,
        reactMaxHeadersLength: options.reactMaxHeadersLength,
        rootParams: options.rootParams,
        pprFallbackShellSignal: options.pprFallbackShellSignal,
        preloadRoutePattern: options.routePattern,
        formState: options.formState ?? null,
        rscStream: rscForResponse,
        scriptNonce: options.scriptNonce,
        sideStream: rscCapture.sideStream,
        ssrHandler,
        fallbackToErrorDocumentOnShellError:
          options.isPrerender === true && options.isSpeculativePrerender === true
            ? false
            : undefined,
        waitForAllReady: shouldWaitForAllReady,
        isStaticGeneration: options.isPrerender === true,
        isForceStatic: options.isForceStatic,
        isCacheCandidate: isCacheCandidateHtmlRender,
        onSsrError: createAppPageSsrErrorHandler(onSsrError, rscErrorTracker.isCapturedError),
        // A document that streams a special error a boundary caught carries
        // Next.js's `self.__next_f` Flight transport, as the boundary's own
        // document does.
        mirrorNextFlight: () => rscErrorTracker.getCapturedSpecialError() !== null,
        resolveCaughtNotFoundBoundaries: (error) =>
          resolveAppPageCaughtNotFoundBoundaries(
            error,
            rscErrorTracker.getCapturedSpecialErrors(error),
          ),
      });
    },
    async renderSpecialErrorResponse(specialError, caughtDocument) {
      shellSpecialError = specialError;
      const mayPrerender = mayPrerenderShellSpecialError();
      if (mayStoreShellSpecialError() || mayPrerender) {
        // The page's Flight render goes on after its shell rejected, such as
        // a layout's Suspense boundary reading cookies(). Let it finish while
        // the request context is alive, before the special-error response
        // clears it, so that its dynamic API use, fetch tags and cacheLife all
        // decide the store. A render that turns dynamic isn't stored, and
        // stops the wait.
        await settleCapturedRscRenderForCacheMetadata(
          capturedRscDataRef.value,
          peekRenderDynamicUsage,
        );
      }
      if (mayPrerender) {
        prerenderedSpecialError = {
          dynamicUsed: consumeRenderDynamicUsage(),
          redirectMetadata: specialError.kind === "redirect" ? readPrerenderCacheMetadata() : null,
        };
      }
      return options.renderPageSpecialError(specialError, {
        isCacheCandidate: isCacheCandidateHtmlRender,
        ...(caughtDocument
          ? {
              caughtDocument: buildAppPageHtmlDocumentResponse(caughtDocument.htmlStream, {
                clearRequestContext: options.clearRequestContext,
                fontLinkHeader,
                isEdgeRuntime: options.isEdgeRuntime,
                // buildAppPageSpecialErrorResponse() merges the middleware
                // headers into the fallback page it returns.
                middlewareHeaders: null,
                reactLinkHeader: caughtDocument.linkHeader,
                reactMaxHeadersLength: options.reactMaxHeadersLength,
                status: specialError.statusCode,
              }),
            }
          : {}),
      });
    },
    resolveSpecialError(error: unknown) {
      return resolveAppPageShellSpecialError(
        error,
        rscErrorTracker.getCapturedSpecialErrors(error),
      );
    },
  });
  options.onRenderComplete?.(htmlRender.renderComplete);
  if (htmlRender.response) {
    // A special error that escaped the shell sets the status of the render,
    // which Next.js stores like any other: 404/403/401, or 307/308 with its
    // `location`, beside the page's RSC payload carrying the digest.
    if (
      shellSpecialError &&
      options.isProduction &&
      options.isPrerender !== true &&
      resolveEarlyResponseCacheControl(options) === null
    ) {
      return finalizeShellSpecialErrorResponse(htmlRender.response, shellSpecialError);
    }
    if (shellSpecialError && prerenderedSpecialError) {
      return finalizePrerenderedShellSpecialErrorResponse(
        htmlRender.response,
        shellSpecialError,
        prerenderedSpecialError,
      );
    }
    return applyIneligibleRouteCachePolicy(htmlRender.response, options);
  }
  let htmlStream = htmlRender.htmlStream;
  if (!htmlStream) {
    throw new Error("[vinext] Expected an HTML stream when no fallback response was returned");
  }

  // Combine React's preload `Link` header (captured via onHeaders during SSR)
  // with the font preload `Link` header, capped to `reactMaxHeadersLength`.
  const linkHeader = buildAppPageLinkHeader(
    htmlRender.linkHeader,
    fontLinkHeader,
    options.reactMaxHeadersLength,
  );

  if (options.isPrerender === true) {
    await htmlRender.metadataReady;
  }

  // A special error that a Suspense boundary, such as a loading.tsx, caught
  // didn't reject the shell. As in Next.js, the document streams as a 200
  // with the digest, which the client's boundary renders, in dev, dynamic and
  // ISR renders alike, and an ISR render is stored with that status.
  // Eagerly read values that must be captured before the stream is consumed.
  let dynamicUsedDuringRender = consumeRenderDynamicUsage();
  dynamicUsedDuringHtmlRender = dynamicUsedDuringRender;
  const stopSpeculativeMetadataWaitOnDynamicUsage =
    options.isSpeculativePrerender === true && shouldReadRequestCacheLifeForPrerender
      ? () => {
          if (dynamicUsedDuringRender || peekRenderDynamicUsage()) {
            dynamicUsedDuringRender = true;
            dynamicUsedDuringHtmlRender = true;
            return true;
          }
          return false;
        }
      : undefined;
  if (shouldWaitForAllReady || shouldReadRequestCacheLifeForPrerender) {
    await settleCapturedRscRenderForCacheMetadata(
      htmlRender.capturedRscData,
      stopSpeculativeMetadataWaitOnDynamicUsage,
    );
  }
  if (stopSpeculativeMetadataWaitOnDynamicUsage) {
    // A speculative prerender returns SSR's stream at the shell, but client
    // code rendered after it, such as a client page reading its searchParams
    // inside Suspense, can still make the page dynamic, and the headers must
    // say so. Wait for SSR to finish unless the render is already dynamic.
    // This adds no time to a static render, whose body only closes once SSR
    // finishes anyway. A render that turns dynamic stops the wait, and
    // prerender skips it without reading the rest of its body.
    await waitUnlessDynamic(htmlRender.renderComplete, stopSpeculativeMetadataWaitOnDynamicUsage);
  }
  if (shouldReadRequestCacheLifeForPrerender) {
    requestCacheLifeForPrerender = readRequestCacheLifeForPrerender(options);
    ({ expireSeconds, revalidateSeconds } = applyRequestCacheLife({
      expireSeconds,
      requestCacheLife: requestCacheLifeForPrerender,
      revalidateSeconds,
    }));
  }
  dynamicUsedDuringRender = dynamicUsedDuringRender || consumeRenderDynamicUsage();
  dynamicUsedDuringHtmlRender = dynamicUsedDuringRender;

  const draftCookie = options.getDraftModeCookieHeader();
  let dynamicUsedBeforeContextCleanup = dynamicUsedDuringRender;

  // Defer clearRequestContext() until the HTML stream is fully consumed by the
  // HTTP layer. The RSC/SSR pipeline is lazy — Server Components execute while
  // the response body is being pulled, not when the stream handle is returned.
  // Clearing the context synchronously here would race those executions, causing
  // headers()/cookies() to see a null context on warm (module-cached) requests.
  // See: https://github.com/cloudflare/vinext/issues/660
  const safeHtmlStream = deferUntilStreamConsumed(htmlStream, () => {
    dynamicUsedBeforeContextCleanup =
      dynamicUsedBeforeContextCleanup || consumeRenderDynamicUsage();
    dynamicUsedDuringHtmlRender = dynamicUsedBeforeContextCleanup;
    options.clearRequestContext();
  });

  const { htmlResponsePolicy, shouldWriteHtmlCache } =
    resolveHtmlCacheWrite(dynamicUsedDuringRender);
  const htmlResponseTiming = buildResponseTiming({
    compileEnd,
    handlerStart: options.handlerStart,
    isProduction: options.isProduction,
    renderEnd,
    responseKind: "html",
  });

  if (htmlRender.shellErrorRecovered) {
    const response = buildAppPageHtmlResponse(safeHtmlStream, {
      cacheTags: options.isPrerender === true ? options.getPageTags() : undefined,
      draftCookie,
      linkHeader,
      isEdgeRuntime: options.isEdgeRuntime,
      middlewareContext: {
        headers: options.middlewareContext.headers,
        status: 500,
      },
      policy: { cacheControl: NEVER_CACHE_CONTROL },
      requestCacheLife: requestCacheLifeForPrerender,
      timing: htmlResponseTiming,
    });
    applyCdnResponseHeaders(response.headers, { cacheControl: NEVER_CACHE_CONTROL });
    return response;
  }

  if (shouldWriteHtmlCache) {
    const isrResponse = buildAppPageHtmlResponse(safeHtmlStream, {
      cacheTags: options.isPrerender === true ? options.getPageTags() : undefined,
      draftCookie,
      linkHeader,
      isEdgeRuntime: options.isEdgeRuntime,
      middlewareContext: options.middlewareContext,
      policy: htmlResponsePolicy,
      requestCacheLife: requestCacheLifeForPrerender,
      timing: htmlResponseTiming,
    });

    if (options.isPrerender === true) {
      return isrResponse;
    }

    return finalizeHtmlCacheWrite(isrResponse, {
      capturedDynamicUsageBeforeContextCleanup: () => dynamicUsedBeforeContextCleanup,
      htmlResponsePolicy,
      linkHeader: linkHeader ?? null,
    });
  }

  const response = buildAppPageHtmlResponse(safeHtmlStream, {
    cacheTags: options.isPrerender === true ? options.getPageTags() : undefined,
    draftCookie,
    linkHeader,
    isEdgeRuntime: options.isEdgeRuntime,
    middlewareContext: options.middlewareContext,
    policy: htmlResponsePolicy,
    requestCacheLife: requestCacheLifeForPrerender,
    timing: htmlResponseTiming,
  });
  return finalizeAppPageCacheabilityEvaluationResponse(response, {
    capturedDynamicUsageBeforeContextCleanup() {
      return dynamicUsedBeforeContextCleanup;
    },
    consumeDynamicUsage: consumeRenderDynamicUsage,
    consumeRenderObservationState,
    getPageTags() {
      return options.getPageTags();
    },
    getRequestCacheLife() {
      return readRequestCacheLifeForCachePolicy(options);
    },
    expireSeconds,
    isStaticEligible: options.isStaticEligible,
    revalidateSeconds: resolveAppPageCacheWriteRevalidateSeconds({
      isDynamicError: options.isDynamicError,
      isForceStatic: options.isForceStatic,
      isStaticEligible: options.isStaticEligible,
      revalidateSeconds,
    }),
  });
}

async function settleCapturedRscRenderForCacheMetadata(
  capturedRscDataPromise: Promise<ArrayBuffer> | null,
  shouldStopWaiting?: () => boolean,
): Promise<void> {
  if (!capturedRscDataPromise) {
    return;
  }

  if (!shouldStopWaiting) {
    try {
      await capturedRscDataPromise;
    } catch {
      // The response stream and cache-write path own render error propagation.
      // This pre-read only makes "use cache" metadata available before headers
      // and ISR seed metadata are finalized.
    }
    return;
  }

  await waitUnlessDynamic(capturedRscDataPromise, shouldStopWaiting);
}

/**
 * Wait for `promise` to settle, or until `shouldStopWaiting` reports that the
 * render turned dynamic. Rejections are ignored: the response stream and the
 * cache-write path own render error propagation.
 */
async function waitUnlessDynamic(
  promise: Promise<unknown>,
  shouldStopWaiting: () => boolean,
): Promise<void> {
  let settled = false;
  const settledPromise = promise
    .catch(() => {})
    .then(() => {
      settled = true;
    });

  try {
    while (!settled && !shouldStopWaiting()) {
      await Promise.race([settledPromise, new Promise<void>((resolve) => setTimeout(resolve, 0))]);
    }
  } finally {
    void settledPromise;
  }
}
