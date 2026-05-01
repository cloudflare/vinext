import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import React from "react";
import {
  APP_LAYOUT_FLAGS_KEY,
  isAppElementsRecord,
  type AppOutgoingElements,
} from "../packages/vinext/src/server/app-elements.js";
import type { LayoutClassificationOptions } from "../packages/vinext/src/server/app-page-execution.js";
import { renderAppPageLifecycle } from "../packages/vinext/src/server/app-page-render.js";

function captureRecord(value: ReactNode | AppOutgoingElements): Record<string, unknown> {
  if (!isAppElementsRecord(value)) {
    throw new Error("Expected captured element to be a plain record");
  }
  return value;
}

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
    async handleSsr(
      _rscStream: ReadableStream<Uint8Array>,
      _navContext: unknown,
      _fontData: unknown,
      options?: {
        scriptNonce?: string;
        sideStream?: ReadableStream<Uint8Array>;
        capturedRscDataRef?: { value: Promise<ArrayBuffer> | null };
      },
    ) {
      // Fill capturedRscDataRef so the ISR cache write path can verify paired
      // HTML + RSC writes. The embed transform accumulates raw bytes; simulate
      // that by providing a resolved promise with test fixture data.
      if (options?.capturedRscDataRef) {
        options.capturedRscDataRef.value = Promise.resolve(
          new TextEncoder().encode("flight-data").buffer,
        );
        // Consume the sideStream so the stream is not left hanging
        if (options.sideStream) {
          void options.sideStream.getReader().cancel();
        }
      }
      return createStream(["<html>page</html>"]);
    },
  }));
  const renderErrorBoundaryResponse = vi.fn(async (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    return new Response(`boundary:${message}`, { status: 200 });
  });
  const renderLayoutSpecialError = vi.fn(
    async (specialError) =>
      new Response(`layout:${specialError.statusCode}`, {
        status: specialError.statusCode,
      }),
  );
  const renderPageSpecialError = vi.fn(
    async (specialError) =>
      new Response(`page:${specialError.statusCode}`, {
        status: specialError.statusCode,
      }),
  );
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
      cleanPathname: "/posts/post",
      clearRequestContext() {},
      consumeDynamicUsage: vi.fn(() => false),
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

describe("clearRequestContext timing — issue #660", () => {
  // Regression test: clearRequestContext() must not be called before the HTML
  // stream is fully consumed. Calling it synchronously after receiving the
  // stream handle races the lazy RSC/SSR pipeline on warm module-cache loads,
  // causing headers()/cookies() to see a null context mid-stream.
  it("does not call clearRequestContext before the HTML stream body is consumed", async () => {
    const common = createCommonOptions();
    const contextCleared: string[] = [];

    // Record when the context is cleared relative to stream reads.
    const clearRequestContext = vi.fn(() => {
      contextCleared.push("cleared");
    });

    // The SSR handler produces a stream that records when each chunk is read.
    const loadSsrHandler = vi.fn(async () => ({
      async handleSsr() {
        return new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("<html>page</html>"));
            controller.close();
          },
        });
      },
    }));

    const response = await renderAppPageLifecycle({
      ...common.options,
      clearRequestContext,
      loadSsrHandler,
    });

    // Context must NOT be cleared yet — stream hasn't been consumed.
    expect(contextCleared).toHaveLength(0);

    // Consume the stream (simulates the HTTP response being sent to the client).
    await response.text();

    // Context must be cleared after the stream is fully consumed.
    expect(contextCleared).toHaveLength(1);
  });

  it("does not call clearRequestContext before the ISR-cacheable HTML stream body is consumed", async () => {
    const common = createCommonOptions();
    const contextCleared: string[] = [];

    const clearRequestContext = vi.fn(() => {
      contextCleared.push("cleared");
    });

    const loadSsrHandler = vi.fn(async () => ({
      async handleSsr() {
        return new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("<html>cached</html>"));
            controller.close();
          },
        });
      },
    }));

    const response = await renderAppPageLifecycle({
      ...common.options,
      clearRequestContext,
      isProduction: true,
      loadSsrHandler,
      revalidateSeconds: 30,
    });

    // Context must NOT be cleared yet — stream hasn't been consumed.
    expect(contextCleared).toHaveLength(0);

    // Consume the stream.
    await response.text();

    // Context must be cleared after the stream is fully consumed.
    expect(contextCleared).toHaveLength(1);
  });
});

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
    expect(response.headers.get("cache-control")).toBe("no-store, must-revalidate");
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
    expect(response.headers.get("cache-control")).toBe("no-store, must-revalidate");
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

  it("disables HTML ISR caching when the response carries a script nonce", async () => {
    const common = createCommonOptions();

    const response = await renderAppPageLifecycle({
      ...common.options,
      isProduction: true,
      revalidateSeconds: 30,
      scriptNonce: "vinext-test-nonce",
    });

    expect(response.headers.get("cache-control")).toBe("no-store, must-revalidate");
    expect(response.headers.get("x-vinext-cache")).toBeNull();
    await expect(response.text()).resolves.toBe("<html>page</html>");
    expect(common.waitUntilPromises).toHaveLength(0);
    expect(common.isrSet).not.toHaveBeenCalled();
  });
});

describe("layoutFlags injection into RSC payload", () => {
  function createRscOptions(overrides: {
    element?: Record<string, ReactNode>;
    layoutCount?: number;
    probeLayoutAt?: (index: number) => unknown;
    classification?: LayoutClassificationOptions | null;
  }) {
    let capturedElement: Record<string, unknown> | null = null;

    const options = {
      cleanPathname: "/test",
      clearRequestContext: vi.fn(),
      consumeDynamicUsage: vi.fn(() => false),
      createRscOnErrorHandler: () => () => {},
      getDraftModeCookieHeader: () => null,
      getFontLinks: () => [],
      getFontPreloads: () => [],
      getFontStyles: () => [],
      getNavigationContext: () => null,
      getPageTags: () => [],
      getRequestCacheLife: () => null,
      handlerStart: 0,
      hasLoadingBoundary: false,
      isDynamicError: false,
      isForceDynamic: false,
      isForceStatic: false,
      isProduction: true,
      isRscRequest: true,
      isrHtmlKey: (p: string) => `html:${p}`,
      isrRscKey: (p: string) => `rsc:${p}`,
      isrSet: vi.fn().mockResolvedValue(undefined),
      layoutCount: overrides.layoutCount ?? 0,
      loadSsrHandler: vi.fn(),
      middlewareContext: { headers: null, status: null },
      params: {},
      probeLayoutAt: overrides.probeLayoutAt ?? (() => null),
      probePage: () => null,
      revalidateSeconds: null,
      renderErrorBoundaryResponse: async () => null,
      renderLayoutSpecialError: async () => new Response("error", { status: 500 }),
      renderPageSpecialError: async () => new Response("error", { status: 500 }),
      renderToReadableStream(el: ReactNode | AppOutgoingElements) {
        capturedElement = captureRecord(el);
        return createStream(["flight-data"]);
      },
      routeHasLocalBoundary: false,
      routePattern: "/test",
      runWithSuppressedHookWarning: <T>(probe: () => Promise<T>) => probe(),
      element: overrides.element ?? { "page:/test": "test-page" },
      classification: overrides.classification,
    };

    return {
      options,
      getCapturedElement: (): Record<string, unknown> => {
        if (capturedElement === null) {
          throw new Error("renderToReadableStream was not called");
        }
        return capturedElement;
      },
    };
  }

  it("injects __layoutFlags with 's' when classification detects a static layout", async () => {
    const { options, getCapturedElement } = createRscOptions({
      element: { "layout:/": "root-layout", "page:/test": "test-page" },
      layoutCount: 1,
      probeLayoutAt: () => null,
      classification: {
        getLayoutId: () => "layout:/",
        buildTimeClassifications: null,
        async runWithIsolatedDynamicScope(fn) {
          const result = await fn();
          return { result, dynamicDetected: false };
        },
      },
    });

    await renderAppPageLifecycle(options);
    expect(getCapturedElement()[APP_LAYOUT_FLAGS_KEY]).toEqual({ "layout:/": "s" });
  });

  it("injects __layoutFlags with 'd' for dynamic layouts", async () => {
    const { options, getCapturedElement } = createRscOptions({
      element: { "layout:/": "root-layout", "page:/test": "test-page" },
      layoutCount: 1,
      probeLayoutAt: () => null,
      classification: {
        getLayoutId: () => "layout:/",
        buildTimeClassifications: null,
        async runWithIsolatedDynamicScope(fn) {
          const result = await fn();
          return { result, dynamicDetected: true };
        },
      },
    });

    await renderAppPageLifecycle(options);
    expect(getCapturedElement()[APP_LAYOUT_FLAGS_KEY]).toEqual({ "layout:/": "d" });
  });

  it("injects empty __layoutFlags when classification is not provided (backward compat)", async () => {
    const { options, getCapturedElement } = createRscOptions({
      element: { "layout:/": "root-layout", "page:/test": "test-page" },
      layoutCount: 1,
      probeLayoutAt: () => null,
    });

    await renderAppPageLifecycle(options);
    expect(getCapturedElement()[APP_LAYOUT_FLAGS_KEY]).toEqual({});
  });

  it("injects __layoutFlags for multiple independently classified layouts", async () => {
    let callCount = 0;
    const { options, getCapturedElement } = createRscOptions({
      element: {
        "layout:/": "root-layout",
        "layout:/blog": "blog-layout",
        "page:/blog/post": "post-page",
      },
      layoutCount: 2,
      probeLayoutAt: () => null,
      classification: {
        getLayoutId: (index: number) => (index === 0 ? "layout:/" : "layout:/blog"),
        buildTimeClassifications: null,
        async runWithIsolatedDynamicScope(fn) {
          callCount++;
          const result = await fn();
          // probeAppPageLayouts iterates from layoutCount-1 down to 0:
          // call 1 → layout index 1 (blog) → dynamic
          // call 2 → layout index 0 (root) → static
          return { result, dynamicDetected: callCount === 1 };
        },
      },
    });

    await renderAppPageLifecycle(options);
    expect(getCapturedElement()[APP_LAYOUT_FLAGS_KEY]).toEqual({
      "layout:/": "s",
      "layout:/blog": "d",
    });
  });

  it("__layoutFlags includes flags for ALL layouts even when some are skipped", async () => {
    const { options, getCapturedElement } = createRscOptions({
      element: {
        "layout:/": "root-layout",
        "layout:/blog": "blog-layout",
        "page:/blog/post": "post-page",
      },
      layoutCount: 2,
      probeLayoutAt: () => null,
      classification: {
        getLayoutId: (index: number) => (index === 0 ? "layout:/" : "layout:/blog"),
        buildTimeClassifications: null,
        async runWithIsolatedDynamicScope(fn) {
          const result = await fn();
          return { result, dynamicDetected: false };
        },
      },
    });

    await renderAppPageLifecycle(options);
    // layoutFlags must include ALL layout flags, even for skipped layouts
    expect(getCapturedElement()[APP_LAYOUT_FLAGS_KEY]).toEqual({
      "layout:/": "s",
      "layout:/blog": "s",
    });
  });

  it("wire payload layoutFlags uses only the shorthand 's'/'d' values, never tagged reasons", async () => {
    const { options, getCapturedElement } = createRscOptions({
      element: {
        "layout:/": "root-layout",
        "layout:/admin": "admin-layout",
        "page:/admin/users": "users-page",
      },
      layoutCount: 2,
      probeLayoutAt: () => null,
      classification: {
        buildTimeClassifications: new Map([
          [0, "static"],
          [1, "dynamic"],
        ]),
        getLayoutId: (index: number) => (index === 0 ? "layout:/" : "layout:/admin"),
        async runWithIsolatedDynamicScope(fn) {
          const result = await fn();
          return { result, dynamicDetected: false };
        },
      },
    });

    await renderAppPageLifecycle(options);

    const wireFlags = getCapturedElement()[APP_LAYOUT_FLAGS_KEY];
    expect(wireFlags).toEqual({ "layout:/": "s", "layout:/admin": "d" });

    for (const [_id, flag] of Object.entries(wireFlags as Record<string, unknown>)) {
      expect(flag === "s" || flag === "d").toBe(true);
    }
  });
});
