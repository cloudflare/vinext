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
import type { VinextLinkPrefetchRoute } from "../client/vinext-next-data.js";
import { findFileWithExts } from "./pages-entry-helpers.js";
import { normalizePathSeparators } from "../utils/path.js";

export async function generateClientEntry(
  pagesDir: string,
  nextConfig: ResolvedNextConfig,
  fileMatcher: ReturnType<typeof createValidFileMatcher>,
  options: {
    appPrefetchRoutes?: readonly VinextLinkPrefetchRoute[];
    instrumentationClientPath?: string | null;
  } = {},
): Promise<string> {
  const pageRoutes = await pagesRouter(pagesDir, nextConfig?.pageExtensions, fileMatcher);

  const appFilePath = findFileWithExts(pagesDir, "_app", fileMatcher);
  const hasApp = appFilePath !== null;
  const appPrefetchRoutes = options.appPrefetchRoutes ?? [];
  const instrumentationClientPath = options.instrumentationClientPath ?? null;

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

  // Refs #1474: Side-effect-import the user's `instrumentation-client.{ts,js}`
  // (when present at project root or in `src/`) BEFORE any other module so its
  // top-level statements run before `hydrateRoot()` is called. Mirrors
  // Next.js's `page-bootstrap.ts`, which side-effect-imports
  // `require-instrumentation-client` ahead of `initialize`/`hydrate`
  // (.nextjs-ref/packages/next/src/client/page-bootstrap.ts L1).
  //
  // The `vinext/instrumentation-client` import below pulls in the hook
  // surface (`onRouterTransitionStart`) for navigation events. It also
  // re-imports the user file via the `private-next-instrumentation-client`
  // alias, but tree-shakers can be conservative about the side effects of
  // an indirectly-loaded module. Importing the user's file directly here
  // makes the contract explicit: bare side-effect imports are always
  // preserved by Vite/Rolldown's import-analysis pipeline.
  const userInstrumentationImport = instrumentationClientPath
    ? `import ${JSON.stringify(normalizePathSeparators(instrumentationClientPath))};\n`
    : "";

  return `${userInstrumentationImport}
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
${
  hasApp
    ? `
const appLoader = () => import(${JSON.stringify(appFileBase!)});
`
    : `
const appLoader = undefined;
`
}
// Expose the code-split loader manifest on window so client-side
// _next/data navigations in shims/router.ts can resolve the correct page
// chunk for any route. Without this, navigateClient() would have to extract
// the chunk URL from an HTML response — the whole point of switching to the
// JSON data endpoint is to avoid that round trip.
//
// Keys are route patterns in Next.js bracket format (matching __NEXT_DATA__.page
// and the keys of pageLoaders above). The patterns list is the same as
// Object.keys(pageLoaders), exposed separately so navigateClient() can iterate
// it without re-keying the map. Ordering is the insertion order of pageRoutes,
// which pagesRouter() has already sorted by specificity (static → dynamic →
// catch-all → optional catch-all) via compareRoutes — so matchPagesPattern()
// can iterate in order and trust the first match.
window.__VINEXT_PAGE_LOADERS__ = pageLoaders;
window.__VINEXT_PAGE_PATTERNS__ = Object.keys(pageLoaders);
window.__VINEXT_APP_LOADER__ = appLoader;
// Expose the App Router prefetch manifest so Pages Router \`<Link>\`s and
// \`Router.prefetch\` can detect when a prefetch target is actually an App
// Router route, and mark it on \`Router.components[urlPathname]\` with
// \`{ __appRouter: true }\`. Mirrors Next.js's \`_bfl\`-driven marker write at
// .nextjs-ref/packages/next/src/shared/lib/router/router.ts:2525, which the
// Next.js deploy test
//   test/e2e/app-dir/app/index.test.ts → "should successfully detect app
//   route during prefetch"
// asserts via \`window.next.router.components[<path>]\`. Issue #1526.
//
// In a hybrid Pages + App Router build, this entry runs when the user lands
// on a Pages Router page. The App Router browser entry sets the same global
// when the user lands on an App Router page (see app-browser-entry.ts) — the
// two writes do not race because only one entry executes per page load.
window.__VINEXT_LINK_PREFETCH_ROUTES__ = ${JSON.stringify(appPrefetchRoutes)};

async function hydrate() {
  const nextData = window.__NEXT_DATA__;
  if (!nextData) {
    console.error("[vinext] No __NEXT_DATA__ found");
    return;
  }

  let hydrateRootOptions;
  if (import.meta.env.DEV) {
    const overlay = await import("vinext/dev-error-overlay");
    overlay.installDevErrorOverlay();
    overlay.installViteHmrErrorHandler(import.meta.hot);
    overlay.reportInitialDevServerErrors();
    hydrateRootOptions = {
      onCaughtError: overlay.devOnCaughtError,
      onUncaughtError: overlay.devOnUncaughtError,
    };
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
    const appModule = await appLoader();
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

  const root = hydrateRoot(container, element, hydrateRootOptions);
  window.__VINEXT_ROOT__ = root;
  installPagesRouterRuntime();
  const hydratedAt = performance.now();
  window.__VINEXT_HYDRATED_AT = hydratedAt;
  window.__NEXT_HYDRATED = true;
  window.__NEXT_HYDRATED_AT = hydratedAt;
  window.__NEXT_HYDRATED_CB?.();
}

hydrate();
`;
}
