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

function createByteStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

function createFailingStream(error: Error): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("<div>partial"));
      controller.error(error);
    },
  });
}

async function settleMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
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

  it("records the streamed body into the ISR HTML cache without a second page render", async () => {
    const common = createCommonOptions();

    const response = await renderPagesPageResponse({
      ...common.options,
      DocumentComponent: null,
      expireSeconds: 300,
      getSSRHeadHTML: undefined,
      isrRevalidateSeconds: 60,
      routeUrl: "/posts/post?draft=0",
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("s-maxage=60, stale-while-revalidate=240");
    expect(response.headers.get("x-vinext-cache")).toBe("MISS");
    await expect(response.text()).resolves.toContain("<div>live-body</div>");
    await settleMicrotasks();

    expect(common.createPageElement).toHaveBeenCalledTimes(1);
    expect(common.renderIsrPassToStringAsync).not.toHaveBeenCalled();
    expect(common.isrSet).toHaveBeenCalledTimes(1);
    expect(common.isrSet).toHaveBeenCalledWith(
      "pages:/posts/post",
      expect.objectContaining({
        kind: "PAGES",
        html: expect.stringContaining("<div>live-body</div>"),
        pageData: { title: "hello" },
      }),
      60,
      undefined,
      300,
    );
  });

  it("records split UTF-8 chunks without corrupting cached ISR HTML", async () => {
    const common = createCommonOptions();
    common.renderToReadableStream.mockResolvedValue(
      createByteStream([
        new Uint8Array([0xe2]),
        new Uint8Array([0x82, 0xac]),
        new TextEncoder().encode("<div>live-body</div>"),
      ]),
    );

    const response = await renderPagesPageResponse({
      ...common.options,
      isrRevalidateSeconds: 60,
    });

    await expect(response.text()).resolves.toContain("\u20ac<div>live-body</div>");
    await settleMicrotasks();

    expect(common.isrSet).toHaveBeenCalledWith(
      "pages:/posts/post",
      expect.objectContaining({
        html: expect.stringContaining("\u20ac<div>live-body</div>"),
      }),
      60,
      undefined,
      undefined,
    );
  });

  it("does not write a Pages ISR cache entry when the streamed render fails", async () => {
    const common = createCommonOptions();
    common.renderToReadableStream.mockResolvedValue(
      createFailingStream(new Error("stream failed")),
    );
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const response = await renderPagesPageResponse({
        ...common.options,
        isrRevalidateSeconds: 60,
      });

      await expect(response.text()).rejects.toThrow("stream failed");
      await settleMicrotasks();

      expect(common.renderIsrPassToStringAsync).not.toHaveBeenCalled();
      expect(common.isrSet).not.toHaveBeenCalled();
      expect(consoleError).toHaveBeenCalledWith(
        "[vinext] Pages ISR cache write failed for pages:/posts/post:",
        expect.any(Error),
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it("adds nonce attributes to inline scripts and font tags when provided", async () => {
    const common = createCommonOptions();

    const response = await renderPagesPageResponse({
      ...common.options,
      assetTags:
        '<link rel="modulepreload" nonce="pages-test-nonce" href="/entry.js" />\n' +
        '<script type="module" nonce="pages-test-nonce" src="/entry.js" crossorigin></script>',
      scriptNonce: "pages-test-nonce",
    });

    const html = await response.text();
    expect(html).toContain('<script nonce="pages-test-nonce">window.__NEXT_DATA__ = ');
    expect(html).toContain('<link rel="stylesheet" nonce="pages-test-nonce" href="/font.css" />');
    expect(html).toContain(
      '<link rel="preload" nonce="pages-test-nonce" href="/font.woff2" as="font" type="font/woff2" crossorigin />',
    );
    expect(html).toContain('<style data-vinext-fonts nonce="pages-test-nonce">');
    expect(html).toContain(
      '<script type="module" nonce="pages-test-nonce" src="/entry.js" crossorigin></script>',
    );
  });

  it("renders page before collecting SSR head HTML to prevent style race conditions", async () => {
    // Ported from Next.js: vercel/next.js@9853944
    // styled-jsx (and <Head>) styles must be collected AFTER rendering completes,
    // not concurrently. Otherwise dynamic styles that are registered during
    // rendering are silently dropped from the HTML output.
    const common = createCommonOptions();
    const callOrder: string[] = [];

    common.renderToReadableStream.mockImplementation(async () => {
      // Verify getSSRHeadHTML has NOT been called yet
      expect(common.options.getSSRHeadHTML).not.toHaveBeenCalled();
      callOrder.push("render");
      // Return the original stream by calling the original factory
      return createStream(["<div>live-body</div>"]);
    });

    (common.options.getSSRHeadHTML as ReturnType<typeof vi.fn>).mockImplementation(() => {
      callOrder.push("head");
      return '<meta name="test-head" content="1" />';
    });

    await renderPagesPageResponse(common.options);

    expect(callOrder).toEqual(["render", "head"]);
  });

  it("clears SSR context only after rendering, not before", async () => {
    const common = createCommonOptions();
    const callOrder: string[] = [];

    common.renderToReadableStream.mockImplementation(async () => {
      // Verify clearSsrContext has NOT been called yet
      expect(common.clearSsrContext).not.toHaveBeenCalled();
      callOrder.push("render");
      return createStream(["<div>live-body</div>"]);
    });

    common.clearSsrContext.mockImplementation(() => {
      callOrder.push("clear");
    });

    await renderPagesPageResponse(common.options);

    expect(callOrder).toEqual(["render", "clear"]);
  });

  it("disables pages ISR caching when a script nonce is present", async () => {
    const common = createCommonOptions();

    const response = await renderPagesPageResponse({
      ...common.options,
      isrRevalidateSeconds: 60,
      scriptNonce: "pages-test-nonce",
    });

    expect(response.headers.get("cache-control")).toBe("no-store, must-revalidate");
    expect(response.headers.get("x-vinext-cache")).toBeNull();
    expect(common.renderIsrPassToStringAsync).not.toHaveBeenCalled();
    expect(common.isrSet).not.toHaveBeenCalled();
  });
});
