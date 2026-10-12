import { describe, expect, it } from "vite-plus/test";
import { createPagesDevHydrationScript } from "../packages/vinext/src/server/pages-dev-hydration.js";

describe("createPagesDevHydrationScript", () => {
  it("generates the normal Pages Router hydration entry", () => {
    const script = createPagesDevHydrationScript({
      appModuleSource: "/pages/_app.tsx",
      pageModuleSource: "/pages/index.tsx",
      reactStrictMode: true,
      replaceFallbackRoute: true,
      scriptNonce: "nonce-value",
    });

    expect(script).toContain('<script type="module" nonce="nonce-value">');
    expect(script).toContain("_initializePagesRouterReadyFromNextData(nextData);");
    expect(script).toContain(
      "window.__VINEXT_MIDDLEWARE_MATCHER__ = nextData.__vinext?.clientMiddlewareMatcher;",
    );
    expect(
      script.indexOf(
        "window.__VINEXT_MIDDLEWARE_MATCHER__ = nextData.__vinext?.clientMiddlewareMatcher;",
      ),
    ).toBeLessThan(script.indexOf("_initializePagesRouterReadyFromNextData(nextData);"));
    expect(script).toContain('() => import("/pages/index.tsx")');
    expect(script).toContain('() => import("/pages/_app.tsx")');
    expect(script).toContain("const appRouter = Router;");
    expect(script).not.toContain("pageProps: rawPageProps,");
    expect(script).toContain("const shouldHydrateQuery =");
    expect(script).toContain("const initialMatchesMiddleware =");
    expect(script).toContain("nextData.__vinext?.hasMiddleware === true");
    expect(script).toContain("nextData.__vinext?.hasRewrites === true");
    expect(script).toContain("shallow: !nextData.isFallback && !initialMatchesMiddleware");
    expect(script).not.toContain("window.__VINEXT_PAGE_PATTERNS__ = [nextData.page]");
  });

  it("generates the forced-ready error hydration entry", () => {
    const script = createPagesDevHydrationScript({
      appModuleSource: null,
      forceRouterReady: true,
      normalizePageProps: false,
      pageModuleSource: "next/error",
      reactStrictMode: false,
      setPagePatternsFromNextData: true,
    });

    expect(script).toContain("_initializePagesRouterReadyFromNextData(nextData, true);");
    expect(script).toContain("window.__VINEXT_PAGE_PATTERNS__ = [nextData.page];");
    expect(script).toContain('() => import("next/error")');
    expect(script).toContain("const pageProps = rawPageProps ?? {};");
    expect(script).toContain("element = React.createElement(PageComponent, pageProps);");
    expect(script).not.toContain("if (nextData.isFallback)");
    expect(script).not.toContain("const appRouter =");
  });

  it("exposes other dev pages as lazy loaders without importing them during hydration", () => {
    const script = createPagesDevHydrationScript({
      appModuleSource: null,
      pageModuleSource: "/pages/index.tsx",
      pageLoaders: [
        { pattern: "/", moduleSource: "/pages/index.tsx", dataKind: "none" },
        { pattern: "/posts/[id]", moduleSource: "/pages/posts/[id].tsx", dataKind: "server" },
        { pattern: "/catalog/[id]", moduleSource: "/pages/catalog/[id].tsx", dataKind: "static" },
      ],
      reactStrictMode: false,
    });
    expect(script).toContain("const loadDevPage = (source) => import(/* @vite-ignore */ source);");
    expect(script).toContain(
      '"/posts/[id]": () => loadDevPage(import.meta.env.BASE_URL + "pages/posts/[id].tsx")',
    );
    expect(script).toContain('const pageModule = await import("/pages/index.tsx")');
    expect(
      script.indexOf('"/": () => loadDevPage(import.meta.env.BASE_URL + "pages/index.tsx")'),
    ).toBeLessThan(script.indexOf('[nextData.page]: () => import("/pages/index.tsx")'));
    expect(script).toContain('window.__VINEXT_PAGES_SSG_PATTERNS__ = ["/catalog/[id]"];');
    expect(script).toContain('window.__VINEXT_PAGES_SSP_PATTERNS__ = ["/posts/[id]"];');
  });

  it("reads the current response's middleware matcher before initial router state is stamped", () => {
    const script = createPagesDevHydrationScript({
      appModuleSource: null,
      pageModuleSource: "/pages/index.tsx",
      reactStrictMode: false,
    });
    const assignment =
      "window.__VINEXT_MIDDLEWARE_MATCHER__ = nextData.__vinext?.clientMiddlewareMatcher;";
    expect(script).toContain(assignment);
    expect(script.indexOf(assignment)).toBeLessThan(
      script.indexOf("_initializePagesRouterReadyFromNextData(nextData);"),
    );
  });

  it("exposes known routes after hydrating a dev error page", () => {
    const script = createPagesDevHydrationScript({
      appModuleSource: null,
      pageModuleSource: "next/error",
      pageLoaders: [{ pattern: "/posts/[id]", moduleSource: "/pages/posts/[id].tsx" }],
      reactStrictMode: false,
      setPagePatternsFromNextData: true,
    });
    expect(script).toContain(
      '"/posts/[id]": () => loadDevPage(import.meta.env.BASE_URL + "pages/posts/[id].tsx")',
    );
    expect(script).toContain(
      "window.__VINEXT_PAGE_PATTERNS__ = Object.keys(window.__VINEXT_PAGE_LOADERS__)",
    );
    expect(script).toContain('[nextData.page]: () => import("next/error")');
  });

  it("serializes module specifiers safely", () => {
    const script = createPagesDevHydrationScript({
      appModuleSource: '/pages/_app"quoted.tsx',
      pageModuleSource: "/pages/line\nfeed.tsx",
      reactStrictMode: false,
    });

    expect(script).toContain('import("/pages/_app\\"quoted.tsx")');
    expect(script).toContain('import("/pages/line\\nfeed.tsx")');
  });

  it("does not let route specifiers close the inline module script", () => {
    const script = createPagesDevHydrationScript({
      appModuleSource: '/pages/</script><script>alert("app")</script>.tsx',
      pageModuleSource: "/pages/index.tsx",
      pageLoaders: [
        {
          pattern: '</script><script>alert("route")</script>',
          moduleSource: '/pages/</script><script>alert("module")</script>.tsx',
        },
      ],
      reactStrictMode: false,
    });

    expect(script.match(/<\/script>/g)).toHaveLength(1);
    expect(script).toContain('"\\u003c/script\\u003e\\u003cscript\\u003ealert(\\"route\\")');
    expect(script).toContain('import("/pages/\\u003c/script\\u003e');
    expect(script).toContain('alert(\\"app\\")');
  });
});
