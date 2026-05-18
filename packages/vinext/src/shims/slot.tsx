"use client";

import * as React from "react";
import {
  AppElementsWire,
  UNMATCHED_SLOT,
  type AppElementValue,
  type AppElements,
  type AppElementsInterception,
  type AppElementsSlotBinding,
  type LayoutFlags,
} from "../server/app-elements.js";
import type { ArtifactCompatibilityEnvelope } from "../server/artifact-compatibility.js";
import { notFound } from "./navigation.js";

const EMPTY_ELEMENTS: AppElements = Object.freeze({});
const warnedMissingEntryIds = new Set<string>();
const warnedTransportMetadataEntryIds = new Set<string>();

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

type MergeElementsOptions = {
  clearAbsentSlots?: boolean;
  preserveAbsentSlots?: boolean;
  preserveElementIds?: readonly string[];
  preservePreviousSlotIds?: readonly string[];
};

function isLayoutFlagsValue(value: unknown): value is LayoutFlags {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const entries = Object.values(value);
  return entries.length > 0 && entries.every((entry) => entry === "s" || entry === "d");
}

function isArtifactCompatibilityEnvelopeValue(
  value: unknown,
): value is ArtifactCompatibilityEnvelope {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return (
    "schemaVersion" in value &&
    "appElementsSchemaVersion" in value &&
    "rscPayloadSchemaVersion" in value &&
    "graphVersion" in value &&
    "deploymentVersion" in value &&
    "rootBoundaryId" in value &&
    "renderEpoch" in value
  );
}

function isSlotBindingValue(value: unknown): value is AppElementsSlotBinding {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return "ownerLayoutId" in value && "slotId" in value && "state" in value;
}

function isSlotBindingListValue(value: unknown): value is readonly AppElementsSlotBinding[] {
  // Empty [] is valid metadata when parsed from a missing __slotBindings key,
  // but it is not valid renderable slot content. Keep this guard non-empty so
  // accidental [] entries under render keys are not silently swallowed.
  return Array.isArray(value) && value.length > 0 && value.every(isSlotBindingValue);
}

function isInterceptionMetadataValue(value: unknown): value is AppElementsInterception {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return (
    "sourceMatchedUrl" in value &&
    typeof value.sourceMatchedUrl === "string" &&
    "sourceRouteId" in value &&
    typeof value.sourceRouteId === "string" &&
    "slotId" in value &&
    typeof value.slotId === "string" &&
    "targetMatchedUrl" in value &&
    typeof value.targetMatchedUrl === "string" &&
    "targetRouteId" in value &&
    typeof value.targetRouteId === "string"
  );
}

function isTransportMetadataValue(
  value: AppElementValue | undefined,
): value is
  | LayoutFlags
  | ArtifactCompatibilityEnvelope
  | AppElementsInterception
  | readonly AppElementsSlotBinding[] {
  return (
    isLayoutFlagsValue(value) ||
    isArtifactCompatibilityEnvelopeValue(value) ||
    isInterceptionMetadataValue(value) ||
    isSlotBindingListValue(value)
  );
}

function warnTransportMetadataEntry(id: string): void {
  if (process.env.NODE_ENV === "production") return;
  if (warnedTransportMetadataEntryIds.has(id)) return;

  warnedTransportMetadataEntryIds.add(id);
  console.warn("[vinext] Transport metadata value found under App Router render entry: " + id);
}

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
  const preservePreviousSlotIds =
    typeof options === "boolean" ? [] : (options.preservePreviousSlotIds ?? []);
  const merged: Record<string, AppElementValue> = { ...next };

  for (const id of preserveElementIds) {
    if (Object.hasOwn(merged, id)) continue;
    if (Object.hasOwn(prev, id)) {
      const value = prev[id];
      if (value !== undefined) merged[id] = value;
    }
  }

  const slotKeys = new Set(
    [...Object.keys(prev), ...Object.keys(next)].filter((key) => AppElementsWire.isSlotId(key)),
  );
  // On traversal (browser back/forward), the server renders the full destination
  // route tree. A slot absent from next means the destination route tree does not
  // include it, so clear it rather than keeping the stale prev value. The legacy
  // absent-slot path stays opt-in for unpromoted fallbacks; promoted navigation
  // commits preserve default/unmatched slots through planner-approved
  // preservePreviousSlotIds.
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

  // Default/unmatched slot preservation is a router-state decision, not a
  // consequence of a missing key or an unmatched marker on the transport. This
  // loop intentionally runs after clear/preserve element handling so planner-
  // approved slot content and binding proof win the final merged value.
  for (const id of preservePreviousSlotIds) {
    if (!AppElementsWire.isSlotId(id)) continue;
    if (!Object.hasOwn(prev, id)) continue;
    const value = prev[id];
    if (value !== undefined && value !== UNMATCHED_SLOT) {
      merged[id] = value;
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
  if (isTransportMetadataValue(element)) {
    warnTransportMetadataEntry(id);
    return null;
  }
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
