import { describe, expect, it, vi } from "vite-plus/test";
import {
  buildAppPageLinkHeader,
  createAppPageFontData,
  createAppPageRscErrorTracker,
  renderAppPageHtmlResponse,
  renderAppPageHtmlStream,
  renderAppPageHtmlStreamWithRecovery,
} from "../packages/vinext/src/server/app-page-stream.js";
import { deferUntilStreamConsumed } from "../packages/vinext/src/server/defer-until-stream-consumed.js";

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

    const { htmlStream } = await renderAppPageHtmlStream({
      fontData,
      navigationContext: { pathname: "/test", searchParams: new URLSearchParams(), params: {} },
      rscStream: createStream(["flight"]),
      ssrHandler: {
        async handleSsr(_rscStream, navigationContext, receivedFontData) {
          expect(navigationContext).toEqual({
            pathname: "/test",
            searchParams: new URLSearchParams(),
            params: {},
          });
          expect(receivedFontData).toEqual(fontData);
          return createStream(["<html>ok</html>"]);
        },
      },
    });

    await expect(new Response(htmlStream).text()).resolves.toBe("<html>ok</html>");
  });

  it("forwards waitForAllReady to the SSR handler", async () => {
    const ssrHandler = vi.fn(async () => createStream(["<html>all-ready</html>"]));

    const { htmlStream } = await renderAppPageHtmlStream({
      fontData: createAppPageFontData({
        getLinks: () => [],
        getPreloads: () => [],
        getStyles: () => [],
      }),
      navigationContext: null,
      rscStream: createStream(["flight"]),
      waitForAllReady: true,
      ssrHandler: { handleSsr: ssrHandler },
    });

    await expect(new Response(htmlStream).text()).resolves.toBe("<html>all-ready</html>");
    expect(ssrHandler).toHaveBeenCalledTimes(1);
    expect(ssrHandler).toHaveBeenCalledWith(
      expect.anything(),
      null,
      expect.anything(),
      expect.objectContaining({ waitForAllReady: true }),
    );
  });

  it("forwards the PPR fallback-shell abort signal to the SSR handler", async () => {
    const abortController = new AbortController();
    const ssrHandler = vi.fn(async () => createStream(["<html>fallback-shell</html>"]));

    const { htmlStream } = await renderAppPageHtmlStream({
      fontData: createAppPageFontData({
        getLinks: () => [],
        getPreloads: () => [],
        getStyles: () => [],
      }),
      navigationContext: null,
      pprFallbackShellSignal: abortController.signal,
      rscStream: createStream(["flight"]),
      ssrHandler: { handleSsr: ssrHandler },
    });

    await expect(new Response(htmlStream).text()).resolves.toBe("<html>fallback-shell</html>");
    expect(ssrHandler).toHaveBeenCalledWith(
      expect.anything(),
      null,
      expect.anything(),
      expect.objectContaining({ pprFallbackShellSignal: abortController.signal }),
    );
  });

  it("forwards form state to the SSR handler", async () => {
    const formState = ["action-result", "key-path", "reference-id", 1] as never;
    const ssrHandler = vi.fn(async () => createStream(["<html>form-state</html>"]));

    const { htmlStream } = await renderAppPageHtmlStream({
      fontData: createAppPageFontData({
        getLinks: () => [],
        getPreloads: () => [],
        getStyles: () => [],
      }),
      formState,
      navigationContext: null,
      rscStream: createStream(["flight"]),
      ssrHandler: { handleSsr: ssrHandler },
    });

    await expect(new Response(htmlStream).text()).resolves.toBe("<html>form-state</html>");
    expect(ssrHandler).toHaveBeenCalledWith(
      expect.anything(),
      null,
      expect.anything(),
      expect.objectContaining({ formState }),
    );
  });

  it("forwards basePath to the SSR handler", async () => {
    const ssrHandler = vi.fn(async () => createStream(["<html>base-path</html>"]));

    const { htmlStream } = await renderAppPageHtmlStream({
      basePath: "/docs",
      fontData: createAppPageFontData({
        getLinks: () => [],
        getPreloads: () => [],
        getStyles: () => [],
      }),
      navigationContext: null,
      rscStream: createStream(["flight"]),
      ssrHandler: { handleSsr: ssrHandler },
    });

    await expect(new Response(htmlStream).text()).resolves.toBe("<html>base-path</html>");
    expect(ssrHandler).toHaveBeenCalledWith(
      expect.anything(),
      null,
      expect.anything(),
      expect.objectContaining({ basePath: "/docs" }),
    );
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
    expect(result.shellErrorRecovered).toBe(false);
    await expect(new Response(result.htmlStream).text()).resolves.toBe("<html>ok</html>");
  });

  it("preserves the SSR shell recovery outcome", async () => {
    const result = await renderAppPageHtmlStreamWithRecovery({
      async renderErrorBoundaryResponse() {
        throw new Error("should not render an error boundary");
      },
      async renderHtmlStream() {
        return {
          htmlStream: createStream(['<html id="__next_error__"></html>']),
          metadataReady: Promise.resolve(),
          capturedRscData: null,
          shellErrorRecovered: true,
        };
      },
      async renderSpecialErrorResponse() {
        throw new Error("should not render a special response");
      },
      resolveSpecialError() {
        return null;
      },
    });

    expect(result.response).toBeNull();
    expect(result.shellErrorRecovered).toBe(true);
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

  it("routes a non-signal digest error to the captured error, not the special slot", () => {
    const baseOnError = vi.fn(() => "base-result");
    const tracker = createAppPageRscErrorTracker(baseOnError);

    // A genuine error that merely carries a (e.g. hashed) digest is not a
    // navigation signal: it must reach the error boundary, not pre-empt the
    // 307/404 swap slot reserved for real redirect/notFound signals.
    const realError = Object.assign(new Error("kaboom"), { digest: "1234567890" });
    tracker.onRenderError(realError, { path: "/test" }, { chunk: 1 });

    expect(tracker.getCapturedError()).toBe(realError);
    expect(tracker.getCapturedSpecialError()).toBeNull();

    // A subsequent real navigation signal still wins the special slot.
    const redirect = { digest: "NEXT_REDIRECT;push;%2Flogin;307" };
    tracker.onRenderError(redirect, { path: "/test" }, { chunk: 2 });

    expect(tracker.getCapturedSpecialError()).toBe(redirect);
    expect(tracker.getCapturedError()).toBe(realError);
  });

  it("emits the `x-edge-runtime: 1` marker on HTML stream responses for edge-runtime routes", async () => {
    const response = await renderAppPageHtmlResponse({
      clearRequestContext: vi.fn(),
      fontData: { links: [], preloads: [], styles: [] },
      isEdgeRuntime: true,
      navigationContext: null,
      rscStream: createStream(["flight"]),
      ssrHandler: {
        async handleSsr() {
          return createStream(["<html>page</html>"]);
        },
      },
      status: 200,
    });

    expect(response.headers.get("x-edge-runtime")).toBe("1");
  });

  it("omits the `x-edge-runtime` marker on HTML stream responses for nodejs-runtime routes", async () => {
    const response = await renderAppPageHtmlResponse({
      clearRequestContext: vi.fn(),
      fontData: { links: [], preloads: [], styles: [] },
      navigationContext: null,
      rscStream: createStream(["flight"]),
      ssrHandler: {
        async handleSsr() {
          return createStream(["<html>page</html>"]);
        },
      },
      status: 200,
    });

    expect(response.headers.get("x-edge-runtime")).toBeNull();
  });
});

describe("buildAppPageLinkHeader", () => {
  // Each entry is ~40 chars including the `, ` join.
  const reactEntry = (i: number) => `</r${i}.js>; rel=preload; as=script`;
  const fontEntry = (i: number) => `</f${i}.woff2>; rel=preload; as=font`;

  it("combines React preloads first, then font preloads", () => {
    const header = buildAppPageLinkHeader(reactEntry(1), fontEntry(1), 6000);
    expect(header).toBe(`${reactEntry(1)}, ${fontEntry(1)}`);
  });

  it("returns an empty string when the cap is 0 (emission disabled)", () => {
    expect(buildAppPageLinkHeader(reactEntry(1), fontEntry(1), 0)).toBe("");
  });

  it("defaults to a 6000-char cap when no limit is supplied", () => {
    const react = [reactEntry(1), reactEntry(2)].join(", ");
    expect(buildAppPageLinkHeader(react, undefined, undefined)).toBe(react);
  });

  it("drops whole entries once the cap is exceeded (never a partial entry)", () => {
    const react = [reactEntry(1), reactEntry(2), reactEntry(3)].join(", ");
    // Cap fits only the first two entries.
    const limit = reactEntry(1).length + 2 + reactEntry(2).length + 1;
    const header = buildAppPageLinkHeader(react, undefined, limit);
    expect(header.length).toBeLessThanOrEqual(limit);
    expect(header).toBe(`${reactEntry(1)}, ${reactEntry(2)}`);
  });

  it("drops trailing font preloads first under a tight cap (React preloads survive)", () => {
    const limit = reactEntry(1).length + 2; // room for one entry only
    const header = buildAppPageLinkHeader(reactEntry(1), fontEntry(1), limit);
    expect(header).toBe(reactEntry(1));
  });

  it("ignores empty sources", () => {
    expect(buildAppPageLinkHeader("", fontEntry(1), 6000)).toBe(fontEntry(1));
    expect(buildAppPageLinkHeader(undefined, undefined, 6000)).toBe("");
  });
});
