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

/**
 * Parses row 0 from a fake-RSC stream payload and returns its top-level
 * object keys. Tests assert on these keys to detect whether a slot survived
 * the skip filter, without matching fragile substrings inside nested JSON.
 */
function parseRow0Keys(body: string): string[] {
  for (const line of body.split("\n")) {
    if (!line.startsWith("0:")) continue;
    const payload = line.slice(2);
    if (!payload.startsWith("{")) return [];
    const parsed = JSON.parse(payload);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return [];
    }
    return Object.keys(parsed);
  }
  return [];
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
    requestedSkipLayoutIds?: ReadonlySet<string>;
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
      requestedSkipLayoutIds: overrides.requestedSkipLayoutIds,
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
      requestedSkipLayoutIds: new Set(["layout:/"]),
    });

    await renderAppPageLifecycle(options);
    // layoutFlags must include ALL layout flags, even for skipped layouts
    expect(getCapturedElement()[APP_LAYOUT_FLAGS_KEY]).toEqual({
      "layout:/": "s",
      "layout:/blog": "s",
    });
  });

  it("wire payload layoutFlags uses only the shorthand 's'/'d' values, never tagged reasons", async () => {
    // Regression guard: Fix 5 introduced a tagged discriminated union for
    // classification reasons as a build-time sidecar, but the wire payload
    // must stay lean so debug metadata never leaks into the RSC stream.
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

    // Every entry must be exactly "s" or "d" — not an object, not undefined.
    for (const [_id, flag] of Object.entries(wireFlags as Record<string, unknown>)) {
      expect(flag === "s" || flag === "d").toBe(true);
    }
  });
});

describe("skip header filtering", () => {
  /**
   * Fake RSC serializer: emits a wire-format stream whose row 0 carries the
   * same keys as the incoming element (so the byte filter can reference them
   * by slot id). Each slot value becomes its own child row and row 0
   * references it via `$L<hexId>`.
   */
  function renderElementToFakeRsc(el: ReactNode | AppOutgoingElements): ReadableStream<Uint8Array> {
    if (!isAppElementsRecord(el)) {
      return createStream(["0:null\n"]);
    }
    const childRows: string[] = [];
    const row0Record: Record<string, unknown> = {};
    let nextId = 1;
    for (const [key, value] of Object.entries(el)) {
      if (key.startsWith("__")) {
        row0Record[key] = value;
        continue;
      }
      const id = nextId++;
      const label = typeof value === "string" ? value : key;
      childRows.push(`${id.toString(16)}:["$","div",null,${JSON.stringify({ children: label })}]`);
      row0Record[key] = `$L${id.toString(16)}`;
    }
    const row0 = `0:${JSON.stringify(row0Record)}`;
    return createStream([childRows.join("\n") + (childRows.length > 0 ? "\n" : ""), row0 + "\n"]);
  }

  function createRscOptions(overrides: {
    element?: Record<string, ReactNode>;
    layoutCount?: number;
    probeLayoutAt?: (index: number) => unknown;
    classification?: LayoutClassificationOptions | null;
    requestedSkipLayoutIds?: ReadonlySet<string>;
    isRscRequest?: boolean;
    revalidateSeconds?: number | null;
    isProduction?: boolean;
    supportsFilteredRscStream?: boolean;
  }) {
    let capturedElement: Record<string, unknown> | null = null;
    const isrSetCalls: Array<{
      key: string;
      hasRscData: boolean;
      rscText: string | null;
    }> = [];
    const waitUntilPromises: Promise<void>[] = [];
    const isrSet = vi.fn(async (key: string, data: { rscData?: ArrayBuffer }) => {
      isrSetCalls.push({
        key,
        hasRscData: Boolean(data.rscData),
        rscText: data.rscData ? new TextDecoder().decode(data.rscData) : null,
      });
    });

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
      isProduction: overrides.isProduction ?? true,
      isRscRequest: overrides.isRscRequest ?? true,
      supportsFilteredRscStream: overrides.supportsFilteredRscStream ?? true,
      isrHtmlKey: (p: string) => `html:${p}`,
      isrRscKey: (p: string) => `rsc:${p}`,
      isrSet,
      layoutCount: overrides.layoutCount ?? 0,
      loadSsrHandler: vi.fn(async () => ({
        async handleSsr() {
          return createStream(["<html>page</html>"]);
        },
      })),
      middlewareContext: { headers: null, status: null },
      params: {},
      probeLayoutAt: overrides.probeLayoutAt ?? (() => null),
      probePage: () => null,
      revalidateSeconds: overrides.revalidateSeconds ?? null,
      renderErrorBoundaryResponse: async () => null,
      renderLayoutSpecialError: async () => new Response("error", { status: 500 }),
      renderPageSpecialError: async () => new Response("error", { status: 500 }),
      renderToReadableStream(el: ReactNode | AppOutgoingElements) {
        capturedElement = captureRecord(el);
        return renderElementToFakeRsc(el);
      },
      routeHasLocalBoundary: false,
      routePattern: "/test",
      runWithSuppressedHookWarning: <T>(probe: () => Promise<T>) => probe(),
      element: overrides.element ?? { "page:/test": "test-page" },
      classification: overrides.classification,
      requestedSkipLayoutIds: overrides.requestedSkipLayoutIds,
      waitUntil(promise: Promise<void>) {
        waitUntilPromises.push(promise);
      },
    };

    return {
      options,
      isrSetCalls,
      waitUntilPromises,
      getCapturedElement: (): Record<string, unknown> => {
        if (capturedElement === null) {
          throw new Error("renderToReadableStream was not called");
        }
        return capturedElement;
      },
    };
  }

  function staticClassification(layoutIdMap: Record<number, string>): LayoutClassificationOptions {
    return {
      getLayoutId: (index: number) => layoutIdMap[index],
      buildTimeClassifications: null,
      async runWithIsolatedDynamicScope(fn) {
        const result = await fn();
        return { result, dynamicDetected: false };
      },
    };
  }

  it("renders the canonical element to the RSC serializer regardless of skipIds", async () => {
    const { options, getCapturedElement } = createRscOptions({
      element: {
        "layout:/": "root-layout",
        "layout:/blog": "blog-layout",
        "page:/blog/post": "post-page",
      },
      layoutCount: 2,
      probeLayoutAt: () => null,
      classification: staticClassification({ 0: "layout:/", 1: "layout:/blog" }),
      requestedSkipLayoutIds: new Set(["layout:/"]),
    });

    await renderAppPageLifecycle(options);
    const captured = getCapturedElement();
    expect(captured["layout:/"]).toBe("root-layout");
    expect(captured["layout:/blog"]).toBe("blog-layout");
    expect(captured["page:/blog/post"]).toBe("post-page");
  });

  it("omits the skipped slot from the RSC response body on RSC requests", async () => {
    const { options } = createRscOptions({
      element: {
        "layout:/": "root-layout",
        "layout:/blog": "blog-layout",
        "page:/blog/post": "post-page",
      },
      layoutCount: 2,
      probeLayoutAt: () => null,
      classification: staticClassification({ 0: "layout:/", 1: "layout:/blog" }),
      requestedSkipLayoutIds: new Set(["layout:/"]),
    });

    const response = await renderAppPageLifecycle(options);
    const body = await response.text();
    const row0Keys = parseRow0Keys(body);
    expect(row0Keys).not.toContain("layout:/");
    expect(row0Keys).toContain("layout:/blog");
    expect(row0Keys).toContain("page:/blog/post");
    expect(body).not.toContain("root-layout");
    expect(body).toContain("blog-layout");
    expect(body).toContain("post-page");
  });

  it("keeps a dynamic layout in the response body even if the client asked to skip it", async () => {
    const { options } = createRscOptions({
      element: {
        "layout:/": "root-layout",
        "page:/test": "test-page",
      },
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
      requestedSkipLayoutIds: new Set(["layout:/"]),
    });

    const response = await renderAppPageLifecycle(options);
    const body = await response.text();
    const row0Keys = parseRow0Keys(body);
    expect(row0Keys).toContain("layout:/");
    expect(body).toContain("root-layout");
  });

  it("preserves metadata keys in the filtered response body", async () => {
    const { options } = createRscOptions({
      element: {
        __route: "route:/blog",
        __rootLayout: "/",
        __interceptionContext: null,
        "layout:/": "root-layout",
        "page:/blog": "blog-page",
      },
      layoutCount: 1,
      probeLayoutAt: () => null,
      classification: staticClassification({ 0: "layout:/" }),
      requestedSkipLayoutIds: new Set(["layout:/"]),
    });

    const response = await renderAppPageLifecycle(options);
    const body = await response.text();
    const row0Keys = parseRow0Keys(body);
    expect(row0Keys).toContain("__route");
    expect(row0Keys).toContain("__rootLayout");
    expect(row0Keys).toContain("__layoutFlags");
    expect(row0Keys).not.toContain("layout:/");
    expect(row0Keys).toContain("page:/blog");
  });

  it("returns byte-identical output when skip set is empty", async () => {
    const { options } = createRscOptions({
      element: {
        "layout:/": "root-layout",
        "layout:/blog": "blog-layout",
        "page:/blog/post": "post-page",
      },
      layoutCount: 2,
      probeLayoutAt: () => null,
      classification: staticClassification({ 0: "layout:/", 1: "layout:/blog" }),
      requestedSkipLayoutIds: new Set(),
    });

    const response = await renderAppPageLifecycle(options);
    const body = await response.text();
    const row0Keys = parseRow0Keys(body);
    expect(row0Keys).toContain("layout:/");
    expect(row0Keys).toContain("layout:/blog");
    expect(row0Keys).toContain("page:/blog/post");
  });

  it("does not filter layouts on non-RSC requests (SSR/initial load)", async () => {
    const { options, getCapturedElement } = createRscOptions({
      element: {
        "layout:/": "root-layout",
        "page:/test": "test-page",
      },
      layoutCount: 1,
      probeLayoutAt: () => null,
      classification: staticClassification({ 0: "layout:/" }),
      requestedSkipLayoutIds: new Set(["layout:/"]),
      isRscRequest: false,
    });

    await renderAppPageLifecycle(options);
    const captured = getCapturedElement();
    expect(captured["layout:/"]).toBe("root-layout");
  });

  it("does not filter layouts on development RSC requests", async () => {
    const { options } = createRscOptions({
      element: {
        "layout:/": "root-layout",
        "page:/test": "test-page",
      },
      layoutCount: 1,
      probeLayoutAt: () => null,
      classification: staticClassification({ 0: "layout:/" }),
      requestedSkipLayoutIds: new Set(["layout:/"]),
      supportsFilteredRscStream: false,
    });

    const response = await renderAppPageLifecycle(options);
    const body = await response.text();
    const row0Keys = parseRow0Keys(body);
    expect(row0Keys).toContain("layout:/");
    expect(body).toContain("root-layout");
  });

  it("writes canonical RSC bytes to the cache even when skipIds are non-empty", async () => {
    const { options, isrSetCalls, waitUntilPromises } = createRscOptions({
      element: {
        "layout:/": "root-layout",
        "layout:/blog": "blog-layout",
        "page:/blog/post": "post-page",
      },
      layoutCount: 2,
      probeLayoutAt: () => null,
      classification: staticClassification({ 0: "layout:/", 1: "layout:/blog" }),
      requestedSkipLayoutIds: new Set(["layout:/"]),
      isProduction: true,
      revalidateSeconds: 60,
    });

    const response = await renderAppPageLifecycle(options);
    await response.text();
    await Promise.all(waitUntilPromises);

    const rscWrite = isrSetCalls.find((call) => call.key.startsWith("rsc:"));
    expect(rscWrite?.hasRscData).toBe(true);
    expect(rscWrite?.rscText).toBeDefined();
    // Canonical cache bytes must contain ALL slot keys, even the skipped one.
    const cachedRow0Keys = parseRow0Keys(rscWrite?.rscText ?? "");
    expect(cachedRow0Keys).toContain("layout:/");
    expect(cachedRow0Keys).toContain("layout:/blog");
    expect(cachedRow0Keys).toContain("page:/blog/post");
  });

  it("does not mutate options.element during render", async () => {
    const element: Record<string, ReactNode> = {
      __route: "route:/blog",
      __rootLayout: "/",
      __interceptionContext: null,
      "layout:/": "root-layout",
      "layout:/blog": "blog-layout",
      "page:/blog": "blog-page",
    };
    const snapshot = structuredClone(element);
    const snapshotKeys = Object.keys(element);

    const { options } = createRscOptions({
      element,
      layoutCount: 1,
      probeLayoutAt: () => null,
      classification: staticClassification({ 0: "layout:/" }),
      requestedSkipLayoutIds: new Set(["layout:/"]),
    });

    const response = await renderAppPageLifecycle(options);
    await response.text();

    expect(element).toEqual(snapshot);
    expect(Object.keys(element)).toEqual(snapshotKeys);
    expect("__layoutFlags" in element).toBe(false);
  });
});
