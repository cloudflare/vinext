/**
 * The not-found, forbidden and unauthorized boundaries that caught a signal
 * in the document. Fizz has no error boundaries, so a slot page's notFound(),
 * or the page's own signal in a route with parallel slots, rejects the shell;
 * the App Router SSR entry then renders the document again from the same
 * Flight payload, with the boundaries that would have caught it on
 * the client rendering their fallback (Next.js renders them in the browser
 * after an empty error shell). The browser reads the same ids from
 * `self.__VINEXT_CAUGHT_NOT_FOUND__`, so those boundaries hydrate caught. Only
 * the boundaries the document rendered are sent, since one inside another
 * caught boundary never mounts to consume its id.
 *
 * Stored on a global symbol so duplicate module instances share one context,
 * and null in react-server, which has no createContext.
 */
import React from "react";

const CAUGHT_NOT_FOUND_BOUNDARIES_CONTEXT_KEY = Symbol.for(
  "vinext.caughtNotFoundBoundariesContext",
);

export const CAUGHT_NOT_FOUND_BOUNDARIES_GLOBAL = "__VINEXT_CAUGHT_NOT_FOUND__";

/** The boundaries that caught, and those of them the document rendered. */
export type CaughtNotFoundBoundaries = {
  ids: ReadonlySet<string>;
  rendered: Set<string>;
};

type CaughtNotFoundBoundariesGlobal = typeof globalThis & {
  [CAUGHT_NOT_FOUND_BOUNDARIES_CONTEXT_KEY]?: React.Context<CaughtNotFoundBoundaries | null>;
  [CAUGHT_NOT_FOUND_BOUNDARIES_GLOBAL]?: string[];
};

function getCaughtNotFoundBoundariesContext(): React.Context<CaughtNotFoundBoundaries | null> | null {
  if (typeof React.createContext !== "function") return null;
  const globalState = globalThis as CaughtNotFoundBoundariesGlobal;
  globalState[CAUGHT_NOT_FOUND_BOUNDARIES_CONTEXT_KEY] ??=
    React.createContext<CaughtNotFoundBoundaries | null>(null);
  return globalState[CAUGHT_NOT_FOUND_BOUNDARIES_CONTEXT_KEY];
}

export const CaughtNotFoundBoundariesContext = getCaughtNotFoundBoundariesContext();

export function withCaughtNotFoundBoundaries(
  boundaries: CaughtNotFoundBoundaries,
  children: React.ReactElement,
): React.ReactElement {
  return CaughtNotFoundBoundariesContext
    ? React.createElement(CaughtNotFoundBoundariesContext.Provider, { value: boundaries }, children)
    : children;
}

/** Whether the boundary with this id caught a signal in the document. */
export function useCaughtNotFoundBoundary(id: string | undefined): boolean {
  const serverBoundaries = React.useContext(CaughtNotFoundBoundariesContext!);
  if (id === undefined) return false;
  if (typeof window === "undefined") {
    if (serverBoundaries?.ids.has(id) !== true) return false;
    serverBoundaries.rendered.add(id);
    return true;
  }
  return (
    (globalThis as CaughtNotFoundBoundariesGlobal)[CAUGHT_NOT_FOUND_BOUNDARIES_GLOBAL]?.includes(
      id,
    ) === true
  );
}

/**
 * The route's page entry the document rendered, and the payload it came
 * from, which the page's Slot records. The page's boundary catches a signal
 * from anywhere in that subtree on the client, as Next.js wraps the whole
 * `children` subtree in it, so the SSR entry counts the copies of the error
 * that rejected the shell that only this entry renders (see
 * `countPageEntryRejections`).
 */
export type RenderedPageEntry = {
  id?: string;
  elements?: Readonly<Record<string, unknown>>;
};

type RecordRenderedPageEntry = (id: string, elements: Readonly<Record<string, unknown>>) => void;

const RENDERED_PAGE_ENTRY_CONTEXT_KEY = Symbol.for("vinext.renderedPageEntryContext");

type RenderedPageEntryGlobal = typeof globalThis & {
  [RENDERED_PAGE_ENTRY_CONTEXT_KEY]?: React.Context<RecordRenderedPageEntry | null>;
};

function getRenderedPageEntryContext(): React.Context<RecordRenderedPageEntry | null> | null {
  if (typeof React.createContext !== "function") return null;
  const globalState = globalThis as RenderedPageEntryGlobal;
  globalState[RENDERED_PAGE_ENTRY_CONTEXT_KEY] ??=
    React.createContext<RecordRenderedPageEntry | null>(null);
  return globalState[RENDERED_PAGE_ENTRY_CONTEXT_KEY];
}

/** Records the entry the page's Slot renders, where a document provides one. */
export const RenderedPageEntryContext = getRenderedPageEntryContext();

export function withRenderedPageEntry(
  entry: RenderedPageEntry,
  children: React.ReactElement,
): React.ReactElement {
  const record: RecordRenderedPageEntry = (id, elements) => {
    entry.id = id;
    entry.elements = elements;
  };
  return RenderedPageEntryContext
    ? React.createElement(RenderedPageEntryContext.Provider, { value: record }, children)
    : children;
}

const REACT_ELEMENT_TYPE = Symbol.for("react.transitional.element");
const REACT_LEGACY_ELEMENT_TYPE = Symbol.for("react.element");
const REACT_LAZY_TYPE = Symbol.for("react.lazy");

/**
 * How many copies of `error` the page's entry alone renders. The Flight
 * client turns each error the RSC render threw into its own error instance,
 * which a lazy or a promise at the position that threw rejects with, so this
 * counts the distinct instances with the error's digest in the page's entry.
 * Flight writes an object it already wrote as a reference to the first, so
 * one instance can render in another entry too, as from an element a layout
 * and the page share; it isn't the page's alone. Only what the document
 * rendered has settled, so a pending or an unread chunk counts nothing yet,
 * and a payload the walk can't read counts nothing.
 */
export function countPageEntryRejections(entry: RenderedPageEntry, error: unknown): number {
  const { id, elements } = entry;
  const digest = readDigest(error);
  if (id === undefined || elements === undefined || digest === undefined) return 0;
  try {
    const inPage = collectRejections([elements[id]], digest);
    const others = Object.keys(elements)
      .filter((key) => key !== id)
      .map((key) => elements[key]);
    for (const rejection of collectRejections(others, digest)) inPage.delete(rejection);
    return inPage.size;
  } catch {
    return 0;
  }
}

/** The rejection reasons with `digest` that rendering `roots` throws. */
function collectRejections(roots: readonly unknown[], digest: string): Set<unknown> {
  const rejections = new Set<unknown>();
  const visited = new Set<object>();
  const pending = [...roots];
  while (pending.length > 0) {
    const value = pending.pop();
    if (value === null || typeof value !== "object" || visited.has(value)) continue;
    visited.add(value);
    const typeOf: unknown = Reflect.get(value, "$$typeof");
    if (typeOf === REACT_ELEMENT_TYPE || typeOf === REACT_LEGACY_ELEMENT_TYPE) {
      pending.push(Reflect.get(value, "props"));
    } else if (typeOf === REACT_LAZY_TYPE) {
      const payload: unknown = Reflect.get(value, "_payload");
      if (isThenable(payload)) pending.push(payload);
    } else if (isThenable(value)) {
      const status: unknown = Reflect.get(value, "status");
      if (status === "rejected") {
        const reason: unknown = Reflect.get(value, "reason");
        if (readDigest(reason) === digest) rejections.add(reason);
      } else if (status === "fulfilled") {
        pending.push(Reflect.get(value, "value"));
      }
    } else if (Array.isArray(value) || value instanceof Set || value instanceof Map) {
      // Flight keeps a Set or a Map of children, which renders as an array,
      // a Map's entries as [key, value] arrays. An iterator it keeps reads
      // only once, so the walk leaves it unread.
      for (const item of value) pending.push(item);
    } else {
      const prototype: unknown = Object.getPrototypeOf(value);
      if (prototype === Object.prototype || prototype === null) {
        for (const item of Object.values(value)) pending.push(item);
      }
    }
  }
  return rejections;
}

function readDigest(error: unknown): string | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const digest: unknown = Reflect.get(error, "digest");
  return typeof digest === "string" ? digest : undefined;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null && typeof value === "object" && typeof Reflect.get(value, "then") === "function"
  );
}

/** A hydrated boundary consumes its id, so a later mount renders its children. */
export function consumeCaughtNotFoundBoundary(id: string | undefined): void {
  if (id === undefined || typeof window === "undefined") return;
  const ids = (globalThis as CaughtNotFoundBoundariesGlobal)[CAUGHT_NOT_FOUND_BOUNDARIES_GLOBAL];
  const index = ids?.indexOf(id) ?? -1;
  if (index !== -1) ids!.splice(index, 1);
}
