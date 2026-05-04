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

function createMiddlewareContext() {
  const headers = new Headers();
  headers.set("x-middleware-security", "present");
  headers.append("set-cookie", "session=rotated; Path=/; HttpOnly");
  headers.set("vary", "x-auth-state");

  return {
    headers,
    status: 299,
  };
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
      isRscRequest: false,
      middlewareContext: createMiddlewareContext(),
      request: new Request("https://example.com/start"),
      specialError: {
        kind: "redirect",
        location: "/redirected",
        statusCode: 307,
      },
    });

    expect(redirectResponse.status).toBe(307);
    expect(redirectResponse.headers.get("location")).toBe("https://example.com/redirected");
    expect(redirectResponse.headers.get("x-middleware-security")).toBe("present");
    expect(redirectResponse.headers.get("vary")).toBe("x-auth-state");
    expect(redirectResponse.headers.getSetCookie()).toContain("session=rotated; Path=/; HttpOnly");
    expect(clearRequestContext).toHaveBeenCalledTimes(1);

    clearRequestContext.mockClear();

    const fallbackResponse = await buildAppPageSpecialErrorResponse({
      clearRequestContext,
      isRscRequest: false,
      middlewareContext: createMiddlewareContext(),
      renderFallbackPage(statusCode) {
        return Promise.resolve(
          new Response(`fallback:${statusCode}`, {
            headers: { Vary: "RSC, Accept" },
            status: statusCode,
          }),
        );
      },
      request: new Request("https://example.com/start"),
      specialError: {
        kind: "http-access-fallback",
        statusCode: 404,
      },
    });

    expect(fallbackResponse.status).toBe(404);
    expect(fallbackResponse.headers.get("x-middleware-security")).toBe("present");
    expect(fallbackResponse.headers.get("vary")).toBe("RSC, Accept, x-auth-state");
    expect(fallbackResponse.headers.getSetCookie()).toContain("session=rotated; Path=/; HttpOnly");
    expect(
      fallbackResponse.headers
        .getSetCookie()
        .filter((cookie) => cookie === "session=rotated; Path=/; HttpOnly"),
    ).toHaveLength(1);
    await expect(fallbackResponse.text()).resolves.toBe("fallback:404");
    expect(clearRequestContext).not.toHaveBeenCalled();
  });

  it("falls back to a plain status response when no fallback page is available", async () => {
    const clearRequestContext = vi.fn();

    const response = await buildAppPageSpecialErrorResponse({
      clearRequestContext,
      isRscRequest: false,
      middlewareContext: createMiddlewareContext(),
      renderFallbackPage() {
        return Promise.resolve(null);
      },
      request: new Request("https://example.com/start"),
      specialError: {
        kind: "http-access-fallback",
        statusCode: 401,
      },
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("x-middleware-security")).toBe("present");
    expect(response.headers.get("vary")).toBe("x-auth-state");
    expect(response.headers.getSetCookie()).toContain("session=rotated; Path=/; HttpOnly");
    await expect(response.text()).resolves.toBe("Unauthorized");
    expect(clearRequestContext).toHaveBeenCalledTimes(1);
  });

  it("canonicalizes same-origin RSC redirect locations to .rsc URLs", async () => {
    const response = await buildAppPageSpecialErrorResponse({
      clearRequestContext: vi.fn(),
      isRscRequest: true,
      request: new Request("https://example.com/start.rsc", {
        headers: {
          Accept: "text/x-component",
          RSC: "1",
          "Next-Router-State-Tree": "tree",
        },
      }),
      specialError: {
        kind: "redirect",
        location: "/redirected?tab=1",
        statusCode: 307,
      },
    });

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toMatch(
      /^https:\/\/example\.com\/redirected\.rsc\?tab=1&_rsc=/,
    );
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

  it("produces fused ssrStream + sideStream when capturing (#981)", async () => {
    const capture = teeAppPageRscStreamForCapture(createStream(["flight-", "chunk"]), true);

    // ssrStream is for createFromReadableStream (SSR)
    expect(capture.ssrStream).toBeInstanceOf(ReadableStream);
    // sideStream is for embed+capture
    expect(capture.sideStream).toBeInstanceOf(ReadableStream);

    // Both streams should contain identical data (teed from same source)
    const ssrText = await readAppPageTextStream(capture.ssrStream);
    const sideText = await readAppPageTextStream(capture.sideStream!);
    expect(ssrText).toBe("flight-chunk");
    expect(sideText).toBe("flight-chunk");
  });

  it("bypasses tee when not capturing (#981)", async () => {
    const stream = createStream(["no-capture"]);
    const capture = teeAppPageRscStreamForCapture(stream, false);

    // When not capturing, no tee — the original stream is returned as ssrStream
    expect(capture.ssrStream).toBe(stream);
    expect(capture.sideStream).toBeUndefined();
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

  it("isolates dynamic usage across throwing layout probes", async () => {
    let dynamicUsageDetected = false;

    const result = await probeAppPageLayouts({
      layoutCount: 2,
      onLayoutError() {
        return Promise.resolve(null);
      },
      probeLayoutAt(layoutIndex) {
        if (layoutIndex === 1) {
          dynamicUsageDetected = true;
          throw new Error("layout failed after headers()");
        }
        return null;
      },
      runWithSuppressedHookWarning(probe) {
        return probe();
      },
      classification: {
        getLayoutId(layoutIndex) {
          return ["layout:/", "layout:/dashboard"][layoutIndex];
        },
        async runWithIsolatedDynamicScope(fn) {
          const priorDynamic = dynamicUsageDetected;
          dynamicUsageDetected = false;
          try {
            const result = await fn();
            const detectedInScope = dynamicUsageDetected;
            dynamicUsageDetected = false;
            return { result, dynamicDetected: detectedInScope };
          } finally {
            dynamicUsageDetected = false;
            if (priorDynamic) dynamicUsageDetected = true;
          }
        },
      },
    });

    expect(result.response).toBeNull();
    expect(result.layoutFlags).toEqual({
      "layout:/": "s",
      "layout:/dashboard": "d",
    });
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

  it("does not read build-time reasons when debugClassification is absent", async () => {
    const throwingReasons = {
      get() {
        throw new Error("build-time reasons should stay dormant when debug is disabled");
      },
    } as unknown as ReadonlyMap<number, { layer: "segment-config"; key: "dynamic"; value: string }>;

    await probeAppPageLayouts({
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
        buildTimeReasons: throwingReasons,
        getLayoutId(layoutIndex) {
          return ["layout:/", "layout:/admin"][layoutIndex];
        },
        runWithIsolatedDynamicScope(fn) {
          return Promise.resolve({ result: fn(), dynamicDetected: false });
        },
      },
    });
  });

  it("emits a debug reason per layout when debugClassification is provided with build-time reasons", async () => {
    const calls: Array<{ layoutId: string; reason: unknown }> = [];

    await probeAppPageLayouts({
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
          [1, "dynamic"],
          [2, "static"],
        ]),
        buildTimeReasons: new Map([
          [0, { layer: "segment-config", key: "dynamic", value: "force-static" }],
          [1, { layer: "segment-config", key: "dynamic", value: "force-dynamic" }],
          [2, { layer: "module-graph", result: "static" }],
        ]),
        debugClassification(layoutId, reason) {
          calls.push({ layoutId, reason });
        },
        getLayoutId(layoutIndex) {
          return ["layout:/", "layout:/admin", "layout:/admin/posts"][layoutIndex];
        },
        runWithIsolatedDynamicScope(fn) {
          return Promise.resolve({ result: fn(), dynamicDetected: false });
        },
      },
    });

    expect(calls).toHaveLength(3);
    const byId = Object.fromEntries(calls.map((c) => [c.layoutId, c.reason]));
    expect(byId["layout:/"]).toEqual({
      layer: "segment-config",
      key: "dynamic",
      value: "force-static",
    });
    expect(byId["layout:/admin"]).toEqual({
      layer: "segment-config",
      key: "dynamic",
      value: "force-dynamic",
    });
    expect(byId["layout:/admin/posts"]).toEqual({
      layer: "module-graph",
      result: "static",
    });
  });

  it("emits runtime-probe reason for layouts resolved by the Layer 3 probe", async () => {
    const calls: Array<{ layoutId: string; reason: unknown }> = [];
    let probeCalls = 0;

    await probeAppPageLayouts({
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
        // No buildTimeClassifications → every layout takes the runtime path.
        debugClassification(layoutId, reason) {
          calls.push({ layoutId, reason });
        },
        getLayoutId(layoutIndex) {
          return ["layout:/", "layout:/dashboard"][layoutIndex];
        },
        runWithIsolatedDynamicScope(fn) {
          probeCalls++;
          // probeAppPageLayouts iterates inner-to-outer:
          // first call → layout 1 (dashboard) → dynamic
          // second call → layout 0 (root) → static
          return Promise.resolve({ result: fn(), dynamicDetected: probeCalls === 1 });
        },
      },
    });

    expect(calls).toHaveLength(2);
    const byId = Object.fromEntries(calls.map((c) => [c.layoutId, c.reason]));
    expect(byId["layout:/dashboard"]).toEqual({
      layer: "runtime-probe",
      outcome: "dynamic",
    });
    expect(byId["layout:/"]).toEqual({
      layer: "runtime-probe",
      outcome: "static",
    });
  });

  it("emits runtime-probe reason with the error message when the probe throws", async () => {
    const calls: Array<{ layoutId: string; reason: unknown }> = [];

    await probeAppPageLayouts({
      layoutCount: 2,
      onLayoutError() {
        return Promise.resolve(null);
      },
      probeLayoutAt(layoutIndex) {
        if (layoutIndex === 1) throw new Error("headers() outside render");
        return null;
      },
      runWithSuppressedHookWarning(probe) {
        return probe();
      },
      classification: {
        debugClassification(layoutId, reason) {
          calls.push({ layoutId, reason });
        },
        getLayoutId(layoutIndex) {
          return ["layout:/", "layout:/dashboard"][layoutIndex];
        },
        runWithIsolatedDynamicScope(fn) {
          return Promise.resolve(fn()).then((result) => ({ result, dynamicDetected: false }));
        },
      },
    });

    const byId = Object.fromEntries(calls.map((c) => [c.layoutId, c.reason]));
    expect(byId["layout:/dashboard"]).toEqual({
      layer: "runtime-probe",
      outcome: "dynamic",
      error: "headers() outside render",
    });
    expect(byId["layout:/"]).toEqual({
      layer: "runtime-probe",
      outcome: "static",
    });
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
