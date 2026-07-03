/// <reference types="vite/client" />

import { createElement, startTransition, use, useEffect } from "react";
import { createFromReadableStream } from "@vitejs/plugin-rsc/browser";
import { createRoot, hydrateRoot } from "react-dom/client";
import "../client/instrumentation-client.js";
import {
  chunksToReadableStream,
  createProgressiveRscStream,
  getVinextBrowserGlobal,
} from "./app-browser-stream.js";
import { AppElementsWire, type AppElements, type AppWireElements } from "./app-elements.js";
import { ElementsContext, Slot } from "vinext/shims/slot";
import { installWindowNext } from "../client/window-next.js";

function decodeAppElementsPromise(payload: Promise<AppWireElements>): Promise<AppElements> {
  return Promise.resolve(payload).then((elements) => AppElementsWire.decode(elements));
}

function BrowserRoot({ initialElements }: { initialElements: Promise<AppElements> }) {
  const elements = use(initialElements);
  const metadata = AppElementsWire.readMetadata(elements);

  useEffect(() => {
    const hydratedAt = performance.now();
    window.__VINEXT_HYDRATED_AT = hydratedAt;
    window.__NEXT_HYDRATED = true;
    window.__NEXT_HYDRATED_AT = hydratedAt;
    window.__NEXT_HYDRATED_CB?.();
  }, []);

  return createElement(
    ElementsContext.Provider,
    { value: elements },
    createElement(Slot, { id: metadata.routeId }),
  );
}

function readInitialRscStream(): ReadableStream<Uint8Array> {
  const browserGlobal = getVinextBrowserGlobal();
  if (browserGlobal.__VINEXT_RSC_DONE__) {
    return chunksToReadableStream(browserGlobal.__VINEXT_RSC_CHUNKS__ ?? []);
  }
  return createProgressiveRscStream();
}

function canonicalizeEmptySearchHref(): void {
  if (!window.location.href.endsWith("?") || window.location.search !== "") return;
  window.history.replaceState(
    window.history.state,
    "",
    window.location.pathname + window.location.hash,
  );
}

function main(): void {
  if (window.__VINEXT_RSC_ROOT__ || window.__VINEXT_RSC_BOOTSTRAP_STATE__) return;
  window.__VINEXT_DOCUMENT_ONLY_RSC_RUNTIME__ = true;
  window.__VINEXT_RSC_BOOTSTRAP_STATE__ = "starting";
  canonicalizeEmptySearchHref();

  const initialElements = decodeAppElementsPromise(
    createFromReadableStream<AppWireElements>(readInitialRscStream()),
  );
  const children = createElement(BrowserRoot, { initialElements });

  startTransition(() => {
    if (document.documentElement.id === "__next_error__") {
      for (const style of document.querySelectorAll("style[data-vinext-error-shell-style]")) {
        style.remove();
      }
      const root = createRoot(document);
      root.render(children);
      window.__VINEXT_RSC_ROOT__ = root;
    } else {
      window.__VINEXT_RSC_ROOT__ = hydrateRoot(document, children);
    }
  });
  window.__VINEXT_RSC_BOOTSTRAP_STATE__ = "hydrated";
}

if (typeof document !== "undefined") {
  installWindowNext({ appDir: true });
  main();
}
