type PagesRouterPopStateHandler = (event: PopStateEvent) => void;

let pagesRouterPopStateHandler: PagesRouterPopStateHandler | undefined;
let stampInitialHistoryStateFn: (() => void) | undefined;
let pagesRouterRuntimeInstalled = false;

export function setPagesRouterPopStateHandler(handler: PagesRouterPopStateHandler): void {
  pagesRouterPopStateHandler = handler;
}

/**
 * Register the function that stamps Next.js-shaped state onto the initial
 * document entry (called once at install time). Router.ts registers this so
 * the runtime module stays free of router internals.
 */
export function setStampInitialHistoryState(fn: () => void): void {
  stampInitialHistoryStateFn = fn;
}

export function installPagesRouterRuntime(): void {
  if (typeof window === "undefined" || pagesRouterRuntimeInstalled) {
    return;
  }

  if (!pagesRouterPopStateHandler) {
    throw new Error("[vinext] Pages Router runtime installed before next/router was initialized");
  }

  pagesRouterRuntimeInstalled = true;
  // Stamp the initial document entry with router-shaped state *before* the
  // listener attaches so a back-navigation popstate carries the active locale
  // and passes the foreign-state filter.
  stampInitialHistoryStateFn?.();
  window.addEventListener("popstate", pagesRouterPopStateHandler);
}
