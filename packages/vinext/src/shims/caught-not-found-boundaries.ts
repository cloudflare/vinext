/**
 * The parallel slot not-found boundaries that caught a slot's notFound() in
 * the document. Fizz has no error boundaries, so a slot page's notFound()
 * rejects the shell; the App Router SSR entry then renders the document again
 * from the same Flight payload, with the boundaries that would have caught it
 * on the client rendering their fallback (Next.js renders them in the browser
 * after an empty error shell). The browser reads the same ids from
 * `self.__VINEXT_CAUGHT_NOT_FOUND__`, so those boundaries hydrate caught.
 *
 * Stored on a global symbol so duplicate module instances share one context,
 * and null in react-server, which has no createContext.
 */
import React from "react";

const CAUGHT_NOT_FOUND_BOUNDARIES_CONTEXT_KEY = Symbol.for(
  "vinext.caughtNotFoundBoundariesContext",
);

export const CAUGHT_NOT_FOUND_BOUNDARIES_GLOBAL = "__VINEXT_CAUGHT_NOT_FOUND__";

type CaughtNotFoundBoundariesGlobal = typeof globalThis & {
  [CAUGHT_NOT_FOUND_BOUNDARIES_CONTEXT_KEY]?: React.Context<ReadonlySet<string> | null>;
  [CAUGHT_NOT_FOUND_BOUNDARIES_GLOBAL]?: string[];
};

function getCaughtNotFoundBoundariesContext(): React.Context<ReadonlySet<string> | null> | null {
  if (typeof React.createContext !== "function") return null;
  const globalState = globalThis as CaughtNotFoundBoundariesGlobal;
  globalState[CAUGHT_NOT_FOUND_BOUNDARIES_CONTEXT_KEY] ??=
    React.createContext<ReadonlySet<string> | null>(null);
  return globalState[CAUGHT_NOT_FOUND_BOUNDARIES_CONTEXT_KEY];
}

export const CaughtNotFoundBoundariesContext = getCaughtNotFoundBoundariesContext();

export function withCaughtNotFoundBoundaries(
  ids: ReadonlySet<string>,
  children: React.ReactElement,
): React.ReactElement {
  return CaughtNotFoundBoundariesContext
    ? React.createElement(CaughtNotFoundBoundariesContext.Provider, { value: ids }, children)
    : children;
}

/** Whether the boundary with this id caught a notFound() in the document. */
export function useCaughtNotFoundBoundary(id: string | undefined): boolean {
  const serverIds = React.useContext(CaughtNotFoundBoundariesContext!);
  if (id === undefined) return false;
  if (typeof window === "undefined") return serverIds?.has(id) === true;
  return (
    (globalThis as CaughtNotFoundBoundariesGlobal)[CAUGHT_NOT_FOUND_BOUNDARIES_GLOBAL]?.includes(
      id,
    ) === true
  );
}

/** A hydrated boundary consumes its id, so a later mount renders its children. */
export function consumeCaughtNotFoundBoundary(id: string | undefined): void {
  if (id === undefined || typeof window === "undefined") return;
  const ids = (globalThis as CaughtNotFoundBoundariesGlobal)[CAUGHT_NOT_FOUND_BOUNDARIES_GLOBAL];
  const index = ids?.indexOf(id) ?? -1;
  if (index !== -1) ids!.splice(index, 1);
}
