import { Fragment, createElement, type ReactNode } from "react";
import { ElementsContext, Slot } from "vinext/shims/slot";
import type { AppElements } from "./app-elements.js";

/**
 * Builds the App Router route tree after a sibling that the browser uses to
 * write navigation history. Insertion effects run in tree order, so that
 * sibling's effect runs before React mutates the route tree's DOM, like
 * Next.js' HistoryUpdater. The route announcer follows the route tree, like
 * Next.js' AppRouterAnnouncer follows its RootLayoutBoundary.
 *
 * The server and the browser must render this same shape: a sibling changes
 * the useId values of everything below it, so SSR passes null in the browser-
 * only siblings' places to keep hydrated ids matching.
 */
export function createAppRouteTree(options: {
  elements: AppElements;
  historyCommit: ReactNode;
  routeAnnouncer: ReactNode;
  routeId: string;
}): ReactNode {
  return createElement(
    Fragment,
    null,
    options.historyCommit,
    createElement(
      ElementsContext.Provider,
      { value: options.elements },
      createElement(Slot, { id: options.routeId }),
    ),
    options.routeAnnouncer,
  );
}
