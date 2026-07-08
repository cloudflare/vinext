import { renderToReadableStream, renderToStaticMarkup } from "react-dom/server.edge";
import { prerender } from "react-dom/static.edge";
import type { RenderToReadableStreamOptions } from "react-dom/server";
import { renderSsrErrorDocumentShellHtml } from "./app-ssr-error-shell.js";
import { createTickBufferedTransform } from "./app-ssr-stream.js";
import type { AppSsrRenderRuntime } from "./app-ssr-entry-core.js";

function createUtf8Stream(html: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(html));
      controller.close();
    },
  });
}

function renderSsrErrorDocumentShell(
  bootstrapModuleUrl?: string,
  nonce?: string,
): ReadableStream<Uint8Array> {
  return createUtf8Stream(
    renderSsrErrorDocumentShellHtml(renderToStaticMarkup, bootstrapModuleUrl, nonce),
  );
}

function transformHtmlStream(
  htmlStream: ReadableStream<Uint8Array>,
  options: Parameters<AppSsrRenderRuntime["renderFinalHtmlStream"]>[0]["transform"],
): ReadableStream<Uint8Array> {
  return htmlStream.pipeThrough(createTickBufferedTransform(options));
}

export const appSsrWebRuntime: AppSsrRenderRuntime = {
  renderStaticMarkup(element) {
    return renderToStaticMarkup(element);
  },

  async renderFinalHtmlStream(options) {
    let htmlStream: ReadableStream<Uint8Array>;
    let shellErrorRecovered = false;

    if (options.pprFallbackShellSignal) {
      const htmlAbortController = new AbortController();
      const pendingHtml = prerender(options.element, {
        ...(options.renderOptions as RenderToReadableStreamOptions),
        signal: htmlAbortController.signal,
      });
      setTimeout(() => htmlAbortController.abort(), 0);
      htmlStream = (await pendingHtml).prelude;
    } else {
      let streamingHtmlStream: Awaited<ReturnType<typeof renderToReadableStream>> | undefined;
      try {
        streamingHtmlStream = await renderToReadableStream(options.element, {
          ...(options.renderOptions as RenderToReadableStreamOptions),
        });

        if (options.waitForAllReady) {
          await streamingHtmlStream.allReady;
        }

        htmlStream = streamingHtmlStream;
      } catch (error) {
        void streamingHtmlStream?.cancel().catch(() => {});
        if (!options.shouldRecoverShellError(error)) {
          throw error;
        }
        shellErrorRecovered = true;
        htmlStream = renderSsrErrorDocumentShell(options.bootstrapModuleUrl, options.scriptNonce);
      }
    }

    return {
      htmlStream: transformHtmlStream(htmlStream, options.transform),
      shellErrorRecovered,
    };
  },
};
