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

/** Recover an owned abort or completion in the surviving document, never a slow load. */
export function observeDocumentNavigationCancellation(
  navigation: EventTarget | undefined,
  href: string,
  onCancel: () => void,
): () => void {
  const observer = new AbortController();
  let observedSignal: AbortSignal | undefined;
  let observedInitialNavigation = false;
  navigation?.addEventListener(
    "navigate",
    (event) => {
      const { destination, signal } = event as Event & {
        destination: { url: string; sameDocument: boolean };
        signal: AbortSignal;
      };
      // A replacement can reach this listener before the original event does.
      // Stage its signal, but only recover once our original dispatch is seen.
      if (!destination.sameDocument && destination.url === href) observedInitialNavigation = true;
      // Never let an aborted outer event overwrite its live nested replacement.
      if (destination.sameDocument) return;
      if (signal.aborted && (observedSignal || destination.url !== href)) return;
      observedSignal = signal;
      const recover = () => {
        queueMicrotask(() => {
          if (!observedInitialNavigation || observer.signal.aborted || observedSignal !== signal)
            return;
          observer.abort();
          onCancel();
        });
      };
      // Initial dispatch may have been replaced by a canceled hash before it
      // reached us. Its aborted signal is the fallback when no newer one exists.
      if (signal.aborted) recover();
      else signal.addEventListener("abort", recover, { once: true, signal: observer.signal });
      // An intercepted document navigation can finish without abort or unload.
      // Capture this attempt: an earlier success listener may start a newer one.
      navigation?.addEventListener("navigatesuccess", recover, {
        once: true,
        signal: observer.signal,
      });
    },
    { signal: observer.signal },
  );
  return () => observer.abort();
}
