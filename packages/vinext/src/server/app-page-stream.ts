import type { AppPageFontPreload } from "./app-page-execution.js";
import type { ReactFormState } from "react-dom/client";
import type { NavigationContext } from "vinext/shims/navigation";
import { VINEXT_RSC_VARY_HEADER } from "./app-rsc-cache-busting.js";
import { isNavigationSignalError } from "../utils/navigation-signal.js";
import { applyEdgeRuntimeHeader } from "./app-page-response.js";
import { mergeMiddlewareResponseHeaders } from "./middleware-response-headers.js";
import type { RootParams } from "vinext/shims/root-params";
import { deferUntilStreamConsumed } from "./defer-until-stream-consumed.js";
import type { InitialNavigationCacheMetadata } from "./app-ssr-stream.js";
import { markFrameworkLinkHeaders } from "./app-response-header-provenance.js";
import { getNextErrorDigest } from "./next-error-digest.js";
import { isAppRenderAbortError } from "./app-render-abort-error.js";

export { deferUntilStreamConsumed } from "./defer-until-stream-consumed.js";

export type AppPageFontData = {
  links: string[];
  preloads: readonly AppPageFontPreload[];
  styles: string[];
};

type CreateAppPageFontDataOptions = {
  getLinks: () => string[];
  getPreloads: () => AppPageFontPreload[];
  getStyles: () => string[];
};

export type AppSsrRenderResult = {
  htmlStream: ReadableStream<Uint8Array>;
  metadataReady: Promise<void>;
  renderComplete?: Promise<void>;
  capturedRscData: Promise<ArrayBuffer> | null;
  shellErrorRecovered?: boolean;
  /**
   * The special error that rejected the shell, when parallel slot not-found
   * boundaries caught it in a second render of the same payload. The document
   * is that error's, with its status.
   */
  caughtShellError?: unknown;
  /**
   * A PPR fallback shell's document is a prelude, with React's postponed
   * state for its holes, null when only its payload has them.
   */
  pprShellPrelude?: { postponed: unknown };
  /**
   * Preload `Link` header value emitted by React during SSR (via `onHeaders`),
   * already capped to `reactMaxHeadersLength`. Empty/undefined when React
   * emitted no preload headers (or emission was disabled with `0`).
   */
  linkHeader?: string;
};

/** A stored PPR shell a request resumes. */
export type AppPagePprShellResume = {
  /** The shell's document up to its holes, for this request. */
  prelude: string;
  /** React's postponed state, or null when only the payload has holes. */
  postponed: unknown;
  /** The `Link` header the shell's render sent. */
  linkHeader?: string;
};

export function isAppSsrRenderResult(value: unknown): value is AppSsrRenderResult {
  return (
    typeof value === "object" && value !== null && "htmlStream" in value && "metadataReady" in value
  );
}

const resolvedMetadataReady = Promise.resolve();

function normalizeAppSsrRenderResult(
  raw: ReadableStream<Uint8Array> | AppSsrRenderResult,
  fallbackCapturedRscData: Promise<ArrayBuffer> | null = null,
): AppSsrRenderResult {
  if (isAppSsrRenderResult(raw)) {
    return raw;
  }

  return {
    htmlStream: raw,
    metadataReady: resolvedMetadataReady,
    capturedRscData: fallbackCapturedRscData,
    shellErrorRecovered: false,
  };
}

/**
 * Combine the React-emitted preload `Link` header with vinext's font preload
 * `Link` header, capping the result to `reactMaxHeadersLength`.
 *
 * React already caps its own portion, but vinext emits font preloads through a
 * separate channel. Mirroring Next.js — where every preload flows through a
 * single capped `onHeaders` callback — we cap the *combined* header here,
 * keeping only whole entries that fit and dropping the rest once the limit is
 * exceeded. `0` disables emission entirely (matches React); `undefined` falls
 * back to the React default of 6000.
 *
 * React's hints (scripts/modules/styles) come first so that under a tight cap
 * the render-critical entries survive and trailing font preloads are dropped
 * first.
 */
export function buildAppPageLinkHeader(
  reactLinkHeader: string | undefined,
  fontLinkHeader: string | undefined,
  maxHeadersLength: number | undefined,
): string {
  // Matches Next.js's `defaultConfig.reactMaxHeadersLength` (and the SSR
  // renderer's fallback) so both caps agree when no config value is supplied.
  const DEFAULT_REACT_MAX_HEADERS_LENGTH = 6000;
  const limit =
    typeof maxHeadersLength === "number" ? maxHeadersLength : DEFAULT_REACT_MAX_HEADERS_LENGTH;
  if (limit <= 0) {
    return "";
  }

  const entries: string[] = [];
  for (const source of [reactLinkHeader, fontLinkHeader]) {
    if (!source) continue;
    for (const entry of source.split(", ")) {
      if (entry.length > 0) {
        entries.push(entry);
      }
    }
  }

  let header = "";
  for (const entry of entries) {
    const next = header.length === 0 ? entry : `${header}, ${entry}`;
    if (next.length > limit) {
      // React drops whole entries once the cap is exceeded; do the same.
      break;
    }
    header = next;
  }

  return header;
}

export type AppPageSsrHandler = {
  handleSsr: (
    rscStream: ReadableStream<Uint8Array>,
    navigationContext: NavigationContext | null,
    fontData: AppPageFontData,
    options?: {
      formState?: ReactFormState | null;
      scriptNonce?: string;
      basePath?: string;
      /**
       * Allow-list of OpenTelemetry propagation keys to emit as `<meta>` tags
       * in the SSR head. Sourced from `experimental.clientTraceMetadata`.
       */
      clientTraceMetadata?: readonly string[];
      /** Private marker used to identify only this render's injected trace tags. */
      clientTraceMetadataMarker?: string;
      /**
       * Maximum total length (in characters) of the preload `Link` header
       * emitted during SSR. `0` disables emission. From `reactMaxHeadersLength`
       * in `next.config`.
       */
      reactMaxHeadersLength?: number;
      rootParams?: RootParams;
      sideStream?: ReadableStream<Uint8Array>;
      capturedRscDataRef?: { value: Promise<ArrayBuffer> | null };
      /** Abort signal for a build-time PPR fallback-shell static render. */
      pprFallbackShellSignal?: AbortSignal;
      /** Whether the fallback shell's payload left holes. */
      isPprFallbackShellPartial?: () => boolean;
      /** A stored shell this render resumes. */
      pprShellResume?: AppPagePprShellResume;
      /** Aborts a streaming render whose document is given up. */
      signal?: AbortSignal;
      /** Route whose client references load before the render; null for none. */
      preloadRoutePattern?: string | null;
      /** When true, wait for the full React tree before emitting bytes. */
      waitForAllReady?: boolean;
      /** Render is producing a static/prerendered HTML artifact. */
      isStaticGeneration?: boolean;
      /** `dynamic = "force-static"` suppresses the useSearchParams bailout. */
      isForceStatic?: boolean;
      /** Production render that may be stored under a query-free key. */
      isCacheCandidate?: boolean;
      /** Dev-only: original server error to surface in the browser overlay. */
      initialDevServerError?: unknown;
      /** Report an SSR/Fizz render failure through instrumentation. */
      onSsrError?: (error: unknown) => unknown;
      /** Mirror inline Flight chunks into Next.js's `self.__next_f` transport, or start
       *  mirroring once a function returns true. */
      mirrorNextFlight?: boolean | (() => boolean);
      /** When true, an SSR-phase-only shell render error resolves to the
       *  default `__next_error__` error-document shell (with the original
       *  flight payload and bootstrap) instead of rejecting. See handleSsr. */
      fallbackToErrorDocumentOnShellError?: boolean;
      /** The parallel slot not-found boundaries that catch a shell error. See handleSsr. */
      resolveCaughtNotFoundBoundaries?: (error: unknown) => readonly string[] | null;
      dynamicStaleTimeSeconds?: number;
      getInitialNavigationCacheMetadata?: () => InitialNavigationCacheMetadata;
    },
  ) => Promise<ReadableStream<Uint8Array> | AppSsrRenderResult>;
};

type RenderAppPageHtmlStreamOptions = {
  dynamicStaleTimeSeconds?: number;
  getInitialNavigationCacheMetadata?: () => InitialNavigationCacheMetadata;
  fontData: AppPageFontData;
  formState?: ReactFormState | null;
  navigationContext: NavigationContext | null;
  rscStream: ReadableStream<Uint8Array>;
  scriptNonce?: string;
  basePath?: string;
  /**
   * Allow-list of OpenTelemetry propagation keys (from
   * `experimental.clientTraceMetadata`) to surface as `<meta>` tags in
   * the SSR head. Undefined or empty disables emission.
   */
  clientTraceMetadata?: readonly string[];
  /** Private marker used to identify only this render's injected trace tags. */
  clientTraceMetadataMarker?: string;
  /**
   * Maximum total length (in characters) of the preload `Link` header emitted
   * during SSR. `0` disables emission. From `reactMaxHeadersLength` in
   * `next.config`.
   */
  reactMaxHeadersLength?: number;
  rootParams?: RootParams;
  ssrHandler: AppPageSsrHandler;
  /** Pre-split side stream for fused embed+capture (#981). When set,
   *  handleSsr skips its internal tee and accumulates raw RSC bytes. */
  sideStream?: ReadableStream<Uint8Array>;
  /** Out-parameter filled with accumulated raw RSC bytes after stream consumption. */
  capturedRscDataRef?: { value: Promise<ArrayBuffer> | null };
  /** Abort signal for a build-time PPR fallback-shell static render. */
  pprFallbackShellSignal?: AbortSignal;
  /** Whether the fallback shell's payload left holes. */
  isPprFallbackShellPartial?: () => boolean;
  /** A stored shell this render resumes. */
  pprShellResume?: AppPagePprShellResume;
  /**
   * Route whose client references load before the render, or null for a
   * render without a route. Undefined loads every client reference.
   */
  preloadRoutePattern?: string | null;
  /** When true, wait for the full React tree before emitting bytes. */
  waitForAllReady?: boolean;
  /** Render is producing a static/prerendered HTML artifact. */
  isStaticGeneration?: boolean;
  /** `dynamic = "force-static"` suppresses the useSearchParams bailout. */
  isForceStatic?: boolean;
  /** Production render that may be stored under a query-free key. */
  isCacheCandidate?: boolean;
  /** Override the default shell-error recovery decision passed to handleSsr. */
  fallbackToErrorDocumentOnShellError?: boolean;
  /** The parallel slot not-found boundaries that catch a shell error. See handleSsr. */
  resolveCaughtNotFoundBoundaries?: (error: unknown) => readonly string[] | null;
  /** Dev-only: original server error to surface in the browser overlay. */
  initialDevServerError?: unknown;
  /** Report an SSR/Fizz render failure through instrumentation. */
  onSsrError?: (error: unknown) => unknown;
  /** Mirror inline Flight chunks into Next.js's `self.__next_f` transport, or start
   *  mirroring once a function returns true. */
  mirrorNextFlight?: boolean | (() => boolean);
  /** True when the app supplies a custom global-error.tsx. Disables the
   *  default error-document shell fallback so SSR shell errors keep driving
   *  the server-rendered global-error boundary re-render. */
  hasCustomGlobalError?: boolean;
};

type RenderAppPageHtmlResponseOptions = {
  clearRequestContext: () => void;
  fontLinkHeader?: string;
  isEdgeRuntime?: boolean;
  middlewareHeaders?: Headers | null;
  status: number;
} & RenderAppPageHtmlStreamOptions;

type AppPageHtmlStreamRecoveryResult = {
  htmlStream: ReadableStream<Uint8Array> | null;
  response: Response | null;
  metadataReady: Promise<void>;
  renderComplete: Promise<void>;
  capturedRscData: Promise<ArrayBuffer> | null;
  shellErrorRecovered: boolean;
  /** React-emitted preload `Link` header (already capped). */
  linkHeader?: string;
  pprShellPrelude?: { postponed: unknown };
};

type RenderAppPageHtmlStreamWithRecoveryOptions<TSpecialError> = {
  onShellRendered?: () => void;
  renderErrorBoundaryResponse: (error: unknown) => Promise<Response | null>;
  renderHtmlStream: () => Promise<ReadableStream<Uint8Array> | AppSsrRenderResult>;
  /**
   * The document of a special error that rejected the shell. With
   * `caughtDocument`, parallel slot boundaries caught it in the page's own
   * document, which that response sends.
   */
  renderSpecialErrorResponse: (
    specialError: TSpecialError,
    caughtDocument?: AppPageCaughtShellErrorDocument,
  ) => Promise<Response>;
  resolveSpecialError: (error: unknown) => TSpecialError | null;
};

/** The page's document, rendered with the slot boundaries that caught its shell error. */
type AppPageCaughtShellErrorDocument = {
  htmlStream: ReadableStream<Uint8Array>;
  /** React-emitted preload `Link` header (already capped). */
  linkHeader?: string;
};

type AppPageRscErrorTracker = {
  getCapturedError: () => unknown;
  /**
   * Returns the first NEXT_REDIRECT or NEXT_HTTP_ERROR_FALLBACK error captured
   * during the RSC render, if any. Whether it set the render's status depends
   * on whether it rejected the document's shell.
   */
  getCapturedSpecialError: () => unknown;
  /**
   * The special errors the RSC render threw with the digest of `error`. The
   * SSR shell rejects with its own copy, decoded from the Flight digest, which
   * loses server-side markers such as generateMetadata()'s.
   */
  getCapturedSpecialErrors: (error: unknown) => readonly unknown[];
  isCapturedError: (error: unknown) => boolean;
  onRenderError: (error: unknown, requestInfo: unknown, errorContext: unknown) => unknown;
};

export function createAppPageSsrErrorHandler(
  baseOnError: (error: unknown, requestInfo: unknown, errorContext: unknown) => unknown,
  isCapturedRscError: (error: unknown) => boolean,
): (error: unknown) => unknown {
  return (error) => {
    if (isAppRenderAbortError(error)) return undefined;
    if (isCapturedRscError(error)) return getNextErrorDigest(error) ?? undefined;
    return baseOnError(error, undefined, undefined);
  };
}

export function createAppPageFontData(options: CreateAppPageFontDataOptions): AppPageFontData {
  return {
    links: options.getLinks(),
    preloads: options.getPreloads(),
    styles: options.getStyles(),
  };
}

export async function renderAppPageHtmlStream(
  options: RenderAppPageHtmlStreamOptions,
): Promise<AppSsrRenderResult> {
  const ssrOptions = {
    formState: options.formState ?? null,
    scriptNonce: options.scriptNonce,
    basePath: options.basePath,
    clientTraceMetadata: options.clientTraceMetadata,
    clientTraceMetadataMarker: options.clientTraceMetadataMarker,
    reactMaxHeadersLength: options.reactMaxHeadersLength,
    rootParams: options.rootParams,
    sideStream: options.sideStream,
    capturedRscDataRef: options.capturedRscDataRef,
    pprFallbackShellSignal: options.pprFallbackShellSignal,
    isPprFallbackShellPartial: options.isPprFallbackShellPartial,
    pprShellResume: options.pprShellResume,
    preloadRoutePattern: options.preloadRoutePattern,
    waitForAllReady: options.waitForAllReady,
    isStaticGeneration: options.isStaticGeneration,
    isForceStatic: options.isForceStatic,
    isCacheCandidate: options.isCacheCandidate,
    initialDevServerError: options.initialDevServerError,
    onSsrError: options.onSsrError,
    mirrorNextFlight: options.mirrorNextFlight,
    // Only when the caller affirmatively knows there is no custom
    // global-error.tsx; undefined (unknown) keeps reject semantics.
    fallbackToErrorDocumentOnShellError:
      options.fallbackToErrorDocumentOnShellError ??
      (options.waitForAllReady !== true && options.hasCustomGlobalError === false),
    resolveCaughtNotFoundBoundaries: options.resolveCaughtNotFoundBoundaries,
    dynamicStaleTimeSeconds: options.dynamicStaleTimeSeconds,
    getInitialNavigationCacheMetadata: options.getInitialNavigationCacheMetadata,
  };

  const rawResult = await options.ssrHandler.handleSsr(
    options.rscStream,
    options.navigationContext,
    options.fontData,
    ssrOptions,
  );

  return normalizeAppSsrRenderResult(rawResult, options.capturedRscDataRef?.value ?? null);
}

export async function renderAppPageHtmlResponse(
  options: RenderAppPageHtmlResponseOptions,
): Promise<Response> {
  const { htmlStream, linkHeader: reactLinkHeader } = await renderAppPageHtmlStream(options);
  return buildAppPageHtmlDocumentResponse(htmlStream, { ...options, reactLinkHeader });
}

export function buildAppPageHtmlDocumentResponse(
  htmlStream: ReadableStream<Uint8Array>,
  options: {
    clearRequestContext: () => void;
    fontLinkHeader?: string;
    isEdgeRuntime?: boolean;
    middlewareHeaders?: Headers | null;
    reactLinkHeader?: string;
    reactMaxHeadersLength?: number;
    status: number;
  },
): Response {
  // Defer clearRequestContext() until the stream is fully consumed by the HTTP
  // layer. Calling it synchronously here would race the lazy RSC/SSR pipeline:
  // components execute while the stream is being pulled, not when the handle
  // is first returned. See: https://github.com/cloudflare/vinext/issues/660
  const safeStream = deferUntilStreamConsumed(htmlStream, () => {
    options.clearRequestContext();
  });

  const headers = new Headers({
    "Content-Type": "text/html; charset=utf-8",
    Vary: VINEXT_RSC_VARY_HEADER,
  });

  applyEdgeRuntimeHeader(headers, options.isEdgeRuntime);

  mergeMiddlewareResponseHeaders(headers, options.middlewareHeaders ?? null);
  const frameworkLinkHeader = buildAppPageLinkHeader(
    options.reactLinkHeader,
    options.fontLinkHeader,
    options.reactMaxHeadersLength,
  );
  if (frameworkLinkHeader) {
    headers.append("Link", frameworkLinkHeader);
  }

  const response = new Response(safeStream, {
    status: options.status,
    headers,
  });
  markFrameworkLinkHeaders(response.headers, frameworkLinkHeader);
  return response;
}

export async function renderAppPageHtmlStreamWithRecovery<TSpecialError>(
  options: RenderAppPageHtmlStreamWithRecoveryOptions<TSpecialError>,
): Promise<AppPageHtmlStreamRecoveryResult> {
  try {
    const rawResult = await options.renderHtmlStream();
    const {
      htmlStream,
      metadataReady,
      renderComplete,
      capturedRscData,
      linkHeader,
      shellErrorRecovered,
      caughtShellError,
      pprShellPrelude,
    } = normalizeAppSsrRenderResult(rawResult);
    options.onShellRendered?.();
    const caughtSpecialError =
      caughtShellError === undefined ? null : options.resolveSpecialError(caughtShellError);
    if (caughtSpecialError) {
      return {
        htmlStream: null,
        response: await options.renderSpecialErrorResponse(caughtSpecialError, {
          htmlStream,
          linkHeader,
        }),
        metadataReady: resolvedMetadataReady,
        renderComplete: renderComplete ?? resolvedMetadataReady,
        capturedRscData: null,
        shellErrorRecovered: false,
      };
    }
    return {
      htmlStream,
      response: null,
      metadataReady,
      renderComplete: renderComplete ?? resolvedMetadataReady,
      capturedRscData,
      shellErrorRecovered: shellErrorRecovered === true,
      linkHeader,
      ...(pprShellPrelude ? { pprShellPrelude } : {}),
    };
  } catch (error) {
    const specialError = options.resolveSpecialError(error);
    if (specialError) {
      return {
        htmlStream: null,
        response: await options.renderSpecialErrorResponse(specialError),
        metadataReady: resolvedMetadataReady,
        renderComplete: resolvedMetadataReady,
        capturedRscData: null,
        shellErrorRecovered: false,
      };
    }

    const boundaryResponse = await options.renderErrorBoundaryResponse(error);
    if (boundaryResponse) {
      return {
        htmlStream: null,
        response: boundaryResponse,
        metadataReady: resolvedMetadataReady,
        renderComplete: resolvedMetadataReady,
        capturedRscData: null,
        shellErrorRecovered: false,
      };
    }

    throw error;
  }
}

export function createAppPageRscErrorTracker(
  baseOnError: (error: unknown, requestInfo: unknown, errorContext: unknown) => unknown,
): AppPageRscErrorTracker {
  let capturedError: unknown = null;
  let capturedSpecialError: unknown = null;
  const capturedErrors = new Set<unknown>();
  const capturedDigests = new Set<string>();
  const specialErrorsByDigest = new Map<string, unknown[]>();

  return {
    getCapturedError() {
      return capturedError;
    },
    getCapturedSpecialError() {
      return capturedSpecialError;
    },
    getCapturedSpecialErrors(error) {
      const digest = getNextErrorDigest(error);
      return (digest !== null && specialErrorsByDigest.get(digest)) || [];
    },
    isCapturedError(error) {
      if (capturedErrors.has(error)) return true;
      const digest = getNextErrorDigest(error);
      return digest !== null && capturedDigests.has(digest);
    },
    onRenderError(error, requestInfo, errorContext) {
      if (isNavigationSignalError(error)) {
        // Navigation signal throws (NEXT_REDIRECT, NEXT_NOT_FOUND,
        // NEXT_HTTP_ERROR_FALLBACK) are not real failures, so keep the first
        // one apart from them. A bare `digest` field is NOT enough: a genuine
        // error that happens to carry a (e.g. hashed) digest is a real failure
        // and must reach the error boundary, not masquerade as a special one.
        if (capturedSpecialError === null) {
          capturedSpecialError = error;
        }
      } else {
        capturedError = error;
        capturedErrors.add(error);
      }
      const result = baseOnError(error, requestInfo, errorContext);
      const digest = typeof result === "string" ? result : getNextErrorDigest(error);
      if (digest !== null && !isNavigationSignalError(error)) {
        capturedDigests.add(digest);
      } else if (digest !== null) {
        specialErrorsByDigest.set(digest, [...(specialErrorsByDigest.get(digest) ?? []), error]);
      }
      return result;
    },
  };
}
