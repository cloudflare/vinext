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
import { createValidFileMatcher } from "../routing/file-matcher.js";
import { type ResolvedNextConfig } from "../config/next-config.js";
import { findFileWithExts } from "./pages-entry-helpers.js";
import { normalizePathSeparators } from "./runtime-entry-module.js";

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
    const absPath = normalizePathSeparators(r.filePath);
    const nextFormatPattern = pagesPatternToNextFormat(r.pattern);
    // JSON.stringify safely escapes quotes, backslashes, and special chars in
    // both the route pattern and the absolute file path.
    // lgtm[js/bad-code-sanitization]
    return `  ${JSON.stringify(nextFormatPattern)}: () => import(${JSON.stringify(absPath)})`;
  });

  const appFileBase = appFilePath ? normalizePathSeparators(appFilePath) : undefined;

  return `
import "vinext/instrumentation-client";
import React from "react";
import { hydrateRoot } from "react-dom/client";
import { installPagesRouterRuntime } from "vinext/pages-router-runtime";
// Statically import next/router as the very first vinext shim so that
// (a) installWindowNext runs at top-level — \`window.next.router\` is
//     available to test harnesses and third-party scripts BEFORE
//     hydrate() resolves (see .nextjs-ref/packages/next/src/client/next.ts
//     line 13, which also sets window.next as a top-level side effect),
// and (b) the popstate handler is registered before
//     installPagesRouterRuntime() runs, removing the race window where a
//     popstate event could fire between hydration and runtime install.
//
// Mirrors Next.js's bootstrap order: client/next.ts statically imports
// from './' before calling initialize/hydrate, so window.next is set up
// before any async work.
import { wrapWithRouterContext } from "next/router";

const pageLoaders = {
${loaderEntries.join(",\n")}
};

async function hydrate() {
  const nextData = window.__NEXT_DATA__;
  if (!nextData) {
    console.error("[vinext] No __NEXT_DATA__ found");
    return;
  }

  const { pageProps } = nextData.props;
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
    element = React.createElement(AppComponent, { Component: PageComponent, pageProps });
  } catch {
    element = React.createElement(PageComponent, pageProps);
  }
  `
      : `
  element = React.createElement(PageComponent, pageProps);
  `
  }

  // Wrap with RouterContext.Provider so next/router and next/compat/router work during hydration.
  element = wrapWithRouterContext(element);

  const container = document.getElementById("__next");
  if (!container) {
    console.error("[vinext] No #__next element found");
    return;
  }

  const root = hydrateRoot(container, element);
  window.__VINEXT_ROOT__ = root;
  installPagesRouterRuntime();
  window.__VINEXT_HYDRATED_AT = performance.now();
}

hydrate();
`;
}
