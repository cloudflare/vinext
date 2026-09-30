import { DOCUMENT_UNLOAD_TIMEOUT_MS, toDocumentLoadHref } from "../client/chunk-load-recovery.js";
import type { HardNavigationMode, HistoryUpdateMode } from "./app-browser-navigation-controller.js";
import {
  observeDocumentNavigationCancellation,
  type AppBrowserMpaNavigationWindow,
} from "./app-browser-mpa-navigation.js";
import { ServerActionNotSentError } from "./app-browser-refresh-queue.js";

export type DocumentNavigationOutcome = {
  onCanceled(): void;
  onAbandoned(): void;
};

type AppBrowserDocumentNavigationDeps = {
  clearHardNavigationLoopGuard(): void;
  discardPendingNavigation(): void;
  expireDocumentNavigation(error: Error): void;
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

  /**
   * Holds refreshes and Server Actions back while a document loads. A confirmed
   * cancel replays them. A load that neither unloads the page nor reports a
   * cancel (a 204, an attachment, a dismissed Leave-site prompt) expires after
   * DOCUMENT_UNLOAD_TIMEOUT_MS: held Server Actions are rejected, and the loop
   * guard stays because the load may still be in progress.
   */
  function beforeDocumentNavigation(href: string, outcome?: DocumentNavigationOutcome): () => void {
    const targetHref = new URL(href, window.location.href).href;
    deps.stopRefreshes();
    resetRecovery();
    const restore = () => {
      resetRecovery();
      deps.mpaNavigationScheduler.reset();
      deps.discardPendingNavigation();
    };
    const recover = () => {
      if (cancelRecovery !== cancel) return;
      restore();
      deps.clearHardNavigationLoopGuard();
      deps.resumeAfterDocumentNavigation();
      outcome?.onCanceled();
    };
    const expire = () => {
      if (cancelRecovery !== cancel) return;
      restore();
      deps.expireDocumentNavigation(new ServerActionNotSentError());
      outcome?.onAbandoned();
    };
    const cancelObserver = observeDocumentNavigationCancellation(
      (window as Window & { navigation?: EventTarget }).navigation,
      targetHref,
      recover,
    );
    const timer = setTimeout(expire, DOCUMENT_UNLOAD_TIMEOUT_MS);
    const cancel = () => {
      cancelObserver();
      clearTimeout(timer);
    };
    cancelRecovery = cancel;
    return recover;
  }

  return {
    beforeDocumentNavigation,
    performHardNavigation(href: string, mode?: HardNavigationMode): boolean {
      // A fragment-only change scrolls instead of loading a document.
      const loadHref = toDocumentLoadHref(href);
      return deps.performHardNavigationWithLoopGuard(loadHref, mode, () =>
        beforeDocumentNavigation(loadHref),
      );
    },
    performMpaNavigation(href: string, historyUpdateMode: HistoryUpdateMode): void {
      deps.stopRefreshes();
      const loadHref = toDocumentLoadHref(href);
      // Match Next's MPA path by suspending forever, but delay the actual location
      // mutation just enough for the old tree to commit the pending transition
      // signal before unload.
      deps.mpaNavigationScheduler.navigate(window, loadHref, historyUpdateMode, () =>
        beforeDocumentNavigation(loadHref),
      );
    },
    resetRecovery,
  };
}
