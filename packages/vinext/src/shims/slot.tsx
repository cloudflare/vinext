"use client";

import * as React from "react";
import { UNMATCHED_SLOT, type AppElementValue, type AppElements } from "../server/app-elements.js";
import { notFound } from "./navigation.js";

const EMPTY_ELEMENTS: AppElements = Object.freeze({});
const warnedMissingEntryIds = new Set<string>();

export { UNMATCHED_SLOT };

/**
 * Holds resolved AppElements (not a Promise). React 19's use(Promise) during
 * hydration triggers "async Client Component" for native Promises that lack
 * React's internal .status property. Storing resolved values sidesteps this.
 */
export const ElementsContext = React.createContext<AppElements>(EMPTY_ELEMENTS);

export const ChildrenContext = React.createContext<React.ReactNode>(null);

export const ParallelSlotsContext = React.createContext<Readonly<
  Record<string, React.ReactNode>
> | null>(null);

export function mergeElements(
  prev: AppElements,
  next: AppElements,
  clearAbsentSlots = false,
): AppElements {
  const merged: Record<string, AppElementValue> = { ...prev, ...next };
  // On soft navigation, unmatched parallel slots preserve their previous subtree
  // instead of firing notFound(). Only hard navigation (full page load) should 404.
  // This matches Next.js behavior for parallel route persistence.
  for (const key of Object.keys(merged)) {
    if (key.startsWith("slot:") && merged[key] === UNMATCHED_SLOT && Object.hasOwn(prev, key)) {
      merged[key] = prev[key];
    }
  }
  // On traversal (browser back/forward), the server renders the full destination
  // route tree. A slot absent from next means the destination route tree does not
  // include it, so clear it rather than keeping the stale prev value. This only
  // runs for traversals because soft forward navigations may omit parent layout
  // slots that should be preserved.
  if (clearAbsentSlots) {
    for (const key of Object.keys(merged)) {
      if (key.startsWith("slot:") && !Object.hasOwn(next, key)) {
        delete merged[key];
      }
    }
  }
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
  const elements = React.useContext(ElementsContext);

  if (!Object.hasOwn(elements, id)) {
    if (process.env.NODE_ENV !== "production" && !id.startsWith("slot:")) {
      if (!warnedMissingEntryIds.has(id)) {
        warnedMissingEntryIds.add(id);
        console.warn("[vinext] Missing App Router element entry during render: " + id);
      }
    }
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
