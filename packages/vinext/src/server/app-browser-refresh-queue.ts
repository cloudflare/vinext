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
  | {
      kind: "refresh";
      revalidation?: boolean;
      resolve: () => void;
      reject: (error: unknown) => void;
    }
  | {
      kind: "server-action";
      run: ServerAction;
      resolve: (value: unknown) => void;
      reject: (error: unknown) => void;
    };

export class ServerActionNotSentError extends Error {
  override name = "ServerActionNotSentError";

  constructor() {
    super("[vinext] Server Action not sent: the page began loading another document. Try again.");
  }
}

/** Refresh and Server Actions share a FIFO, independently of React commit and Flight EOF. */
export function createAppBrowserRefreshQueue(
  runRefresh: (result: AppBrowserNavigationActionResult | null, revalidation?: boolean) => void,
) {
  let active: { id: number; ready: boolean } | null = null;
  let result: AppBrowserNavigationActionResult | null = null;
  const requests: Request[] = [];
  // Server Actions that were waiting when a document navigation began.
  const dormantRequests: Request[] = [];
  let executing: Request | null = null;
  let dispatching = false;
  let needsRefresh = false;
  let documentNavigation = false;

  function discardExecuting(): void {
    const previous = executing;
    executing = null;
    // A superseded Server Action still settles its caller from its own response.
    if (previous?.kind === "refresh") previous.resolve();
  }

  function restoreDormantRequests(): void {
    requests.unshift(...dormantRequests.splice(0));
  }

  function drain(): void {
    if (documentNavigation || executing || (active && !active.ready)) return;
    let request = requests.shift();
    if (!request && needsRefresh) {
      needsRefresh = false;
      request = { kind: "refresh", revalidation: true, resolve() {}, reject() {} };
    }
    if (!request) return;
    executing = request;
    dispatching = true;
    try {
      if (request.kind === "refresh") {
        // Idle refresh starts synchronously, before a later navigation can win.
        if (request.revalidation) runRefresh(result, true);
        else runRefresh(result);
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
      documentNavigation = false;
      restoreDormantRequests();
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
      documentNavigation = true;
      active = null;
      result = null;
      discardExecuting();
      // Keep undispatched mutations dormant until confirmed recovery, expiry or
      // a new navigation. Public refresh alone is not proof that unload was
      // canceled. Requests made after this point wait in the queue proper.
      for (const request of requests.splice(0)) {
        if (request.kind === "refresh") request.resolve();
        else dormantRequests.push(request);
      }
    },
    resumeAfterDocumentNavigation() {
      documentNavigation = false;
      restoreDormantRequests();
      drain();
    },
    /** The load never replaced this document: fail held actions rather than replay a possibly slow one. */
    expireDocumentNavigation(error: Error) {
      documentNavigation = false;
      for (const request of dormantRequests.splice(0)) request.reject(error);
      drain();
    },
    refreshCurrentAction() {
      if (documentNavigation) {
        needsRefresh = true;
        return;
      }
      // A forwarded action has no tree. Its refresh continues this action
      // before the next queued request, while discarded actions wait for idle.
      runRefresh(result, true);
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
