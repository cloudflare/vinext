import type { ReactNode } from "react";
import type { ReactFormState } from "react-dom/client";
import type { CachedAppPageValue } from "vinext/shims/cache";
import type { RootParams } from "vinext/shims/root-params";
import { runWithFetchDedupe } from "vinext/shims/fetch-cache";
import { AppElementsWire, isAppElementsRecord, type AppOutgoingElements } from "./app-elements.js";
import { hasDigest } from "./app-rsc-errors.js";
import {
  finalizeAppPageHtmlCacheResponse,
  finalizeAppPageRscCacheResponse,
} from "./app-page-cache.js";
import {
  buildAppPageFontLinkHeader,
  readAppPageBinaryStream,
  resolveAppPageSpecialError,
  teeAppPageRscStreamForCapture,
  type AppPageFontPreload,
  type AppPageSpecialError,
  type LayoutClassificationOptions,
} from "./app-page-execution.js";
import { probeAppPageBeforeRender } from "./app-page-probe.js";
import {
  buildAppPageHtmlResponse,
  buildAppPageRscResponse,
  resolveAppPageHtmlResponsePolicy,
  resolveAppPageRscResponsePolicy,
  type AppPageMiddlewareContext,
  type AppPageResponseTiming,
} from "./app-page-response.js";
import {
  createAppPageFontData,
  createAppPageRscErrorTracker,
  deferUntilStreamConsumed,
  renderAppPageHtmlStream,
  renderAppPageHtmlStreamWithRecovery,
  shouldRerenderAppPageWithGlobalError,
  type AppPageSsrHandler,
} from "./app-page-stream.js";
import type { AppRscRenderMode } from "./app-rsc-render-mode.js";
import {
  createArtifactCompatibilityEnvelope,
  createArtifactCompatibilityGraphVersion,
  type ArtifactCompatibilityEnvelope,
} from "./artifact-compatibility.js";
import {
  createAppPageHtmlOutputScope,
  createAppPageRenderObservation,
  createAppPageRscOutputScope,
  createEmptyAppPageRenderObservationState,
  type AppPageRenderObservationState,
} from "./app-page-render-observation.js";

type AppPageBoundaryOnError = (
  error: unknown,
  requestInfo: unknown,
  errorContext: unknown,
) => unknown;
type AppPageDebugLogger = (event: string, detail: string) => void;
type AppPageCacheSetter = (
  key: string,
  data: CachedAppPageValue,
  revalidateSeconds: number,
  tags: string[],
  expireSeconds?: number,
) => Promise<void>;

type AppPageRequestCacheLife = {
  revalidate?: number;
  expire?: number;
};

type RenderAppPageLifecycleOptions = {
  basePath?: string;
  cleanPathname: string;
  clearRequestContext: () => void;
  consumeDynamicUsage: () => boolean;
  consumeRenderObservationState?: () => AppPageRenderObservationState;
  /** Read and clear any invalid dynamic usage error recorded during render (dev-only). */
  consumeInvalidDynamicUsageError?: () => unknown;
  createRscOnErrorHandler: (pathname: string, routePath: string) => AppPageBoundaryOnError;
  getFontLinks: () => string[];
  getFontPreloads: () => AppPageFontPreload[];
  getFontStyles: () => string[];
  getNavigationContext: () => unknown;
  getPageTags: () => string[];
  getRequestCacheLife: () => AppPageRequestCacheLife | null;
  peekRequestCacheLife?: () => AppPageRequestCacheLife | null;
  getDraftModeCookieHeader: () => string | null | undefined;
  handlerStart: number;
  hasLoadingBoundary: boolean;
  isDynamicError: boolean;
  isDraftMode: boolean;
  isEdgeRuntime?: boolean;
  isForceDynamic: boolean;
  isForceStatic: boolean;
  isProgressiveActionRender?: boolean;
  isPrerender?: boolean;
  isProduction: boolean;
  isRscRequest: boolean;
  isrDebug?: AppPageDebugLogger;
  isrHtmlKey: (pathname: string) => string;
  isrRscKey: (
    pathname: string,
    mountedSlotsHeader?: string | null,
    renderMode?: AppRscRenderMode,
    interceptionContext?: string | null,
  ) => string;
  isrSet: AppPageCacheSetter;
  interceptionContext?: string | null;
  layoutCount: number;
  loadSsrHandler: () => Promise<AppPageSsrHandler>;
  middlewareContext: AppPageMiddlewareContext;
  params: Record<string, unknown>;
  rootParams?: RootParams;
  peekRenderObservationState?: () => AppPageRenderObservationState;
  probeLayoutAt: (layoutIndex: number) => unknown;
  probePage: () => unknown;
  expireSeconds?: number;
  formState?: ReactFormState | null;
  revalidateSeconds: number | null;
  renderErrorBoundaryResponse: (error: unknown) => Promise<Response | null>;
  renderLayoutSpecialError: (
    specialError: AppPageSpecialError,
    layoutIndex: number,
  ) => Promise<Response>;
  renderPageSpecialError: (specialError: AppPageSpecialError) => Promise<Response>;
  renderToReadableStream: (
    element: ReactNode | AppOutgoingElements,
    options: { onError: AppPageBoundaryOnError },
  ) => ReadableStream<Uint8Array>;
  routeHasLocalBoundary: boolean;
  routePattern: string;
  runWithSuppressedHookWarning<T>(probe: () => Promise<T>): Promise<T>;
  scriptNonce?: string;
  mountedSlotsHeader?: string | null;
  renderMode?: AppRscRenderMode;
  waitUntil?: (promise: Promise<void>) => void;
  element: ReactNode | Readonly<Record<string, ReactNode>>;
  classification?: LayoutClassificationOptions | null;
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
  options: Pick<RenderAppPageLifecycleOptions, "getRequestCacheLife" | "peekRequestCacheLife">,
): AppPageRequestCacheLife | null {
  // Prefer the non-destructive reader so prerender.ts can consume metadata
  // after the handler returns. The consume fallback supports older entry glue
  // and is only safe because this path reads at most once per prerender.
  return options.peekRequestCacheLife?.() ?? options.getRequestCacheLife();
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

  return { expireSeconds, revalidateSeconds };
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
  const preRenderResult = await probeAppPageBeforeRender({
    hasLoadingBoundary: options.hasLoadingBoundary,
    layoutCount: options.layoutCount,
    probeLayoutAt(layoutIndex) {
      return options.probeLayoutAt(layoutIndex);
    },
    probePage() {
      return options.probePage();
    },
    renderLayoutSpecialError(specialError, layoutIndex) {
      return options.renderLayoutSpecialError(specialError, layoutIndex);
    },
    renderPageSpecialError(specialError) {
      return options.renderPageSpecialError(specialError);
    },
    resolveSpecialError: resolveAppPageSpecialError,
    runWithSuppressedHookWarning(probe) {
      return options.runWithSuppressedHookWarning(probe);
    },
    classification: options.classification,
  });
  if (preRenderResult.response) {
    return preRenderResult.response;
  }

  const layoutFlags = preRenderResult.layoutFlags;

  // Render the CANONICAL element. The outgoing payload carries per-layout
  // static/dynamic flags under `__layoutFlags` so the client can later tell
  // which layouts are safe to skip on subsequent navigations.
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
  // Partial payload metadata is a pre-stream snapshot. Fetch tags may still
  // accumulate while the RSC/HTML streams are consumed; complete cache artifact
  // observations below rebuild this field after the stream drains.
  const payloadRenderObservation = createAppPageRenderObservation({
    boundaryOutcome: { kind: "unknown" },
    cacheability: "unknown",
    cacheTags: options.getPageTags(),
    cleanPathname: options.cleanPathname,
    completeness: "partial",
    output: rscOutputScope,
    params: options.params,
    state: options.peekRenderObservationState?.() ?? createEmptyAppPageRenderObservationState(),
  });
  const outgoingElement = AppElementsWire.encodeOutgoingPayload({
    element: options.element,
    layoutFlags,
    ...(artifactCompatibility ? { artifactCompatibility } : {}),
    renderObservation: payloadRenderObservation,
  });

  const compileEnd = options.isProduction ? undefined : performance.now();
  const baseOnError = options.createRscOnErrorHandler(options.cleanPathname, options.routePattern);
  const rscErrorTracker = createAppPageRscErrorTracker(baseOnError);
  // Defensive wrap for standalone callers. In the normal dispatch path this is
  // a no-op since dispatchAppPage already activated dedupe. Note that
  // renderToReadableStream returns synchronously — the actual fetch calls
  // happen later during async stream consumption — so the dedupe map a
  // standalone call would establish here is only effective if the caller has
  // an outer runWithRequestContext / runWithFetchDedupe scope keeping the ALS
  // store alive across that consumption.
  const rscStream = runWithFetchDedupe(() =>
    options.renderToReadableStream(outgoingElement, {
      onError: rscErrorTracker.onRenderError,
    }),
  );

  let revalidateSeconds = options.revalidateSeconds;
  let expireSeconds = options.expireSeconds;
  const shouldCaptureRscForCacheMetadata =
    options.isProgressiveActionRender !== true &&
    (options.isProduction || options.isPrerender === true) &&
    (revalidateSeconds === null || (revalidateSeconds > 0 && revalidateSeconds !== Infinity)) &&
    !options.isDraftMode &&
    !options.isForceDynamic;
  const rscCapture = teeAppPageRscStreamForCapture(rscStream, shouldCaptureRscForCacheMetadata);
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

  if (options.isRscRequest) {
    if (options.isPrerender === true) {
      await settleCapturedRscRenderForCacheMetadata(capturedRscDataRef.value);
      ({ expireSeconds, revalidateSeconds } = applyRequestCacheLife({
        expireSeconds,
        requestCacheLife: readRequestCacheLifeForPrerender(options),
        revalidateSeconds,
      }));
    }

    const dynamicUsedDuringBuild = options.consumeDynamicUsage();
    const rscResponsePolicy = resolveAppPageRscResponsePolicy({
      dynamicUsedDuringBuild,
      isDraftMode: options.isDraftMode,
      isDynamicError: options.isDynamicError,
      isForceDynamic: options.isForceDynamic,
      isForceStatic: options.isForceStatic,
      isProduction: options.isProduction,
      expireSeconds,
      revalidateSeconds,
    });
    const rscResponse = buildAppPageRscResponse(rscForResponse, {
      isEdgeRuntime: options.isEdgeRuntime,
      middlewareContext: options.middlewareContext,
      mountedSlotsHeader: options.mountedSlotsHeader,
      params: options.params,
      policy: rscResponsePolicy,
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
    const devRscResponse =
      !options.isProduction && rscResponse.body && options.consumeInvalidDynamicUsageError
        ? wrapRscResponseForDevErrorReporting(rscResponse, options.consumeInvalidDynamicUsageError)
        : rscResponse;

    return finalizeAppPageRscCacheResponse(devRscResponse, {
      capturedRscDataPromise:
        options.isProduction && shouldCaptureRscForCacheMetadata ? capturedRscDataRef.value : null,
      cleanPathname: options.cleanPathname,
      consumeDynamicUsage: options.consumeDynamicUsage,
      consumeRenderObservationState: options.consumeRenderObservationState,
      createRscRenderObservation(input) {
        return createAppPageRenderObservation({
          boundaryOutcome: { kind: "success" },
          cacheability: "public",
          cacheTags: input.cacheTags,
          cleanPathname: options.cleanPathname,
          completeness: "complete",
          output: rscOutputScope,
          params: options.params,
          state: input.state,
        });
      },
      dynamicUsedDuringBuild,
      getPageTags() {
        return options.getPageTags();
      },
      getRequestCacheLife() {
        return options.getRequestCacheLife();
      },
      isrDebug: options.isrDebug,
      isrRscKey: options.isrRscKey,
      isrSet: options.isrSet,
      interceptionContext: options.interceptionContext,
      mountedSlotsHeader: options.mountedSlotsHeader,
      renderMode: options.renderMode,
      preserveClientResponseHeaders: rscResponsePolicy.cacheState !== "MISS",
      expireSeconds,
      revalidateSeconds,
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
  let renderEnd: number | undefined;

  const htmlRender = await renderAppPageHtmlStreamWithRecovery({
    onShellRendered() {
      if (!options.isProduction) {
        renderEnd = performance.now();
      }
    },
    renderErrorBoundaryResponse(error) {
      return options.renderErrorBoundaryResponse(error);
    },
    async renderHtmlStream() {
      const ssrHandler = await options.loadSsrHandler();
      return renderAppPageHtmlStream({
        capturedRscDataRef,
        fontData,
        navigationContext: options.getNavigationContext(),
        basePath: options.basePath,
        rootParams: options.rootParams,
        formState: options.formState ?? null,
        rscStream: rscForResponse,
        scriptNonce: options.scriptNonce,
        sideStream: rscCapture.sideStream,
        ssrHandler,
        waitForAllReady: options.isPrerender,
      });
    },
    renderSpecialErrorResponse(specialError) {
      return options.renderPageSpecialError(specialError);
    },
    resolveSpecialError: resolveAppPageSpecialError,
  });
  if (htmlRender.response) {
    return htmlRender.response;
  }
  const htmlStream = htmlRender.htmlStream;
  if (!htmlStream) {
    throw new Error("[vinext] Expected an HTML stream when no fallback response was returned");
  }

  // Routes with a route-level Suspense boundary (loading.tsx) skip the page
  // probe — the page render happens once, inside the RSC stream. Mirror
  // Next.js's `app-render.tsx:4293` catch shape: by the time the SSR shell
  // promise has resolved, any redirect()/notFound() throw whose async work
  // settles in microtasks during shell rendering has already fired through
  // React's onError and been captured by the tracker. Convert that to a
  // 307/404 before any bytes are flushed.
  //
  // Late rejections — ones that settle after macrotask boundaries (real
  // I/O, setTimeout, etc.) — fall through to the streamed body, exactly
  // as Next.js does. The digest survives in the Flight payload for the
  // client router to consume.
  if (options.hasLoadingBoundary) {
    const captured = rscErrorTracker.getCapturedSpecialError();
    if (captured) {
      const specialError = resolveAppPageSpecialError(captured);
      if (specialError) {
        void htmlStream.cancel().catch(() => {});
        return options.renderPageSpecialError(specialError);
      }
    }
  }

  if (
    shouldRerenderAppPageWithGlobalError({
      capturedError: rscErrorTracker.getCapturedError(),
      hasLocalBoundary: options.routeHasLocalBoundary,
    })
  ) {
    const cleanResponse = await options.renderErrorBoundaryResponse(
      rscErrorTracker.getCapturedError(),
    );
    if (cleanResponse) {
      return cleanResponse;
    }
  }

  // Eagerly read values that must be captured before the stream is consumed.
  if (options.isPrerender === true) {
    await settleCapturedRscRenderForCacheMetadata(capturedRscDataRef.value);
    ({ expireSeconds, revalidateSeconds } = applyRequestCacheLife({
      expireSeconds,
      requestCacheLife: readRequestCacheLifeForPrerender(options),
      revalidateSeconds,
    }));
  }
  const draftCookie = options.getDraftModeCookieHeader();
  const dynamicUsedDuringRender = options.consumeDynamicUsage();
  let dynamicUsedBeforeContextCleanup = dynamicUsedDuringRender;

  // Defer clearRequestContext() until the HTML stream is fully consumed by the
  // HTTP layer. The RSC/SSR pipeline is lazy — Server Components execute while
  // the response body is being pulled, not when the stream handle is returned.
  // Clearing the context synchronously here would race those executions, causing
  // headers()/cookies() to see a null context on warm (module-cached) requests.
  // See: https://github.com/cloudflare/vinext/issues/660
  const safeHtmlStream = deferUntilStreamConsumed(htmlStream, () => {
    dynamicUsedBeforeContextCleanup =
      dynamicUsedBeforeContextCleanup || options.consumeDynamicUsage();
    options.clearRequestContext();
  });

  const htmlResponsePolicy = resolveAppPageHtmlResponsePolicy({
    dynamicUsedDuringRender,
    isProgressiveActionRender: options.isProgressiveActionRender === true,
    hasScriptNonce: Boolean(options.scriptNonce),
    isDraftMode: options.isDraftMode,
    isDynamicError: options.isDynamicError,
    isForceDynamic: options.isForceDynamic,
    isForceStatic: options.isForceStatic,
    isProduction: options.isProduction,
    expireSeconds,
    revalidateSeconds,
  });
  const htmlResponseTiming = buildResponseTiming({
    compileEnd,
    handlerStart: options.handlerStart,
    isProduction: options.isProduction,
    renderEnd,
    responseKind: "html",
  });

  const shouldSpeculativelyWriteCache =
    options.isProduction &&
    shouldCaptureRscForCacheMetadata &&
    revalidateSeconds === null &&
    !options.isDynamicError &&
    !options.isForceStatic &&
    !options.scriptNonce &&
    options.isProgressiveActionRender !== true &&
    !dynamicUsedDuringRender;

  if (htmlResponsePolicy.shouldWriteToCache || shouldSpeculativelyWriteCache) {
    const isrResponse = buildAppPageHtmlResponse(safeHtmlStream, {
      draftCookie,
      fontLinkHeader,
      isEdgeRuntime: options.isEdgeRuntime,
      middlewareContext: options.middlewareContext,
      policy: htmlResponsePolicy,
      timing: htmlResponseTiming,
    });

    if (options.isPrerender === true) {
      return isrResponse;
    }

    return finalizeAppPageHtmlCacheResponse(isrResponse, {
      capturedDynamicUsageBeforeContextCleanup() {
        return dynamicUsedBeforeContextCleanup;
      },
      capturedRscDataPromise: capturedRscDataRef.value,
      cleanPathname: options.cleanPathname,
      consumeDynamicUsage: options.consumeDynamicUsage,
      consumeRenderObservationState: options.consumeRenderObservationState,
      createHtmlRenderObservation(input) {
        return createAppPageRenderObservation({
          boundaryOutcome: { kind: "success" },
          cacheability: "public",
          cacheTags: input.cacheTags,
          cleanPathname: options.cleanPathname,
          completeness: "complete",
          output: htmlOutputScope,
          params: options.params,
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
          params: options.params,
          state: input.state,
        });
      },
      getPageTags() {
        return options.getPageTags();
      },
      getRequestCacheLife() {
        return options.getRequestCacheLife();
      },
      isrDebug: options.isrDebug,
      isrHtmlKey: options.isrHtmlKey,
      isrRscKey: options.isrRscKey,
      isrSet: options.isrSet,
      interceptionContext: options.interceptionContext,
      preserveClientResponseHeaders: !htmlResponsePolicy.shouldWriteToCache,
      expireSeconds,
      revalidateSeconds,
      waitUntil(cachePromise) {
        options.waitUntil?.(cachePromise);
      },
    });
  }

  return buildAppPageHtmlResponse(safeHtmlStream, {
    draftCookie,
    fontLinkHeader,
    isEdgeRuntime: options.isEdgeRuntime,
    middlewareContext: options.middlewareContext,
    policy: htmlResponsePolicy,
    timing: htmlResponseTiming,
  });
}

async function settleCapturedRscRenderForCacheMetadata(
  capturedRscDataPromise: Promise<ArrayBuffer> | null,
): Promise<void> {
  if (!capturedRscDataPromise) {
    return;
  }

  try {
    await capturedRscDataPromise;
  } catch {
    // The response stream and cache-write path own render error propagation.
    // This pre-read only makes "use cache" metadata available before headers
    // and ISR seed metadata are finalized.
  }
}
