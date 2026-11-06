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
 * response to finish streaming. Both refresh the page the navigation landed on.
 *
 * Deliberate differences from Next.js:
 * - The navigation commits on its own response, with its history entry, and
 *   the refresh then runs as a navigation of its own. Next.js starts the
 *   refresh when the navigation's response arrives and commits the
 *   destination once, with the refresh's response, replacing the navigation's
 *   history entry. While refreshes keep starting faster than the server
 *   responds (a polling page), Next.js never commits the navigation at all.
 * - So the caller's useTransition is pending only until the navigation ahead
 *   of a queued refresh commits, not until the refresh commits as in Next.js.
 *   Keeping it pending would mean suspending a transition, and React renders
 *   pending transitions together, so that would hold the navigation's commit
 *   too: the single commit above.
 * - Refreshes queued behind one navigation run once, where Next.js sends a
 *   request for each. The one request starts after all of them were made.
 * - A document load the router starts (for a navigation, a Server Action
 *   redirect, or a push to a route it can't render) drops the queued
 *   refresh. Next.js still runs it, but here a refresh in the page being
 *   unloaded can fall back to a document load of its own and replace the
 *   pending one.
 */
export function createAppBrowserRefreshQueue(
  options: { queueTask?: (task: () => void) => void } = {},
): {
  beginNavigation(): AppBrowserRefreshQueueNavigation;
  dropQueuedRefresh(): void;
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
    /** A document load started; drop the refresh waiting to run. */
    dropQueuedRefresh() {
      queuedRefresh = null;
      releasedRefresh = null;
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
