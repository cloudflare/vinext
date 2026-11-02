import { Fragment, createElement, type ReactNode } from "react";
import { ElementsContext, Slot } from "vinext/shims/slot";
import type { AppElements } from "./app-elements.js";

/**
 * Builds the App Router route tree after a sibling that the browser uses to
 * write navigation history. Insertion effects run in tree order, so that
 * sibling's effect runs before React mutates the route tree's DOM, like
 * Next.js' HistoryUpdater.
 *
 * The server and the browser must render this same shape: a second child
 * changes the useId values of everything below it, so SSR passes null in the
 * sibling's place to keep hydrated ids matching.
 */
export function createAppRouteTree(options: {
  elements: AppElements;
  historyCommit: ReactNode;
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
  );
}
