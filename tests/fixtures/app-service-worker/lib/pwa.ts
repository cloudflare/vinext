/// <reference lib="webworker" />
import { INTERCEPTED_BODY } from "./sw-message";

declare const self: ServiceWorkerGlobalScope;

self.addEventListener("fetch", (event) => {
  if (new URL(event.request.url).pathname.endsWith("/sw-intercepted")) {
    event.respondWith(new Response(INTERCEPTED_BODY));
  }
});

export {};
