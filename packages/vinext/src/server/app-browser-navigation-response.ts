import type { ClientNavigationRenderSnapshot } from "vinext/shims/navigation";
import { stripBasePath } from "../utils/base-path.js";

export function shouldRecoverSamePathSearchCommitOnResponseCompletion(options: {
  basePath: string;
  currentSnapshot: ClientNavigationRenderSnapshot;
  navigationKind: "navigate" | "traverse" | "refresh";
  programmaticTransition: boolean;
  targetUrl: URL;
}): boolean {
  if (!options.programmaticTransition || options.navigationKind !== "navigate") {
    return false;
  }

  return (
    options.currentSnapshot.pathname ===
      stripBasePath(options.targetUrl.pathname, options.basePath) &&
    options.currentSnapshot.search !== options.targetUrl.search
  );
}

type LiveNavigationFetch = {
  /** Issue the request now; later calls reuse it. */
  start(): void;
  /** The request issued by `start()`, or a new one if it was never started. */
  take(): Promise<Response>;
};

/**
 * Lets a navigation hop issue its live RSC request before slower client-only
 * work (learning optimistic route templates) and await it afterwards, so the
 * request is not queued behind that work. The request is issued at most once.
 */
export function createLiveNavigationFetch(
  fetchResponse: () => Promise<Response>,
): LiveNavigationFetch {
  let response: Promise<Response> | null = null;
  return {
    start() {
      if (response) return;
      response = fetchResponse();
      // A navigation superseded before take() aborts this request and returns
      // without awaiting it. take() still hands back the rejecting promise.
      response.catch(() => {});
    },
    take() {
      return (response ??= fetchResponse());
    },
  };
}
