import { describe, expect, it, vi } from "vite-plus/test";
import {
  buildAppPageFontLinkHeader,
  buildAppPageSpecialErrorResponse,
  probeAppPageComponent,
  probeAppPageLayouts,
  readAppPageTextStream,
  resolveAppPageSpecialError,
  teeAppPageRscStreamForCapture,
} from "../packages/vinext/src/server/app-page-execution.js";

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

describe("app page execution helpers", () => {
  it("parses redirect and access-fallback digests", () => {
    expect(
      resolveAppPageSpecialError({
        digest: "NEXT_REDIRECT;replace;%2Fredirected;308",
      }),
    ).toEqual({
      kind: "redirect",
      location: "/redirected",
      statusCode: 308,
    });

    expect(
      resolveAppPageSpecialError({
        digest: "NEXT_HTTP_ERROR_FALLBACK;403",
      }),
    ).toEqual({
      kind: "http-access-fallback",
      statusCode: 403,
    });

    expect(resolveAppPageSpecialError({ digest: "not-special" })).toBeNull();
  });

  it("builds redirect and fallback responses while preserving fallback context behavior", async () => {
    const clearRequestContext = vi.fn();

    const redirectResponse = await buildAppPageSpecialErrorResponse({
      clearRequestContext,
      requestUrl: "https://example.com/start",
      specialError: {
        kind: "redirect",
        location: "/redirected",
        statusCode: 307,
      },
    });

    expect(redirectResponse.status).toBe(307);
    expect(redirectResponse.headers.get("location")).toBe("https://example.com/redirected");
    expect(clearRequestContext).toHaveBeenCalledTimes(1);

    clearRequestContext.mockClear();

    const fallbackResponse = await buildAppPageSpecialErrorResponse({
      clearRequestContext,
      renderFallbackPage(statusCode) {
        return Promise.resolve(new Response(`fallback:${statusCode}`, { status: statusCode }));
      },
      requestUrl: "https://example.com/start",
      specialError: {
        kind: "http-access-fallback",
        statusCode: 404,
      },
    });

    expect(fallbackResponse.status).toBe(404);
    await expect(fallbackResponse.text()).resolves.toBe("fallback:404");
    expect(clearRequestContext).not.toHaveBeenCalled();
  });

  it("falls back to a plain status response when no fallback page is available", async () => {
    const clearRequestContext = vi.fn();

    const response = await buildAppPageSpecialErrorResponse({
      clearRequestContext,
      renderFallbackPage() {
        return Promise.resolve(null);
      },
      requestUrl: "https://example.com/start",
      specialError: {
        kind: "http-access-fallback",
        statusCode: 401,
      },
    });

    expect(response.status).toBe(401);
    await expect(response.text()).resolves.toBe("Unauthorized");
    expect(clearRequestContext).toHaveBeenCalledTimes(1);
  });

  it("probes layouts from inner to outer and stops on a handled special response", async () => {
    const probedLayouts: number[] = [];

    const result = await probeAppPageLayouts({
      layoutCount: 3,
      async onLayoutError(error, layoutIndex) {
        expect(error).toBeInstanceOf(Error);
        return layoutIndex === 1 ? new Response("layout-fallback", { status: 404 }) : null;
      },
      probeLayoutAt(layoutIndex) {
        probedLayouts.push(layoutIndex);
        if (layoutIndex === 1) {
          throw new Error("layout failed");
        }
        return null;
      },
      runWithSuppressedHookWarning(probe) {
        return probe();
      },
    });

    expect(probedLayouts).toEqual([2, 1]);
    expect(result.response?.status).toBe(404);
    await expect(result.response?.text()).resolves.toBe("layout-fallback");
  });

  it("does not await async page probes when a loading boundary is present", async () => {
    const onError = vi.fn();

    const response = await probeAppPageComponent({
      awaitAsyncResult: false,
      onError,
      probePage() {
        return new Promise<void>(() => {});
      },
      runWithSuppressedHookWarning(probe) {
        return probe();
      },
    });

    expect(response).toBeNull();
    expect(onError).not.toHaveBeenCalled();
  });

  it("reads streamed text and captures RSC bytes when teeing the response stream", async () => {
    const capture = teeAppPageRscStreamForCapture(createStream(["flight-", "chunk"]), true);

    await expect(readAppPageTextStream(capture.responseStream)).resolves.toBe("flight-chunk");
    const captured = await capture.capturedRscDataPromise;
    expect(new TextDecoder().decode(captured ? new Uint8Array(captured) : undefined)).toBe(
      "flight-chunk",
    );
  });

  it("tracks per-layout dynamic usage when classification options are provided", async () => {
    const result = await probeAppPageLayouts({
      layoutCount: 3,
      onLayoutError() {
        return Promise.resolve(null);
      },
      probeLayoutAt() {
        return null;
      },
      runWithSuppressedHookWarning(probe) {
        return probe();
      },
      classification: {
        buildTimeClassifications: new Map([
          [0, "static"],
          [2, "dynamic"],
        ]),
        getLayoutId(layoutIndex) {
          return ["layout:/", "layout:/blog", "layout:/blog/post"][layoutIndex];
        },
        runWithIsolatedDynamicScope(fn) {
          return Promise.resolve({ result: fn(), dynamicDetected: false });
        },
      },
    });

    expect(result.response).toBeNull();
    // Layout 0 is build-time static, layout 2 is build-time dynamic
    // Layout 1 has no build-time classification, probed with no dynamic detected
    expect(result.layoutFlags).toEqual({
      "layout:/": "s",
      "layout:/blog": "s",
      "layout:/blog/post": "d",
    });
  });

  it("detects dynamic usage per-layout through isolated scope", async () => {
    let probeCallCount = 0;
    const result = await probeAppPageLayouts({
      layoutCount: 2,
      onLayoutError() {
        return Promise.resolve(null);
      },
      probeLayoutAt() {
        return null;
      },
      runWithSuppressedHookWarning(probe) {
        return probe();
      },
      classification: {
        getLayoutId(layoutIndex) {
          return ["layout:/", "layout:/dashboard"][layoutIndex];
        },
        runWithIsolatedDynamicScope(fn) {
          probeCallCount++;
          const result = fn();
          // Simulate: second probe call (layout 0, since we iterate inner-to-outer)
          // detects dynamic usage
          return Promise.resolve({
            result,
            dynamicDetected: probeCallCount === 2,
          });
        },
      },
    });

    expect(result.response).toBeNull();
    expect(result.layoutFlags).toEqual({
      "layout:/": "d",
      "layout:/dashboard": "s",
    });
  });

  it("returns empty layoutFlags when classification options are absent (backward compat)", async () => {
    const result = await probeAppPageLayouts({
      layoutCount: 2,
      onLayoutError() {
        return Promise.resolve(null);
      },
      probeLayoutAt() {
        return null;
      },
      runWithSuppressedHookWarning(probe) {
        return probe();
      },
    });

    expect(result.response).toBeNull();
    expect(result.layoutFlags).toEqual({});
  });

  it("defaults to dynamic flag when probe throws a non-special error", async () => {
    const result = await probeAppPageLayouts({
      layoutCount: 2,
      onLayoutError() {
        // Non-special error — return null (don't short-circuit)
        return Promise.resolve(null);
      },
      probeLayoutAt(layoutIndex) {
        if (layoutIndex === 1) throw new Error("use() outside render");
        return null;
      },
      runWithSuppressedHookWarning(probe) {
        return probe();
      },
      classification: {
        getLayoutId(layoutIndex) {
          return ["layout:/", "layout:/dashboard"][layoutIndex];
        },
        runWithIsolatedDynamicScope(fn) {
          // Re-throw so the catch path in probeAppPageLayouts fires
          return Promise.resolve(fn()).then((result) => ({ result, dynamicDetected: false }));
        },
      },
    });

    expect(result.response).toBeNull();
    // Layout 1 threw → conservatively flagged as dynamic
    expect(result.layoutFlags["layout:/dashboard"]).toBe("d");
    // Layout 0 probed successfully
    expect(result.layoutFlags["layout:/"]).toBe("s");
  });

  it("skips probe for build-time classified layouts", async () => {
    let probeCalls = 0;
    const result = await probeAppPageLayouts({
      layoutCount: 2,
      onLayoutError() {
        return Promise.resolve(null);
      },
      probeLayoutAt() {
        return null;
      },
      runWithSuppressedHookWarning(probe) {
        return probe();
      },
      classification: {
        buildTimeClassifications: new Map([
          [0, "static"],
          [1, "dynamic"],
        ]),
        getLayoutId(layoutIndex) {
          return ["layout:/", "layout:/admin"][layoutIndex];
        },
        runWithIsolatedDynamicScope(fn) {
          probeCalls++;
          return Promise.resolve({ result: fn(), dynamicDetected: false });
        },
      },
    });

    expect(probeCalls).toBe(0);
    expect(result.layoutFlags).toEqual({
      "layout:/": "s",
      "layout:/admin": "d",
    });
  });

  it("returns special error response when build-time classified layout throws during error probe", async () => {
    const layoutError = new Error("layout failed");
    const specialResponse = new Response("layout-fallback", { status: 404 });

    const result = await probeAppPageLayouts({
      layoutCount: 2,
      onLayoutError(error) {
        return Promise.resolve(error === layoutError ? specialResponse : null);
      },
      probeLayoutAt(layoutIndex) {
        if (layoutIndex === 1) throw layoutError;
        return null;
      },
      runWithSuppressedHookWarning(probe) {
        return probe();
      },
      classification: {
        buildTimeClassifications: new Map([
          [0, "static"],
          [1, "static"],
        ]),
        getLayoutId(layoutIndex) {
          return ["layout:/", "layout:/admin"][layoutIndex];
        },
        runWithIsolatedDynamicScope() {
          throw new Error("isolated scope must not run for build-time classified layouts");
        },
      },
    });

    // The special-error response from the throwing layout short-circuits the
    // loop. The flag for layout 1 is still recorded (set before the error
    // probe runs), and layout 0 is never reached.
    expect(result.response).toBe(specialResponse);
    expect(result.layoutFlags).toEqual({ "layout:/admin": "s" });
  });

  it("builds Link headers for preloaded app-page fonts", () => {
    expect(
      buildAppPageFontLinkHeader([
        { href: "/font-a.woff2", type: "font/woff2" },
        { href: "/font-b.woff2", type: "font/woff2" },
      ]),
    ).toBe(
      "</font-a.woff2>; rel=preload; as=font; type=font/woff2; crossorigin, </font-b.woff2>; rel=preload; as=font; type=font/woff2; crossorigin",
    );
  });
});
