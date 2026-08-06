import { describe, expect, it } from "vite-plus/test";
import {
  createAppPprFallbackShell,
  createAppPprFallbackShells,
  isAppPprDynamicFallbackShellHtml,
  markAppPprDynamicFallbackShellHtml,
  rewriteAppPprFallbackShellHtmlNavigation,
} from "../packages/vinext/src/server/app-ppr-fallback-shell.js";

describe("createAppPprFallbackShell", () => {
  it("builds a cacheComponents fallback shell from known root params and missing child params", () => {
    const shell = createAppPprFallbackShell(
      {
        params: ["locale", "slug"],
        pattern: "/:locale/blog/:slug",
        rootParamNames: ["locale"],
      },
      { locale: "en", slug: "new-post" },
    );

    expect(shell).toEqual({
      fallbackParamNames: ["slug"],
      pathname: "/en/blog/[slug]",
      params: { locale: "en", slug: "[slug]" },
    });
  });

  it("preserves catch-all placeholder shape in the shell path and params", () => {
    const shell = createAppPprFallbackShell(
      {
        params: ["locale", "slug"],
        pattern: "/:locale/docs/:slug+",
        rootParamNames: ["locale"],
      },
      { locale: "fr", slug: ["guides", "intro"] },
    );

    expect(shell).toEqual({
      fallbackParamNames: ["slug"],
      pathname: "/fr/docs/[...slug]",
      params: { locale: "fr", slug: ["[...slug]"] },
    });
  });

  it("preserves optional catch-all placeholder shape in the shell path and params", () => {
    const shell = createAppPprFallbackShell(
      {
        params: ["locale", "slug"],
        pattern: "/:locale/docs/:slug*",
        rootParamNames: ["locale"],
      },
      { locale: "fr", slug: ["guides", "intro"] },
    );

    expect(shell).toEqual({
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

  it("does not create a fallback shell without a known root-param boundary", () => {
    expect(
      createAppPprFallbackShell(
        {
          params: ["locale", "slug"],
          pattern: "/:locale/blog/:slug",
          rootParamNames: [],
        },
        { locale: "en", slug: "new-post" },
      ),
    ).toBeNull();
  });

  it("does not create a fallback shell when the matched request lacks a root param", () => {
    expect(
      createAppPprFallbackShell(
        {
          params: ["locale", "slug"],
          pattern: "/:locale/blog/:slug",
          rootParamNames: ["locale"],
        },
        { slug: "new-post" },
      ),
    ).toBeNull();
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
    const paramsIndex = html.indexOf('params:{"locale":"en","slug":"new-post"}');
    const headCloseIndex = html.indexOf("</head>");
    expect(paramsIndex).toBeGreaterThanOrEqual(0);
    expect(headCloseIndex).toBeGreaterThanOrEqual(0);
    expect(paramsIndex).toBeLessThan(headCloseIndex);
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
