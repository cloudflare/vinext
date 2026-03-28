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

    const response = await probeAppPageLayouts({
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
    expect(response?.status).toBe(404);
    await expect(response?.text()).resolves.toBe("layout-fallback");
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
