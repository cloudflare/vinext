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

type NavigationCommitEffectOptions = {
  activeRoutePaths: readonly string[];
  bfcacheIds: Readonly<Record<string, string>>;
  href: string;
  historyUpdateMode: HistoryUpdateMode | undefined;
  navId: number;
  params: Record<string, string | string[]>;
  previousNextUrl: string | null;
  targetHistoryIndex?: number | null;
};

/**
 * Binds the commit-effect dependencies once. The returned factory builds the
 * pre-paint effect that writes history and commits client navigation state for
 * one render. The caller passes whether the render activated a navigation
 * snapshot, so a superseded effect balances the snapshot counter only when it
 * should.
 */
export function createNavigationCommitEffect(deps: NavigationCommitEffectDeps) {
  return (
    options: NavigationCommitEffectOptions,
  ): ((deferNotifications: boolean, releaseSnapshot: boolean) => void) => {
    const {
      activeRoutePaths,
      bfcacheIds,
      href,
      historyUpdateMode,
      navId,
      params,
      previousNextUrl,
      targetHistoryIndex,
    } = options;

    return (deferNotifications, releaseSnapshot) => {
      if (!deps.isCurrentNavigation(navId)) {
        // Superseded before commit: balance the active snapshot counter without
        // clearing pendingPathname ownership.
        deps.commitClientNavigationState(undefined, { deferNotifications, releaseSnapshot });
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
  };
}
