/// <reference lib="webworker" />
import { INTERCEPTED_BODY } from "./sw-message";

declare const self: ServiceWorkerGlobalScope;

// An asset the worker references; only the worker script is served, so it
// must be inlined into it.
const OFFLINE_PAGE = new URL("./offline.txt", import.meta.url).href;

self.addEventListener("fetch", (event) => {
  const { pathname } = new URL(event.request.url);
  if (pathname.endsWith("/sw-intercepted")) {
    event.respondWith(new Response(INTERCEPTED_BODY));
  } else if (pathname.endsWith("/sw-offline")) {
    event.respondWith(fetch(OFFLINE_PAGE));
  }
});

export {};
