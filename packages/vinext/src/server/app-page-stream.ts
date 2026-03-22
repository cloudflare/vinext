import type { AppPageFontPreload } from "./app-page-execution.js";

export interface AppPageFontData {
  links: string[];
  preloads: readonly AppPageFontPreload[];
  styles: string[];
}

export interface CreateAppPageFontDataOptions {
  getLinks: () => string[];
  getPreloads: () => AppPageFontPreload[];
  getStyles: () => string[];
}

export interface AppPageSsrHandler {
  handleSsr: (
    rscStream: ReadableStream<Uint8Array>,
    navigationContext: unknown,
    fontData: AppPageFontData,
  ) => Promise<ReadableStream<Uint8Array>>;
}

export interface RenderAppPageHtmlStreamOptions {
  fontData: AppPageFontData;
  navigationContext: unknown;
  rscStream: ReadableStream<Uint8Array>;
  ssrHandler: AppPageSsrHandler;
}

export interface RenderAppPageHtmlResponseOptions extends RenderAppPageHtmlStreamOptions {
  clearRequestContext: () => void;
  fontLinkHeader?: string;
  status: number;
}

export interface AppPageHtmlStreamRecoveryResult {
  htmlStream: ReadableStream<Uint8Array> | null;
  response: Response | null;
}

export interface RenderAppPageHtmlStreamWithRecoveryOptions<TSpecialError> {
  onShellRendered?: () => void;
  renderErrorBoundaryResponse: (error: unknown) => Promise<Response | null>;
  renderHtmlStream: () => Promise<ReadableStream<Uint8Array>>;
  renderSpecialErrorResponse: (specialError: TSpecialError) => Promise<Response>;
  resolveSpecialError: (error: unknown) => TSpecialError | null;
}

export interface AppPageRscErrorTracker {
  getCapturedError: () => unknown;
  onRenderError: (error: unknown, requestInfo: unknown, errorContext: unknown) => unknown;
}

export interface ShouldRerenderAppPageWithGlobalErrorOptions {
  capturedError: unknown;
  hasLocalBoundary: boolean;
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
): Promise<ReadableStream<Uint8Array>> {
  return options.ssrHandler.handleSsr(
    options.rscStream,
    options.navigationContext,
    options.fontData,
  );
}

export async function renderAppPageHtmlResponse(
  options: RenderAppPageHtmlResponseOptions,
): Promise<Response> {
  const htmlStream = await renderAppPageHtmlStream(options);

  const headers: Record<string, string> = {
    "Content-Type": "text/html; charset=utf-8",
    Vary: "RSC, Accept",
  };

  if (options.fontLinkHeader) {
    headers.Link = options.fontLinkHeader;
  }

  return new Response(htmlStream, {
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
