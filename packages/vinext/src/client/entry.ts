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

// Read the SSR data injected by the server
const nextData = (window as any).__NEXT_DATA__;
const { pageProps } = nextData?.props ?? { pageProps: {} };
const pageModulePath = nextData?.__pageModule;
const appModulePath = nextData?.__appModule;

async function hydrate() {
  if (!pageModulePath) {
    console.error("[vinext] No __pageModule in __NEXT_DATA__");
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
    try {
      const appModule = await import(/* @vite-ignore */ appModulePath);
      const AppComponent = appModule.default;
      element = React.createElement(AppComponent, {
        Component: PageComponent,
        pageProps,
      });
    } catch {
      // No _app, render page directly
      element = React.createElement(PageComponent, pageProps);
    }
  } else {
    element = React.createElement(PageComponent, pageProps);
  }

  const container = document.getElementById("__next");
  if (!container) {
    console.error("[vinext] No #__next element found");
    return;
  }

  hydrateRoot(container, element);
}

hydrate();
