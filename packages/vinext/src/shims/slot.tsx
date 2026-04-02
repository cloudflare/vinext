"use client";

import * as React from "react";
import { notFound } from "./navigation.js";

export type Elements = Record<string, React.ReactNode | typeof UNMATCHED_SLOT>;

// Shared across requests — safe because the resolved value is an immutable empty object.
// A Slot rendered outside an ElementsContext.Provider sees {} and returns null for all IDs.
const EMPTY_ELEMENTS_PROMISE = Promise.resolve<Elements>({});
const mergeCache = new WeakMap<Promise<Elements>, WeakMap<Promise<Elements>, Promise<Elements>>>();

export const UNMATCHED_SLOT = Symbol.for("vinext.unmatchedSlot");

export const ElementsContext = React.createContext<Promise<Elements>>(EMPTY_ELEMENTS_PROMISE);

export const ChildrenContext = React.createContext<React.ReactNode>(null);

export const ParallelSlotsContext = React.createContext<Readonly<
  Record<string, React.ReactNode>
> | null>(null);

export function mergeElementsPromise(
  prev: Promise<Elements>,
  next: Promise<Elements>,
): Promise<Elements> {
  let nextCache = mergeCache.get(prev);
  if (!nextCache) {
    nextCache = new WeakMap();
    mergeCache.set(prev, nextCache);
  }

  const cached = nextCache.get(next);
  if (cached) {
    return cached;
  }

  // Cached permanently including rejections — intentional because these promises come from
  // createFromFetch() and a rejection means the navigation itself has failed.
  const merged = Promise.all([prev, next]).then(([prevElements, nextElements]) => ({
    ...prevElements,
    ...nextElements,
  }));
  nextCache.set(next, merged);
  return merged;
}

export function Slot({
  id,
  children,
  parallelSlots,
}: {
  id: string;
  children?: React.ReactNode;
  parallelSlots?: Readonly<Record<string, React.ReactNode>>;
}) {
  const elements = React.use(React.useContext(ElementsContext));

  if (!(id in elements)) {
    return null;
  }

  const element = elements[id];
  if (element === UNMATCHED_SLOT) {
    notFound();
  }

  return (
    <ParallelSlotsContext.Provider value={parallelSlots ?? null}>
      <ChildrenContext.Provider value={children ?? null}>{element}</ChildrenContext.Provider>
    </ParallelSlotsContext.Provider>
  );
}

export function Children() {
  return React.useContext(ChildrenContext);
}

export function ParallelSlot({ name }: { name: string }) {
  const slots = React.useContext(ParallelSlotsContext);
  return slots?.[name] ?? null;
}
