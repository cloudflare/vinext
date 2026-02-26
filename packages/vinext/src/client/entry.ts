/**
 * Client-side hydration entry point.
 *
 * This module is injected as a <script type="module"> in the SSR HTML.
 * It reads __NEXT_DATA__ from the window, dynamically imports the page
 * component, and hydrates it onto #__next.
 *
 * The actual page import path is injected at serve-time by the plugin
 * via a virtual module or inline script.
 */
import React from "react";
import { hydrateRoot } from "react-dom/client";
// Eagerly import the router shim so its module-level popstate listener is
// registered.  Without this, browser back/forward buttons do nothing because
// navigateClient() is never invoked on history changes.
import "next/router";
import { isValidModulePath } from "./validate-module-path.js";

// Read the SSR data injected by the server
const nextData = (window as any).__NEXT_DATA__;
const { pageProps } = nextData?.props ?? { pageProps: {} };
const pageModulePath = nextData?.__pageModule;
const appModulePath = nextData?.__appModule;

async function hydrate() {
  if (!isValidModulePath(pageModulePath)) {
    console.error("[vinext] Invalid or missing __pageModule in __NEXT_DATA__");
    return;
  }

  // Dynamically import the page module
  const pageModule = await import(/* @vite-ignore */ pageModulePath);
  const PageComponent = pageModule.default;

  if (!PageComponent) {
    console.error("[vinext] Page module has no default export");
    return;
  }

  let element: React.ReactElement;

  // If there's a custom _app, wrap the page with it
  if (appModulePath) {
    if (!isValidModulePath(appModulePath)) {
      console.error("[vinext] Invalid __appModule in __NEXT_DATA__");
    } else {
      try {
        const appModule = await import(/* @vite-ignore */ appModulePath);
        const AppComponent = appModule.default;
        element = React.createElement(AppComponent, {
          Component: PageComponent,
          pageProps,
        });
      } catch {
        // No _app, render page directly
      }
    }
  }

  // @ts-expect-error -- element is assigned in the _app branch above, or falls through here
  if (!element) {
    element = React.createElement(PageComponent, pageProps);
  }

  const container = document.getElementById("__next");
  if (!container) {
    console.error("[vinext] No #__next element found");
    return;
  }

  const root = hydrateRoot(container, element);

  // Expose root on window so the router shim (a separate module) can
  // re-render the tree during client-side navigation. import.meta.hot.data
  // is module-scoped and cannot be read across module boundaries.
  (window as any).__VINEXT_ROOT__ = root;
}

hydrate();
