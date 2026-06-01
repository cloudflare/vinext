import type { HistoryUpdateMode } from "./app-browser-navigation-controller.js";

export type AppBrowserMpaNavigationWindow = {
  location: Pick<Location, "assign" | "replace">;
  requestAnimationFrame?: (callback: FrameRequestCallback) => unknown;
  setTimeout(callback: () => void, timeout: number): unknown;
};

type PendingMpaNavigation = {
  href: string;
  historyUpdateMode: HistoryUpdateMode;
  token: number;
};

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
    const pendingNavigation = this.#pendingNavigation;
    if (
      pendingNavigation?.href === href &&
      pendingNavigation.historyUpdateMode === historyUpdateMode
    ) {
      return;
    }

    const token = this.#nextToken + 1;
    this.#nextToken = token;
    this.#pendingNavigation = { href, historyUpdateMode, token };

    const navigate = () => {
      const currentNavigation = this.#pendingNavigation;
      if (
        currentNavigation?.href !== href ||
        currentNavigation.historyUpdateMode !== historyUpdateMode ||
        currentNavigation.token !== token
      ) {
        return;
      }

      if (historyUpdateMode === "replace") {
        targetWindow.location.replace(href);
      } else {
        targetWindow.location.assign(href);
      }
    };

    if (typeof targetWindow.requestAnimationFrame === "function") {
      targetWindow.requestAnimationFrame(() => {
        targetWindow.setTimeout(navigate, 0);
      });
      return;
    }

    targetWindow.setTimeout(navigate, 0);
  }
}
