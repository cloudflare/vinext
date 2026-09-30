import type { CommitNavigationHistoryOptions } from "./app-browser-history-controller.js";
import type { HistoryUpdateMode } from "./app-browser-navigation-controller.js";

type CommitClientNavigationState = (
  navId?: number,
  options?: { deferNotifications?: boolean; releaseSnapshot?: boolean },
) => void;

type NavigationCommitEffectDeps = {
  clearNavigationFailureTarget(href: string): void;
  commitClientNavigationState: CommitClientNavigationState;
  commitNavigationHistory(options: CommitNavigationHistoryOptions): void;
  isCurrentNavigation(navId: number): boolean;
  stageClientParams(params: Record<string, string | string[]>): void;
};

export type NavigationCommitEffectOptions = {
  activeRoutePaths: readonly string[];
  bfcacheIds: Readonly<Record<string, string>>;
  href: string;
  historyUpdateMode: HistoryUpdateMode | undefined;
  navId: number;
  params: Record<string, string | string[]>;
  previousNextUrl: string | null;
  /** False when the effect's render never activated a navigation snapshot. */
  releaseSnapshot?: boolean;
  targetHistoryIndex?: number | null;
};

/**
 * Builds the pre-paint effect that writes history and commits client navigation
 * state for one render. A superseded effect still balances the snapshot
 * counter, but only when its render activated a snapshot.
 */
export function createNavigationCommitEffect(
  options: NavigationCommitEffectOptions,
  deps: NavigationCommitEffectDeps,
): (deferNotifications?: boolean) => void {
  const {
    activeRoutePaths,
    bfcacheIds,
    href,
    historyUpdateMode,
    navId,
    params,
    previousNextUrl,
    releaseSnapshot,
    targetHistoryIndex,
  } = options;

  return (deferNotifications = false) => {
    if (!deps.isCurrentNavigation(navId)) {
      // Superseded before commit: balance the active snapshot counter without
      // clearing pendingPathname ownership.
      deps.commitClientNavigationState(undefined, {
        deferNotifications,
        releaseSnapshot: releaseSnapshot !== false,
      });
      return;
    }

    deps.commitNavigationHistory({
      activeRoutePaths,
      bfcacheIds,
      href,
      historyUpdateMode,
      previousNextUrl,
      stageClientParams: () => deps.stageClientParams(params),
      targetHistoryIndex,
    });

    // URL has been updated; the recovery hard-nav target is no longer needed.
    deps.clearNavigationFailureTarget(href);
    deps.commitClientNavigationState(navId, { deferNotifications, releaseSnapshot });
  };
}
