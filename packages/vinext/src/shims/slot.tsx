"use client";

import * as React from "react";
import {
  APP_SKIPPED_LAYOUT_IDS_KEY,
  AppElementsWire,
  UNMATCHED_SLOT,
  type AppElementValue,
  type AppElements,
  type AppElementsInterception,
  type AppElementsSlotBinding,
  type LayoutFlags,
} from "../server/app-elements.js";
import type { ArtifactCompatibilityEnvelope } from "../server/artifact-compatibility.js";
import type { CacheEntryReuseProof } from "../server/cache-proof.js";
import { getBfcacheIdMapContext, getBfcacheSegmentIdContext, notFound } from "./navigation.js";

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
const BfcacheIdMapContext = getBfcacheIdMapContext();
const BfcacheSegmentIdContext = getBfcacheSegmentIdContext();
const EMPTY_BFCACHE_STATE_KEYS: Readonly<Record<string, string>> = Object.freeze({});
const MAX_BFCACHE_SLOT_ENTRIES_WITH_CACHE_COMPONENTS = 3;
const MAX_BFCACHE_SLOT_ENTRIES_WITHOUT_CACHE_COMPONENTS = 1;

export const BfcacheStateKeyMapContext =
  React.createContext<Readonly<Record<string, string>>>(EMPTY_BFCACHE_STATE_KEYS);

export type BfcacheSlotEntry = {
  content: React.ReactNode;
  elements?: AppElements;
  segmentId?: string;
  stateKey: string;
  stateKeyMap?: Readonly<Record<string, string>>;
};

type MergeElementsOptions = {
  clearAbsentSlots?: boolean;
  preserveAbsentSlots?: boolean;
  preserveElementIds?: readonly string[];
  preservePreviousSlotIds?: readonly string[];
};

function getBfcacheSlotEntryLimit(): number {
  return process.env.__NEXT_CACHE_COMPONENTS
    ? MAX_BFCACHE_SLOT_ENTRIES_WITH_CACHE_COMPONENTS
    : MAX_BFCACHE_SLOT_ENTRIES_WITHOUT_CACHE_COMPONENTS;
}

function normalizeBfcacheSlotEntryLimit(maxEntries: number): number {
  if (!Number.isFinite(maxEntries)) return 1;
  return Math.max(1, Math.trunc(maxEntries));
}

export function updateBfcacheSlotEntries(
  previousEntries: readonly BfcacheSlotEntry[],
  activeStateKey: string,
  content: React.ReactNode,
  maxEntries: number = getBfcacheSlotEntryLimit(),
  segmentId?: string,
  elements?: AppElements,
  stateKeyMap?: Readonly<Record<string, string>>,
): BfcacheSlotEntry[] {
  const activeEntry: BfcacheSlotEntry = { content, stateKey: activeStateKey };
  if (segmentId !== undefined) activeEntry.segmentId = segmentId;
  if (elements !== undefined) activeEntry.elements = elements;
  if (stateKeyMap !== undefined) activeEntry.stateKeyMap = stateKeyMap;

  const nextEntries: BfcacheSlotEntry[] = [activeEntry];
  const entryLimit = normalizeBfcacheSlotEntryLimit(maxEntries);

  for (const entry of previousEntries) {
    if (nextEntries.length >= entryLimit) break;
    if (entry.stateKey === activeStateKey) continue;
    nextEntries.push(entry);
  }

  return nextEntries;
}

function haveSameBfcacheSlotEntryOrder(
  left: readonly BfcacheSlotEntry[],
  right: readonly BfcacheSlotEntry[],
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) {
    if (left[index].stateKey !== right[index].stateKey) return false;
  }
  return true;
}

function pruneLatestBfcacheSlotEntries(
  latestEntriesByStateKey: Map<string, BfcacheSlotEntry>,
  currentEntries: readonly BfcacheSlotEntry[],
): void {
  const currentKeys = new Set(currentEntries.map((entry) => entry.stateKey));
  for (const stateKey of latestEntriesByStateKey.keys()) {
    if (!currentKeys.has(stateKey)) {
      latestEntriesByStateKey.delete(stateKey);
    }
  }
}

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

function isSkippedLayoutIdsMetadataValue(id: string, value: unknown): value is readonly string[] {
  return (
    id === APP_SKIPPED_LAYOUT_IDS_KEY &&
    Array.isArray(value) &&
    value.every((entry) => typeof entry === "string")
  );
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

function isCacheEntryReuseProofValue(value: unknown): value is CacheEntryReuseProof {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return "kind" in value && value.kind === "runtime-cache-entry" && "decision" in value;
}

function isTransportMetadataValue(
  id: string,
  value: AppElementValue | undefined,
): value is
  | LayoutFlags
  | ArtifactCompatibilityEnvelope
  | CacheEntryReuseProof
  | AppElementsInterception
  | readonly string[]
  | readonly AppElementsSlotBinding[] {
  return (
    isLayoutFlagsValue(value) ||
    isArtifactCompatibilityEnvelopeValue(value) ||
    isCacheEntryReuseProofValue(value) ||
    isInterceptionMetadataValue(value) ||
    isSkippedLayoutIdsMetadataValue(id, value) ||
    isSlotBindingListValue(value)
  );
}

function warnTransportMetadataEntry(id: string): void {
  if (process.env.NODE_ENV === "production") return;
  if (warnedTransportMetadataEntryIds.has(id)) return;

  warnedTransportMetadataEntryIds.add(id);
  console.warn("[vinext] Transport metadata value found under App Router render entry: " + id);
}

function BfcacheSlotBoundary({ content, id }: { content: React.ReactNode; id: string }) {
  const SegmentContext = BfcacheSegmentIdContext;
  const elements = React.useContext(ElementsContext);
  const stateKeyMap = React.useContext(BfcacheStateKeyMapContext);
  const activeStateKey = stateKeyMap[id];
  const latestEntriesByStateKey = React.useRef(new Map<string, BfcacheSlotEntry>());
  const [entries, setEntries] = React.useState<BfcacheSlotEntry[]>(() =>
    updateBfcacheSlotEntries(
      [],
      activeStateKey ?? id,
      content,
      getBfcacheSlotEntryLimit(),
      id,
      elements,
      stateKeyMap,
    ),
  );
  if (!SegmentContext) return <>{content}</>;
  if (activeStateKey === undefined) {
    return <SegmentContext.Provider value={id}>{content}</SegmentContext.Provider>;
  }

  latestEntriesByStateKey.current.set(activeStateKey, {
    content,
    elements,
    segmentId: id,
    stateKey: activeStateKey,
    stateKeyMap,
  });

  const orderedEntries = updateBfcacheSlotEntries(
    entries,
    activeStateKey,
    content,
    getBfcacheSlotEntryLimit(),
    id,
    elements,
    stateKeyMap,
  ).map((entry) => latestEntriesByStateKey.current.get(entry.stateKey) ?? entry);

  if (!haveSameBfcacheSlotEntryOrder(entries, orderedEntries)) {
    pruneLatestBfcacheSlotEntries(latestEntriesByStateKey.current, orderedEntries);
    setEntries(orderedEntries);
  }

  const renderEntries = haveSameBfcacheSlotEntryOrder(entries, orderedEntries)
    ? entries.map((entry) => latestEntriesByStateKey.current.get(entry.stateKey) ?? entry)
    : orderedEntries;

  if (!process.env.__NEXT_CACHE_COMPONENTS) {
    const activeEntry = renderEntries[0];
    return (
      <BfcacheStateKeyMapContext.Provider
        key={activeEntry.stateKey}
        value={activeEntry.stateKeyMap ?? stateKeyMap}
      >
        <ElementsContext.Provider value={activeEntry.elements ?? elements}>
          <SegmentContext.Provider value={activeEntry.segmentId ?? id}>
            {activeEntry.content}
          </SegmentContext.Provider>
        </ElementsContext.Provider>
      </BfcacheStateKeyMapContext.Provider>
    );
  }

  return (
    <>
      {renderEntries.map((entry) => (
        <React.Activity
          key={entry.stateKey}
          mode={entry.stateKey === activeStateKey ? "visible" : "hidden"}
        >
          <BfcacheStateKeyMapContext.Provider value={entry.stateKeyMap ?? stateKeyMap}>
            <ElementsContext.Provider value={entry.elements ?? elements}>
              <SegmentContext.Provider value={entry.segmentId ?? id}>
                {entry.content}
              </SegmentContext.Provider>
            </ElementsContext.Provider>
          </BfcacheStateKeyMapContext.Provider>
        </React.Activity>
      ))}
    </>
  );
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
  if (isTransportMetadataValue(id, element)) {
    warnTransportMetadataEntry(id);
    return null;
  }
  if (element === UNMATCHED_SLOT) {
    notFound();
  }
  if (element === null) {
    return null;
  }

  const content = (
    <ParallelSlotsContext.Provider value={parallelSlots ?? null}>
      <ChildrenContext.Provider value={children ?? null}>{element}</ChildrenContext.Provider>
    </ParallelSlotsContext.Provider>
  );

  return BfcacheIdMapContext && BfcacheSegmentIdContext ? (
    <BfcacheSlotBoundary id={id} content={content} />
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
