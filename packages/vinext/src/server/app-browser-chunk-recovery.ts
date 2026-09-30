import { toDocumentLoadHref, type ChunkRecoveryNavigator } from "../client/chunk-load-recovery.js";
import type { DocumentNavigationOutcome } from "./app-browser-document-navigation.js";
import {
  performHardNavigationWithLoopGuard,
  type HistoryUpdateMode,
} from "./app-browser-navigation-controller.js";

export type InFlightNavigation = {
  navId: number;
  href: string;
  historyUpdateMode: HistoryUpdateMode | "traverse";
};

type AppBrowserChunkRecoveryDeps = {
  beforeDocumentNavigation(href: string, outcome: DocumentNavigationOutcome): () => void;
};

/**
 * Tracks the navigation the user is waiting on and supplies the chunk-load
 * recovery navigator that loads its target as a document.
 */
export function createAppBrowserChunkRecovery(deps: AppBrowserChunkRecoveryDeps) {
  let inFlight: InFlightNavigation | null = null;

  const navigator: ChunkRecoveryNavigator = (outcome) => {
    const currentHref = window.location.href;
    const targetHref = inFlight?.href ?? currentHref;
    // The URL of a push navigation commits before the render that fails, and
    // assigning it again would duplicate the history entry.
    const mode =
      inFlight?.historyUpdateMode === "push" &&
      new URL(targetHref, currentHref).href !== new URL(currentHref).href
        ? "assign"
        : "replace";
    const loadHref = toDocumentLoadHref(targetHref);

    return performHardNavigationWithLoopGuard(loadHref, mode, () =>
      deps.beforeDocumentNavigation(loadHref, outcome),
    );
  };

  return {
    clearNavigation(navId: number): void {
      if (inFlight?.navId === navId) inFlight = null;
    },
    discardNavigation(): void {
      inFlight = null;
    },
    navigator,
    recordNavigation(navigation: InFlightNavigation): void {
      inFlight = navigation;
    },
  };
}

/** Starts a chunk-load recovery for a root error callback and drops its rejection. */
export function createRootErrorRecovery(
  recoverFromChunkFailure: (error: unknown) => Promise<never>,
): (error: unknown) => void {
  return (error) => {
    recoverFromChunkFailure(error).catch(() => {});
  };
}
