import type { HistoryUpdateMode } from "./app-browser-navigation-controller.js";

const NEXT_APP_ROUTER_PAGE_REDIRECT_MARKER_ID = "__next-page-redirect";

export type AppBrowserMpaNavigationWindow = {
  document?: Pick<Document, "visibilityState">;
  location: Pick<Location, "assign" | "replace">;
  requestAnimationFrame?: (callback: FrameRequestCallback) => unknown;
  setTimeout(callback: () => void, timeout: number): unknown;
};

type PendingMpaNavigation = {
  href: string;
  token: number;
};

export function hasPendingAppRouterPageRedirect(targetDocument: unknown): boolean {
  if (typeof targetDocument !== "object" || targetDocument === null) {
    return false;
  }

  if (!("getElementById" in targetDocument)) {
    return false;
  }

  const { getElementById } = targetDocument;
  if (typeof getElementById !== "function") {
    return false;
  }

  return getElementById.call(targetDocument, NEXT_APP_ROUTER_PAGE_REDIRECT_MARKER_ID) !== null;
}

export class AppBrowserMpaNavigationScheduler {
  #pendingNavigation: PendingMpaNavigation | null = null;
  #nextToken = 0;

  reset(): void {
    this.#pendingNavigation = null;
  }

  navigate(
    targetWindow: AppBrowserMpaNavigationWindow,
    href: string,
    historyUpdateMode: HistoryUpdateMode,
  ): void {
    // Like Next.js's pendingMpaPath, the first navigation to a URL wins until
    // a bfcache restore resets it, whatever history mode a later one asks for.
    if (this.#pendingNavigation?.href === href) {
      return;
    }

    const token = this.#nextToken + 1;
    this.#nextToken = token;
    this.#pendingNavigation = { href, token };

    const navigate = () => {
      if (this.#pendingNavigation?.token !== token) {
        return;
      }

      if (historyUpdateMode === "replace") {
        targetWindow.location.replace(href);
      } else {
        targetWindow.location.assign(href);
      }
    };

    // A hidden document paints nothing before unload, runs no animation
    // frames, and throttles timers, so navigate now as Next.js does.
    if (targetWindow.document?.visibilityState === "hidden") {
      navigate();
      return;
    }

    if (typeof targetWindow.requestAnimationFrame === "function") {
      targetWindow.requestAnimationFrame(() => {
        targetWindow.setTimeout(navigate, 0);
      });
      return;
    }

    targetWindow.setTimeout(navigate, 0);
  }
}
