import type { AppRouterScrollIntent } from "vinext/shims/app-router-scroll-state";
import type { AppRouterState } from "./app-browser-state.js";
import type { HistoryUpdateMode } from "./app-browser-navigation-controller.js";

export type AppBrowserNavigationActionResult = {
  state: AppRouterState;
  href: string;
  historyUpdateMode: HistoryUpdateMode | undefined;
  scrollIntent: AppRouterScrollIntent | null;
};

type RefreshRequest = {
  resolve: () => void;
  reject: (error: unknown) => void;
  navigationId: number | null;
};

/** Public refresh actions wait for router state, independently of React commit and Flight EOF. */
export function createAppBrowserRefreshQueue(
  runRefresh: (result: AppBrowserNavigationActionResult | null) => void,
) {
  let active: {
    id: number;
    ready: boolean;
    result: AppBrowserNavigationActionResult | null;
  } | null = null;
  const requests: RefreshRequest[] = [];
  let executing: RefreshRequest | null = null;
  let documentNavigation = false;

  function finishRefresh(): void {
    const completed = executing;
    executing = null;
    completed?.resolve();
  }

  function drain(): void {
    if (executing || (active && !active.ready)) return;
    const request = requests.shift();
    if (!request) return;
    executing = request;
    try {
      // Dispatch synchronously when idle, like Next's action queue. Deferring
      // this call would let a later navigation change an already-issued refresh.
      runRefresh(active?.result ?? null);
      request.navigationId = active?.id ?? null;
      if (!active || active.ready) {
        finishRefresh();
        drain();
      }
    } catch (error) {
      executing = null;
      request.reject(error);
      drain();
    }
  }

  return {
    start(navigationId: number) {
      documentNavigation = false;
      // A newer navigation discards an executing refresh but keeps requests
      // still queued behind it. Its stale completion must not drain this queue.
      if (executing && executing.navigationId !== null) finishRefresh();
      active = { id: navigationId, ready: false, result: null };
    },
    ready(navigationId: number, result: AppBrowserNavigationActionResult | null = null) {
      if (!active || active.id !== navigationId || active.ready) return;
      active.result = result;
      active.ready = true;
      if (executing?.navigationId === navigationId) finishRefresh();
      drain();
    },
    stopForDocumentNavigation() {
      // The destination document owns the next UI. A queued refresh must not
      // refetch the old location while that document response is still pending.
      documentNavigation = true;
      active = null;
      finishRefresh();
      for (const request of requests.splice(0)) request.resolve();
    },
    resumeAfterDocumentRestore() {
      documentNavigation = false;
    },
    refresh(): Promise<void> {
      if (documentNavigation) return Promise.resolve();
      // Each public ACTION_REFRESH is distinct. Discarded Server Action
      // revalidations retain their separate, coalescing needsRefresh scheduler.
      return new Promise<void>((resolve, reject) => {
        requests.push({ resolve, reject, navigationId: null });
        drain();
      });
    },
  };
}
