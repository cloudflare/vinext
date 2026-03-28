import React from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { renderPagesPageResponse } from "../packages/vinext/src/server/pages-page-response.js";

function createStream(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

function createCommonOptions() {
  const clearSsrContext = vi.fn();
  const createPageElement = vi.fn((pageProps: Record<string, unknown>) =>
    React.createElement("div", {
      "data-page": typeof pageProps.title === "string" ? pageProps.title : "",
    }),
  );
  const isrSet = vi.fn(async () => {});
  const renderDocumentToString = vi.fn(
    async () =>
      '<!DOCTYPE html><html><head></head><body><div id="__next">__NEXT_MAIN__</div><!-- __NEXT_SCRIPTS__ --></body></html>',
  );
  const renderIsrPassToStringAsync = vi.fn(async () => "<div>cached-body</div>");
  const renderToReadableStream = vi.fn(async () => createStream(["<div>live-body</div>"]));

  return {
    clearSsrContext,
    createPageElement,
    isrSet,
    renderDocumentToString,
    renderIsrPassToStringAsync,
    renderToReadableStream,
    options: {
      assetTags: '<script type="module" src="/entry.js" crossorigin></script>',
      buildId: "build-123",
      clearSsrContext,
      createPageElement,
      DocumentComponent: function TestDocument() {
        return null;
      },
      flushPreloads: vi.fn(async () => {}),
      fontLinkHeader: "</font.woff2>; rel=preload; as=font; type=font/woff2; crossorigin",
      fontPreloads: [{ href: "/font.woff2", type: "font/woff2" }],
      getFontLinks: vi.fn(() => ["/font.css"]),
      getFontStyles: vi.fn(() => [".font { font-family: Test; }"]),
      getSSRHeadHTML: vi.fn(() => '<meta name="test-head" content="1" />'),
      gsspRes: null,
      isrCacheKey(_router: string, pathname: string) {
        return `pages:${pathname}`;
      },
      isrRevalidateSeconds: null,
      isrSet,
      i18n: {
        locale: "en",
        locales: ["en", "fr"],
        defaultLocale: "en",
        domainLocales: [{ domain: "example.com", defaultLocale: "en", locales: ["en"] }],
      },
      pageProps: { title: "hello" },
      params: { slug: "post" },
      renderDocumentToString,
      renderIsrPassToStringAsync,
      renderToReadableStream,
      resetSSRHead: vi.fn(),
      routePattern: "/posts/[slug]",
      routeUrl: "/posts/post",
      safeJsonStringify(value: unknown) {
        return JSON.stringify(value);
      },
    },
  };
}

describe("pages page response", () => {
  it("renders the document shell, merges gSSP headers, and marks streamed HTML responses", async () => {
    const common = createCommonOptions();

    const response = await renderPagesPageResponse({
      ...common.options,
      gsspRes: {
        statusCode: 201,
        getHeaders() {
          return {
            "content-type": "application/json",
            "x-test": "1",
          };
        },
      },
    });

    expect(response.status).toBe(201);
    expect(response.headers.get("content-type")).toBe("text/html");
    expect(response.headers.get("x-test")).toBe("1");
    expect(response.headers.get("link")).toBe(
      "</font.woff2>; rel=preload; as=font; type=font/woff2; crossorigin",
    );
    expect(
      (response as Response & { __vinextStreamedHtmlResponse?: boolean })
        .__vinextStreamedHtmlResponse,
    ).toBe(true);

    const html = await response.text();
    expect(html).toContain("<div>live-body</div>");
    expect(html).toContain('<meta name="test-head" content="1" />');
    expect(html).toContain('<link rel="stylesheet" href="/font.css" />');
    expect(html).toContain("window.__NEXT_DATA__");
    expect(html).toContain("__VINEXT_LOCALE__");

    expect(common.clearSsrContext).toHaveBeenCalledTimes(1);
    expect(common.renderDocumentToString).toHaveBeenCalledTimes(1);
  });

  it("preserves array-valued non-set-cookie headers from gSSP responses", async () => {
    const common = createCommonOptions();

    const response = await renderPagesPageResponse({
      ...common.options,
      gsspRes: {
        statusCode: 200,
        getHeaders() {
          return {
            vary: ["Accept", "Accept-Encoding"],
            "set-cookie": ["a=1; Path=/", "b=2; Path=/"],
            "x-custom": 42,
          };
        },
      },
    });

    expect(response.headers.get("vary")).toBe("Accept, Accept-Encoding");
    expect(response.headers.get("x-custom")).toBe("42");
    expect(response.headers.getSetCookie()).toEqual(["a=1; Path=/", "b=2; Path=/"]);
  });

  it("writes the ISR HTML cache entry for cacheable page responses", async () => {
    const common = createCommonOptions();

    const response = await renderPagesPageResponse({
      ...common.options,
      DocumentComponent: null,
      getSSRHeadHTML: undefined,
      isrRevalidateSeconds: 60,
      routeUrl: "/posts/post?draft=0",
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("s-maxage=60, stale-while-revalidate");
    expect(response.headers.get("x-vinext-cache")).toBe("MISS");
    await expect(response.text()).resolves.toContain("<div>live-body</div>");

    expect(common.createPageElement).toHaveBeenCalledTimes(2);
    expect(common.renderIsrPassToStringAsync).toHaveBeenCalledTimes(1);
    expect(common.isrSet).toHaveBeenCalledTimes(1);
    expect(common.isrSet).toHaveBeenCalledWith(
      "pages:/posts/post",
      expect.objectContaining({
        kind: "PAGES",
        html: expect.stringContaining("<div>cached-body</div>"),
        pageData: { title: "hello" },
      }),
      60,
    );
  });
});
