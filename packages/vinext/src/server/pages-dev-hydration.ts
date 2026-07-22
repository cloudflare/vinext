import { createNonceAttribute } from "./html.js";

export type PagesDevHydrationOptions = {
  appModuleSource: string | null;
  forceRouterReady?: boolean;
  normalizePageProps?: boolean;
  pageModuleSource: string;
  reactStrictMode: boolean;
  replaceFallbackRoute?: boolean;
  scriptNonce?: string;
  setPagePatternsFromNextData?: boolean;
};

export function createPagesDevHydrationScript(options: PagesDevHydrationOptions): string {
  const nonceAttr = createNonceAttribute(options.scriptNonce);
  const initializeRouter = options.forceRouterReady
    ? "_initializePagesRouterReadyFromNextData(nextData, true);"
    : "_initializePagesRouterReadyFromNextData(nextData);";
  const pagePatterns = options.setPagePatternsFromNextData
    ? "window.__VINEXT_PAGE_PATTERNS__ = [nextData.page];"
    : "";
  const pageProps =
    options.normalizePageProps === false
      ? "const pageProps = rawPageProps ?? {};"
      : 'const pageProps = rawPageProps && typeof rawPageProps === "object" ? rawPageProps : {};';
  const fallbackReplacement = options.replaceFallbackRoute
    ? `
  if (nextData.isFallback) {
    await Router.replace(window.location.pathname + window.location.search + window.location.hash, undefined, { _h: 1, scroll: false });
  }`
    : "";
  const createElement = options.appModuleSource
    ? `
  const appModule = await import(${JSON.stringify(options.appModuleSource)});
  const AppComponent = appModule.default;
  window.__VINEXT_APP__ = AppComponent;
  const appRouter = ${options.forceRouterReady ? "{ ...Router, isReady: true }" : "Router"};
  element = React.createElement(AppComponent, {
    ...props,
    Component: PageComponent,
    router: appRouter,
  });
  `
    : `
  element = React.createElement(PageComponent, pageProps);
  `;

  return `
<script type="module"${nonceAttr}>
import "vinext/instrumentation-client";
import React from "react";
import { hydrateRoot } from "react-dom/client";
import Router, { wrapWithRouterContext, _initializePagesRouterReadyFromNextData } from "next/router";

const nextDataElement = document.getElementById("__NEXT_DATA__");
if (nextDataElement?.textContent) {
  window.__NEXT_DATA__ = JSON.parse(nextDataElement.textContent);
  window.__VINEXT_LOCALE__ = window.__NEXT_DATA__.locale;
  window.__VINEXT_LOCALES__ = window.__NEXT_DATA__.locales;
  window.__VINEXT_DEFAULT_LOCALE__ = window.__NEXT_DATA__.defaultLocale;
}
const nextData = window.__NEXT_DATA__;
${initializeRouter}
const props = nextData.props && typeof nextData.props === "object" ? nextData.props : {};
const rawPageProps = props.pageProps;
${pageProps}
window.__VINEXT_PAGE_LOADERS__ = { [nextData.page]: () => import(${JSON.stringify(options.pageModuleSource)}) };
${pagePatterns}
window.__VINEXT_APP_LOADER__ = ${options.appModuleSource ? `() => import(${JSON.stringify(options.appModuleSource)})` : "undefined"};
window.__VINEXT_REACT_STRICT_MODE__ = ${JSON.stringify(options.reactStrictMode)};

async function hydrate() {
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

  const pageModule = await import(${JSON.stringify(options.pageModuleSource)});
  const PageComponent = pageModule.default;
  let element;
  ${createElement}
  let resolveHydrationCommit;
  const hydrationCommitted = new Promise((resolve) => { resolveHydrationCommit = resolve; });
  element = wrapWithRouterContext(element, resolveHydrationCommit);
  const root = hydrateRoot(document.getElementById("__next"), element, hydrateRootOptions);
  window.__VINEXT_ROOT__ = root;
  await hydrationCommitted;
  const hydratedAt = performance.now();
  window.__VINEXT_HYDRATED_AT = hydratedAt;
  window.__NEXT_HYDRATED = true;
  window.__NEXT_HYDRATED_AT = hydratedAt;
  window.__NEXT_HYDRATED_CB?.();${fallbackReplacement}
}
hydrate();
</script>`;
}
