"use client";

import * as React from "react";
import {
  AppElementsWire,
  UNMATCHED_SLOT,
  type AppElementValue,
  type AppElements,
} from "../server/app-elements.js";
import { getBfcacheSegmentIdContext, notFound } from "./navigation.js";

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
const BfcacheSegmentIdContext = getBfcacheSegmentIdContext();

type MergeElementsOptions = {
  clearAbsentSlots?: boolean;
  preserveAbsentSlots?: boolean;
  preserveElementIds?: readonly string[];
};

export function mergeElements(
  prev: AppElements,
  next: AppElements,
  options: MergeElementsOptions | boolean = {},
): AppElements {
  const clearAbsentSlots =
    typeof options === "boolean" ? options : (options.clearAbsentSlots ?? false);
  const preserveAbsentSlots =
    typeof options === "boolean" ? !options : (options.preserveAbsentSlots ?? true);
  const preserveElementIds = typeof options === "boolean" ? [] : (options.preserveElementIds ?? []);
  const merged: Record<string, AppElementValue> = { ...next };

  for (const id of preserveElementIds) {
    if (Object.hasOwn(merged, id)) continue;
    if (Object.hasOwn(prev, id)) {
      const value = prev[id];
      if (value !== undefined) merged[id] = value;
    }
  }

  // On soft navigation, unmatched parallel slots preserve their previous subtree
  // instead of firing notFound(). Only hard navigation (full page load) should 404.
  // This matches Next.js behavior for parallel route persistence.
  const slotKeys = new Set(
    [...Object.keys(prev), ...Object.keys(next)].filter((key) => AppElementsWire.isSlotId(key)),
  );
  for (const key of slotKeys) {
    if (next[key] === UNMATCHED_SLOT && Object.hasOwn(prev, key)) {
      merged[key] = prev[key];
    }
  }
  // On traversal (browser back/forward), the server renders the full destination
  // route tree. A slot absent from next means the destination route tree does not
  // include it, so clear it rather than keeping the stale prev value. The legacy
  // absent-slot path stays opt-in for unpromoted fallbacks; promoted navigation
  // commits preserve mounted slots through planner-approved preserveElementIds.
  if (clearAbsentSlots) {
    for (const key of slotKeys) {
      if (!Object.hasOwn(next, key)) {
        delete merged[key];
      }
    }
  } else if (preserveAbsentSlots) {
    for (const key of slotKeys) {
      if (!Object.hasOwn(merged, key) && Object.hasOwn(prev, key)) {
        const value = prev[key];
        if (value !== undefined) merged[key] = value;
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
    if (process.env.NODE_ENV !== "production" && !AppElementsWire.isSlotId(id)) {
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

  const content = (
    <ParallelSlotsContext.Provider value={parallelSlots ?? null}>
      <ChildrenContext.Provider value={children ?? null}>{element}</ChildrenContext.Provider>
    </ParallelSlotsContext.Provider>
  );

  return BfcacheSegmentIdContext ? (
    <BfcacheSegmentIdContext.Provider value={id}>{content}</BfcacheSegmentIdContext.Provider>
  ) : (
    content
  );
}

export function Children() {
  return React.useContext(ChildrenContext);
}

export function ParallelSlot({ name }: { name: string }) {
  const slots = React.useContext(ParallelSlotsContext);
  return slots?.[name] ?? null;
}
