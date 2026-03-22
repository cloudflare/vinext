import { describe, expect, it, vi } from "vite-plus/test";
import {
  createAppPageFontData,
  createAppPageRscErrorTracker,
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

  it("builds an HTML response, including link headers", async () => {
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

    expect(clearRequestContext).not.toHaveBeenCalled();
    expect(response.status).toBe(203);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("link")).toBe(
      "</font.woff2>; rel=preload; as=font; type=font/woff2; crossorigin",
    );
    await expect(response.text()).resolves.toBe("<html>page</html>");
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
