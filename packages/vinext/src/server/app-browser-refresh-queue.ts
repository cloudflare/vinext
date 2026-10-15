export type AppBrowserRefreshQueueNavigation = {
  /** The navigation reached its visible outcome; run a refresh queued behind it. */
  settle(): void;
};

type AppBrowserRefreshQueueOptions = {
  /**
   * Called for each refresh the queue drops. The page may not unload after
   * all (a download, a 204), so a dropped refresh still invalidates caches.
   */
  onDropRefresh: () => void;
  queueTask?: (callback: () => void) => void;
  runRefresh: () => void;
};

/**
 * Holds router.refresh() behind the navigation in flight, like Next.js's
 * action queue: only navigations discard pending actions, so a refresh waits
 * for the navigation ahead of it and the refresh reducer then runs on the
 * navigation's result. A newer navigation takes over the queued refresh.
 *
 * vinext runs the refresh once the navigation commits (or ends without a
 * commit), where Next.js runs it once the navigation reducer resolves; both
 * refresh the destination. Unlike Next.js, refreshes queued behind the same
 * navigation run once, not once each, a refresh supersedes an in-flight
 * refresh instead of waiting behind it, and a queued refresh does not keep its
 * caller's transition pending. Next.js also restores back/forward navigations
 * synchronously, so a refresh never waits behind one there; here it waits for
 * a back/forward navigation that refetches. A document load the router starts
 * itself drops the queued refresh (see drop()), where Next.js still runs it;
 * behind any other document load (a Pages Router link, a native anchor) it
 * runs, as in Next.js. A Server Action redirect or re-render (or, in dev, an
 * HMR update) can commit over the navigation without ending it; the refresh
 * still waits for that navigation, then refreshes the page shown. Next.js
 * queues the action behind both, so the action's commit lands last.
 * https://github.com/vercel/next.js/blob/canary/packages/next/src/client/components/app-router-instance.ts
 */
export function createAppBrowserRefreshQueue(options: AppBrowserRefreshQueueOptions): {
  beginNavigation(): AppBrowserRefreshQueueNavigation;
  drop(): void;
  queueRefresh(): boolean;
} {
  const queueTask = options.queueTask ?? queueMicrotask;
  let activeNavigation: object | null = null;
  let refreshQueued = false;
  // A released refresh still counts as queued until its task runs: a refresh
  // that starts first replaces it, and a navigation that starts first takes it
  // over.
  let scheduledRefresh: object | null = null;
  // The navigation in flight when the router started a document load: a
  // refresh issued before it settles is moot too. One issued after it runs,
  // since the page may stay after all (a download, a 204).
  let leavingNavigation: object | null = null;

  const release = (navigation: object) => {
    if (activeNavigation !== navigation) return;
    activeNavigation = null;
    if (!refreshQueued) return;
    refreshQueued = false;
    const scheduled = {};
    scheduledRefresh = scheduled;
    queueTask(() => {
      if (scheduledRefresh !== scheduled) return;
      scheduledRefresh = null;
      options.runRefresh();
    });
  };

  return {
    beginNavigation() {
      // A navigation that starts before a released refresh runs takes it over.
      if (scheduledRefresh !== null) {
        scheduledRefresh = null;
        refreshQueued = true;
      }
      const navigation = {};
      activeNavigation = navigation;
      return { settle: () => release(navigation) };
    },
    /** The router has started a document load, so a queued refresh is moot. */
    drop() {
      const dropped = refreshQueued || scheduledRefresh !== null;
      refreshQueued = false;
      scheduledRefresh = null;
      leavingNavigation = activeNavigation;
      if (dropped) options.onDropRefresh();
    },
    /** Queues a refresh behind the navigation in flight, if there is one. */
    queueRefresh() {
      if (activeNavigation !== null && activeNavigation === leavingNavigation) {
        options.onDropRefresh();
        return true;
      }
      if (activeNavigation === null) {
        // A refresh that starts now covers one released but not yet run.
        scheduledRefresh = null;
        return false;
      }
      refreshQueued = true;
      return true;
    },
  };
}
