import type { ChunkRecoveryNavigator } from "../client/chunk-load-recovery.js";
import type { DocumentNavigationOutcome } from "./app-browser-document-navigation.js";
import type { HardNavigationMode, HistoryUpdateMode } from "./app-browser-navigation-controller.js";

export type InFlightNavigation = {
  navId: number;
  href: string;
  historyUpdateMode: HistoryUpdateMode | "traverse";
};

type AppBrowserChunkRecoveryDeps = {
  beforeDocumentNavigation(href: string, outcome: DocumentNavigationOutcome): () => void;
  getCurrentHref(): string;
  performHardNavigationWithLoopGuard(
    href: string,
    mode: HardNavigationMode,
    beforeNavigate?: () => void | (() => void),
  ): boolean;
  toDocumentLoadHref(target: string): string;
};

/**
 * Tracks the navigation the user is waiting on and supplies the chunk-load
 * recovery navigator that loads its target as a document.
 */
export function createAppBrowserChunkRecovery(deps: AppBrowserChunkRecoveryDeps) {
  let inFlight: InFlightNavigation | null = null;

  function resolveMode(navigation: InFlightNavigation, targetHref: string): HardNavigationMode {
    if (navigation.historyUpdateMode !== "push") return "replace";
    // The URL commits before the render that fails, and assigning it again
    // would duplicate the history entry.
    const currentHref = deps.getCurrentHref();
    return new URL(targetHref, currentHref).href === new URL(currentHref).href
      ? "replace"
      : "assign";
  }

  const navigator: ChunkRecoveryNavigator = (outcome) => {
    const targetHref = inFlight?.href ?? deps.getCurrentHref();
    const mode = inFlight ? resolveMode(inFlight, targetHref) : "replace";
    const loadHref = deps.toDocumentLoadHref(targetHref);

    return deps.performHardNavigationWithLoopGuard(loadHref, mode, () =>
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
