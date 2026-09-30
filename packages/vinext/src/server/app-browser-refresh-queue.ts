import type { AppRouterScrollIntent } from "vinext/shims/app-router-scroll-state";
import type { HistoryTraversalIntent, AppRouterState } from "./app-browser-state.js";
import type { HistoryUpdateMode } from "./app-browser-navigation-controller.js";

export type AppBrowserNavigationActionResult = {
  state: AppRouterState;
  href: string;
  historyUpdateMode: HistoryUpdateMode | undefined;
  scrollIntent: AppRouterScrollIntent | null;
  traversalIntent: HistoryTraversalIntent | null;
};

type ServerAction = (
  previous: AppBrowserNavigationActionResult | null,
  publish: (result: AppBrowserNavigationActionResult) => void,
) => Promise<unknown>;

type Request =
  | { kind: "refresh"; resolve: () => void; reject: (error: unknown) => void }
  | {
      kind: "server-action";
      run: ServerAction;
      resolve: (value: unknown) => void;
      reject: (error: unknown) => void;
    };

/** Refresh and Server Actions share a FIFO, independently of React commit and Flight EOF. */
export function createAppBrowserRefreshQueue(
  runRefresh: (result: AppBrowserNavigationActionResult | null) => void,
) {
  let active: { id: number; ready: boolean } | null = null;
  let result: AppBrowserNavigationActionResult | null = null;
  const requests: Request[] = [];
  let executing: Request | null = null;
  let dispatching = false;
  let needsRefresh = false;

  function discardExecuting(): void {
    const previous = executing;
    executing = null;
    // A superseded Server Action still settles its caller from its own response.
    if (previous?.kind === "refresh") previous.resolve();
  }

  function drain(): void {
    if (executing || (active && !active.ready)) return;
    let request = requests.shift();
    if (!request && needsRefresh) {
      needsRefresh = false;
      request = { kind: "refresh", resolve() {}, reject() {} };
    }
    if (!request) return;
    executing = request;
    dispatching = true;
    try {
      if (request.kind === "refresh") {
        // Idle refresh starts synchronously, before a later navigation can win.
        runRefresh(result);
        if (!active || active.ready) discardExecuting();
      } else {
        void request
          .run(result, (accepted) => {
            if (executing !== request) return;
            result = accepted;
            executing = null;
            drain();
          })
          .then(request.resolve, request.reject)
          .finally(() => {
            // Errors and actions without a router result also release the queue.
            // A discarded action cannot release a newer navigation or action.
            if (executing !== request) return;
            executing = null;
            drain();
          });
      }
    } catch (error) {
      executing = null;
      request.reject(error);
    } finally {
      dispatching = false;
    }
    if (!executing) drain();
  }

  return {
    start(navigationId: number) {
      // Navigation/restore preempts the running entry, preserving queued work.
      // A refresh starts its own navigation synchronously inside drain().
      if (!dispatching) discardExecuting();
      active = { id: navigationId, ready: false };
      result = null;
    },
    ready(navigationId: number, accepted: AppBrowserNavigationActionResult | null = null) {
      if (!active || active.id !== navigationId || active.ready) return;
      result = accepted;
      active.ready = true;
      if (executing?.kind === "refresh") discardExecuting();
      drain();
    },
    stopForDocumentNavigation() {
      active = null;
      result = null;
      needsRefresh = false;
      discardExecuting();
      // Keep undispatched mutations dormant. A fresh router operation can
      // resume them if the user cancels beforeunload; do not lose their callers.
      for (const request of requests.splice(0)) {
        if (request.kind === "refresh") request.resolve();
        else requests.push(request);
      }
    },
    refreshWhenIdle() {
      needsRefresh = true;
      drain();
    },
    serverAction(run: ServerAction): Promise<unknown> {
      return new Promise((resolve, reject) => {
        requests.push({ kind: "server-action", run, resolve, reject });
        drain();
      });
    },
    refresh(): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        requests.push({ kind: "refresh", resolve, reject });
        drain();
      });
    },
  };
}
