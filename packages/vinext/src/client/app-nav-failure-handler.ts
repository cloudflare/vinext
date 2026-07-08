import { installWindowNext } from "./window-next.js";

function getPendingUrl(): URL | null {
  if (typeof window === "undefined") return null;
  return window.next?.__pendingUrl ?? null;
}

export function stageAppNavigationFailureTarget(href: string): void {
  if (!process.env.__NEXT_APP_NAV_FAIL_HANDLING || typeof window === "undefined") return;
  installWindowNext({ __pendingUrl: new URL(href, window.location.href) });
}

export function getAppNavigationFailureTarget(href: string): URL | null {
  const pendingUrl = getPendingUrl();
  if (pendingUrl === null || typeof window === "undefined") return null;
  return pendingUrl.href === new URL(href, window.location.href).href ? pendingUrl : null;
}

export function clearAppNavigationFailureTarget(target?: string | URL): void {
  if (typeof window === "undefined" || window.next?.__pendingUrl === undefined) return;
  if (target instanceof URL) {
    if (window.next.__pendingUrl !== target) return;
  } else if (
    target !== undefined &&
    window.next.__pendingUrl.href !== new URL(target, window.location.href).href
  ) {
    return;
  }
  delete window.next.__pendingUrl;
}

export function handleAppNavigationFailure(error: unknown): boolean {
  if (!process.env.__NEXT_APP_NAV_FAIL_HANDLING || typeof window === "undefined") return false;
  const pendingUrl = getPendingUrl();
  if (pendingUrl === null || pendingUrl.href === window.location.href) return false;
  console.error("Error occurred during navigation, falling back to hard navigation", error);
  window.location.assign(pendingUrl.href);
  return true;
}

export function installAppNavigationFailureListeners(): () => void {
  if (!process.env.__NEXT_APP_NAV_FAIL_HANDLING || typeof window === "undefined") return () => {};
  const listener = (event: ErrorEvent | PromiseRejectionEvent) => {
    handleAppNavigationFailure("reason" in event ? event.reason : event.error);
  };
  window.addEventListener("error", listener);
  window.addEventListener("unhandledrejection", listener);
  return () => {
    window.removeEventListener("error", listener);
    window.removeEventListener("unhandledrejection", listener);
  };
}
