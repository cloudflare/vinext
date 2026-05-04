import type { AppPageFontPreload } from "./app-page-execution.js";
import { VINEXT_RSC_VARY_HEADER } from "./app-rsc-cache-busting.js";
import { mergeMiddlewareResponseHeaders } from "./middleware-response-headers.js";

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

export type AppPageSsrHandler = {
  handleSsr: (
    rscStream: ReadableStream<Uint8Array>,
    navigationContext: unknown,
    fontData: AppPageFontData,
    options?: {
      scriptNonce?: string;
      sideStream?: ReadableStream<Uint8Array>;
      capturedRscDataRef?: { value: Promise<ArrayBuffer> | null };
    },
  ) => Promise<ReadableStream<Uint8Array>>;
};

type RenderAppPageHtmlStreamOptions = {
  fontData: AppPageFontData;
  navigationContext: unknown;
  rscStream: ReadableStream<Uint8Array>;
  scriptNonce?: string;
  ssrHandler: AppPageSsrHandler;
  /** Pre-split side stream for fused embed+capture (#981). When set,
   *  handleSsr skips its internal tee and accumulates raw RSC bytes. */
  sideStream?: ReadableStream<Uint8Array>;
  /** Out-parameter filled with accumulated raw RSC bytes after stream consumption. */
  capturedRscDataRef?: { value: Promise<ArrayBuffer> | null };
};

type RenderAppPageHtmlResponseOptions = {
  clearRequestContext: () => void;
  fontLinkHeader?: string;
  middlewareHeaders?: Headers | null;
  status: number;
} & RenderAppPageHtmlStreamOptions;

type AppPageHtmlStreamRecoveryResult = {
  htmlStream: ReadableStream<Uint8Array> | null;
  response: Response | null;
};

type RenderAppPageHtmlStreamWithRecoveryOptions<TSpecialError> = {
  onShellRendered?: () => void;
  renderErrorBoundaryResponse: (error: unknown) => Promise<Response | null>;
  renderHtmlStream: () => Promise<ReadableStream<Uint8Array>>;
  renderSpecialErrorResponse: (specialError: TSpecialError) => Promise<Response>;
  resolveSpecialError: (error: unknown) => TSpecialError | null;
};

type AppPageRscErrorTracker = {
  getCapturedError: () => unknown;
  onRenderError: (error: unknown, requestInfo: unknown, errorContext: unknown) => unknown;
};

type ShouldRerenderAppPageWithGlobalErrorOptions = {
  capturedError: unknown;
  hasLocalBoundary: boolean;
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
): Promise<ReadableStream<Uint8Array>> {
  const ssrOptions = {
    scriptNonce: options.scriptNonce,
    sideStream: options.sideStream,
    capturedRscDataRef: options.capturedRscDataRef,
  };

  return options.ssrHandler.handleSsr(
    options.rscStream,
    options.navigationContext,
    options.fontData,
    ssrOptions,
  );
}

/**
 * Wraps a stream so that `onFlush` is called when the last byte has been read
 * by the downstream consumer (i.e. when the HTTP layer finishes draining the
 * response body). This is the correct place to clear per-request context,
 * because the RSC/SSR pipeline is lazy — components execute while the stream
 * is being consumed, not when the stream handle is first obtained.
 */
export function deferUntilStreamConsumed(
  stream: ReadableStream<Uint8Array>,
  onFlush: () => void,
): ReadableStream<Uint8Array> {
  let called = false;
  const once = () => {
    if (!called) {
      called = true;
      onFlush();
    }
  };

  const cleanup = new TransformStream<Uint8Array, Uint8Array>({
    flush() {
      once();
    },
  });

  const piped = stream.pipeThrough(cleanup);

  // Wrap with a ReadableStream so we can intercept cancel() — the TransformStream
  // Transformer interface does not expose a cancel hook in the Web Streams spec.
  const reader = piped.getReader();
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      return reader.read().then(
        ({ done, value }) => {
          if (done) {
            controller.close();
          } else {
            controller.enqueue(value);
          }
        },
        (error) => {
          once();
          controller.error(error);
        },
      );
    },
    cancel(reason) {
      // Stream cancelled before fully consumed (e.g. client disconnected).
      // Still clear per-request context to avoid leaks.
      once();
      return reader.cancel(reason);
    },
  });
}

export async function renderAppPageHtmlResponse(
  options: RenderAppPageHtmlResponseOptions,
): Promise<Response> {
  const htmlStream = await renderAppPageHtmlStream(options);

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
    const htmlStream = await options.renderHtmlStream();
    options.onShellRendered?.();
    return {
      htmlStream,
      response: null,
    };
  } catch (error) {
    const specialError = options.resolveSpecialError(error);
    if (specialError) {
      return {
        htmlStream: null,
        response: await options.renderSpecialErrorResponse(specialError),
      };
    }

    const boundaryResponse = await options.renderErrorBoundaryResponse(error);
    if (boundaryResponse) {
      return {
        htmlStream: null,
        response: boundaryResponse,
      };
    }

    throw error;
  }
}

export function createAppPageRscErrorTracker(
  baseOnError: (error: unknown, requestInfo: unknown, errorContext: unknown) => unknown,
): AppPageRscErrorTracker {
  let capturedError: unknown = null;

  return {
    getCapturedError() {
      return capturedError;
    },
    onRenderError(error, requestInfo, errorContext) {
      if (!(error && typeof error === "object" && "digest" in error)) {
        capturedError = error;
      }
      return baseOnError(error, requestInfo, errorContext);
    },
  };
}

export function shouldRerenderAppPageWithGlobalError(
  options: ShouldRerenderAppPageWithGlobalErrorOptions,
): boolean {
  return Boolean(options.capturedError) && !options.hasLocalBoundary;
}
