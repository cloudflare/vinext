import { describe, expect, it, vi } from "vite-plus/test";
import {
  createAppPageFontData,
  createAppPageRscErrorTracker,
  deferUntilStreamConsumed,
  renderAppPageHtmlResponse,
  renderAppPageHtmlStream,
  renderAppPageHtmlStreamWithRecovery,
  shouldRerenderAppPageWithGlobalError,
} from "../packages/vinext/src/server/app-page-stream.js";

function createStream(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(new TextEncoder().encode(chunk));
      }
      controller.close();
    },
  });
}

describe("app page stream helpers", () => {
  it("collects app page font data from RSC environment getters", () => {
    expect(
      createAppPageFontData({
        getLinks() {
          return ["/font.css"];
        },
        getPreloads() {
          return [{ href: "/font.woff2", type: "font/woff2" }];
        },
        getStyles() {
          return [".font { font-family: Test; }"];
        },
      }),
    ).toEqual({
      links: ["/font.css"],
      preloads: [{ href: "/font.woff2", type: "font/woff2" }],
      styles: [".font { font-family: Test; }"],
    });
  });

  it("renders the HTML stream through the SSR handler", async () => {
    const fontData = createAppPageFontData({
      getLinks: () => ["/font.css"],
      getPreloads: () => [{ href: "/font.woff2", type: "font/woff2" }],
      getStyles: () => [],
    });

    const htmlStream = await renderAppPageHtmlStream({
      fontData,
      navigationContext: { pathname: "/test" },
      rscStream: createStream(["flight"]),
      ssrHandler: {
        async handleSsr(_rscStream, navigationContext, receivedFontData) {
          expect(navigationContext).toEqual({ pathname: "/test" });
          expect(receivedFontData).toEqual(fontData);
          return createStream(["<html>ok</html>"]);
        },
      },
    });

    await expect(new Response(htmlStream).text()).resolves.toBe("<html>ok</html>");
  });

  it("defers clearRequestContext until the HTML stream body is fully consumed", async () => {
    // Regression test for issue #660: clearRequestContext() must not race the
    // lazy RSC/SSR stream pipeline. It should be called only after the HTTP
    // response body has been fully consumed by the downstream consumer.
    const contextCleared: string[] = [];
    const clearRequestContext = vi.fn(() => {
      contextCleared.push("cleared");
    });

    const response = await renderAppPageHtmlResponse({
      clearRequestContext,
      fontData: {
        links: [],
        preloads: [],
        styles: [],
      },
      navigationContext: null,
      rscStream: createStream(["flight"]),
      ssrHandler: {
        async handleSsr() {
          return createStream(["<html>page</html>"]);
        },
      },
      status: 200,
    });

    // The context must NOT be cleared yet — the response stream hasn't been
    // consumed by the downstream caller (i.e. the HTTP layer) yet.
    expect(contextCleared).toHaveLength(0);

    // Consuming the stream simulates the HTTP layer reading the response body.
    await response.text();

    // Now that the stream is fully consumed, context must have been cleared.
    expect(contextCleared).toHaveLength(1);
  });

  it("calls onFlush when the upstream stream errors mid-consumption", async () => {
    const onFlush = vi.fn();
    const streamError = new Error("component threw during streaming");

    // Emit one chunk, then error on the next pull — simulates a component
    // throwing partway through RSC/SSR streaming.
    let pullCount = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        pullCount++;
        if (pullCount === 1) {
          controller.enqueue(new TextEncoder().encode("partial"));
        } else {
          controller.error(streamError);
        }
      },
    });

    const wrapped = deferUntilStreamConsumed(source, onFlush);
    const reader = wrapped.getReader();

    // First read succeeds with the enqueued chunk.
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toBe("partial");

    // Second read should surface the upstream error.
    await expect(reader.read()).rejects.toThrow("component threw during streaming");

    // onFlush must have been called despite the error — this is the bug fix.
    expect(onFlush).toHaveBeenCalledTimes(1);
  });

  it("calls onFlush only once when the stream errors then is cancelled", async () => {
    const onFlush = vi.fn();
    const streamError = new Error("stream error");

    // Error on the very first pull — simulates immediate failure.
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(streamError);
      },
    });

    const wrapped = deferUntilStreamConsumed(source, onFlush);
    const reader = wrapped.getReader();

    // Reading the errored stream triggers the error handler.
    await expect(reader.read()).rejects.toThrow("stream error");

    // The idempotent once() guard prevents double invocation — even if
    // some code path triggered cleanup again, onFlush fires exactly once.
    expect(onFlush).toHaveBeenCalledTimes(1);
  });

  it("builds an HTML response, including link headers, and defers clearing request context until after body is consumed", async () => {
    const clearRequestContext = vi.fn();

    const response = await renderAppPageHtmlResponse({
      clearRequestContext,
      fontData: {
        links: [],
        preloads: [],
        styles: [],
      },
      fontLinkHeader: "</font.woff2>; rel=preload; as=font; type=font/woff2; crossorigin",
      navigationContext: null,
      rscStream: createStream(["flight"]),
      ssrHandler: {
        async handleSsr() {
          return createStream(["<html>page</html>"]);
        },
      },
      status: 203,
    });

    // Context must NOT be cleared before body is consumed (see issue #660).
    expect(clearRequestContext).toHaveBeenCalledTimes(0);
    expect(response.status).toBe(203);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("link")).toBe(
      "</font.woff2>; rel=preload; as=font; type=font/woff2; crossorigin",
    );
    await expect(response.text()).resolves.toBe("<html>page</html>");

    // After body is consumed, context must be cleared exactly once.
    expect(clearRequestContext).toHaveBeenCalledTimes(1);
  });

  it("returns the HTML stream and marks shell render completion when SSR succeeds", async () => {
    const onShellRendered = vi.fn();

    const result = await renderAppPageHtmlStreamWithRecovery({
      onShellRendered,
      async renderErrorBoundaryResponse() {
        throw new Error("should not render an error boundary");
      },
      async renderHtmlStream() {
        return createStream(["<html>ok</html>"]);
      },
      async renderSpecialErrorResponse() {
        throw new Error("should not render a special response");
      },
      resolveSpecialError() {
        return null;
      },
    });

    expect(onShellRendered).toHaveBeenCalledTimes(1);
    expect(result.response).toBeNull();
    await expect(new Response(result.htmlStream).text()).resolves.toBe("<html>ok</html>");
  });

  it("turns special SSR failures into the provided response", async () => {
    const ssrError = new Error("redirect");
    const renderSpecialErrorResponse = vi.fn(async () => new Response("special", { status: 307 }));

    const result = await renderAppPageHtmlStreamWithRecovery({
      async renderErrorBoundaryResponse() {
        throw new Error("should not render an error boundary");
      },
      async renderHtmlStream() {
        throw ssrError;
      },
      renderSpecialErrorResponse,
      resolveSpecialError(error) {
        return error === ssrError
          ? {
              kind: "redirect",
              location: "/target",
              statusCode: 307,
            }
          : null;
      },
    });

    expect(renderSpecialErrorResponse).toHaveBeenCalledWith({
      kind: "redirect",
      location: "/target",
      statusCode: 307,
    });
    expect(result.htmlStream).toBeNull();
    expect(result.response?.status).toBe(307);
    await expect(result.response?.text()).resolves.toBe("special");
  });

  it("falls back to the error boundary response for non-special SSR failures", async () => {
    const ssrError = new Error("boom");
    const renderErrorBoundaryResponse = vi.fn(
      async () => new Response("boundary", { status: 200 }),
    );

    const result = await renderAppPageHtmlStreamWithRecovery({
      renderErrorBoundaryResponse,
      async renderHtmlStream() {
        throw ssrError;
      },
      async renderSpecialErrorResponse() {
        throw new Error("should not render a special response");
      },
      resolveSpecialError() {
        return null;
      },
    });

    expect(renderErrorBoundaryResponse).toHaveBeenCalledWith(ssrError);
    expect(result.htmlStream).toBeNull();
    expect(result.response?.status).toBe(200);
    await expect(result.response?.text()).resolves.toBe("boundary");
  });

  it("tracks non-navigation RSC errors while preserving the base onError callback", () => {
    const baseOnError = vi.fn(() => "base-result");
    const tracker = createAppPageRscErrorTracker(baseOnError);

    expect(tracker.onRenderError(new Error("boom"), { path: "/test" }, { chunk: 1 })).toBe(
      "base-result",
    );
    expect(tracker.getCapturedError()).toBeInstanceOf(Error);

    tracker.onRenderError({ digest: "NEXT_NOT_FOUND" }, { path: "/test" }, { chunk: 2 });
    expect((tracker.getCapturedError() as Error).message).toBe("boom");
    expect(baseOnError).toHaveBeenCalledTimes(2);
  });

  it("only rerenders with global-error when an RSC error was captured and no local boundary exists", () => {
    expect(
      shouldRerenderAppPageWithGlobalError({
        capturedError: new Error("boom"),
        hasLocalBoundary: false,
      }),
    ).toBe(true);

    expect(
      shouldRerenderAppPageWithGlobalError({
        capturedError: new Error("boom"),
        hasLocalBoundary: true,
      }),
    ).toBe(false);

    expect(
      shouldRerenderAppPageWithGlobalError({
        capturedError: null,
        hasLocalBoundary: false,
      }),
    ).toBe(false);
  });
});
