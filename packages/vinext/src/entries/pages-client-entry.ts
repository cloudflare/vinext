/**
 * Pages Router client hydration entry generator.
 *
 * Generates the virtual client entry module (`virtual:vinext-client-entry`).
 * This is the entry point for `vite build` (client bundle). It maps route
 * patterns to dynamic imports of page modules so Vite code-splits each page
 * into its own chunk. At runtime it reads __NEXT_DATA__ to determine which
 * page to hydrate.
 *
 * Extracted from index.ts.
 */
import {
  pagesRouter,
  patternToNextFormat as pagesPatternToNextFormat,
  type Route,
} from "../routing/pages-router.js";
import fs from "node:fs/promises";
import { hasNamedExport } from "../build/report.js";
import { createValidFileMatcher } from "../routing/file-matcher.js";
import { type ResolvedNextConfig } from "../config/next-config.js";
import { findFileWithExts } from "./pages-entry-helpers.js";

export async function generateClientEntry(
  pagesDir: string,
  nextConfig: ResolvedNextConfig,
  fileMatcher: ReturnType<typeof createValidFileMatcher>,
): Promise<string> {
  const pageRoutes = await pagesRouter(pagesDir, nextConfig?.pageExtensions, fileMatcher);

  const appFilePath = findFileWithExts(pagesDir, "_app", fileMatcher);
  const hasApp = appFilePath !== null;

  // Build a map of route pattern -> dynamic import.
  // Keys must use Next.js bracket format (e.g. "/user/[id]") to match
  // __NEXT_DATA__.page which is set via patternToNextFormat() during SSR.
  const loaderEntries = pageRoutes.map((r: Route) => {
    const absPath = r.filePath.replace(/\\/g, "/");
    const nextFormatPattern = pagesPatternToNextFormat(r.pattern);
    // JSON.stringify safely escapes quotes, backslashes, and special chars in
    // both the route pattern and the absolute file path.
    // lgtm[js/bad-code-sanitization]
    return `  ${JSON.stringify(nextFormatPattern)}: () => import(${JSON.stringify(absPath)})`;
  });

  const ssgRoutes: string[] = [];
  for (const route of pageRoutes) {
    try {
      const source = await fs.readFile(route.filePath, "utf-8");
      if (hasNamedExport(source, "getStaticProps")) {
        ssgRoutes.push(pagesPatternToNextFormat(route.pattern));
      }
    } catch {
      // If source analysis fails, skip data prefetch for this route. Navigation
      // still loads data on demand, which is safer than executing GSSP early.
    }
  }

  const appFileBase = appFilePath?.replace(/\\/g, "/");

  return `
import "vinext/instrumentation-client";
import React from "react";
import { hydrateRoot } from "react-dom/client";
// Eagerly import the router shim so its module-level popstate listener is
// registered.  Without this, browser back/forward buttons do nothing because
// navigateClient() is never invoked on history changes.
import "next/router";

const pageLoaders = {
${loaderEntries.join(",\n")}
};

window.__VINEXT_PAGES_SSG_ROUTES__ = new Set(${JSON.stringify(ssgRoutes)});

async function hydrate() {
  const nextData = window.__NEXT_DATA__;
  if (!nextData) {
    console.error("[vinext] No __NEXT_DATA__ found");
    return;
  }

  const { pageProps, ...appProps } = nextData.props;
  const loader = pageLoaders[nextData.page];
  if (!loader) {
    console.error("[vinext] No page loader for route:", nextData.page);
    return;
  }

  const pageModule = await loader();
  const PageComponent = pageModule.default;
  if (!PageComponent) {
    console.error("[vinext] Page module has no default export");
    return;
  }

  let element;
  ${
    hasApp
      ? `
  try {
    const appModule = await import(${JSON.stringify(appFileBase!)});
    const AppComponent = appModule.default;
    window.__VINEXT_APP__ = AppComponent;
    element = React.createElement(AppComponent, { Component: PageComponent, pageProps, ...appProps });
  } catch {
    element = React.createElement(PageComponent, pageProps);
  }
  `
      : `
  element = React.createElement(PageComponent, pageProps);
  `
  }

  // Wrap with RouterContext.Provider so next/compat/router works during hydration
  const { wrapWithRouterContext } = await import("next/router");
  element = wrapWithRouterContext(element);

  const container = document.getElementById("__next");
  if (!container) {
    console.error("[vinext] No #__next element found");
    return;
  }

  const root = hydrateRoot(container, element);
  window.__VINEXT_ROOT__ = root;
  window.__VINEXT_HYDRATED_AT = performance.now();
  window.__NEXT_HYDRATED = true;
  window.__NEXT_HYDRATED_AT = window.__VINEXT_HYDRATED_AT;
  if (typeof window.__NEXT_HYDRATED_CB === "function") {
    window.__NEXT_HYDRATED_CB();
  }

  if (nextData.isFallback === true) {
    const Router = (await import("next/router")).default;
    window.__VINEXT_SUPPRESS_DATA_NAVIGATION_FAILURE = true;
    Router.replace(window.location.pathname + window.location.search)
      .catch((error) => {
        console.error("[vinext] Failed to resolve fallback page data", error);
      })
      .finally(() => {
        window.__VINEXT_SUPPRESS_DATA_NAVIGATION_FAILURE = false;
      });
  }
}

hydrate();
`;
}
