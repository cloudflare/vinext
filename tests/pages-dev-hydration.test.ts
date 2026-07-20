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
    expect(script).toContain('() => import("/pages/index.tsx")');
    expect(script).toContain('() => import("/pages/_app.tsx")');
    expect(script).toContain("const appRouter = Router;");
    expect(script).not.toContain("pageProps: rawPageProps,");
    expect(script).toContain("if (nextData.isFallback)");
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

  it("serializes module specifiers safely", () => {
    const script = createPagesDevHydrationScript({
      appModuleSource: '/pages/_app"quoted.tsx',
      pageModuleSource: "/pages/line\nfeed.tsx",
      reactStrictMode: false,
    });

    expect(script).toContain('import("/pages/_app\\"quoted.tsx")');
    expect(script).toContain('import("/pages/line\\nfeed.tsx")');
  });
});
