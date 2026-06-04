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
    expect(response.headers.get("x-nextjs-cache")).toBe("MISS");
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

  // Matches Next.js's `pages-handler.ts` (revalidate: 0 →
  // getCacheControlHeader). gSSP responses with no user-set Cache-Control
  // must default to no-store so middlebox caches do not pin per-request
  // server-rendered HTML. See packages/vinext/src/server/dev-server.ts for
  // the dev-server twin. Fixes #1461.
  it("applies default no-store Cache-Control for gSSP responses without one", async () => {
    const common = createCommonOptions();

    const response = await renderPagesPageResponse({
      ...common.options,
      gsspRes: {
        statusCode: 200,
        getHeaders() {
          return { "x-test": "1" };
        },
      },
    });

    expect(response.headers.get("cache-control")).toBe(
      "private, no-cache, no-store, max-age=0, must-revalidate",
    );
  });

  it("preserves user-set Cache-Control from gSSP res.setHeader", async () => {
    const common = createCommonOptions();

    const response = await renderPagesPageResponse({
      ...common.options,
      gsspRes: {
        statusCode: 200,
        getHeaders() {
          return { "Cache-Control": "public, max-age=60" };
        },
      },
    });

    expect(response.headers.get("cache-control")).toBe("public, max-age=60");
  });

  it("preserves user-set Cache-Control regardless of header name case", async () => {
    const common = createCommonOptions();

    const response = await renderPagesPageResponse({
      ...common.options,
      gsspRes: {
        statusCode: 200,
        getHeaders() {
          return { "cache-control": "s-maxage=120" };
        },
      },
    });

    expect(response.headers.get("cache-control")).toBe("s-maxage=120");
  });

  it("lets ISR Cache-Control win over the gSSP default when both apply", async () => {
    const common = createCommonOptions();

    const response = await renderPagesPageResponse({
      ...common.options,
      gsspRes: {
        statusCode: 200,
        getHeaders() {
          return { "x-test": "1" };
        },
      },
      isrRevalidateSeconds: 60,
    });

    expect(response.headers.get("cache-control")).toBe("s-maxage=60, stale-while-revalidate");
  });

  it("does not set a gSSP default Cache-Control when there is no gSSP response", async () => {
    const common = createCommonOptions();

    const response = await renderPagesPageResponse({
      ...common.options,
      gsspRes: null,
    });

    expect(response.headers.get("cache-control")).toBeNull();
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

  // Regression test for #1468: custom `_document.getInitialProps` that wraps
  // `ctx.renderPage({ enhanceApp, enhanceComponent })` (e.g. for
  // styled-components, emotion) must run the enhancers around the page tree.
  //
  // Mirrors the contract in Next.js render.tsx (search `renderPage`) and the
  // styled-components integration test in
  // .nextjs-ref/test/development/basic/styled-components/pages/_document.js
  it("invokes _document.getInitialProps with a renderPage that runs enhanceApp/enhanceComponent", async () => {
    const common = createCommonOptions();
    const calls: string[] = [];

    // Custom Document.getInitialProps that wraps renderPage with enhancers,
    // styled-components style.
    function MyDocument() {
      return null;
    }
    (MyDocument as unknown as { getInitialProps: unknown }).getInitialProps = async (ctx: {
      renderPage: (opts?: {
        enhanceApp?: (App: React.ComponentType<{ children?: React.ReactNode }>) => unknown;
        enhanceComponent?: (Comp: React.ComponentType<unknown>) => unknown;
      }) => Promise<{ html: string; head?: React.ReactNode[] }> | { html: string };
    }) => {
      calls.push("getInitialProps");
      const result = await ctx.renderPage({
        enhanceApp: (App) => {
          calls.push("enhanceApp");
          return (props: { children?: React.ReactNode }) =>
            React.createElement(
              "div",
              { "data-enhanced-app": "true" },
              React.createElement(App, props),
            );
        },
        enhanceComponent: (Comp) => {
          calls.push("enhanceComponent");
          return Comp;
        },
      });
      return { html: result.html, head: [] };
    };

    // The enhancePageElement option exposes App/Component separation to the
    // SSR pipeline so the renderPage closure can rewrap them.
    function App({ children }: { children?: React.ReactNode }) {
      return React.createElement("section", { "data-app": "true" }, children);
    }
    function Page() {
      return React.createElement("p", null, "page");
    }
    const enhancePageElement = vi.fn(
      (opts: {
        enhanceApp?: (App: React.ComponentType<{ children?: React.ReactNode }>) => unknown;
        enhanceComponent?: (Comp: React.ComponentType<unknown>) => unknown;
      }) => {
        const FinalApp = opts.enhanceApp
          ? (opts.enhanceApp(App) as React.ComponentType<{ children?: React.ReactNode }>)
          : App;
        const FinalComp = opts.enhanceComponent
          ? (opts.enhanceComponent(Page) as React.ComponentType<unknown>)
          : Page;
        return React.createElement(FinalApp, null, React.createElement(FinalComp, null));
      },
    );

    // Use the real React renderer so the enhanced element actually
    // renders into the body — the default mock returns a fixed string.
    const reactDomServer = await import("react-dom/server.edge");
    const response = await renderPagesPageResponse({
      ...common.options,
      DocumentComponent: MyDocument as unknown as React.ComponentType,
      enhancePageElement,
      renderToReadableStream: async (element: React.ReactNode) =>
        await reactDomServer.renderToReadableStream(element as React.ReactElement),
    });

    const html = await response.text();
    // Both enhancers ran during renderPage.
    expect(calls).toContain("getInitialProps");
    expect(calls).toContain("enhanceApp");
    expect(calls).toContain("enhanceComponent");
    // The enhanced tree appears in the body (renderPage returned its html).
    expect(html).toContain('data-enhanced-app="true"');
    expect(html).toContain('data-app="true"');
    expect(html).toContain("<p>page</p>");
    expect(enhancePageElement).toHaveBeenCalledTimes(1);
  });

  // Edge case: `getInitialProps` returns `styles` (the styled-components /
  // emotion pattern collects style tags and returns them). They must be
  // rendered to a string and merged into the document head.
  it("renders styles returned from _document.getInitialProps into the head", async () => {
    const common = createCommonOptions();

    function MyDocument() {
      return null;
    }
    (MyDocument as unknown as { getInitialProps: unknown }).getInitialProps = async (ctx: {
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any
      renderPage: (opts?: any) => Promise<{ html: string }>;
    }) => {
      const result = await ctx.renderPage();
      return {
        html: result.html,
        styles: React.createElement("style", { "data-collected": "true" }, ".x{color:red}"),
      };
    };

    function Page() {
      return React.createElement("p", null, "page");
    }
    const enhancePageElement = vi.fn(() => React.createElement(Page, null));

    const reactDomServer = await import("react-dom/server.edge");
    // Spy on renderDocumentToString so we can confirm styles are rendered via
    // the shared helper. Falls back to the real renderer for the styles tree.
    const renderDocumentToString = vi.fn(async (element: React.ReactNode) => {
      const stream = await reactDomServer.renderToReadableStream(element as React.ReactElement);
      const text = await new Response(stream).text();
      // The document shell render still needs the NEXT placeholders.
      if (!text.includes("data-collected")) {
        return '<!DOCTYPE html><html><head></head><body><div id="__next">__NEXT_MAIN__</div><!-- __NEXT_SCRIPTS__ --></body></html>';
      }
      return text;
    });

    const response = await renderPagesPageResponse({
      ...common.options,
      DocumentComponent: MyDocument as unknown as React.ComponentType,
      enhancePageElement,
      renderDocumentToString,
      renderToReadableStream: async (element: React.ReactNode) =>
        await reactDomServer.renderToReadableStream(element as React.ReactElement),
    });

    const html = await response.text();
    // The collected <style> tag landed in the head.
    expect(html).toContain('data-collected="true"');
    expect(html).toContain(".x{color:red}");
    // The body still rendered.
    expect(html).toContain("<p>page</p>");
  });

  // Edge case: a user `getInitialProps` that throws must not crash the render —
  // the pipeline logs and falls back to the normal streaming page render.
  it("falls back to streaming render when _document.getInitialProps throws", async () => {
    const common = createCommonOptions();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    function MyDocument() {
      return null;
    }
    (MyDocument as unknown as { getInitialProps: unknown }).getInitialProps = async () => {
      throw new Error("boom");
    };

    const enhancePageElement = vi.fn(() => React.createElement("p", null, "enhanced"));

    const response = await renderPagesPageResponse({
      ...common.options,
      DocumentComponent: MyDocument as unknown as React.ComponentType,
      enhancePageElement,
    });

    const html = await response.text();
    // Fell back to the default streaming render (the common mock body), not
    // the enhanced renderPage output.
    expect(html).toContain("live-body");
    expect(html).not.toContain("enhanced");
    // enhancePageElement is only reached inside renderPage, which never ran.
    expect(enhancePageElement).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      "[vinext] _document.getInitialProps() threw:",
      expect.any(Error),
    );
    errorSpy.mockRestore();
  });

  // Edge case: a user `getInitialProps` that never calls `renderPage` (it only
  // returns head/styles) must fall back to the normal streaming render so the
  // body content is still produced.
  it("falls back to streaming render when getInitialProps never calls renderPage", async () => {
    const common = createCommonOptions();

    function MyDocument() {
      return null;
    }
    // Returns props without ever invoking ctx.renderPage.
    (MyDocument as unknown as { getInitialProps: unknown }).getInitialProps = async () => ({
      custom: "value",
    });

    const enhancePageElement = vi.fn(() => React.createElement("p", null, "enhanced"));

    const response = await renderPagesPageResponse({
      ...common.options,
      DocumentComponent: MyDocument as unknown as React.ComponentType,
      enhancePageElement,
    });

    const html = await response.text();
    // Body came from the streaming fallback, not renderPage.
    expect(html).toContain("live-body");
    expect(html).not.toContain("enhanced");
    expect(enhancePageElement).not.toHaveBeenCalled();
  });

  // Edge case: `renderPage` is called but the underlying stream render throws.
  // The error propagates out of `getInitialProps`, is caught by the shared
  // helper, and the pipeline falls back to the normal streaming render.
  it("falls back to streaming render when renderPage's stream render throws", async () => {
    const common = createCommonOptions();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    function MyDocument() {
      return null;
    }
    (MyDocument as unknown as { getInitialProps: unknown }).getInitialProps = async (ctx: {
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any
      renderPage: (opts?: any) => Promise<{ html: string }>;
    }) => {
      // Calling renderPage triggers renderToReadableStream, which throws below.
      const result = await ctx.renderPage();
      return { html: result.html };
    };

    const enhancePageElement = vi.fn(() => React.createElement("p", null, "enhanced"));

    let renderCall = 0;
    const response = await renderPagesPageResponse({
      ...common.options,
      DocumentComponent: MyDocument as unknown as React.ComponentType,
      enhancePageElement,
      renderToReadableStream: vi.fn(async () => {
        renderCall += 1;
        // First call is renderPage's render (throw); a later fallback call must
        // succeed so the page still renders.
        if (renderCall === 1) throw new Error("stream render failed");
        return createStream(["<div>live-body</div>"]);
      }),
    });

    const html = await response.text();
    // renderPage was reached (enhancePageElement ran) but the throw bubbled up
    // and the pipeline fell back to the normal streaming render.
    expect(enhancePageElement).toHaveBeenCalledTimes(1);
    expect(html).toContain("live-body");
    expect(html).not.toContain("enhanced");
    expect(errorSpy).toHaveBeenCalledWith(
      "[vinext] _document.getInitialProps() threw:",
      expect.any(Error),
    );
    errorSpy.mockRestore();
  });
});
