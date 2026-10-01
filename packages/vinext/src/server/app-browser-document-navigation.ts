import { DOCUMENT_UNLOAD_TIMEOUT_MS, toDocumentLoadHref } from "../client/chunk-load-recovery.js";
import {
  clearHardNavigationLoopGuard,
  performHardNavigationWithLoopGuard,
  type HardNavigationMode,
  type HistoryUpdateMode,
} from "./app-browser-navigation-controller.js";
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
  resumeAfterDocumentNavigation(): void;
  stopRefreshes(): void;
};

/**
 * Owns the two chokepoints through which the App Router leaves the current
 * document, and the recovery that runs when that navigation is canceled.
 */
export function createAppBrowserDocumentNavigation(deps: AppBrowserDocumentNavigationDeps) {
  let cancelRecovery = () => {};
  let pendingOutcome: DocumentNavigationOutcome | undefined;

  function resetRecoveryOnPageHide(): void {
    const cancel = cancelRecovery;
    cancelRecovery = () => {};
    pendingOutcome = undefined;
    cancel();
  }

  function resetRecovery(): void {
    const outcome = pendingOutcome;
    resetRecoveryOnPageHide();
    outcome?.onAbandoned();
  }

  /**
   * Holds refreshes and Server Actions back while a document loads. A confirmed
   * cancel replays them. A load that neither unloads the page nor reports a
   * cancel (a 204, an attachment, a dismissed Leave-site prompt) expires after
   * DOCUMENT_UNLOAD_TIMEOUT_MS: held Server Actions are rejected, and the loop
   * guard stays because the load may still be in progress.
   */
  function beginDocumentNavigation(
    href: string,
    outcome: DocumentNavigationOutcome | undefined,
    alreadyStopped: boolean,
  ): () => void {
    const targetHref = new URL(href, window.location.href).href;
    if (!alreadyStopped) deps.stopRefreshes();
    resetRecovery();
    const restore = () => {
      resetRecoveryOnPageHide();
      deps.mpaNavigationScheduler.reset();
      deps.discardPendingNavigation();
    };
    const recover = () => {
      if (cancelRecovery !== cancel) return;
      restore();
      clearHardNavigationLoopGuard();
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
    pendingOutcome = outcome;
    return recover;
  }

  function beforeDocumentNavigation(href: string, outcome?: DocumentNavigationOutcome): () => void {
    return beginDocumentNavigation(href, outcome, false);
  }

  return {
    beforeDocumentNavigation,
    performHardNavigation(href: string, mode?: HardNavigationMode): boolean {
      // A fragment-only change scrolls instead of loading a document.
      const loadHref = toDocumentLoadHref(href);
      return performHardNavigationWithLoopGuard(loadHref, mode, () =>
        beforeDocumentNavigation(loadHref),
      );
    },
    performMpaNavigation(
      href: string,
      historyUpdateMode: HistoryUpdateMode,
      options: { refreshesStopped?: boolean } = {},
    ): void {
      if (!options.refreshesStopped) deps.stopRefreshes();
      const loadHref = toDocumentLoadHref(href);
      // Match Next's MPA path by suspending forever, but delay the actual location
      // mutation just enough for the old tree to commit the pending transition
      // signal before unload.
      deps.mpaNavigationScheduler.navigate(window, loadHref, historyUpdateMode, () =>
        beginDocumentNavigation(loadHref, undefined, true),
      );
    },
    resetRecovery,
    resetRecoveryOnPageHide,
  };
}
