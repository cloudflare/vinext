import { describe, expect, it } from "vite-plus/test";
import React from "react";
import { renderAppPageCacheArtifacts } from "../packages/vinext/src/server/app-page-cache-render.js";
import { _setRequestScopedCacheLife } from "../packages/vinext/src/shims/cache-request-state.js";

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
