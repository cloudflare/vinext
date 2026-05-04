import type { ReactNode } from "react";
import type { CachedAppPageValue } from "vinext/shims/cache";
import { buildOutgoingAppPayload, type AppOutgoingElements } from "./app-elements.js";
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
  cleanPathname: string;
  clearRequestContext: () => void;
  consumeDynamicUsage: () => boolean;
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
  isForceDynamic: boolean;
  isForceStatic: boolean;
  isPrerender?: boolean;
  isProduction: boolean;
  isRscRequest: boolean;
  isrDebug?: AppPageDebugLogger;
  isrHtmlKey: (pathname: string) => string;
  isrRscKey: (pathname: string, mountedSlotsHeader?: string | null) => string;
  isrSet: AppPageCacheSetter;
  layoutCount: number;
  loadSsrHandler: () => Promise<AppPageSsrHandler>;
  middlewareContext: AppPageMiddlewareContext;
  params: Record<string, unknown>;
  probeLayoutAt: (layoutIndex: number) => unknown;
  probePage: () => unknown;
  expireSeconds?: number;
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

/**
 * Wraps an RSC response body to report invalid dynamic usage errors after the
 * stream is fully consumed. In dev mode, errors from cookies()/headers() inside
 * "use cache" may be caught by user try/catch and silently swallowed — this
 * wrapper waits for the stream to drain and surfaces any recorded error to the
 * terminal (and, via HMR, the browser dev overlay).
 * Ported from Next.js: https://github.com/vercel/next.js/commit/f5e54c06726b571a042fce67417e40a29f6b8689
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
    if (error) {
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
  const outgoingElement = buildOutgoingAppPayload({
    element: options.element,
    layoutFlags,
  });

  const compileEnd = options.isProduction ? undefined : performance.now();
  const baseOnError = options.createRscOnErrorHandler(options.cleanPathname, options.routePattern);
  const rscErrorTracker = createAppPageRscErrorTracker(baseOnError);
  const rscStream = options.renderToReadableStream(outgoingElement, {
    onError: rscErrorTracker.onRenderError,
  });

  let revalidateSeconds = options.revalidateSeconds;
  let expireSeconds = options.expireSeconds;
  const shouldCaptureRscForCacheMetadata =
    (options.isProduction || options.isPrerender === true) &&
    (revalidateSeconds === null || (revalidateSeconds > 0 && revalidateSeconds !== Infinity)) &&
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
      isDynamicError: options.isDynamicError,
      isForceDynamic: options.isForceDynamic,
      isForceStatic: options.isForceStatic,
      isProduction: options.isProduction,
      expireSeconds,
      revalidateSeconds,
    });
    const rscResponse = buildAppPageRscResponse(rscForResponse, {
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
      mountedSlotsHeader: options.mountedSlotsHeader,
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
        rscStream: rscForResponse,
        scriptNonce: options.scriptNonce,
        sideStream: rscCapture.sideStream,
        ssrHandler,
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

  // Defer clearRequestContext() until the HTML stream is fully consumed by the
  // HTTP layer. The RSC/SSR pipeline is lazy — Server Components execute while
  // the response body is being pulled, not when the stream handle is returned.
  // Clearing the context synchronously here would race those executions, causing
  // headers()/cookies() to see a null context on warm (module-cached) requests.
  // See: https://github.com/cloudflare/vinext/issues/660
  const safeHtmlStream = deferUntilStreamConsumed(htmlStream, () => {
    options.clearRequestContext();
  });

  const htmlResponsePolicy = resolveAppPageHtmlResponsePolicy({
    dynamicUsedDuringRender,
    hasScriptNonce: Boolean(options.scriptNonce),
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
    !dynamicUsedDuringRender;

  if (htmlResponsePolicy.shouldWriteToCache || shouldSpeculativelyWriteCache) {
    const isrResponse = buildAppPageHtmlResponse(safeHtmlStream, {
      draftCookie,
      fontLinkHeader,
      middlewareContext: options.middlewareContext,
      policy: htmlResponsePolicy,
      timing: htmlResponseTiming,
    });

    if (options.isPrerender === true) {
      return isrResponse;
    }

    return finalizeAppPageHtmlCacheResponse(isrResponse, {
      capturedRscDataPromise: capturedRscDataRef.value,
      cleanPathname: options.cleanPathname,
      consumeDynamicUsage: options.consumeDynamicUsage,
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
