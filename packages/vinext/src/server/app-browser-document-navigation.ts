import type { HardNavigationMode, HistoryUpdateMode } from "./app-browser-navigation-controller.js";
import {
  observeDocumentNavigationCancellation,
  type AppBrowserMpaNavigationWindow,
} from "./app-browser-mpa-navigation.js";

export type DocumentNavigationOutcome = {
  onCanceled(): void;
  onAbandoned(): void;
};

type AppBrowserDocumentNavigationDeps = {
  clearHardNavigationLoopGuard(): void;
  discardPendingNavigation(): void;
  mpaNavigationScheduler: {
    navigate(
      targetWindow: AppBrowserMpaNavigationWindow,
      href: string,
      historyUpdateMode: HistoryUpdateMode,
      beforeNavigate?: () => void | (() => void),
    ): void;
    reset(): void;
  };
  performHardNavigationWithLoopGuard(
    href: string,
    mode: HardNavigationMode | undefined,
    beforeNavigate?: () => void | (() => void),
  ): boolean;
  resumeAfterDocumentNavigation(): void;
  stopRefreshes(): void;
};

/**
 * Owns the two chokepoints through which the App Router leaves the current
 * document, and the recovery that runs when that navigation is canceled.
 */
export function createAppBrowserDocumentNavigation(deps: AppBrowserDocumentNavigationDeps) {
  let cancelRecovery = () => {};

  function resetRecovery(): void {
    const cancel = cancelRecovery;
    cancelRecovery = () => {};
    cancel();
  }

  function beforeDocumentNavigation(href: string): () => void {
    const targetHref = new URL(href, window.location.href).href;
    deps.stopRefreshes();
    resetRecovery();
    const recover = () => {
      if (cancelRecovery !== cancelObserver) return;
      resetRecovery();
      deps.mpaNavigationScheduler.reset();
      deps.discardPendingNavigation();
      deps.clearHardNavigationLoopGuard();
      deps.resumeAfterDocumentNavigation();
    };
    const cancelObserver = observeDocumentNavigationCancellation(
      (window as Window & { navigation?: EventTarget }).navigation,
      targetHref,
      recover,
    );
    cancelRecovery = cancelObserver;
    return recover;
  }

  return {
    beforeDocumentNavigation,
    performHardNavigation(href: string, mode?: HardNavigationMode): boolean {
      return deps.performHardNavigationWithLoopGuard(href, mode, () =>
        beforeDocumentNavigation(href),
      );
    },
    performMpaNavigation(href: string, historyUpdateMode: HistoryUpdateMode): void {
      deps.stopRefreshes();
      // Match Next's MPA path by suspending forever, but delay the actual location
      // mutation just enough for the old tree to commit the pending transition
      // signal before unload.
      deps.mpaNavigationScheduler.navigate(window, href, historyUpdateMode, () =>
        beforeDocumentNavigation(href),
      );
    },
    resetRecovery,
  };
}
