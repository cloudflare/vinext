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
  apiRouter,
  pagesRouter,
  patternToNextFormat as pagesPatternToNextFormat,
  type Route,
} from "../routing/pages-router.js";
import { createValidFileMatcher } from "../routing/file-matcher.js";
import { type ResolvedNextConfig } from "../config/next-config.js";
import type {
  VinextLinkPrefetchRoute,
  VinextPagesLinkPrefetchRoute,
} from "../client/vinext-next-data.js";
import { findFileWithExts } from "./pages-entry-helpers.js";
import { normalizePathSeparators } from "../utils/path.js";

/**
 * Project a Pages `Route` down to the public `VinextPagesLinkPrefetchRoute`
 * shape used for client-side hybrid ownership decisions. Mirrors
 * `toLinkPrefetchRoute` in `app-browser-entry.ts`.
 *
 * Lives here (not in `routing/pages-router.ts`) so the routing module
 * stays free of `vitext/client` type imports.
 */
function toPagesLinkPrefetchRoute(route: Route): VinextPagesLinkPrefetchRoute {
  return {
    canPrefetchLoadingShell: false,
    isDynamic: route.isDynamic,
    patternParts: [...route.patternParts],
  };
}

export async function generateClientEntry(
  pagesDir: string,
  nextConfig: ResolvedNextConfig,
  fileMatcher: ReturnType<typeof createValidFileMatcher>,
  options: {
    appPrefetchRoutes?: readonly VinextLinkPrefetchRoute[];
    instrumentationClientPath?: string | null;
    reactPreamble?: boolean;
  } = {},
): Promise<string> {
  const pageRoutes = await pagesRouter(pagesDir, nextConfig?.pageExtensions, fileMatcher);
  const apiRoutes = await apiRouter(pagesDir, nextConfig?.pageExtensions, fileMatcher);

  const appFilePath = findFileWithExts(pagesDir, "_app", fileMatcher);
  const hasApp = appFilePath !== null;
  const appPrefetchRoutes = options.appPrefetchRoutes ?? [];
  const pagesPrefetchRoutes: VinextPagesLinkPrefetchRoute[] = [
    ...pageRoutes.map(toPagesLinkPrefetchRoute),
    ...apiRoutes.map((route) => ({ ...toPagesLinkPrefetchRoute(route), documentOnly: true })),
  ];
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
  const reactPreambleImport =
    options.reactPreamble === false ? "" : 'import "@vitejs/plugin-react/preamble";\n';

  return `${userInstrumentationImport}${reactPreambleImport}
import "vinext/instrumentation-client";
import React from "react";
import { hydrateRoot } from "react-dom/client";
import Router, {
  wrapWithRouterContext,
  _initializePagesRouterReadyFromNextData,
} from "next/router";

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
// catch-all → optional catch-all) via sortRoutes — so matchPagesPattern()
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
// Pages route manifest, exposed so the App Router runtime can decide when
// a soft-navigated URL is actually owned by Pages (and must hard-navigate
// instead of issuing an RSC request). Set here AND in app-browser-entry.ts
// so whichever entry runs first emits the Pages manifest.
window.__VINEXT_PAGES_LINK_PREFETCH_ROUTES__ = ${JSON.stringify(pagesPrefetchRoutes)};
window.__VINEXT_CLIENT_REWRITES__ = ${JSON.stringify(nextConfig.rewrites)};

const nextDataElement = document.getElementById("__NEXT_DATA__");
if (nextDataElement?.textContent) {
  window.__NEXT_DATA__ = JSON.parse(nextDataElement.textContent);
  window.__VINEXT_LOCALE__ = window.__NEXT_DATA__.locale;
  window.__VINEXT_LOCALES__ = window.__NEXT_DATA__.locales;
  window.__VINEXT_DEFAULT_LOCALE__ = window.__NEXT_DATA__.defaultLocale;
}

async function hydrate() {
  const nextData = window.__NEXT_DATA__;
  if (!nextData) {
    console.error("[vinext] No __NEXT_DATA__ found");
    return;
  }

  _initializePagesRouterReadyFromNextData(nextData);

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

  const props = nextData.props && typeof nextData.props === "object" ? nextData.props : {};
  const rawPageProps = props.pageProps;
  const pageProps = rawPageProps && typeof rawPageProps === "object" ? rawPageProps : {};
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
    element = React.createElement(AppComponent, {
      ...props,
      Component: PageComponent,
      pageProps: rawPageProps,
      router: Router,
    });
  } catch {
    element = React.createElement(PageComponent, pageProps);
  }
  `
      : `
  element = React.createElement(PageComponent, pageProps);
  `
  }

  let resolveHydrationCommit;
  const hydrationCommitted = new Promise((resolve) => {
    resolveHydrationCommit = resolve;
  });

  // Wrap with RouterContext.Provider so next/router and next/compat/router work during hydration.
  element = wrapWithRouterContext(element, resolveHydrationCommit);

  const container = document.getElementById("__next");
  if (!container) {
    console.error("[vinext] No #__next element found");
    return;
  }

  const root = hydrateRoot(container, element, hydrateRootOptions);
  window.__VINEXT_ROOT__ = root;
  await hydrationCommitted;
  const hydratedAt = performance.now();
  window.__VINEXT_HYDRATED_AT = hydratedAt;
  window.__NEXT_HYDRATED = true;
  window.__NEXT_HYDRATED_AT = hydratedAt;
  window.__NEXT_HYDRATED_CB?.();

  if (nextData.isFallback) {
    await Router.replace(
      window.location.pathname + window.location.search + window.location.hash,
      undefined,
      { _h: 1, scroll: false },
    );
  }
}

hydrate();
`;
}
