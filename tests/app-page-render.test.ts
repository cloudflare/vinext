import { describe, expect, it, vi } from "vite-plus/test";
import React from "react";
import { renderAppPageLifecycle } from "../packages/vinext/src/server/app-page-render.js";

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

function createCommonOptions() {
  const waitUntilPromises: Promise<void>[] = [];
  const renderToReadableStream = vi.fn(() => createStream(["flight-data"]));
  const loadSsrHandler = vi.fn(async () => ({
    async handleSsr() {
      return createStream(["<html>page</html>"]);
    },
  }));
  const renderErrorBoundaryResponse = vi.fn(async (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    return new Response(`boundary:${message}`, { status: 200 });
  });
  const renderLayoutSpecialError = vi.fn(async (specialError) => {
    return new Response(`layout:${specialError.statusCode}`, {
      status: specialError.statusCode,
    });
  });
  const renderPageSpecialError = vi.fn(async (specialError) => {
    return new Response(`page:${specialError.statusCode}`, {
      status: specialError.statusCode,
    });
  });
  const isrSet = vi.fn(async () => {});

  return {
    isrSet,
    loadSsrHandler,
    renderErrorBoundaryResponse,
    renderLayoutSpecialError,
    renderPageSpecialError,
    renderToReadableStream,
    waitUntilPromises,
    options: {
      buildDynamicUsage: false,
      buildRenderHeaders: undefined,
      cleanPathname: "/posts/post",
      clearRequestContext() {},
      consumeDynamicUsage: vi.fn(() => false),
      consumeRenderResponseHeaders: vi.fn(() => undefined),
      createRscOnErrorHandler() {
        return () => null;
      },
      element: React.createElement("div", null, "page"),
      getDraftModeCookieHeader() {
        return null;
      },
      getFontLinks() {
        return [];
      },
      getFontPreloads() {
        return [];
      },
      getFontStyles() {
        return [];
      },
      getNavigationContext() {
        return { pathname: "/posts/post" };
      },
      getPageTags() {
        return ["_N_T_/posts/post"];
      },
      getRequestCacheLife() {
        return null;
      },
      handlerStart: 10,
      hasLoadingBoundary: false,
      isDynamicError: false,
      isForceDynamic: false,
      isForceStatic: false,
      isProduction: false,
      isRscRequest: false,
      isrHtmlKey(pathname: string) {
        return `html:${pathname}`;
      },
      isrRscKey(pathname: string) {
        return `rsc:${pathname}`;
      },
      isrSet,
      layoutCount: 0,
      loadSsrHandler,
      middlewareContext: {
        headers: null,
        status: null,
      },
      params: { slug: "post" },
      peekDynamicUsage: vi.fn(() => false),
      peekRenderResponseHeaders: vi.fn(() => undefined),
      probeLayoutAt() {
        return null;
      },
      probePage() {
        return null;
      },
      revalidateSeconds: null,
      renderErrorBoundaryResponse,
      renderLayoutSpecialError,
      renderPageSpecialError,
      renderToReadableStream,
      restoreDynamicUsage: vi.fn(),
      restoreRenderResponseHeaders: vi.fn(),
      routeHasLocalBoundary: false,
      routePattern: "/posts/[slug]",
      runWithSuppressedHookWarning<T>(probe: () => Promise<T>) {
        return probe();
      },
      waitUntil(promise: Promise<void>) {
        waitUntilPromises.push(promise);
      },
    },
  };
}

describe("app page render lifecycle", () => {
  it("returns pre-render special responses before starting the render stream", async () => {
    const common = createCommonOptions();

    const response = await renderAppPageLifecycle({
      ...common.options,
      probePage() {
        throw { digest: "NEXT_NOT_FOUND" };
      },
    });

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toBe("page:404");
    expect(common.renderToReadableStream).not.toHaveBeenCalled();
    expect(common.renderPageSpecialError).toHaveBeenCalledTimes(1);
  });

  it("returns RSC responses and schedules an ISR cache write through waitUntil", async () => {
    const common = createCommonOptions();
    const consumeDynamicUsage = vi.fn(() => false);

    const response = await renderAppPageLifecycle({
      ...common.options,
      consumeDynamicUsage,
      isProduction: true,
      isRscRequest: true,
      revalidateSeconds: 60,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/x-component; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("s-maxage=60, stale-while-revalidate");
    expect(response.headers.get("x-vinext-cache")).toBe("MISS");
    await expect(response.text()).resolves.toBe("flight-data");

    expect(common.waitUntilPromises).toHaveLength(1);
    await Promise.all(common.waitUntilPromises);
    expect(common.isrSet).toHaveBeenCalledTimes(1);
    expect(common.isrSet).toHaveBeenCalledWith(
      "rsc:/posts/post",
      expect.objectContaining({ kind: "APP_PAGE" }),
      60,
      ["_N_T_/posts/post"],
    );
    expect(consumeDynamicUsage).toHaveBeenCalledTimes(2);
  });

  it("rerenders HTML responses with the error boundary when a global RSC error was captured", async () => {
    const common = createCommonOptions();

    const response = await renderAppPageLifecycle({
      ...common.options,
      renderToReadableStream(_element, { onError }) {
        onError(new Error("boom"), null, null);
        return createStream(["flight-data"]);
      },
    });

    expect(common.renderErrorBoundaryResponse).toHaveBeenCalledTimes(1);
    await expect(response.text()).resolves.toBe("boundary:boom");
  });

  it("writes paired HTML and RSC cache entries for cacheable HTML responses", async () => {
    const common = createCommonOptions();

    const response = await renderAppPageLifecycle({
      ...common.options,
      getDraftModeCookieHeader() {
        return "draft=1; Path=/";
      },
      isProduction: true,
      revalidateSeconds: 30,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("s-maxage=30, stale-while-revalidate");
    expect(response.headers.get("x-vinext-cache")).toBe("MISS");
    expect(response.headers.get("set-cookie")).toBe("draft=1; Path=/");
    await expect(response.text()).resolves.toBe("<html>page</html>");

    expect(common.waitUntilPromises).toHaveLength(1);
    await Promise.all(common.waitUntilPromises);
    expect(common.isrSet).toHaveBeenCalledTimes(2);
    expect(common.isrSet).toHaveBeenNthCalledWith(
      1,
      "html:/posts/post",
      expect.objectContaining({ kind: "APP_PAGE" }),
      30,
      ["_N_T_/posts/post"],
    );
    expect(common.isrSet).toHaveBeenNthCalledWith(
      2,
      "rsc:/posts/post",
      expect.objectContaining({ kind: "APP_PAGE" }),
      30,
      ["_N_T_/posts/post"],
    );
  });
});
