import { describe, expect, it } from "vite-plus/test";
import {
  appendAppPprFallbackShellState,
  createAppPprFallbackShells,
  createAppPprRequestFallbackShells,
  hasAppPprFallbackShellPrelude,
  isAppPprDynamicFallbackShellHtml,
  markAppPprDynamicFallbackShellHtml,
  parseAppPprShellState,
  replaceAppPprShellFallbackParamKeys,
  rewriteAppPprFallbackShellHtmlNavigation,
  splitAppPprFallbackShellState,
  type AppPprShellState,
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

  it("keeps a param named __proto__", () => {
    const shells = createAppPprRequestFallbackShells(
      {
        params: ["__proto__", "slug"],
        pattern: "/:__proto__/:slug",
        rootParamNames: ["__proto__"],
      },
      JSON.parse('{"__proto__":"caf%C3%A9","slug":"new-post"}'),
    );

    expect(shells).toHaveLength(1);
    expect(shells[0].pathname).toBe("/caf%C3%A9/[slug]");
    expect(Object.entries(shells[0].params)).toEqual([
      ["__proto__", "café"],
      ["slug", "[slug]"],
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

  it("derives no shell from a value equal to its param's placeholder", () => {
    const route = { params: ["locale", "slug"], pattern: "/:locale/:slug", rootParamNames: [] };
    const pathnamesFor = (locale: string) =>
      createAppPprFallbackShells(route, { locale, slug: "a" }).map((shell) => shell.pathname);

    // `/%5Blocale%5D/[slug]` would share `/[locale]/[slug]`'s decoded key.
    expect(pathnamesFor("[locale]")).toEqual(["/[locale]/[slug]"]);
    expect(pathnamesFor("[en]")).toEqual(["/%5Ben%5D/[slug]", "/[locale]/[slug]"]);
  });

  it("keeps a root param's bracket-shaped value, which no shell leaves out", () => {
    const shells = createAppPprFallbackShells(
      { params: ["locale", "slug"], pattern: "/:locale/:slug", rootParamNames: ["locale"] },
      { locale: "[locale]", slug: "a" },
    );

    expect(shells.map((shell) => shell.pathname)).toEqual(["/%5Blocale%5D/[slug]"]);
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

describe("fallback shell state transport", () => {
  async function readAppended(html: string, state: AppPprShellState): Promise<string> {
    const encoder = new TextEncoder();
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(html));
        controller.close();
      },
    });
    return new Response(appendAppPprFallbackShellState(source, () => state)).text();
  }

  it("round-trips a prelude's postponed state and resume data cache out of the shell HTML", async () => {
    const resumeDataCache = JSON.stringify({ cache: { key: { body: "--></script>" } }, fetch: {} });
    const postponed = { replayNodes: [["Activity", '["slug|%5Bslug%5D|d"]', [], null]] };
    const html = "<!DOCTYPE html><html><head></head><body>shell";
    const transported = await readAppended(html, { prelude: true, postponed, resumeDataCache });

    expect(transported).not.toContain("--></script>");
    const split = splitAppPprFallbackShellState(transported);
    expect(split.html).toBe(html);
    const state = parseAppPprShellState(split.state ?? undefined);
    expect(state?.prelude).toBe(true);
    expect(state?.postponed).toEqual(postponed);
    expect(JSON.parse(state?.resumeDataCache ?? "null")).toEqual(JSON.parse(resumeDataCache));
  });

  it("round-trips a state that holds the trailer's own start", async () => {
    const resumeDataCache = JSON.stringify({
      cache: { key: { tags: ["<!--vinext-ppr-shell-state:"] } },
      fetch: {},
    });
    const html = "<!DOCTYPE html><html><body>shell</body></html>";
    const split = splitAppPprFallbackShellState(
      await readAppended(html, { prelude: false, postponed: null, resumeDataCache }),
    );

    expect(split.html).toBe(html);
    const state = parseAppPprShellState(split.state ?? undefined);
    expect(state).toMatchObject({ prelude: false, postponed: null });
    expect(JSON.parse(state?.resumeDataCache ?? "null")).toEqual(JSON.parse(resumeDataCache));
  });

  it("carries a state without a resume data cache", async () => {
    const html = "<!DOCTYPE html><html><body>shell</body></html>";
    const split = splitAppPprFallbackShellState(
      await readAppended(html, { prelude: true, postponed: null, resumeDataCache: null }),
    );

    expect(split.html).toBe(html);
    expect(parseAppPprShellState(split.state ?? undefined)).toEqual({
      prelude: true,
      postponed: null,
      resumeDataCache: null,
    });
    expect(splitAppPprFallbackShellState(html)).toEqual({ html, state: null });
    expect(parseAppPprShellState('{"cache":{},"fetch":{}}')).toBeNull();
  });

  it("only treats a shell with a document prelude as resumable", () => {
    expect(hasAppPprFallbackShellPrelude("<!DOCTYPE html><html><body>shell</body></html>")).toBe(
      true,
    );
    expect(hasAppPprFallbackShellPrelude("")).toBe(false);
  });
});

describe("replaceAppPprShellFallbackParamKeys", () => {
  it("rewrites the shell's placeholder segment keys to the request's values", () => {
    const key = JSON.stringify([
      "page",
      "page:/:locale/blog/:slug",
      JSON.stringify(["locale|en|d", "blog", "slug|%5Bslug%5D|d"]),
    ]);
    const postponed = { replayNodes: [["Activity", key, [], null]], idPrefix: "" };

    const replaced = replaceAppPprShellFallbackParamKeys(postponed, [
      { name: "slug", shellValue: "%5Bslug%5D", requestValue: "caf%C3%A9" },
    ]) as typeof postponed;

    expect(JSON.parse(JSON.parse(replaced.replayNodes[0][1] as string)[2])).toEqual([
      "locale|en|d",
      "blog",
      "slug|caf%C3%A9|d",
    ]);
    expect(postponed.replayNodes[0][1]).toBe(key);
  });

  it("joins catch-all values and leaves other params' keys alone", () => {
    const key = JSON.stringify(["xslug|%5B...rest%5D|d", "rest|%5B...rest%5D|c"]);

    expect(
      replaceAppPprShellFallbackParamKeys({ key }, [
        { name: "rest", shellValue: ["%5B...rest%5D"], requestValue: ["a", "b%2Fc"] },
      ]),
    ).toEqual({ key: JSON.stringify(["xslug|%5B...rest%5D|d", "rest|a/b%2Fc|c"]) });
  });
});
