import type { AppPageFontPreload } from "./app-page-execution.js";
import type { ReactFormState } from "react-dom/client";
import type { NavigationContext } from "vinext/shims/navigation";
import { VINEXT_RSC_VARY_HEADER } from "./app-rsc-cache-busting.js";
import { isNavigationSignalError } from "../utils/navigation-signal.js";
import { applyEdgeRuntimeHeader } from "./app-page-response.js";
import { mergeMiddlewareResponseHeaders } from "./middleware-response-headers.js";
import type { RootParams } from "vinext/shims/root-params";
import { deferUntilStreamConsumed } from "./defer-until-stream-consumed.js";

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
  capturedRscData: Promise<ArrayBuffer> | null;
  shellErrorRecovered?: boolean;
  /**
   * Preload `Link` header value emitted by React during SSR (via `onHeaders`),
   * already capped to `reactMaxHeadersLength`. Empty/undefined when React
   * emitted no preload headers (or emission was disabled with `0`).
   */
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
      /** When true, wait for the full React tree before emitting bytes. */
      waitForAllReady?: boolean;
      /** Dev-only: original server error to surface in the browser overlay. */
      initialDevServerError?: unknown;
      /** When true, an SSR-phase-only shell render error resolves to the
       *  default `__next_error__` error-document shell (with the original
       *  flight payload and bootstrap) instead of rejecting. See handleSsr. */
      fallbackToErrorDocumentOnShellError?: boolean;
    },
  ) => Promise<ReadableStream<Uint8Array> | AppSsrRenderResult>;
};

type RenderAppPageHtmlStreamOptions = {
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
  /** When true, wait for the full React tree before emitting bytes. */
  waitForAllReady?: boolean;
  /** Dev-only: original server error to surface in the browser overlay. */
  initialDevServerError?: unknown;
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
  capturedRscData: Promise<ArrayBuffer> | null;
  shellErrorRecovered: boolean;
  /** React-emitted preload `Link` header (already capped). */
  linkHeader?: string;
};

type RenderAppPageHtmlStreamWithRecoveryOptions<TSpecialError> = {
  onShellRendered?: () => void;
  renderErrorBoundaryResponse: (error: unknown) => Promise<Response | null>;
  renderHtmlStream: () => Promise<ReadableStream<Uint8Array> | AppSsrRenderResult>;
  renderSpecialErrorResponse: (specialError: TSpecialError) => Promise<Response>;
  resolveSpecialError: (error: unknown) => TSpecialError | null;
};

type AppPageRscErrorTracker = {
  getCapturedError: () => unknown;
  /**
   * Returns a NEXT_REDIRECT or NEXT_HTTP_ERROR_FALLBACK error captured during
   * the RSC render. Read after the SSR shell promise resolves to swap a
   * 307/404 in place of the streamed body when redirect()/notFound() throws
   * synchronously inside a route-level Suspense boundary (loading.tsx).
   */
  getCapturedSpecialError: () => unknown;
  onRenderError: (error: unknown, requestInfo: unknown, errorContext: unknown) => unknown;
};

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
    reactMaxHeadersLength: options.reactMaxHeadersLength,
    rootParams: options.rootParams,
    sideStream: options.sideStream,
    capturedRscDataRef: options.capturedRscDataRef,
    pprFallbackShellSignal: options.pprFallbackShellSignal,
    waitForAllReady: options.waitForAllReady,
    initialDevServerError: options.initialDevServerError,
    // Only when the caller affirmatively knows there is no custom
    // global-error.tsx; undefined (unknown) keeps reject semantics.
    fallbackToErrorDocumentOnShellError:
      options.waitForAllReady !== true && options.hasCustomGlobalError === false,
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
  const { htmlStream } = await renderAppPageHtmlStream(options);

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

  if (options.fontLinkHeader) {
    headers.set("Link", options.fontLinkHeader);
  }

  mergeMiddlewareResponseHeaders(headers, options.middlewareHeaders ?? null);

  return new Response(safeStream, {
    status: options.status,
    headers,
  });
}

export async function renderAppPageHtmlStreamWithRecovery<TSpecialError>(
  options: RenderAppPageHtmlStreamWithRecoveryOptions<TSpecialError>,
): Promise<AppPageHtmlStreamRecoveryResult> {
  try {
    const rawResult = await options.renderHtmlStream();
    const { htmlStream, metadataReady, capturedRscData, linkHeader, shellErrorRecovered } =
      normalizeAppSsrRenderResult(rawResult);
    options.onShellRendered?.();
    return {
      htmlStream,
      response: null,
      metadataReady,
      capturedRscData,
      shellErrorRecovered: shellErrorRecovered === true,
      linkHeader,
    };
  } catch (error) {
    const specialError = options.resolveSpecialError(error);
    if (specialError) {
      return {
        htmlStream: null,
        response: await options.renderSpecialErrorResponse(specialError),
        metadataReady: resolvedMetadataReady,
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

  return {
    getCapturedError() {
      return capturedError;
    },
    getCapturedSpecialError() {
      return capturedSpecialError;
    },
    onRenderError(error, requestInfo, errorContext) {
      if (isNavigationSignalError(error)) {
        // Navigation signal throws (NEXT_REDIRECT, NEXT_NOT_FOUND,
        // NEXT_HTTP_ERROR_FALLBACK) are not real failures — keep the first one
        // so the lifecycle can swap a 307/404 in place of a streamed "Switched
        // to client rendering" body for routes with a route-level Suspense
        // boundary. A bare `digest` field is NOT enough: a genuine error that
        // happens to carry a (e.g. hashed) digest is a real failure and must
        // reach the error boundary, not masquerade as a special response.
        if (capturedSpecialError === null) {
          capturedSpecialError = error;
        }
      } else {
        capturedError = error;
      }
      return baseOnError(error, requestInfo, errorContext);
    },
  };
}
