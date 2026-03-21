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
  options.clearRequestContext();

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
