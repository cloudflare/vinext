type RestoreScrollPosition = (
  state: unknown,
  options?: {
    shouldContinue?: () => boolean;
  },
) => void;
type NavigateRsc = (
  href: string,
  redirectDepth?: number,
  navigationKind?: "navigate" | "traverse" | "refresh",
) => Promise<void>;

type BrowserPopstateRestoreDeps = {
  getActiveNavigationId: () => number;
  getPendingNavigation: () => Promise<void> | null | undefined;
  getNavigate: () => NavigateRsc | undefined;
  isCurrentNavigation: (navId: number) => boolean;
  notifyAppRouterTransitionStart: (href: string) => void;
  restorePopstateScrollPosition: RestoreScrollPosition;
  setPendingNavigation: (pendingNavigation: Promise<void> | null) => void;
};

function hasSavedScrollPosition(state: unknown): boolean {
  return Boolean(state && typeof state === "object" && "__vinext_scrollY" in state);
}

function scheduleAfterFrame(callback: () => void): void {
  if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
    window.requestAnimationFrame(callback);
    return;
  }

  queueMicrotask(callback);
}

export function createPopstateRestoreHandler(
  deps: BrowserPopstateRestoreDeps,
): (event: PopStateEvent) => void {
  return (event) => {
    deps.notifyAppRouterTransitionStart(window.location.href);
    const navigate = deps.getNavigate();
    const pendingNavigation = navigate?.(window.location.href, 0, "traverse") ?? Promise.resolve();
    const popstateNavId = deps.getActiveNavigationId();

    deps.setPendingNavigation(pendingNavigation);
    const shouldRestoreSavedScroll = hasSavedScrollPosition(event.state);
    if (shouldRestoreSavedScroll) {
      scheduleAfterFrame(() => {
        if (deps.isCurrentNavigation(popstateNavId)) {
          deps.restorePopstateScrollPosition(event.state, {
            shouldContinue: () => deps.isCurrentNavigation(popstateNavId),
          });
        }
      });
    }

    void pendingNavigation.finally(() => {
      if (deps.isCurrentNavigation(popstateNavId) && !shouldRestoreSavedScroll) {
        deps.restorePopstateScrollPosition(event.state);
      }

      if (deps.getPendingNavigation() === pendingNavigation) {
        deps.setPendingNavigation(null);
      }
    });
  };
}
