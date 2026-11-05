export type AppBrowserRefreshQueueNavigation = {
  /** The navigation committed or ended; run the refresh queued behind it. */
  settle(): void;
  /** The navigation started a document load; drop the refresh queued behind it. */
  drop(): void;
};

/**
 * Holds router.refresh() behind the App Router navigation (or refresh) in
 * flight, like Next.js's action queue: only a navigation discards the pending
 * action, so a refresh waits for the one ahead of it, and the refresh reducer
 * then runs on its result (`state.canonicalUrl`), refreshing the destination.
 * A newer navigation inherits the queued refresh, as
 * `newAction.next = pending.next` does in Next.js.
 * https://github.com/vercel/next.js/blob/canary/packages/next/src/client/components/app-router-instance.ts
 *
 * The queue releases once the navigation commits, without waiting for its
 * response to finish streaming. Next.js releases once the navigation reducer
 * resolves; both refresh the page the navigation landed on.
 *
 * Deliberate differences from Next.js:
 * - Refreshes queued behind one navigation run once, where Next.js sends a
 *   request for each.
 * - A navigation that starts a document load drops the refresh queued behind
 *   it. Next.js still runs it, but here a refresh in the page being unloaded
 *   can fall back to a document load of its own and replace the pending one.
 */
export function createAppBrowserRefreshQueue(
  options: { queueTask?: (task: () => void) => void } = {},
): {
  beginNavigation(): AppBrowserRefreshQueueNavigation;
  queueRefresh(refresh: () => void): boolean;
} {
  const queueTask = options.queueTask ?? queueMicrotask;
  let activeNavigation: object | null = null;
  let queuedRefresh: (() => void) | null = null;
  // A released refresh runs in a task after the navigation's commit. Until
  // then a navigation that starts takes it over, and a refresh that starts
  // runs in its place.
  let releasedRefresh: (() => void) | null = null;

  function end(navigation: object, runQueuedRefresh: boolean): void {
    if (activeNavigation !== navigation) return;
    activeNavigation = null;
    const refresh = queuedRefresh;
    queuedRefresh = null;
    if (!runQueuedRefresh || refresh === null) return;
    releasedRefresh = refresh;
    queueTask(() => {
      if (releasedRefresh !== refresh) return;
      releasedRefresh = null;
      refresh();
    });
  }

  return {
    beginNavigation() {
      if (releasedRefresh !== null) {
        queuedRefresh = releasedRefresh;
        releasedRefresh = null;
      }
      const navigation = {};
      activeNavigation = navigation;
      return {
        settle: () => end(navigation, true),
        drop: () => end(navigation, false),
      };
    },
    /**
     * Queues `refresh` behind the navigation in flight and returns true, or
     * returns false when there is none and the caller should refresh now.
     */
    queueRefresh(refresh) {
      if (activeNavigation === null) {
        releasedRefresh = null;
        return false;
      }
      queuedRefresh = refresh;
      return true;
    },
  };
}
