import { describe, expect, it } from "vite-plus/test";
import React from "react";
import { renderAppPageCacheArtifacts } from "../packages/vinext/src/server/app-page-cache-render.js";
import { _setRequestScopedCacheLife } from "../packages/vinext/src/shims/cache-request-state.js";
import { registerFrameworkTracingIntegration } from "../packages/vinext/src/server/tracer.js";
import type {
  FrameworkTracingBackendSpan,
  ResolvedFrameworkSpanDescriptor,
} from "../packages/vinext/src/server/framework-tracer.js";

type RecordedSpan = {
  errors: unknown[];
  status?: string;
  type: string;
};

const recordedSpans: RecordedSpan[] = [];
registerFrameworkTracingIntegration({
  id: "app-page-cache-render-test",
  enterSpan<T>(
    descriptor: ResolvedFrameworkSpanDescriptor,
    callback: (span: FrameworkTracingBackendSpan) => T,
  ): T {
    const recorded: RecordedSpan = { errors: [], type: descriptor.type };
    recordedSpans.push(recorded);
    return callback({
      recordException: (error) => recorded.errors.push(error),
      setAttribute() {},
      setErrorStatus: (message) => {
        recorded.status = message ?? "error";
      },
    });
  },
});

function createStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

describe("renderAppPageCacheArtifacts", () => {
  it("records a recovered regeneration error on the exact framework span", async () => {
    recordedSpans.length = 0;
    const failure = new TypeError("recovered regeneration failure");

    await renderAppPageCacheArtifacts({
      captureRscData: false,
      cleanPathname: "/posts/post",
      element: React.createElement("div", null, "page"),
      getFontLinks: () => [],
      getFontPreloads: () => [],
      getFontStyles: () => [],
      getNavigationContext: () => null,
      loadSsrHandler: async () => ({
        async handleSsr() {
          return createStream(["<html>error boundary</html>"]);
        },
      }),
      navigationParams: {},
      onError: () => undefined,
      renderToReadableStream(_element, { onError }) {
        onError(failure, undefined, undefined);
        return createStream(["error flight"]);
      },
      route: { pattern: "/posts/[slug]", routeSegments: [] },
    });

    expect(recordedSpans).toContainEqual({
      errors: [failure],
      status: "recovered regeneration failure",
      type: "AppRender.getBodyResult",
    });
  });

  it("does not mark well-known SSR control flow as a regeneration failure", async () => {
    recordedSpans.length = 0;

    await renderAppPageCacheArtifacts({
      captureRscData: false,
      cleanPathname: "/posts/post",
      element: React.createElement("div", null, "page"),
      getFontLinks: () => [],
      getFontPreloads: () => [],
      getFontStyles: () => [],
      getNavigationContext: () => null,
      isCapturedRscError: () => false,
      loadSsrHandler: async () => ({
        async handleSsr(_stream, _navigation, _fontData, options) {
          options?.onSsrError?.({ digest: "NEXT_REDIRECT;replace;%2Ftarget;307" });
          return createStream(["<html>redirect</html>"]);
        },
      }),
      navigationParams: {},
      onError: () => undefined,
      onSsrError: () => undefined,
      renderToReadableStream: () => createStream(["redirect flight"]),
      route: { pattern: "/posts/[slug]", routeSegments: [] },
    });

    expect(recordedSpans).toContainEqual({
      errors: [],
      type: "AppRender.getBodyResult",
    });
  });

  it("marks regenerated HTML as static generation for client navigation hooks", async () => {
    let receivedOptions: { isStaticGeneration?: boolean; isForceStatic?: boolean } | undefined;

    await renderAppPageCacheArtifacts({
      captureRscData: false,
      cleanPathname: "/posts/post",
      element: React.createElement("div", null, "page"),
      getFontLinks: () => [],
      getFontPreloads: () => [],
      getFontStyles: () => [],
      getNavigationContext: () => null,
      isForceStatic: true,
      loadSsrHandler: async () => ({
        async handleSsr(_rscStream, _navigationContext, _fontData, options) {
          receivedOptions = options;
          return createStream(["<html>page</html>"]);
        },
      }),
      navigationParams: {},
      onError: () => undefined,
      renderToReadableStream: () => createStream(["flight-data"]),
      route: { pattern: "/posts/[slug]", routeSegments: [] },
    });

    expect(receivedOptions).toEqual(
      expect.objectContaining({ isStaticGeneration: true, isForceStatic: true }),
    );
  });

  it("carries the consumed cacheLife stale onto the regenerated cacheControl", async () => {
    // Regression: background regeneration goes through this producer, and its
    // cacheControl feeds resolveRegeneratedAppPageCacheControl. Dropping stale
    // here silently widened client reuse back to the configured fallback after
    // the first regen — the mocked-cacheControl regen tests never caught it
    // because they supplied a `stale` this producer could not emit.
    const result = await renderAppPageCacheArtifacts({
      captureRscData: false,
      cleanPathname: "/posts/post",
      element: React.createElement("div", null, "page"),
      getFontLinks: () => [],
      getFontPreloads: () => [],
      getFontStyles: () => [],
      getNavigationContext: () => null,
      loadSsrHandler: async () => ({
        async handleSsr() {
          // A `use cache` scope resolving during the render.
          _setRequestScopedCacheLife({ stale: 30, revalidate: 1, expire: 60 });
          return createStream(["<html>page</html>"]);
        },
      }),
      navigationParams: {},
      onError: () => undefined,
      renderToReadableStream: () => createStream(["flight-data"]),
      route: { pattern: "/posts/[slug]", routeSegments: [] },
    });

    expect(result.cacheControl).toEqual({ revalidate: 1, expire: 60, stale: 30 });
    expect(result.html).toBe("<html>page</html>");
  });
});
