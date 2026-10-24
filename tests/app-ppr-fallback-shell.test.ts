import { describe, expect, it } from "vite-plus/test";
import {
  appendAppPprFallbackShellResumeDataCache,
  createAppPprFallbackShells,
  createAppPprRequestFallbackShells,
  hasAppPprFallbackShellPrelude,
  isAppPprDynamicFallbackShellHtml,
  markAppPprDynamicFallbackShellHtml,
  rewriteAppPprFallbackShellHtmlNavigation,
  splitAppPprFallbackShellResumeDataCache,
} from "../packages/vinext/src/server/app-ppr-fallback-shell.js";

describe("createAppPprRequestFallbackShells", () => {
  it("encodes a request's kept params once, as the build does", () => {
    const shells = createAppPprRequestFallbackShells(
      { params: ["locale", "slug"], pattern: "/:locale/blog/:slug", rootParamNames: ["locale"] },
      { locale: "caf%C3%A9", slug: "new-post" },
    );

    expect(shells).toEqual([
      {
        fallbackParamNames: ["slug"],
        pathname: "/caf%C3%A9/blog/[slug]",
        params: { locale: "café", slug: "[slug]" },
      },
    ]);
  });
});

describe("createAppPprFallbackShells", () => {
  it("builds a cacheComponents fallback shell from known root params and missing child params", () => {
    const shells = createAppPprFallbackShells(
      {
        params: ["locale", "slug"],
        pattern: "/:locale/blog/:slug",
        rootParamNames: ["locale"],
      },
      { locale: "en", slug: "new-post" },
    );

    expect(shells).toContainEqual({
      fallbackParamNames: ["slug"],
      pathname: "/en/blog/[slug]",
      params: { locale: "en", slug: "[slug]" },
    });
  });

  it("preserves catch-all placeholder shape in the shell path and params", () => {
    const shells = createAppPprFallbackShells(
      {
        params: ["locale", "slug"],
        pattern: "/:locale/docs/:slug+",
        rootParamNames: ["locale"],
      },
      { locale: "fr", slug: ["guides", "intro"] },
    );

    expect(shells).toContainEqual({
      fallbackParamNames: ["slug"],
      pathname: "/fr/docs/[...slug]",
      params: { locale: "fr", slug: ["[...slug]"] },
    });
  });

  it("preserves optional catch-all placeholder shape in the shell path and params", () => {
    const shells = createAppPprFallbackShells(
      {
        params: ["locale", "slug"],
        pattern: "/:locale/docs/:slug*",
        rootParamNames: ["locale"],
      },
      { locale: "fr", slug: ["guides", "intro"] },
    );

    expect(shells).toContainEqual({
      fallbackParamNames: ["slug"],
      pathname: "/fr/docs/[[...slug]]",
      params: { locale: "fr", slug: ["[[...slug]]"] },
    });
  });

  it("orders nested fallback shells from most specific child prefix to root-only", () => {
    const shells = createAppPprFallbackShells(
      {
        params: ["locale", "category", "slug"],
        pattern: "/:locale/category/:category/post/:slug",
        rootParamNames: ["locale"],
      },
      { locale: "en", category: "news", slug: "launch" },
    );

    expect(shells).toEqual([
      {
        fallbackParamNames: ["slug"],
        pathname: "/en/category/news/post/[slug]",
        params: { locale: "en", category: "news", slug: "[slug]" },
      },
      {
        fallbackParamNames: ["category", "slug"],
        pathname: "/en/category/[category]/post/[slug]",
        params: { locale: "en", category: "[category]", slug: "[slug]" },
      },
    ]);
  });

  it("creates fallback shells down to the route root without root params, like Next.js", () => {
    expect(
      createAppPprFallbackShells(
        {
          params: ["locale", "slug"],
          pattern: "/:locale/blog/:slug",
          rootParamNames: [],
        },
        { locale: "en", slug: "new-post" },
      ),
    ).toEqual([
      {
        fallbackParamNames: ["slug"],
        pathname: "/en/blog/[slug]",
        params: { locale: "en", slug: "[slug]" },
      },
      {
        fallbackParamNames: ["locale", "slug"],
        pathname: "/[locale]/blog/[slug]",
        params: { locale: "[locale]", slug: "[slug]" },
      },
    ]);
  });

  it("does not create a fallback shell when the matched request lacks a root param", () => {
    expect(
      createAppPprFallbackShells(
        {
          params: ["locale", "slug"],
          pattern: "/:locale/blog/:slug",
          rootParamNames: ["locale"],
        },
        { slug: "new-post" },
      ),
    ).toEqual([]);
  });
});

describe("rewriteAppPprFallbackShellHtmlNavigation", () => {
  it("patches cached fallback-shell HTML with the actual request navigation metadata", () => {
    const html = rewriteAppPprFallbackShellHtmlNavigation({
      html: "<html><head><title>x</title></head><body>shell</body></html>",
      params: { locale: "en", slug: "new-post" },
      pathname: "/en/blog/new-post",
      searchParams: new URLSearchParams([["preview", "1"]]),
    });

    expect(html).toContain('params:{"locale":"en","slug":"new-post"}');
    expect(html).toContain('"pathname":"/en/blog/new-post"');
    expect(html).toContain('"searchParams":[["preview","1"]]');
    expect(html).toContain("searchParamsFromBrowser:true");
    const paramsIndex = html.indexOf('params:{"locale":"en","slug":"new-post"}');
    const headCloseIndex = html.indexOf("</head>");
    expect(paramsIndex).toBeGreaterThanOrEqual(0);
    expect(headCloseIndex).toBeGreaterThanOrEqual(0);
    expect(paramsIndex).toBeLessThan(headCloseIndex);
  });

  it("keeps force-static fallback-shell search params server-owned", () => {
    const html = rewriteAppPprFallbackShellHtmlNavigation({
      html: "<html><head></head><body>shell</body></html>",
      isForceStatic: true,
      params: { slug: "new-post" },
      pathname: "/blog/new-post",
      searchParams: new URLSearchParams([["preview", "1"]]),
    });

    expect(html).toContain("searchParamsFromBrowser:false");
    expect(html).toContain('"searchParams":[]');
    expect(html).not.toContain('"preview","1"');
  });

  it("appends actual request metadata after cached placeholder metadata", () => {
    const placeholderHtml = rewriteAppPprFallbackShellHtmlNavigation({
      html: "<html><head><title>x</title></head><body>shell</body></html>",
      params: { locale: "en", slug: "[slug]" },
      pathname: "/en/blog/[slug]",
      searchParams: new URLSearchParams(),
    });
    const html = rewriteAppPprFallbackShellHtmlNavigation({
      html: placeholderHtml,
      params: { locale: "en", slug: "new-post" },
      pathname: "/en/blog/new-post",
      searchParams: new URLSearchParams([["preview", "1"]]),
    });

    const placeholderIndex = html.indexOf('params:{"locale":"en","slug":"[slug]"}');
    const actualIndex = html.indexOf('params:{"locale":"en","slug":"new-post"}');
    const headCloseIndex = html.indexOf("</head>");

    expect(placeholderIndex).toBeGreaterThanOrEqual(0);
    expect(actualIndex).toBeGreaterThan(placeholderIndex);
    expect(actualIndex).toBeLessThan(headCloseIndex);
    expect(html).toContain('"pathname":"/en/blog/new-post"');
    expect(html).toContain('"searchParams":[["preview","1"]]');
  });
});

describe("dynamic fallback shell marker", () => {
  it("persists the need for request-time resume in prerendered HTML", () => {
    const html = markAppPprDynamicFallbackShellHtml("<html><body>fallback</body></html>");

    expect(isAppPprDynamicFallbackShellHtml(html)).toBe(true);
    expect(isAppPprDynamicFallbackShellHtml("<html><body>static</body></html>")).toBe(false);
  });
});

describe("fallback shell resume data cache transport", () => {
  async function readAppended(html: string, resumeDataCache: string | null): Promise<string> {
    const encoder = new TextEncoder();
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(html));
        controller.close();
      },
    });
    return new Response(
      appendAppPprFallbackShellResumeDataCache(source, () => resumeDataCache),
    ).text();
  }

  it("round-trips the resume data cache out of the shell HTML", async () => {
    const resumeDataCache = JSON.stringify({ cache: { key: { body: "--></script>" } }, fetch: {} });
    const html = "<!DOCTYPE html><html><body>shell</body></html>";
    const transported = await readAppended(html, resumeDataCache);

    expect(transported).not.toContain("--></script>");
    const split = splitAppPprFallbackShellResumeDataCache(transported);
    expect(split.html).toBe(html);
    expect(JSON.parse(split.resumeDataCache ?? "null")).toEqual(JSON.parse(resumeDataCache));
  });

  it("round-trips a resume data cache that holds the trailer's own start", async () => {
    const resumeDataCache = JSON.stringify({
      cache: { key: { tags: ["<!--vinext-ppr-resume-data-cache:"] } },
      fetch: {},
    });
    const html = "<!DOCTYPE html><html><body>shell</body></html>";
    const split = splitAppPprFallbackShellResumeDataCache(
      await readAppended(html, resumeDataCache),
    );

    expect(split.html).toBe(html);
    expect(JSON.parse(split.resumeDataCache ?? "null")).toEqual(JSON.parse(resumeDataCache));
  });

  it("leaves a shell without a resume data cache unchanged", async () => {
    const html = "<!DOCTYPE html><html><body>shell</body></html>";

    await expect(readAppended(html, null)).resolves.toBe(html);
    expect(splitAppPprFallbackShellResumeDataCache(html)).toEqual({
      html,
      resumeDataCache: null,
    });
  });

  it("only treats a shell with a document prelude as resumable", () => {
    expect(hasAppPprFallbackShellPrelude("<!DOCTYPE html><html><body>shell</body></html>")).toBe(
      true,
    );
    expect(hasAppPprFallbackShellPrelude("")).toBe(false);
  });
});
