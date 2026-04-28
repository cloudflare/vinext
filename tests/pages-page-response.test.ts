import { createHash } from "node:crypto";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  buildPagesIsrCacheControl,
  isPagesHtmlBotUserAgent,
  renderPagesPageResponse,
} from "../packages/vinext/src/server/pages-page-response.js";
import { NextScript } from "../packages/vinext/src/shims/document.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

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

function createReadyStream(
  chunks: string[],
  allReady: Promise<void>,
): ReadableStream<Uint8Array> & { allReady: Promise<void> } {
  return Object.assign(createStream(chunks), { allReady });
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
      assetTags: '<script type="module" defer src="/entry.js" crossorigin></script>',
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

function cspHashOf(text: string): string {
  const hash = createHash("sha256");
  hash.update(text);
  return `'sha256-${hash.digest("base64")}'`;
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
    // Ported from Next.js: test/e2e/optimized-loading/test/index.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/optimized-loading/test/index.test.ts
    expect(html).toContain('<script type="module" defer src="/entry.js" crossorigin>');
    expect(html).not.toContain("<script async");

    expect(common.clearSsrContext).toHaveBeenCalledTimes(1);
    expect(common.renderDocumentToString).toHaveBeenCalledTimes(1);
  });

  it("runs the Pages head prepass before streamed responses build the shell", async () => {
    // Ported from Next.js: test/e2e/next-head/index.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/next-head/index.test.ts
    const common = createCommonOptions();
    let headHtml = "";

    const response = await renderPagesPageResponse({
      ...common.options,
      getSSRHeadHTML: vi.fn(() => headHtml),
      renderHeadPrepassToStringAsync: vi.fn(async () => {
        headHtml = '<meta name="test-head-1" content="hello" data-next-head="" />';
        return "";
      }),
      shouldBufferResponse: false,
    });

    const html = await response.text();
    const headIndex = html.indexOf('<meta name="test-head-1" content="hello" data-next-head=""');
    const assetIndex = html.indexOf('<script type="module" defer src="/entry.js"');

    expect(headIndex).toBeGreaterThan(-1);
    expect(assetIndex).toBeGreaterThan(headIndex);
  });

  it("normalizes inline styled-jsx CSS in streamed Pages HTML", async () => {
    // Ported from Next.js: test/e2e/streaming-ssr/index.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/streaming-ssr/index.test.ts
    const common = createCommonOptions();

    const response = await renderPagesPageResponse({
      ...common.options,
      renderToReadableStream: vi.fn(async () =>
        createStream([
          "<div><style>\n  p {",
          "\n    color: blue;",
          "\n  }\n</style><p>index</p></div>",
        ]),
      ),
      shouldBufferResponse: false,
    });

    await expect(response.text()).resolves.toContain("<style>p{color:blue;}</style>");
  });

  it("does not buffer streamed body content while waiting for later style tags", async () => {
    const common = createCommonOptions();

    const response = await renderPagesPageResponse({
      ...common.options,
      renderToReadableStream: vi.fn(async () =>
        createStream([
          "<main>Loading delayed chunk...</main><style>",
          "\n  p { color: blue; }\n</style><p>done</p>",
        ]),
      ),
      shouldBufferResponse: false,
    });

    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    const decoder = new TextDecoder();
    const firstChunk = await reader!.read();

    expect(firstChunk.done).toBe(false);
    expect(decoder.decode(firstChunk.value)).toContain("Loading delayed chunk...");

    let html = "";
    for (;;) {
      const chunk = await reader!.read();
      if (chunk.done) break;
      html += decoder.decode(chunk.value, { stream: true });
    }
    html += decoder.decode();

    expect(html).toContain("<style>p{color:blue;}</style>");
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

  it("sets Next-compatible default cache-control for gSSP responses", async () => {
    // Ported from Next.js: test/e2e/getserversideprops/test/index.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/getserversideprops/test/index.test.ts
    const common = createCommonOptions();

    const response = await renderPagesPageResponse({
      ...common.options,
      gsspRes: {
        statusCode: 200,
        getHeaders() {
          return {};
        },
      },
    });

    expect(response.headers.get("cache-control")).toBe(
      "private, no-cache, no-store, max-age=0, must-revalidate",
    );
  });

  it("embeds custom App getInitialProps values in __NEXT_DATA__", async () => {
    // Ported from Next.js: test/e2e/getserversideprops/app/pages/_app.js
    // https://github.com/vercel/next.js/blob/canary/test/e2e/getserversideprops/app/pages/_app.js
    const common = createCommonOptions();

    const response = await renderPagesPageResponse({
      ...common.options,
      appProps: {
        appProps: {
          asPath: "/posts/post",
          pathname: "/posts/[slug]",
          query: { slug: "post" },
          url: "/posts/post",
        },
      },
    });

    const html = await response.text();
    expect(html).toContain('"appProps":{"asPath":"/posts/post"');
    expect(html).toContain('"pageProps":{"title":"hello"}');
  });

  it("embeds client navigation module URLs in __NEXT_DATA__", async () => {
    const common = createCommonOptions();

    const response = await renderPagesPageResponse({
      ...common.options,
      pageModuleUrl: "/assets/page-post.js",
      appModuleUrl: "/assets/app.js",
    });

    const html = await response.text();
    expect(html).toContain('"__vinext"');
    expect(html).toContain('"pageModuleUrl":"/assets/page-post.js"');
    expect(html).toContain('"appModuleUrl":"/assets/app.js"');
  });

  it("marks getStaticProps pages with gsp in __NEXT_DATA__", async () => {
    // Ported from Next.js: test/e2e/prerender.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/prerender.test.ts
    const common = createCommonOptions();

    const response = await renderPagesPageResponse({
      ...common.options,
      isGsp: true,
    });

    const html = await response.text();
    expect(html).toContain('"gsp":true');
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

  it("can emit Next deploy-suite cache-control for pages ISR responses", () => {
    vi.stubEnv("VINEXT_NEXT_DEPLOY_CACHE_CONTROL", "1");

    expect(buildPagesIsrCacheControl(60, "MISS")).toBe("public, max-age=0, must-revalidate");
    expect(buildPagesIsrCacheControl(60, "HIT")).toBe("public, max-age=0, must-revalidate");
    expect(buildPagesIsrCacheControl(60, "STALE")).toBe("public, max-age=0, must-revalidate");
  });

  it("emits private cache-control for fallback shell responses outside deploy mode", async () => {
    const common = createCommonOptions();

    const response = await renderPagesPageResponse({
      ...common.options,
      isFallback: true,
    });

    expect(response.headers.get("cache-control")).toBe(
      "private, no-cache, no-store, max-age=0, must-revalidate",
    );
  });

  it("adds nonce attributes to inline scripts and font tags when provided", async () => {
    const common = createCommonOptions();

    const response = await renderPagesPageResponse({
      ...common.options,
      assetTags:
        '<link rel="modulepreload" nonce="pages-test-nonce" href="/entry.js" />\n' +
        '<script type="module" nonce="pages-test-nonce" defer src="/entry.js" crossorigin></script>',
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
      '<script type="module" nonce="pages-test-nonce" defer src="/entry.js" crossorigin></script>',
    );
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

  it("buffers bot Pages SSR responses and emits an etag", async () => {
    // Ported from Next.js: test/e2e/streaming-ssr-edge/streaming-ssr-edge.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/streaming-ssr-edge/streaming-ssr-edge.test.ts
    const common = createCommonOptions();

    const response = await renderPagesPageResponse({
      ...common.options,
      renderToReadableStream: vi.fn(async () =>
        createReadyStream(["<span>next_streaming_data</span>"], Promise.resolve()),
      ),
      shouldBufferResponse: true,
    });

    expect(
      (response as Response & { __vinextStreamedHtmlResponse?: boolean })
        .__vinextStreamedHtmlResponse,
    ).toBeUndefined();
    expect(response.headers.get("etag")).toBeTruthy();
    await expect(response.text()).resolves.toContain("next_streaming_data");
  });

  it("waits for buffered Pages SSR allReady so render errors can use the 500 page", async () => {
    // Ported from Next.js: test/e2e/streaming-ssr-edge/streaming-ssr-edge.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/streaming-ssr-edge/streaming-ssr-edge.test.ts
    const common = createCommonOptions();

    await expect(
      renderPagesPageResponse({
        ...common.options,
        renderToReadableStream: vi.fn(async () =>
          createReadyStream([], Promise.reject(new Error("oops"))),
        ),
        shouldBufferResponse: true,
      }),
    ).rejects.toThrow("oops");
  });

  it("matches Next.js bot user agents that should receive blocking Pages HTML", () => {
    // Ported from Next.js: packages/next/src/shared/lib/router/utils/is-bot.ts
    // https://github.com/vercel/next.js/blob/canary/packages/next/src/shared/lib/router/utils/is-bot.ts
    expect(isPagesHtmlBotUserAgent("Googlebot")).toBe(true);
    expect(
      isPagesHtmlBotUserAgent(
        "Mozilla/5.0 Google-PageRenderer Google (+https://developers.google.com/+/web/snippet/)",
      ),
    ).toBe(true);
    expect(isPagesHtmlBotUserAgent("Mozilla/5.0 Chrome/120 Safari/537.36")).toBe(false);
  });

  it("applies custom Document props and NextScript metadata to the rendered shell", async () => {
    // Ported from Next.js: test/e2e/app-document/rendering.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-document/rendering.test.ts
    const common = createCommonOptions();

    const response = await renderPagesPageResponse({
      ...common.options,
      assetTags:
        '<link rel="modulepreload" href="/entry.js" />\n' +
        '<script type="module" defer src="/entry.js"></script>',
      crossOrigin: "anonymous",
      documentProps: { customProperty: "Hello Document" },
      renderDocumentToString: async (element) => {
        const { renderToString } = await import("react-dom/server");
        return renderToString(element);
      },
      DocumentComponent({ customProperty }: { customProperty?: string }) {
        return React.createElement(
          "html",
          { className: "test-html-props" },
          React.createElement("head"),
          React.createElement(
            "body",
            { className: "custom_class" },
            React.createElement("p", { id: "custom-property" }, customProperty),
            React.createElement("div", {
              id: "__next",
              dangerouslySetInnerHTML: { __html: "__NEXT_MAIN__" },
            }),
            React.createElement("vinext-next-scripts", {
              "data-vinext-next-script-nonce": "test-nonce",
              "data-vinext-next-script-crossorigin": "anonymous",
              dangerouslySetInnerHTML: { __html: "__NEXT_SCRIPTS__" },
            }),
          ),
        );
      },
    });

    const html = await response.text();
    expect(html).toContain('class="test-html-props"');
    expect(html).toContain('class="custom_class"');
    expect(html).toContain('<p id="custom-property">Hello Document</p>');
    expect(html).toContain(
      '<script id="__NEXT_DATA__" type="application/json" crossorigin="anonymous"',
    );
    expect(html).toContain(
      '<script type="module" defer src="/entry.js" nonce="test-nonce" crossorigin="anonymous"></script>',
    );
  });

  it("passes __NEXT_DATA__ to custom Document so hash CSP can authorize NextScript inline source", async () => {
    // Ported from Next.js: test/e2e/app-document/csp.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-document/csp.test.ts
    const common = createCommonOptions();
    let documentCspHash: string | undefined;

    const response = await renderPagesPageResponse({
      ...common.options,
      i18n: {},
      renderDocumentToString: async (element) => {
        const { renderToString } = await import("react-dom/server");
        return renderToString(element);
      },
      DocumentComponent(props: Record<string, unknown>) {
        documentCspHash = cspHashOf(NextScript.getInlineScriptSource(props));
        return React.createElement(
          "html",
          null,
          React.createElement(
            "head",
            null,
            React.createElement("meta", {
              httpEquiv: "Content-Security-Policy",
              content: `script-src 'self' ${documentCspHash}`,
            }),
          ),
          React.createElement(
            "body",
            null,
            React.createElement("div", {
              id: "__next",
              dangerouslySetInnerHTML: { __html: "__NEXT_MAIN__" },
            }),
            React.createElement(NextScript),
          ),
        );
      },
    });

    const html = await response.text();
    const assignment = html.match(
      /<script(?:\s[^>]*)?>(window\.__NEXT_DATA__ = [\s\S]*?)<\/script>/,
    )?.[1];

    expect(assignment).toBeDefined();
    expect(documentCspHash).toBe(cspHashOf(assignment!));
  });
});
