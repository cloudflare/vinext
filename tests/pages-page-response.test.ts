import React from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  renderPagesPageResponse,
  isPagesStreamingBot,
  generatePagesETag,
  etagMatches,
} from "../packages/vinext/src/server/pages-page-response.js";
import { resolvePagesPageData } from "../packages/vinext/src/server/pages-page-data.js";

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

describe("isPagesStreamingBot", () => {
  it("detects Googlebot as a streaming bot", () => {
    expect(isPagesStreamingBot("Googlebot")).toBe(true);
    expect(isPagesStreamingBot("Googlebot/2.1")).toBe(true);
  });

  it("does not match Googlebot suffixed variants (Googlebot-Image etc.)", () => {
    // Googlebot-Image executes no JS so streaming is safe; the regex only
    // blocks the main Googlebot (and the Google-* prefix bots below).
    expect(isPagesStreamingBot("Googlebot-Image/1.0")).toBe(false);
    expect(isPagesStreamingBot("Googlebot-News")).toBe(false);
  });

  it("detects Google-PageRenderer via the HTML_LIMITED_BOT_UA_RE", () => {
    expect(
      isPagesStreamingBot(
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/56.0.2924.87 Safari/537.36 Google-PageRenderer Google (+https://developers.google.com/+/web/snippet/)",
      ),
    ).toBe(true);
  });

  it("detects other known HTML-limited bots", () => {
    expect(isPagesStreamingBot("Bingbot/2.0")).toBe(true);
    expect(isPagesStreamingBot("facebookexternalhit/1.1")).toBe(true);
    expect(isPagesStreamingBot("Twitterbot/1.0")).toBe(true);
    expect(isPagesStreamingBot("Slackbot-LinkExpanding 1.0")).toBe(true);
  });

  it("returns false for normal browser User-Agents", () => {
    expect(
      isPagesStreamingBot(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36",
      ),
    ).toBe(false);
    expect(isPagesStreamingBot("curl/7.88.1")).toBe(false);
    expect(isPagesStreamingBot("")).toBe(false);
  });
});

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
    expect(html).toContain('<script id="__NEXT_DATA__" type="application/json">');
    const nextDataMatch = html.match(
      /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/,
    );
    expect(nextDataMatch).not.toBeNull();
    expect(JSON.parse(nextDataMatch![1]!)).toMatchObject({
      locale: "en",
      locales: ["en", "fr"],
      defaultLocale: "en",
    });

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
    expect(html).toContain(
      '<script id="__NEXT_DATA__" type="application/json" nonce="pages-test-nonce">',
    );
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

  it("passes req/res into _document.getInitialProps and applies res headers/status", async () => {
    const common = createCommonOptions();
    const documentHeaders: Record<string, string | number | boolean | string[]> = {};
    const documentRes = {
      headersSent: false,
      statusCode: 200,
      getHeaders: () => documentHeaders,
      setHeader(name: string, value: string | number | boolean | string[]) {
        documentHeaders[name] = value;
      },
    };

    function MyDocument() {
      return null;
    }
    (MyDocument as unknown as { getInitialProps: unknown }).getInitialProps = async (ctx: {
      req?: { cookies?: Record<string, string> };
      res?: typeof documentRes;
      renderPage: () => Promise<{ html: string }>;
    }) => {
      ctx.res?.setHeader("x-document-cookie", ctx.req?.cookies?.theme ?? "missing");
      if (ctx.res) ctx.res.statusCode = 202;
      const result = await ctx.renderPage();
      return { html: result.html };
    };

    const response = await renderPagesPageResponse({
      ...common.options,
      DocumentComponent: MyDocument as unknown as React.ComponentType,
      documentReqRes: {
        req: { cookies: { theme: "dark" } },
        res: documentRes,
      },
      enhancePageElement: () => React.createElement("p", null, "page"),
    });

    expect(response.status).toBe(202);
    expect(response.headers.get("x-document-cookie")).toBe("dark");
    expect(await response.text()).toContain("live-body");
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

  it("uses custom document html and styles without calling renderPage", async () => {
    const common = createCommonOptions();

    function MyDocument() {
      return null;
    }
    (MyDocument as unknown as { getInitialProps: unknown }).getInitialProps = async () => ({
      html: '<article id="manual-document-html">MANUAL</article>',
      styles: React.createElement(
        "style",
        { "data-manual-document-style": true },
        ".manual{color:blue}",
      ),
    });

    const enhancePageElement = vi.fn(() => React.createElement("p", null, "page"));
    const reactDomServer = await import("react-dom/server.edge");
    const renderToReadableStream = vi.fn(async (element: React.ReactNode) =>
      reactDomServer.renderToReadableStream(element as React.ReactElement),
    );

    const response = await renderPagesPageResponse({
      ...common.options,
      DocumentComponent: MyDocument as unknown as React.ComponentType,
      enhancePageElement,
      renderToReadableStream,
    });
    const html = await response.text();

    expect(html).toContain('id="manual-document-html">MANUAL');
    expect(html).toContain("data-manual-document-style");
    expect(html).toContain(".manual{color:blue}");
    expect(html).not.toContain("live-body");
    expect(enhancePageElement).not.toHaveBeenCalled();
    expect(renderToReadableStream).toHaveBeenCalledTimes(1);
  });

  it("propagates _document.getInitialProps errors without rendering the page", async () => {
    const common = createCommonOptions();

    function MyDocument() {
      return null;
    }
    (MyDocument as unknown as { getInitialProps: unknown }).getInitialProps = async () => {
      throw new Error("boom");
    };

    const enhancePageElement = vi.fn(() => React.createElement("p", null, "enhanced"));

    await expect(
      renderPagesPageResponse({
        ...common.options,
        DocumentComponent: MyDocument as unknown as React.ComponentType,
        enhancePageElement,
      }),
    ).rejects.toThrow("boom");

    expect(enhancePageElement).not.toHaveBeenCalled();
  });

  it.each([undefined, null, 42, {}])(
    "rejects invalid _document html %j without rendering the page",
    async (html) => {
      const common = createCommonOptions();

      function MyDocument() {
        return null;
      }
      (MyDocument as unknown as { getInitialProps: unknown }).getInitialProps = async () => ({
        html,
      });

      const enhancePageElement = vi.fn(() => React.createElement("p", null, "enhanced"));
      const renderToReadableStream = vi.fn(common.options.renderToReadableStream);

      await expect(
        renderPagesPageResponse({
          ...common.options,
          DocumentComponent: MyDocument as unknown as React.ComponentType,
          enhancePageElement,
          renderToReadableStream,
        }),
      ).rejects.toThrow('should resolve to an object with a "html" prop');

      expect(enhancePageElement).not.toHaveBeenCalled();
      expect(renderToReadableStream).not.toHaveBeenCalled();
    },
  );

  it("propagates _document style serialization errors", async () => {
    const common = createCommonOptions();

    function MyDocument() {
      return null;
    }
    (MyDocument as unknown as { getInitialProps: unknown }).getInitialProps = async (ctx: {
      renderPage: () => Promise<{ html: string }>;
    }) => ({ ...(await ctx.renderPage()), styles: React.createElement("style") });

    const enhancePageElement = vi.fn(() => React.createElement("p", null, "enhanced"));
    const renderToReadableStream = vi.fn(async () => {
      if (renderToReadableStream.mock.calls.length === 1) return createStream(["enhanced"]);
      throw new Error("style serialization failed");
    });

    await expect(
      renderPagesPageResponse({
        ...common.options,
        DocumentComponent: MyDocument as unknown as React.ComponentType,
        enhancePageElement,
        renderToReadableStream,
      }),
    ).rejects.toThrow("style serialization failed");

    expect(enhancePageElement).toHaveBeenCalledTimes(1);
    expect(renderToReadableStream).toHaveBeenCalledTimes(2);
  });

  // ---------------------------------------------------------------------------
  // Bot / crawler buffering (streaming-ssr-edge compat)
  // ---------------------------------------------------------------------------

  // Mirrors the Next.js test: "should not stream to crawlers or google pagerender bot"
  // from test/e2e/streaming-ssr-edge/streaming-ssr-edge.test.ts.
  // When the UA is Googlebot the response must be fully buffered (single chunk)
  // and carry an ETag header.
  it("buffers the response for Googlebot and attaches an ETag", async () => {
    const common = createCommonOptions();

    const response = await renderPagesPageResponse({
      ...common.options,
      userAgent: "Googlebot",
    });

    // Bot responses are NOT streamed — they are plain Responses, not the
    // marked PagesStreamedHtmlResponse shape.
    expect(
      (response as Response & { __vinextStreamedHtmlResponse?: boolean })
        .__vinextStreamedHtmlResponse,
    ).toBeUndefined();

    const etag = response.headers.get("etag");
    expect(etag).toBeDefined();
    expect(typeof etag).toBe("string");
    expect((etag as string).length).toBeGreaterThan(0);

    const html = await response.text();
    expect(html).toContain("live-body");
    expect(html).toContain('<script id="__NEXT_DATA__" type="application/json">');
  });

  it("buffers the response for Google-PageRenderer and attaches an ETag", async () => {
    const common = createCommonOptions();

    const response = await renderPagesPageResponse({
      ...common.options,
      userAgent:
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/56.0.2924.87 Safari/537.36 Google-PageRenderer Google (+https://developers.google.com/+/web/snippet/)",
    });

    const etag = response.headers.get("etag");
    expect(etag).toBeDefined();
    expect(typeof etag).toBe("string");

    const html = await response.text();
    expect(html).toContain("live-body");
  });

  it("does not buffer the response for a normal browser UA", async () => {
    const common = createCommonOptions();

    const response = await renderPagesPageResponse({
      ...common.options,
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
    });

    // Normal browsers still get the streaming response marker.
    expect(
      (response as Response & { __vinextStreamedHtmlResponse?: boolean })
        .__vinextStreamedHtmlResponse,
    ).toBe(true);
    // No ETag on streaming responses.
    expect(response.headers.get("etag")).toBeNull();
  });

  it("does not buffer when userAgent is omitted", async () => {
    const common = createCommonOptions();

    const response = await renderPagesPageResponse({
      ...common.options,
      // userAgent intentionally not provided
    });

    expect(
      (response as Response & { __vinextStreamedHtmlResponse?: boolean })
        .__vinextStreamedHtmlResponse,
    ).toBe(true);
    expect(response.headers.get("etag")).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // If-None-Match / 304 handling and ISR cache-HIT ETag
  // ---------------------------------------------------------------------------

  it("returns 304 when If-None-Match matches ETag on bot response (fresh-MISS path)", async () => {
    const common = createCommonOptions();

    // First request: compute the ETag from a full bot render.
    const firstResponse = await renderPagesPageResponse({
      ...common.options,
      userAgent: "Googlebot",
    });
    const etag = firstResponse.headers.get("etag");
    expect(etag).toBeTruthy();

    // Second request: send If-None-Match matching the ETag.
    const common2 = createCommonOptions();
    const notModifiedResponse = await renderPagesPageResponse({
      ...common2.options,
      userAgent: "Googlebot",
      ifNoneMatch: etag as string,
    });

    expect(notModifiedResponse.status).toBe(304);
    // 304 must have no body.
    const body = await notModifiedResponse.text();
    expect(body).toBe("");
    // ETag header still present on 304.
    expect(notModifiedResponse.headers.get("etag")).toBe(etag);
  });

  it("returns 200 + ETag when If-None-Match does not match on bot response", async () => {
    const common = createCommonOptions();

    const response = await renderPagesPageResponse({
      ...common.options,
      userAgent: "Googlebot",
      ifNoneMatch: '"stale-etag-that-wont-match"',
    });

    expect(response.status).toBe(200);
    const etag = response.headers.get("etag");
    expect(etag).toBeTruthy();
    expect(etag).not.toBe('"stale-etag-that-wont-match"');
    const html = await response.text();
    expect(html).toContain("live-body");
  });

  it("ignores If-None-Match for non-bot UAs (never 304)", async () => {
    const common = createCommonOptions();
    // Get a bot ETag first.
    const botResponse = await renderPagesPageResponse({
      ...common.options,
      userAgent: "Googlebot",
    });
    const etag = botResponse.headers.get("etag") as string;

    // Non-bot with same ETag — must NOT get a 304.
    const common2 = createCommonOptions();
    const browserResponse = await renderPagesPageResponse({
      ...common2.options,
      userAgent: "Mozilla/5.0 Chrome/120",
      ifNoneMatch: etag,
    });

    expect(browserResponse.status).toBe(200);
    expect(browserResponse.headers.get("etag")).toBeNull();
  });

  it("ETag weak-comparison: W/ prefix is ignored when matching If-None-Match", async () => {
    expect(etagMatches('"abc123"', 'W/"abc123"')).toBe(true);
    expect(etagMatches('W/"abc123"', '"abc123"')).toBe(true);
    expect(etagMatches('"abc123"', '"abc123"')).toBe(true);
    expect(etagMatches('"abc123"', '"other"')).toBe(false);
    expect(etagMatches('"abc123"', "*")).toBe(true);
  });

  it("attaches ETag to ISR cache-HIT response for bot UAs", async () => {
    // Build a fake cached ISR entry and confirm that cache-HIT + bot UA yields ETag.
    const cachedHtml =
      '<!DOCTYPE html><html><head></head><body><div id="__next"><p>cached</p></div>' +
      "<script>window.__NEXT_DATA__ = {}</script></body></html>";
    const expectedEtag = generatePagesETag(cachedHtml);

    const isrGetMock = vi.fn(async () => ({
      isStale: false,
      value: {
        value: {
          kind: "PAGES" as const,
          html: cachedHtml,
          pageData: {},
          headers: undefined,
          status: 200,
        },
        cacheControl: { revalidate: 60, expire: undefined },
      },
    }));

    const result = await resolvePagesPageData({
      applyRequestContexts: vi.fn(),
      buildId: "build-123",
      isDataReq: false,
      createGsspReqRes: vi.fn() as never,
      createPageElement: vi.fn(),
      fontLinkHeader: "",
      i18n: { locale: "en", locales: ["en"], defaultLocale: "en" },
      isrCacheKey: (_router: string, pathname: string) => `pages:${pathname}`,
      isrGet: isrGetMock as never,
      isrSet: vi.fn(async () => {}),
      expireSeconds: undefined,
      pageModule: {
        // getStaticProps triggers the ISR cache lookup path
        getStaticProps: vi.fn(async () => ({ props: {}, revalidate: 60 })),
      },
      params: {},
      query: {},
      route: { isDynamic: false },
      routePattern: "/posts",
      routeUrl: "/posts",
      runInFreshUnifiedContext: async (cb) => cb(),
      safeJsonStringify: JSON.stringify,
      sanitizeDestination: (d) => d,
      triggerBackgroundRegeneration: vi.fn(),
      renderIsrPassToStringAsync: vi.fn(async () => "<p>cached</p>"),
      userAgent: "Googlebot",
    });

    expect(result.kind).toBe("response");
    if (result.kind === "response") {
      expect(result.response.headers.get("etag")).toBe(expectedEtag);
      expect(result.response.status).toBe(200);
    }
  });

  it("returns 304 on ISR cache-HIT when bot If-None-Match matches", async () => {
    const cachedHtml =
      '<!DOCTYPE html><html><head></head><body><div id="__next"><p>cached</p></div>' +
      "<script>window.__NEXT_DATA__ = {}</script></body></html>";
    const expectedEtag = generatePagesETag(cachedHtml);

    const isrGetMock = vi.fn(async () => ({
      isStale: false,
      value: {
        value: {
          kind: "PAGES" as const,
          html: cachedHtml,
          pageData: {},
          headers: undefined,
          status: 200,
        },
        cacheControl: { revalidate: 60, expire: undefined },
      },
    }));

    const result = await resolvePagesPageData({
      applyRequestContexts: vi.fn(),
      buildId: "build-123",
      isDataReq: false,
      createGsspReqRes: vi.fn() as never,
      createPageElement: vi.fn(),
      fontLinkHeader: "",
      i18n: { locale: "en", locales: ["en"], defaultLocale: "en" },
      isrCacheKey: (_router: string, pathname: string) => `pages:${pathname}`,
      isrGet: isrGetMock as never,
      isrSet: vi.fn(async () => {}),
      expireSeconds: undefined,
      pageModule: {
        getStaticProps: vi.fn(async () => ({ props: {}, revalidate: 60 })),
      },
      params: {},
      query: {},
      route: { isDynamic: false },
      routePattern: "/posts",
      routeUrl: "/posts",
      runInFreshUnifiedContext: async (cb) => cb(),
      safeJsonStringify: JSON.stringify,
      sanitizeDestination: (d) => d,
      triggerBackgroundRegeneration: vi.fn(),
      renderIsrPassToStringAsync: vi.fn(async () => "<p>cached</p>"),
      userAgent: "Googlebot",
      ifNoneMatch: expectedEtag,
    });

    expect(result.kind).toBe("response");
    if (result.kind === "response") {
      expect(result.response.status).toBe(304);
      const body = await result.response.text();
      expect(body).toBe("");
      expect(result.response.headers.get("etag")).toBe(expectedEtag);
    }
  });

  // ISR cache-STALE ETag / 304 — mirrors the HIT tests above but for the stale
  // branch (where a background regeneration is also triggered).

  it("attaches ETag to ISR cache-STALE response for bot UAs", async () => {
    const cachedHtml =
      '<!DOCTYPE html><html><head></head><body><div id="__next"><p>stale</p></div>' +
      "<script>window.__NEXT_DATA__ = {}</script></body></html>";
    const expectedEtag = generatePagesETag(cachedHtml);

    const isrGetMock = vi.fn(async () => ({
      isStale: true,
      value: {
        value: {
          kind: "PAGES" as const,
          html: cachedHtml,
          pageData: {},
          headers: undefined,
          status: 200,
        },
        cacheControl: { revalidate: 60, expire: undefined },
      },
    }));

    const result = await resolvePagesPageData({
      applyRequestContexts: vi.fn(),
      buildId: "build-123",
      isDataReq: false,
      createGsspReqRes: vi.fn() as never,
      createPageElement: vi.fn(),
      fontLinkHeader: "",
      i18n: { locale: "en", locales: ["en"], defaultLocale: "en" },
      isrCacheKey: (_router: string, pathname: string) => `pages:${pathname}`,
      isrGet: isrGetMock as never,
      isrSet: vi.fn(async () => {}),
      expireSeconds: undefined,
      pageModule: {
        getStaticProps: vi.fn(async () => ({ props: {}, revalidate: 60 })),
      },
      params: {},
      query: {},
      route: { isDynamic: false },
      routePattern: "/posts",
      routeUrl: "/posts",
      runInFreshUnifiedContext: async (cb) => cb(),
      safeJsonStringify: JSON.stringify,
      sanitizeDestination: (d) => d,
      triggerBackgroundRegeneration: vi.fn(),
      renderIsrPassToStringAsync: vi.fn(async () => "<p>stale</p>"),
      userAgent: "Googlebot",
    });

    expect(result.kind).toBe("response");
    if (result.kind === "response") {
      expect(result.response.headers.get("etag")).toBe(expectedEtag);
      expect(result.response.headers.get("x-vinext-cache")).toBe("STALE");
      expect(result.response.status).toBe(200);
    }
  });

  it("returns 304 on ISR cache-STALE when bot If-None-Match matches", async () => {
    const cachedHtml =
      '<!DOCTYPE html><html><head></head><body><div id="__next"><p>stale</p></div>' +
      "<script>window.__NEXT_DATA__ = {}</script></body></html>";
    const expectedEtag = generatePagesETag(cachedHtml);

    const isrGetMock = vi.fn(async () => ({
      isStale: true,
      value: {
        value: {
          kind: "PAGES" as const,
          html: cachedHtml,
          pageData: {},
          headers: undefined,
          status: 200,
        },
        cacheControl: { revalidate: 60, expire: undefined },
      },
    }));

    const result = await resolvePagesPageData({
      applyRequestContexts: vi.fn(),
      buildId: "build-123",
      isDataReq: false,
      createGsspReqRes: vi.fn() as never,
      createPageElement: vi.fn(),
      fontLinkHeader: "",
      i18n: { locale: "en", locales: ["en"], defaultLocale: "en" },
      isrCacheKey: (_router: string, pathname: string) => `pages:${pathname}`,
      isrGet: isrGetMock as never,
      isrSet: vi.fn(async () => {}),
      expireSeconds: undefined,
      pageModule: {
        getStaticProps: vi.fn(async () => ({ props: {}, revalidate: 60 })),
      },
      params: {},
      query: {},
      route: { isDynamic: false },
      routePattern: "/posts",
      routeUrl: "/posts",
      runInFreshUnifiedContext: async (cb) => cb(),
      safeJsonStringify: JSON.stringify,
      sanitizeDestination: (d) => d,
      triggerBackgroundRegeneration: vi.fn(),
      renderIsrPassToStringAsync: vi.fn(async () => "<p>stale</p>"),
      userAgent: "Googlebot",
      ifNoneMatch: expectedEtag,
    });

    expect(result.kind).toBe("response");
    if (result.kind === "response") {
      expect(result.response.status).toBe(304);
      const body = await result.response.text();
      expect(body).toBe("");
      expect(result.response.headers.get("etag")).toBe(expectedEtag);
    }
  });

  it("does not return 304 on ISR cache-STALE when non-bot UA matches ETag", async () => {
    const cachedHtml =
      '<!DOCTYPE html><html><head></head><body><div id="__next"><p>stale</p></div>' +
      "<script>window.__NEXT_DATA__ = {}</script></body></html>";
    const etag = generatePagesETag(cachedHtml);

    const isrGetMock = vi.fn(async () => ({
      isStale: true,
      value: {
        value: {
          kind: "PAGES" as const,
          html: cachedHtml,
          pageData: {},
          headers: undefined,
          status: 200,
        },
        cacheControl: { revalidate: 60, expire: undefined },
      },
    }));

    const result = await resolvePagesPageData({
      applyRequestContexts: vi.fn(),
      buildId: "build-123",
      isDataReq: false,
      createGsspReqRes: vi.fn() as never,
      createPageElement: vi.fn(),
      fontLinkHeader: "",
      i18n: { locale: "en", locales: ["en"], defaultLocale: "en" },
      isrCacheKey: (_router: string, pathname: string) => `pages:${pathname}`,
      isrGet: isrGetMock as never,
      isrSet: vi.fn(async () => {}),
      expireSeconds: undefined,
      pageModule: {
        getStaticProps: vi.fn(async () => ({ props: {}, revalidate: 60 })),
      },
      params: {},
      query: {},
      route: { isDynamic: false },
      routePattern: "/posts",
      routeUrl: "/posts",
      runInFreshUnifiedContext: async (cb) => cb(),
      safeJsonStringify: JSON.stringify,
      sanitizeDestination: (d) => d,
      triggerBackgroundRegeneration: vi.fn(),
      renderIsrPassToStringAsync: vi.fn(async () => "<p>stale</p>"),
      userAgent: "Mozilla/5.0 Chrome/120",
      ifNoneMatch: etag,
    });

    expect(result.kind).toBe("response");
    if (result.kind === "response") {
      // Non-bot UAs: no ETag, never 304.
      expect(result.response.status).toBe(200);
      expect(result.response.headers.get("etag")).toBeNull();
    }
  });

  // Cache-Control: no-cache — must bypass 304 even when ETag matches.

  it("skips 304 on fresh-MISS bot response when request has Cache-Control: no-cache", async () => {
    const common = createCommonOptions();
    // First, get the ETag from a normal bot render.
    const firstResponse = await renderPagesPageResponse({
      ...common.options,
      userAgent: "Googlebot",
    });
    const etag = firstResponse.headers.get("etag") as string;
    expect(etag).toBeTruthy();

    // Second request: bot + matching If-None-Match + Cache-Control: no-cache.
    const common2 = createCommonOptions();
    const response = await renderPagesPageResponse({
      ...common2.options,
      userAgent: "Googlebot",
      ifNoneMatch: etag,
      requestCacheControl: "no-cache",
    });

    // Must get full 200 response, not 304.
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("live-body");
  });

  it("skips 304 on ISR cache-HIT bot response when request has Cache-Control: no-cache", async () => {
    const cachedHtml =
      '<!DOCTYPE html><html><head></head><body><div id="__next"><p>cached</p></div>' +
      "<script>window.__NEXT_DATA__ = {}</script></body></html>";
    const expectedEtag = generatePagesETag(cachedHtml);

    const isrGetMock = vi.fn(async () => ({
      isStale: false,
      value: {
        value: {
          kind: "PAGES" as const,
          html: cachedHtml,
          pageData: {},
          headers: undefined,
          status: 200,
        },
        cacheControl: { revalidate: 60, expire: undefined },
      },
    }));

    const result = await resolvePagesPageData({
      applyRequestContexts: vi.fn(),
      buildId: "build-123",
      isDataReq: false,
      createGsspReqRes: vi.fn() as never,
      createPageElement: vi.fn(),
      fontLinkHeader: "",
      i18n: { locale: "en", locales: ["en"], defaultLocale: "en" },
      isrCacheKey: (_router: string, pathname: string) => `pages:${pathname}`,
      isrGet: isrGetMock as never,
      isrSet: vi.fn(async () => {}),
      expireSeconds: undefined,
      pageModule: {
        getStaticProps: vi.fn(async () => ({ props: {}, revalidate: 60 })),
      },
      params: {},
      query: {},
      route: { isDynamic: false },
      routePattern: "/posts",
      routeUrl: "/posts",
      runInFreshUnifiedContext: async (cb) => cb(),
      safeJsonStringify: JSON.stringify,
      sanitizeDestination: (d) => d,
      triggerBackgroundRegeneration: vi.fn(),
      renderIsrPassToStringAsync: vi.fn(async () => "<p>cached</p>"),
      userAgent: "Googlebot",
      ifNoneMatch: expectedEtag,
      requestCacheControl: "no-cache",
    });

    expect(result.kind).toBe("response");
    if (result.kind === "response") {
      // ETag is still attached, but must get 200 not 304.
      expect(result.response.status).toBe(200);
      expect(result.response.headers.get("etag")).toBe(expectedEtag);
    }
  });

  it("skips 304 on ISR cache-STALE bot response when request has Cache-Control: no-cache", async () => {
    const cachedHtml =
      '<!DOCTYPE html><html><head></head><body><div id="__next"><p>stale</p></div>' +
      "<script>window.__NEXT_DATA__ = {}</script></body></html>";
    const expectedEtag = generatePagesETag(cachedHtml);

    const isrGetMock = vi.fn(async () => ({
      isStale: true,
      value: {
        value: {
          kind: "PAGES" as const,
          html: cachedHtml,
          pageData: {},
          headers: undefined,
          status: 200,
        },
        cacheControl: { revalidate: 60, expire: undefined },
      },
    }));

    const result = await resolvePagesPageData({
      applyRequestContexts: vi.fn(),
      buildId: "build-123",
      isDataReq: false,
      createGsspReqRes: vi.fn() as never,
      createPageElement: vi.fn(),
      fontLinkHeader: "",
      i18n: { locale: "en", locales: ["en"], defaultLocale: "en" },
      isrCacheKey: (_router: string, pathname: string) => `pages:${pathname}`,
      isrGet: isrGetMock as never,
      isrSet: vi.fn(async () => {}),
      expireSeconds: undefined,
      pageModule: {
        getStaticProps: vi.fn(async () => ({ props: {}, revalidate: 60 })),
      },
      params: {},
      query: {},
      route: { isDynamic: false },
      routePattern: "/posts",
      routeUrl: "/posts",
      runInFreshUnifiedContext: async (cb) => cb(),
      safeJsonStringify: JSON.stringify,
      sanitizeDestination: (d) => d,
      triggerBackgroundRegeneration: vi.fn(),
      renderIsrPassToStringAsync: vi.fn(async () => "<p>stale</p>"),
      userAgent: "Googlebot",
      ifNoneMatch: expectedEtag,
      requestCacheControl: "no-cache",
    });

    expect(result.kind).toBe("response");
    if (result.kind === "response") {
      // ETag is still attached, but must get 200 not 304.
      expect(result.response.status).toBe(200);
      expect(result.response.headers.get("etag")).toBe(expectedEtag);
    }
  });

  it("propagates renderPage errors without a fallback render", async () => {
    const common = createCommonOptions();

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

    const renderToReadableStream = vi.fn(async () => {
      throw new Error("stream render failed");
    });
    await expect(
      renderPagesPageResponse({
        ...common.options,
        DocumentComponent: MyDocument as unknown as React.ComponentType,
        enhancePageElement,
        renderToReadableStream,
      }),
    ).rejects.toThrow("stream render failed");

    expect(enhancePageElement).toHaveBeenCalledTimes(1);
    expect(renderToReadableStream).toHaveBeenCalledTimes(1);
  });

  it("propagates a throwing enhancer without rendering the page", async () => {
    const common = createCommonOptions();

    function MyDocument() {
      return null;
    }
    (MyDocument as unknown as { getInitialProps: unknown }).getInitialProps = async (ctx: {
      renderPage: (enhancer: (Comp: React.ComponentType) => React.ComponentType) => Promise<{
        html: string;
      }>;
    }) =>
      ctx.renderPage(() => {
        throw new Error("enhancer failed");
      });

    const enhancePageElement = vi.fn(
      (opts: {
        enhanceApp?: (App: React.ComponentType<{ children?: React.ReactNode }>) => unknown;
        enhanceComponent?: (Comp: React.ComponentType<unknown>) => unknown;
      }) => {
        opts.enhanceComponent?.(() => null);
        return React.createElement("p", null, "unreachable");
      },
    );
    const renderToReadableStream = vi.fn(async () => createStream(["unreachable"]));

    await expect(
      renderPagesPageResponse({
        ...common.options,
        DocumentComponent: MyDocument as unknown as React.ComponentType,
        enhancePageElement,
        renderToReadableStream,
      }),
    ).rejects.toThrow("enhancer failed");

    expect(enhancePageElement).toHaveBeenCalledTimes(1);
    expect(renderToReadableStream).not.toHaveBeenCalled();
  });

  it("propagates a throwing page after one renderer invocation", async () => {
    const common = createCommonOptions();

    function MyDocument() {
      return null;
    }
    (MyDocument as unknown as { getInitialProps: unknown }).getInitialProps = async (ctx: {
      renderPage: () => Promise<{ html: string }>;
    }) => ctx.renderPage();

    function ThrowingPage(): React.ReactNode {
      throw new Error("page failed");
    }
    const enhancePageElement = vi.fn(() => React.createElement(ThrowingPage));
    const reactDomServer = await import("react-dom/server.edge");
    const renderToReadableStream = vi.fn(async (element: React.ReactNode) =>
      reactDomServer.renderToReadableStream(element as React.ReactElement),
    );

    await expect(
      renderPagesPageResponse({
        ...common.options,
        DocumentComponent: MyDocument as unknown as React.ComponentType,
        enhancePageElement,
        renderToReadableStream,
      }),
    ).rejects.toThrow("page failed");

    expect(enhancePageElement).toHaveBeenCalledTimes(1);
    expect(renderToReadableStream).toHaveBeenCalledTimes(1);
  });
});
