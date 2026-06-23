import type { ReactNode } from "react";
import {
  isPprFallbackShellAbortError,
  preparePprFallbackShellFinalRender,
  waitForPprFallbackShellCacheReady,
  type PprFallbackShellState,
} from "vinext/shims/ppr-fallback-shell";
import { readAppPageBinaryStream } from "./app-page-execution.js";

type AppPageBoundaryOnError = (
  error: unknown,
  requestInfo: unknown,
  errorContext: unknown,
) => unknown;

type AppPageRenderableElement = ReactNode | Record<string, ReactNode>;

export type WarmPprFallbackShellCachesOptions = {
  element: AppPageRenderableElement;
  onError: AppPageBoundaryOnError;
  renderToReadableStream: (
    element: AppPageRenderableElement,
    options: { onError: AppPageBoundaryOnError; signal?: AbortSignal },
  ) => ReadableStream<Uint8Array>;
  state: PprFallbackShellState;
};

export async function warmPprFallbackShellCaches(
  options: WarmPprFallbackShellCachesOptions,
): Promise<void> {
  let warmupError: unknown = null;
  const warmupStream = options.renderToReadableStream(options.element, {
    signal: options.state.abortController.signal,
    onError(error, requestInfo, errorContext) {
      if (options.state.abortController.signal.aborted || isPprFallbackShellAbortError(error)) {
        return undefined;
      }

      return options.onError(error, requestInfo, errorContext);
    },
  });
  const warmupDrain = readAppPageBinaryStream(warmupStream).catch((error: unknown) => {
    if (options.state.abortController.signal.aborted || isPprFallbackShellAbortError(error)) {
      return;
    }
    warmupError = error;
  });

  try {
    await waitForPprFallbackShellCacheReady(options.state);
  } finally {
    options.state.abortController.abort();
    await warmupDrain;
    preparePprFallbackShellFinalRender(options.state);
  }

  if (warmupError) {
    throw warmupError;
  }
}
