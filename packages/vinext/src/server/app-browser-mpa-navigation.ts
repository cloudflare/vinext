import type { HistoryUpdateMode } from "./app-browser-navigation-controller.js";

const NEXT_APP_ROUTER_PAGE_REDIRECT_MARKER_ID = "__next-page-redirect";

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
    beforeNavigate?: () => void | (() => void),
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

      const recover = beforeNavigate?.();
      try {
        if (historyUpdateMode === "replace") {
          targetWindow.location.replace(href);
        } else {
          targetWindow.location.assign(href);
        }
      } catch (error) {
        recover?.();
        throw error;
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

/** Recover only a confirmed abort, never merely a slow document load. */
export function observeDocumentNavigationCancellation(
  navigation: EventTarget | undefined,
  href: string,
  onCancel: () => void,
): () => void {
  const observer = new AbortController();
  let observed = false;
  navigation?.addEventListener(
    "navigate",
    (event) => {
      const { destination, signal } = event as Event & {
        destination: { url: string; sameDocument: boolean };
        signal: AbortSignal;
      };
      // A newer navigation may abort the old event before firing its own event.
      // Invalidate the queued recovery before its microtask can dispatch actions.
      if (observed || destination.sameDocument || destination.url !== href) {
        observer.abort();
        return;
      }
      observed = true;
      signal.addEventListener(
        "abort",
        () => {
          queueMicrotask(() => {
            if (observer.signal.aborted) return;
            observer.abort();
            onCancel();
          });
        },
        { once: true, signal: observer.signal },
      );
    },
    { signal: observer.signal },
  );
  return () => observer.abort();
}
