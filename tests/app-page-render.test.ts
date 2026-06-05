import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import React from "react";
import {
  APP_ARTIFACT_COMPATIBILITY_KEY,
  APP_LAYOUT_FLAGS_KEY,
  APP_RENDER_OBSERVATION_KEY,
  APP_ROOT_LAYOUT_KEY,
  APP_SKIPPED_LAYOUT_IDS_KEY,
  AppElementsWire,
  isAppElementsRecord,
  type AppOutgoingElements,
} from "../packages/vinext/src/server/app-elements.js";
import {
  APP_ELEMENTS_SCHEMA_VERSION,
  ARTIFACT_COMPATIBILITY_SCHEMA_VERSION,
  createArtifactCompatibilityEnvelope,
  createArtifactCompatibilityGraphVersion,
  RSC_PAYLOAD_SCHEMA_VERSION,
} from "../packages/vinext/src/server/artifact-compatibility.js";
import type { LayoutClassificationOptions } from "../packages/vinext/src/server/app-page-execution.js";
import { createClientReuseManifestHeaderFromVisibleAppState } from "../packages/vinext/src/server/app-browser-client-reuse-manifest.js";
import { createAppLayoutParamAccessTracker } from "../packages/vinext/src/server/app-layout-param-observation.js";
import { renderAppPageLifecycle } from "../packages/vinext/src/server/app-page-render.js";
import {
  parseClientReuseManifestHeader,
  type ClientReuseManifestParseResult,
  type ClientReuseManifestSkipDisposition,
} from "../packages/vinext/src/server/client-reuse-manifest.js";
import { VINEXT_DYNAMIC_STALE_TIME_HEADER } from "../packages/vinext/src/server/headers.js";
import type { CachedAppPageValue } from "../packages/vinext/src/shims/cache.js";
import { markDynamicUsage } from "../packages/vinext/src/shims/headers.js";
import {
  createRequestContext,
  runWithRequestContext,
} from "../packages/vinext/src/shims/unified-request-context.js";

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

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
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
        formState?: unknown;
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
  const isrSet = vi.fn(
    async (
      _key: string,
      _data: CachedAppPageValue,
      _revalidateSeconds: number,
      _tags: string[],
      _expireSeconds?: number,
    ) => {},
  );

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
      isDraftMode: false,
      isForceDynamic: false,
      isForceStatic: false,
      isProgressiveActionRender: false,
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

function createVerifiedStaticLayoutManifest(input: {
  deploymentVersion: string;
  layoutId: string;
  rootBoundaryId: string;
  routeId: string;
  routePattern: string;
}): ClientReuseManifestParseResult {
  const artifactCompatibility = createArtifactCompatibilityEnvelope({
    deploymentVersion: input.deploymentVersion,
    graphVersion: createArtifactCompatibilityGraphVersion({
      routePattern: input.routePattern,
      rootBoundaryId: input.rootBoundaryId,
    }),
    rootBoundaryId: input.rootBoundaryId,
  });

  const header = createClientReuseManifestHeaderFromVisibleAppState({
    elements: {
      ...AppElementsWire.createMetadataEntries({
        interceptionContext: null,
        layoutIds: [input.layoutId],
        rootLayoutTreePath: input.rootBoundaryId,
        routeId: input.routeId,
      }),
      [AppElementsWire.keys.artifactCompatibility]: artifactCompatibility,
      [AppElementsWire.keys.layoutFlags]: { [input.layoutId]: "s" },
      [input.layoutId]: `retained-${input.layoutId}`,
    },
    visibleCommitVersion: 1,
  });
  if (header === null) {
    throw new Error("Expected retained static layout manifest");
  }

  return parseClientReuseManifestHeader(header);
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

describe("form state rendering", () => {
  it("passes action form state to SSR and disables HTML cache writes", async () => {
    const common = createCommonOptions();
    const formState = ["action-result", "key-path", "reference-id", 1] as never;
    const loadSsrHandler = vi.fn(async () => ({
      async handleSsr(
        _rscStream: ReadableStream<Uint8Array>,
        _navContext: unknown,
        _fontData: unknown,
        options?: { formState?: unknown },
      ) {
        expect(options?.formState).toBe(formState);
        return createStream(["<html>action state</html>"]);
      },
    }));

    const response = await renderAppPageLifecycle({
      ...common.options,
      formState,
      isProgressiveActionRender: true,
      isProduction: true,
      loadSsrHandler,
      revalidateSeconds: 60,
    });

    expect(response.headers.get("cache-control")).toBe("no-store, must-revalidate");
    expect(common.isrSet).not.toHaveBeenCalled();
    await expect(response.text()).resolves.toBe("<html>action state</html>");
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
      consumeRenderObservationState() {
        return {
          dynamicFetches: ["https://api.example.test/posts?token=secret"],
          requestApis: ["headers"],
        };
      },
      isProduction: true,
      isRscRequest: true,
      revalidateSeconds: 60,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/x-component");
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
      undefined,
    );
    const cachedValue = common.isrSet.mock.calls[0]?.[1];
    expect(cachedValue?.renderObservation).toMatchObject({
      boundaryOutcome: { kind: "success" },
      cacheability: "public",
      completeness: "complete",
      output: {
        kind: "app-rsc",
        mountedSlotsFingerprint: null,
        renderEpoch: null,
        rootBoundaryId: null,
        routeId: "route:/posts/[slug]",
      },
      requestApis: expect.arrayContaining([
        { kind: "headers", status: "observed" },
        { kind: "params", status: "observed" },
      ]),
    });
    expect(JSON.stringify(cachedValue?.renderObservation)).not.toContain("secret");
    expect(consumeDynamicUsage).toHaveBeenCalledTimes(2);
  });

  it("does not cache RSC responses when skip transport omits layout records", async () => {
    const common = createCommonOptions();
    const isrDebug = vi.fn();
    let capturedElement: Record<string, unknown> | null = null;

    const response = await renderAppPageLifecycle({
      ...common.options,
      element: {
        [APP_ROOT_LAYOUT_KEY]: "/",
        "layout:/": "root-layout",
        "page:/posts/post": "post-page",
      },
      isProduction: true,
      isRscRequest: true,
      isrDebug,
      renderToReadableStream(element) {
        capturedElement = captureRecord(element);
        return createStream(["flight-data"]);
      },
      revalidateSeconds: 60,
      skipDisposition: {
        code: "SKIP_STATIC_LAYOUT_VERIFIED",
        enabled: true,
        mode: "skipStaticLayout",
        skippedEntryIds: ["layout:/"],
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store, must-revalidate");
    expect(response.headers.get("x-vinext-cache")).toBeNull();
    await expect(response.text()).resolves.toBe("flight-data");

    if (capturedElement === null) {
      throw new Error("Expected renderToReadableStream to receive AppElements payload");
    }
    expect(Object.hasOwn(capturedElement, "layout:/")).toBe(false);
    expect(capturedElement["page:/posts/post"]).toBe("post-page");
    expect(common.waitUntilPromises).toHaveLength(0);
    expect(common.isrSet).not.toHaveBeenCalled();
    expect(isrDebug).toHaveBeenCalledWith(
      "RSC cache write skipped (skip transport payload)",
      "/posts/post",
    );
  });

  it("does not wait for the full captured RSC payload before returning production RSC responses", async () => {
    const common = createCommonOptions();
    const releaseRsc = createDeferred();

    const responsePromise = renderAppPageLifecycle({
      ...common.options,
      getRequestCacheLife() {
        return { revalidate: 7, expire: 11 };
      },
      isProduction: true,
      isRscRequest: true,
      renderToReadableStream() {
        let sent = false;
        return new ReadableStream<Uint8Array>({
          async pull(controller) {
            if (sent) {
              await releaseRsc.promise;
              controller.close();
              return;
            }
            sent = true;
            controller.enqueue(new TextEncoder().encode("flight"));
          },
        });
      },
      revalidateSeconds: null,
    });

    await expect(
      Promise.race([responsePromise.then(() => "returned"), releaseRsc.promise.then(() => "done")]),
    ).resolves.toBe("returned");

    const response = await responsePromise;
    expect(response.headers.get("cache-control")).toBeNull();
    expect(response.headers.get("x-vinext-cache")).toBeNull();
    expect(common.waitUntilPromises).toHaveLength(1);

    releaseRsc.resolve();
    await expect(response.text()).resolves.toBe("flight");
    await Promise.all(common.waitUntilPromises);
    expect(common.isrSet).toHaveBeenCalledWith(
      "rsc:/posts/post",
      expect.objectContaining({ kind: "APP_PAGE" }),
      7,
      ["_N_T_/posts/post"],
      11,
    );
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
      undefined,
    );
    expect(common.isrSet).toHaveBeenNthCalledWith(
      2,
      "rsc:/posts/post",
      expect.objectContaining({ kind: "APP_PAGE" }),
      30,
      ["_N_T_/posts/post"],
      undefined,
    );
  });

  it("does not wait for cacheLife-only RSC capture before returning production HTML responses", async () => {
    const common = createCommonOptions();
    const releaseRsc = createDeferred();

    const responsePromise = renderAppPageLifecycle({
      ...common.options,
      getRequestCacheLife() {
        return { revalidate: 5, expire: 9 };
      },
      isProduction: true,
      renderToReadableStream() {
        let sent = false;
        return new ReadableStream<Uint8Array>({
          async pull(controller) {
            if (sent) {
              await releaseRsc.promise;
              controller.close();
              return;
            }
            sent = true;
            controller.enqueue(new TextEncoder().encode("flight"));
          },
        });
      },
      revalidateSeconds: null,
    });

    await expect(
      Promise.race([responsePromise.then(() => "returned"), releaseRsc.promise.then(() => "done")]),
    ).resolves.toBe("returned");

    const response = await responsePromise;
    expect(response.headers.get("cache-control")).toBeNull();
    expect(response.headers.get("x-vinext-cache")).toBeNull();
    expect(common.waitUntilPromises).toHaveLength(1);

    releaseRsc.resolve();
    await expect(response.text()).resolves.toBe("<html>page</html>");
    await Promise.all(common.waitUntilPromises);
    expect(common.isrSet).toHaveBeenNthCalledWith(
      1,
      "html:/posts/post",
      expect.objectContaining({ kind: "APP_PAGE" }),
      5,
      ["_N_T_/posts/post"],
      9,
    );
    expect(common.isrSet).toHaveBeenNthCalledWith(
      2,
      "rsc:/posts/post",
      expect.objectContaining({ kind: "APP_PAGE" }),
      5,
      ["_N_T_/posts/post"],
      9,
    );
  });

  it("preserves original production RSC response headers when speculative cacheLife never appears", async () => {
    const common = createCommonOptions();

    const response = await renderAppPageLifecycle({
      ...common.options,
      isProduction: true,
      isRscRequest: true,
      revalidateSeconds: null,
    });

    expect(response.headers.get("cache-control")).toBeNull();
    expect(response.headers.get("x-vinext-cache")).toBeNull();
    expect(common.waitUntilPromises).toHaveLength(1);

    await expect(response.text()).resolves.toBe("flight-data");
    await Promise.all(common.waitUntilPromises);
    expect(common.isrSet).not.toHaveBeenCalled();
  });

  it("preserves original production HTML response headers when speculative cacheLife never appears", async () => {
    const common = createCommonOptions();

    const response = await renderAppPageLifecycle({
      ...common.options,
      isProduction: true,
      revalidateSeconds: null,
    });

    expect(response.headers.get("cache-control")).toBeNull();
    expect(response.headers.get("x-vinext-cache")).toBeNull();
    expect(common.waitUntilPromises).toHaveLength(1);

    await expect(response.text()).resolves.toBe("<html>page</html>");
    await Promise.all(common.waitUntilPromises);
    expect(common.isrSet).not.toHaveBeenCalled();
  });

  it("captures prerender cache metadata before building non-production HTML responses", async () => {
    const common = createCommonOptions();
    let requestCacheLife: { revalidate: number; expire: number } | null = null;

    const response = await renderAppPageLifecycle({
      ...common.options,
      getRequestCacheLife() {
        const value = requestCacheLife;
        requestCacheLife = null;
        return value;
      },
      isPrerender: true,
      isProduction: false,
      renderToReadableStream() {
        let sent = false;
        return new ReadableStream<Uint8Array>({
          pull(controller) {
            if (sent) {
              controller.close();
              return;
            }
            requestCacheLife = { revalidate: 1, expire: 3 };
            controller.enqueue(new TextEncoder().encode("flight-data"));
            sent = true;
          },
        });
      },
      revalidateSeconds: 1,
    });

    expect(response.headers.get("cache-control")).toBe("s-maxage=1, stale-while-revalidate=2");
    expect(response.headers.get("x-vinext-cache")).toBeNull();
    await expect(response.text()).resolves.toBe("<html>page</html>");
    expect(common.waitUntilPromises).toHaveLength(0);
    expect(common.isrSet).not.toHaveBeenCalled();
  });

  it("captures prerender cache metadata when cacheLife provides the only revalidate value", async () => {
    const common = createCommonOptions();
    let requestCacheLife: { revalidate: number; expire: number } | null = null;

    const response = await renderAppPageLifecycle({
      ...common.options,
      getRequestCacheLife() {
        const value = requestCacheLife;
        requestCacheLife = null;
        return value;
      },
      isPrerender: true,
      isProduction: false,
      renderToReadableStream() {
        let sent = false;
        return new ReadableStream<Uint8Array>({
          pull(controller) {
            if (sent) {
              controller.close();
              return;
            }
            requestCacheLife = { revalidate: 1, expire: 3 };
            controller.enqueue(new TextEncoder().encode("flight-data"));
            sent = true;
          },
        });
      },
      revalidateSeconds: null,
    });

    expect(response.headers.get("cache-control")).toBe("s-maxage=1, stale-while-revalidate=2");
    await expect(response.text()).resolves.toBe("<html>page</html>");
    expect(common.isrSet).not.toHaveBeenCalled();
  });

  it("preserves prerender cache metadata for the manifest writer after shaping headers", async () => {
    const common = createCommonOptions();
    let requestCacheLife: { revalidate: number; expire: number } | null = null;
    const consumeRequestCacheLife = () => {
      const value = requestCacheLife;
      requestCacheLife = null;
      return value;
    };

    const response = await renderAppPageLifecycle({
      ...common.options,
      getRequestCacheLife: consumeRequestCacheLife,
      isPrerender: true,
      isProduction: false,
      peekRequestCacheLife() {
        return requestCacheLife;
      },
      renderToReadableStream() {
        let sent = false;
        return new ReadableStream<Uint8Array>({
          pull(controller) {
            if (sent) {
              controller.close();
              return;
            }
            requestCacheLife = { revalidate: 1, expire: 1 };
            controller.enqueue(new TextEncoder().encode("flight-data"));
            sent = true;
          },
        });
      },
      revalidateSeconds: null,
    });

    expect(response.headers.get("cache-control")).toBe("s-maxage=1");
    await expect(response.text()).resolves.toBe("<html>page</html>");
    expect(consumeRequestCacheLife()).toEqual({ revalidate: 1, expire: 1 });
  });

  it("preserves prerender cache metadata headers in production mode without ISR writes", async () => {
    const common = createCommonOptions();
    let requestCacheLife: { revalidate: number; expire: number } | null = null;

    const response = await renderAppPageLifecycle({
      ...common.options,
      getRequestCacheLife() {
        const value = requestCacheLife;
        requestCacheLife = null;
        return value;
      },
      isPrerender: true,
      isProduction: true,
      renderToReadableStream() {
        let sent = false;
        return new ReadableStream<Uint8Array>({
          pull(controller) {
            if (sent) {
              controller.close();
              return;
            }
            requestCacheLife = { revalidate: 1, expire: 3 };
            controller.enqueue(new TextEncoder().encode("flight-data"));
            sent = true;
          },
        });
      },
      revalidateSeconds: null,
    });

    expect(response.headers.get("cache-control")).toBe("s-maxage=1, stale-while-revalidate=2");
    expect(response.headers.get("x-vinext-cache")).toBe("MISS");
    await expect(response.text()).resolves.toBe("<html>page</html>");
    expect(common.waitUntilPromises).toHaveLength(0);
    expect(common.isrSet).not.toHaveBeenCalled();
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

  it("emits the dynamic stale time header on RSC responses during dynamic renders", async () => {
    const common = createCommonOptions();
    const response = await renderAppPageLifecycle({
      ...common.options,
      dynamicStaleTimeSeconds: 60,
      isRscRequest: true,
    });
    expect(response.headers.get(VINEXT_DYNAMIC_STALE_TIME_HEADER)).toBe("60");
    await expect(response.text()).resolves.toBe("flight-data");
  });

  it("omits the dynamic stale time header during prerender (isPrerender=true)", async () => {
    const common = createCommonOptions();
    const response = await renderAppPageLifecycle({
      ...common.options,
      dynamicStaleTimeSeconds: 60,
      isRscRequest: true,
      isPrerender: true,
    });
    expect(response.headers.get(VINEXT_DYNAMIC_STALE_TIME_HEADER)).toBeNull();
    await expect(response.text()).resolves.toBe("flight-data");
  });

  it("omits the dynamic stale time header during force-static renders", async () => {
    const common = createCommonOptions();
    const response = await renderAppPageLifecycle({
      ...common.options,
      dynamicStaleTimeSeconds: 60,
      isRscRequest: true,
      isForceStatic: true,
    });
    expect(response.headers.get(VINEXT_DYNAMIC_STALE_TIME_HEADER)).toBeNull();
    await expect(response.text()).resolves.toBe("flight-data");
  });

  it("omits the dynamic stale time header on production ISR renders captured into the cache", async () => {
    // Production ISR (revalidate > 0, not force-static, not a build prerender)
    // satisfies shouldCaptureRscForCacheMetadata, so the render feeds the ISR
    // cache. Like Next.js's !workStore.isStaticGeneration guard, the
    // authoritative per-page stale time must not be emitted on such responses.
    const common = createCommonOptions();
    const response = await renderAppPageLifecycle({
      ...common.options,
      dynamicStaleTimeSeconds: 60,
      isProduction: true,
      isRscRequest: true,
      revalidateSeconds: 60,
    });
    expect(response.headers.get(VINEXT_DYNAMIC_STALE_TIME_HEADER)).toBeNull();
    await expect(response.text()).resolves.toBe("flight-data");
  });

  it("emits the dynamic stale time header on dynamic production default-config RSC responses", async () => {
    // Ported from Next.js: test/e2e/app-dir/segment-cache/staleness/segment-cache-per-page-dynamic-stale-time.test.ts
    // The upstream fixture pages export unstable_dynamicStaleTime and call
    // connection(), so the per-page value is authoritative only once the render
    // is known to be dynamic.
    const common = createCommonOptions();
    const response = await renderAppPageLifecycle({
      ...common.options,
      consumeDynamicUsage: vi.fn(() => true),
      dynamicStaleTimeSeconds: 60,
      isProduction: true,
      isRscRequest: true,
      revalidateSeconds: null,
    });
    expect(response.headers.get(VINEXT_DYNAMIC_STALE_TIME_HEADER)).toBe("60");
    await expect(response.text()).resolves.toBe("flight-data");
  });

  it("omits the dynamic stale time header on static production default-config RSC responses", async () => {
    const common = createCommonOptions();
    const response = await renderAppPageLifecycle({
      ...common.options,
      consumeDynamicUsage: vi.fn(() => false),
      dynamicStaleTimeSeconds: 60,
      isProduction: true,
      isRscRequest: true,
      revalidateSeconds: null,
    });
    expect(response.headers.get(VINEXT_DYNAMIC_STALE_TIME_HEADER)).toBeNull();
    await expect(response.text()).resolves.toBe("flight-data");
  });
});

describe("layoutFlags injection into RSC payload", () => {
  function createRscOptions(overrides: {
    cleanPathname?: string;
    clientReuseManifest?: ClientReuseManifestParseResult;
    element?: Record<string, ReactNode>;
    layoutParamAccess?: ReturnType<typeof createAppLayoutParamAccessTracker>;
    layoutCount?: number;
    probeLayoutAt?: (index: number) => unknown;
    classification?: LayoutClassificationOptions | null;
    routePattern?: string;
    skipDisposition?: ClientReuseManifestSkipDisposition;
  }) {
    let capturedElement: Record<string, unknown> | null = null;

    const options = {
      cleanPathname: overrides.cleanPathname ?? "/test",
      clearRequestContext: vi.fn(),
      consumeDynamicUsage: vi.fn(() => false),
      createRscOnErrorHandler: () => () => {},
      clientReuseManifest: overrides.clientReuseManifest,
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
      isDraftMode: false,
      isForceDynamic: false,
      isForceStatic: false,
      isProduction: true,
      isRscRequest: true,
      isrHtmlKey: (p: string) => `html:${p}`,
      isrRscKey: (p: string) => `rsc:${p}`,
      isrSet: vi.fn().mockResolvedValue(undefined),
      layoutParamAccess: overrides.layoutParamAccess,
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
      routePattern: overrides.routePattern ?? "/test",
      runWithSuppressedHookWarning: <T>(probe: () => Promise<T>) => probe(),
      element: overrides.element ?? { "page:/test": "test-page" },
      classification: overrides.classification,
      skipDisposition: overrides.skipDisposition,
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

  it("injects concrete artifact compatibility metadata from the render boundary", async () => {
    const originalBuildId = process.env.__VINEXT_BUILD_ID;
    process.env.__VINEXT_BUILD_ID = "deploy-test";
    const { options, getCapturedElement } = createRscOptions({
      element: {
        [APP_ROOT_LAYOUT_KEY]: "/(shop)",
        "layout:/(shop)": "shop-layout",
        "page:/shop": "shop-page",
      },
    });

    try {
      await renderAppPageLifecycle(options);
    } finally {
      if (originalBuildId === undefined) {
        delete process.env.__VINEXT_BUILD_ID;
      } else {
        process.env.__VINEXT_BUILD_ID = originalBuildId;
      }
    }

    expect(getCapturedElement()[APP_ARTIFACT_COMPATIBILITY_KEY]).toEqual({
      schemaVersion: ARTIFACT_COMPATIBILITY_SCHEMA_VERSION,
      graphVersion: createArtifactCompatibilityGraphVersion({
        routePattern: "/test",
        rootBoundaryId: "/(shop)",
      }),
      deploymentVersion: "deploy-test",
      appElementsSchemaVersion: APP_ELEMENTS_SCHEMA_VERSION,
      rscPayloadSchemaVersion: RSC_PAYLOAD_SCHEMA_VERSION,
      rootBoundaryId: "/(shop)",
      renderEpoch: null,
    });
  });

  it("injects partial render observation metadata into outgoing AppElements payloads", async () => {
    const { options, getCapturedElement } = createRscOptions({
      element: {
        [APP_ROOT_LAYOUT_KEY]: "/",
        "layout:/": "root-layout",
        "page:/test": "test-page",
      },
    });

    await renderAppPageLifecycle({
      ...options,
      params: { id: "123" },
      peekRenderObservationState() {
        return {
          dynamicFetches: ["https://api.example.test/posts?token=secret"],
          requestApis: ["headers"],
        };
      },
    });

    const renderObservation = getCapturedElement()[APP_RENDER_OBSERVATION_KEY];

    expect(renderObservation).toMatchObject({
      boundaryOutcome: { kind: "unknown" },
      cacheability: "unknown",
      completeness: "partial",
      output: {
        kind: "app-rsc",
        mountedSlotsFingerprint: null,
        renderEpoch: null,
        rootBoundaryId: "/",
        routeId: "route:/test",
      },
      requestApis: expect.arrayContaining([
        { kind: "headers", status: "observed" },
        { kind: "params", status: "observed" },
      ]),
    });
    expect(JSON.stringify(renderObservation)).not.toContain("secret");
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

  it("applies enabled static-layout skip transport after preserving all layout flags", async () => {
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
      skipDisposition: {
        code: "SKIP_STATIC_LAYOUT_VERIFIED",
        enabled: true,
        mode: "skipStaticLayout",
        skippedEntryIds: ["layout:/blog"],
      },
    });

    await renderAppPageLifecycle(options);
    expect(getCapturedElement()["layout:/"]).toBe("root-layout");
    expect(Object.hasOwn(getCapturedElement(), "layout:/blog")).toBe(false);
    expect(getCapturedElement()["page:/blog/post"]).toBe("post-page");
    expect(getCapturedElement()[APP_LAYOUT_FLAGS_KEY]).toEqual({
      "layout:/": "s",
      "layout:/blog": "s",
    });
  });

  it("does not apply skip transport while producing an HTML response", async () => {
    const common = createCommonOptions();
    let capturedElement: Record<string, unknown> | null = null;

    await renderAppPageLifecycle({
      ...common.options,
      element: {
        "layout:/": "root-layout",
        "layout:/blog": "blog-layout",
        "page:/blog/post": "post-page",
      },
      layoutCount: 2,
      classification: {
        getLayoutId: (index: number) => (index === 0 ? "layout:/" : "layout:/blog"),
        buildTimeClassifications: null,
        async runWithIsolatedDynamicScope(fn) {
          const result = await fn();
          return { result, dynamicDetected: false };
        },
      },
      isRscRequest: false,
      renderToReadableStream(element) {
        capturedElement = captureRecord(element);
        return createStream(["flight-data"]);
      },
      skipDisposition: {
        code: "SKIP_STATIC_LAYOUT_VERIFIED",
        enabled: true,
        mode: "skipStaticLayout",
        skippedEntryIds: ["layout:/blog"],
      },
    });

    if (capturedElement === null) {
      throw new Error("Expected renderToReadableStream to be called");
    }
    expect(capturedElement["layout:/"]).toBe("root-layout");
    expect(capturedElement["layout:/blog"]).toBe("blog-layout");
    expect(capturedElement["page:/blog/post"]).toBe("post-page");
  });

  it("keeps the layout in the payload when final skip verification rejects dynamic usage", async () => {
    const originalBuildId = process.env.__VINEXT_BUILD_ID;
    process.env.__VINEXT_BUILD_ID = "deploy-test";
    const layoutId = "layout:/blog";
    const tracker = createAppLayoutParamAccessTracker();
    const clientReuseManifest = createVerifiedStaticLayoutManifest({
      deploymentVersion: "deploy-test",
      layoutId,
      rootBoundaryId: "/",
      routeId: "route:/blog/hello",
      routePattern: "/blog/[slug]",
    });
    const { options, getCapturedElement } = createRscOptions({
      cleanPathname: "/blog/hello",
      clientReuseManifest,
      element: {
        [APP_ROOT_LAYOUT_KEY]: "/",
        [layoutId]: "blog-layout",
        "page:/blog/hello": "post-page",
      },
      layoutCount: 1,
      layoutParamAccess: tracker,
      probeLayoutAt() {
        return tracker.runLayoutProbe(layoutId, () => {
          markDynamicUsage();
        });
      },
      classification: {
        getLayoutId: () => layoutId,
        buildTimeClassifications: null,
        isLayoutObservationDynamic: () => false,
        async runWithIsolatedDynamicScope(fn) {
          const result = await fn();
          return { result, dynamicDetected: false };
        },
      },
      routePattern: "/blog/[slug]",
    });

    try {
      await runWithRequestContext(createRequestContext(), () => renderAppPageLifecycle(options));
    } finally {
      if (originalBuildId === undefined) {
        delete process.env.__VINEXT_BUILD_ID;
      } else {
        process.env.__VINEXT_BUILD_ID = originalBuildId;
      }
    }

    expect(getCapturedElement()[layoutId]).toBe("blog-layout");
    expect(getCapturedElement()["page:/blog/hello"]).toBe("post-page");
    expect(getCapturedElement()[APP_LAYOUT_FLAGS_KEY]).toEqual({ [layoutId]: "s" });
    expect(Object.hasOwn(getCapturedElement(), APP_SKIPPED_LAYOUT_IDS_KEY)).toBe(false);
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

describe("dev error reporting for invalid dynamic usage — issue #1195", () => {
  it("does not double-log an uncaught error that React already stamped with a digest", async () => {
    const common = createCommonOptions();
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const errorWithDigest = Object.assign(new Error("cookies() inside use cache"), {
      digest: "DYNAMIC_SERVER_USAGE",
    });
    let consumedError: unknown = null;
    const consumeInvalidDynamicUsageError = vi.fn(() => {
      if (consumedError !== null) return null;
      consumedError = errorWithDigest;
      return errorWithDigest;
    });

    const response = await renderAppPageLifecycle({
      ...common.options,
      consumeInvalidDynamicUsageError,
      isRscRequest: true,
    });

    expect(response.status).toBe(200);
    await response.text();
    expect(consumeInvalidDynamicUsageError).toHaveBeenCalled();
    expect(consoleErrorSpy).not.toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });

  it("logs a caught error that has no digest (React never saw it)", async () => {
    const common = createCommonOptions();
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const errorWithoutDigest = new Error("cookies() inside use cache");
    let consumedError: unknown = null;
    const consumeInvalidDynamicUsageError = vi.fn(() => {
      if (consumedError !== null) return null;
      consumedError = errorWithoutDigest;
      return errorWithoutDigest;
    });

    const response = await renderAppPageLifecycle({
      ...common.options,
      consumeInvalidDynamicUsageError,
      isRscRequest: true,
    });

    expect(response.status).toBe(200);
    await response.text();
    expect(consumeInvalidDynamicUsageError).toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "[vinext] Invalid dynamic usage:",
      errorWithoutDigest,
    );

    consoleErrorSpy.mockRestore();
  });

  it("does not log when no invalid dynamic usage error was recorded", async () => {
    const common = createCommonOptions();
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const consumeInvalidDynamicUsageError = vi.fn(() => null);

    const response = await renderAppPageLifecycle({
      ...common.options,
      consumeInvalidDynamicUsageError,
      isRscRequest: true,
    });

    expect(response.status).toBe(200);
    await response.text();
    expect(consumeInvalidDynamicUsageError).toHaveBeenCalled();
    expect(consoleErrorSpy).not.toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });

  it("still dedups when the stream is cancelled before full consumption", async () => {
    const common = createCommonOptions();
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const errorWithDigest = Object.assign(new Error("cookies() inside use cache"), {
      digest: "DYNAMIC_SERVER_USAGE",
    });
    let consumedError: unknown = null;
    const consumeInvalidDynamicUsageError = vi.fn(() => {
      if (consumedError !== null) return null;
      consumedError = errorWithDigest;
      return errorWithDigest;
    });

    const response = await renderAppPageLifecycle({
      ...common.options,
      consumeInvalidDynamicUsageError,
      isRscRequest: true,
    });

    // Cancel the stream before consuming any bytes
    if (response.body) {
      await response.body.cancel("client disconnect");
    }
    expect(consumeInvalidDynamicUsageError).toHaveBeenCalled();
    expect(consoleErrorSpy).not.toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });

  it("still dedups when the stream errors during pull", async () => {
    const common = createCommonOptions();
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const errorWithDigest = Object.assign(new Error("cookies() inside use cache"), {
      digest: "DYNAMIC_SERVER_USAGE",
    });
    let consumedError: unknown = null;
    const consumeInvalidDynamicUsageError = vi.fn(() => {
      if (consumedError !== null) return null;
      consumedError = errorWithDigest;
      return errorWithDigest;
    });

    const renderToReadableStream = vi.fn(
      () =>
        new ReadableStream<Uint8Array>({
          pull() {
            throw new Error("stream blowup");
          },
        }),
    );

    const response = await renderAppPageLifecycle({
      ...common.options,
      consumeInvalidDynamicUsageError,
      isRscRequest: true,
      renderToReadableStream,
    });

    // Attempting to consume the stream will trigger the error
    try {
      await response.text();
    } catch {
      // Expected
    }
    expect(consumeInvalidDynamicUsageError).toHaveBeenCalled();
    expect(consoleErrorSpy).not.toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });

  it("does not apply the wrapper in production mode", async () => {
    const common = createCommonOptions();
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const errorWithoutDigest = new Error("cookies() inside use cache");
    const consumeInvalidDynamicUsageError = vi.fn(() => errorWithoutDigest);

    const response = await renderAppPageLifecycle({
      ...common.options,
      consumeInvalidDynamicUsageError,
      isProduction: true,
      isRscRequest: true,
    });

    expect(response.status).toBe(200);
    await response.text();
    // In production the wrapper is skipped entirely
    expect(consumeInvalidDynamicUsageError).not.toHaveBeenCalled();
    expect(consoleErrorSpy).not.toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });

  it("does not apply the wrapper for HTML (non-RSC) requests", async () => {
    const common = createCommonOptions();
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const errorWithoutDigest = new Error("cookies() inside use cache");
    const consumeInvalidDynamicUsageError = vi.fn(() => errorWithoutDigest);

    const response = await renderAppPageLifecycle({
      ...common.options,
      consumeInvalidDynamicUsageError,
      isRscRequest: false,
    });

    await response.text();
    // HTML path intentionally defers dev error reporting
    expect(consumeInvalidDynamicUsageError).not.toHaveBeenCalled();
    expect(consoleErrorSpy).not.toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });
});
