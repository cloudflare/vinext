type PagesRouterPopStateHandler = (event: PopStateEvent) => void;

let pagesRouterPopStateHandler: PagesRouterPopStateHandler | undefined;
let pagesRouterRuntimeInstalled = false;

export function setPagesRouterPopStateHandler(handler: PagesRouterPopStateHandler): void {
  pagesRouterPopStateHandler = handler;
}

export function installPagesRouterRuntime(): void {
  if (typeof window === "undefined" || pagesRouterRuntimeInstalled) {
    return;
  }

  if (!pagesRouterPopStateHandler) {
    throw new Error("[vinext] Pages Router runtime installed before next/router was initialized");
  }

  pagesRouterRuntimeInstalled = true;
  window.addEventListener("popstate", pagesRouterPopStateHandler);
}
