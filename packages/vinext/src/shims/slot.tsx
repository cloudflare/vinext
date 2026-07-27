"use client";

import * as React from "react";
import {
  APP_BFCACHE_SEGMENT_IDENTITIES_KEY,
  APP_SKIPPED_LAYOUT_IDS_KEY,
  AppElementsWire,
  UNMATCHED_SLOT,
  type AppElementValue,
  type AppElements,
  type AppElementsInterception,
  type AppElementsBfcacheSegmentIdentities,
  type AppElementsSlotBinding,
  type LayoutFlags,
} from "../server/app-elements.js";
import type { ArtifactCompatibilityEnvelope } from "../server/artifact-compatibility.js";
import {
  isNestedBfcacheSlotSegmentId,
  isNestedBfcacheSlotSegmentIdFor,
} from "../server/bfcache-identity.js";
import type { CacheEntryReuseProof } from "../server/cache-proof.js";
import {
  getBfcacheIdMapContext,
  getBfcacheSegmentIdContext,
  notFound,
} from "./navigation-server.js";

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
// Used by updateBfcacheSlotEntryOrder when invoked directly (unit tests) and
// as a future-proof limit for non-flag-keyed entries; the current render path
// (BfcacheActivitySlotBoundary) only runs under cacheComponents, so this 1-entry
// branch is a contract bound for the helper, not live render code.
const MAX_BFCACHE_SLOT_ENTRIES_WITHOUT_CACHE_COMPONENTS = 1;

export const BfcacheIdentityMapContext =
  React.createContext<Readonly<Record<string, string>>>(EMPTY_BFCACHE_STATE_KEYS);

export type BfcacheSlotEntry = {
  content: React.ReactNode;
  elements?: AppElements;
  segmentId?: string;
  stateKey: string;
  stateKeyMap?: Readonly<Record<string, string>>;
};

function isCacheComponentsEnabled(): boolean {
  return String(process.env.__NEXT_CACHE_COMPONENTS) === "true";
}

type MergeElementsOptions = {
  clearAbsentSlots?: boolean;
  preserveAbsentSlots?: boolean;
  preserveElementIds?: readonly string[];
  preservePreviousSlotIds?: readonly string[];
};

function getBfcacheSlotEntryLimit(): number {
  return isCacheComponentsEnabled()
    ? MAX_BFCACHE_SLOT_ENTRIES_WITH_CACHE_COMPONENTS
    : MAX_BFCACHE_SLOT_ENTRIES_WITHOUT_CACHE_COMPONENTS;
}

function normalizeBfcacheSlotEntryLimit(maxEntries: number): number {
  if (!Number.isFinite(maxEntries)) return 1;
  return Math.max(1, Math.trunc(maxEntries));
}

export function updateBfcacheSlotEntryOrder(
  previousOrder: readonly string[],
  activeStateKey: string,
  maxEntries: number = getBfcacheSlotEntryLimit(),
): string[] {
  const entryLimit = normalizeBfcacheSlotEntryLimit(maxEntries);
  const nextOrder = [activeStateKey];

  for (const stateKey of previousOrder) {
    if (nextOrder.length >= entryLimit) break;
    if (stateKey === activeStateKey) continue;
    nextOrder.push(stateKey);
  }

  return nextOrder;
}

function pruneBfcacheSlotEntrySnapshots(
  snapshotsByStateKey: Map<string, BfcacheSlotEntry>,
  retainedOrder: readonly string[],
): void {
  const retainedKeys = new Set(retainedOrder);
  for (const stateKey of snapshotsByStateKey.keys()) {
    if (!retainedKeys.has(stateKey)) {
      snapshotsByStateKey.delete(stateKey);
    }
  }
}

function haveSameBfcacheSlotEntryOrder(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

export function stageBfcacheSlotEntryForRender(
  committedSnapshots: ReadonlyMap<string, BfcacheSlotEntry>,
  committedOrder: readonly string[],
  activeEntry: BfcacheSlotEntry,
  maxEntries: number = getBfcacheSlotEntryLimit(),
): Readonly<{
  entries: BfcacheSlotEntry[];
  order: string[];
  snapshots: Map<string, BfcacheSlotEntry>;
}> {
  const snapshots = new Map(committedSnapshots);
  snapshots.set(activeEntry.stateKey, activeEntry);
  const order = updateBfcacheSlotEntryOrder(committedOrder, activeEntry.stateKey, maxEntries);
  pruneBfcacheSlotEntrySnapshots(snapshots, order);
  return {
    entries: order
      .map((stateKey) => snapshots.get(stateKey))
      .filter((entry): entry is BfcacheSlotEntry => entry !== undefined),
    order,
    snapshots,
  };
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

function isBfcacheSegmentIdentitiesMetadataValue(
  id: string,
  value: unknown,
): value is AppElementsBfcacheSegmentIdentities {
  if (
    id !== APP_BFCACHE_SEGMENT_IDENTITIES_KEY ||
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    return false;
  }

  return Object.entries(value).every(([elementId, identity]) => {
    const parsed = AppElementsWire.parseElementKey(elementId);
    return parsed !== null && parsed.kind !== "route" && typeof identity === "string";
  });
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
  | AppElementsBfcacheSegmentIdentities
  | ArtifactCompatibilityEnvelope
  | CacheEntryReuseProof
  | AppElementsInterception
  | readonly string[]
  | readonly AppElementsSlotBinding[] {
  return (
    isLayoutFlagsValue(value) ||
    isBfcacheSegmentIdentitiesMetadataValue(id, value) ||
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

/**
 * Provider stack for Activity-retained BFCache entries. Each retained entry
 * re-provides the elements, state-key map, and segment id it was captured with,
 * falling back to the live boundary values for entries that predate per-entry
 * capture.
 */
function BfcacheEntryProviders({
  entry,
  fallbackElements,
  fallbackSegmentId,
  fallbackStateKeyMap,
  SegmentContext,
}: {
  entry: BfcacheSlotEntry;
  fallbackElements: AppElements;
  fallbackSegmentId: string;
  fallbackStateKeyMap: Readonly<Record<string, string>>;
  SegmentContext: React.Context<string | null>;
}) {
  return (
    <BfcacheIdentityMapContext.Provider value={entry.stateKeyMap ?? fallbackStateKeyMap}>
      <ElementsContext.Provider value={entry.elements ?? fallbackElements}>
        <SegmentContext.Provider value={entry.segmentId ?? fallbackSegmentId}>
          {entry.content}
        </SegmentContext.Provider>
      </ElementsContext.Provider>
    </BfcacheIdentityMapContext.Provider>
  );
}

// TODO(bfcache): Move retained segment ownership into the App Router commit
// state once the navigation/BFCache bug queue stabilizes. This synchronous
// slot-local cache intentionally makes Activity entries available in the same
// render that observes the committed active state key; the long-term model
// should let navigation commits update retained slot entries and keep Slot as a
// pure Activity renderer.
function useBfcacheSlotEntries(activeEntry: BfcacheSlotEntry): BfcacheSlotEntry[] {
  const snapshotsByStateKey = React.useRef(new Map<string, BfcacheSlotEntry>());
  const [entryOrder, setEntryOrder] = React.useState<string[]>(() => [activeEntry.stateKey]);

  const staged = stageBfcacheSlotEntryForRender(
    snapshotsByStateKey.current,
    entryOrder,
    activeEntry,
  );
  const nextOrder = staged.order;
  const orderChanged = !haveSameBfcacheSlotEntryOrder(entryOrder, nextOrder);

  // Ref writes survive discarded renders. Publish the cloned snapshot set only
  // after React commits this render so speculative eviction or replacement
  // cannot mutate the previous committed entries.
  React.useLayoutEffect(() => {
    snapshotsByStateKey.current = staged.snapshots;
  }, [staged.snapshots]);

  // Future retention-policy changes must keep the active key in renderOrder.
  if (process.env.NODE_ENV !== "production" && !staged.snapshots.has(activeEntry.stateKey)) {
    throw new Error("BFCache Activity slot is missing the active entry snapshot");
  }

  if (orderChanged) {
    setEntryOrder(nextOrder);
  }

  return staged.entries;
}

function BfcacheActivitySlotBoundary({
  activeStateKey,
  content,
  elements,
  id,
  SegmentContext,
  stateKeyMap,
}: {
  activeStateKey: string;
  content: React.ReactNode;
  elements: AppElements;
  id: string;
  SegmentContext: React.Context<string | null>;
  stateKeyMap: Readonly<Record<string, string>>;
}) {
  const latestActiveEntry: BfcacheSlotEntry = {
    content,
    elements,
    segmentId: id,
    stateKey: activeStateKey,
    stateKeyMap,
  };
  const renderEntries = useBfcacheSlotEntries(latestActiveEntry);

  return (
    <>
      {renderEntries.map((entry) => (
        // Hidden Activity entries keep their DOM mounted, so duplicate userland
        // ids can exist under cacheComponents. Consumers should query by visible
        // scope when that distinction matters.
        <React.Activity
          key={entry.stateKey}
          mode={entry.stateKey === activeStateKey ? "visible" : "hidden"}
        >
          <BfcacheEntryProviders
            entry={entry}
            fallbackElements={elements}
            fallbackSegmentId={id}
            fallbackStateKeyMap={stateKeyMap}
            SegmentContext={SegmentContext}
          />
        </React.Activity>
      ))}
    </>
  );
}

/**
 * Adds a nested segment-owned Activity cache inside a flattened AppElements
 * entry. Named parallel routes are transported as one slot value, but Next.js
 * retains each descendant segment independently. This boundary recreates that
 * ownership without requiring a separate wire entry for every nested segment.
 */
export function BfcacheSegmentBoundary({
  children,
  id,
  stateKey,
}: {
  children: React.ReactNode;
  id: string;
  stateKey: string;
}) {
  const elements = React.useContext(ElementsContext);
  const identityMap = React.useContext(BfcacheIdentityMapContext);
  const bfcacheIdMap = React.useContext(BfcacheIdMapContext!);
  const activeStateKey = resolveBfcacheSegmentStateKey(id, identityMap, bfcacheIdMap);

  if (!BfcacheSegmentIdContext || activeStateKey === undefined) {
    return <React.Fragment key={stateKey}>{children}</React.Fragment>;
  }
  if (!isCacheComponentsEnabled()) {
    return (
      <BfcacheSegmentIdContext.Provider key={activeStateKey} value={id}>
        {children}
      </BfcacheSegmentIdContext.Provider>
    );
  }

  return (
    <BfcacheActivitySlotBoundary
      activeStateKey={activeStateKey}
      content={children}
      elements={elements}
      id={id}
      SegmentContext={BfcacheSegmentIdContext}
      stateKeyMap={identityMap}
    />
  );
}

export function getNonCacheComponentsSegmentKey(
  id: string,
  activeStateKey: string,
): string | undefined {
  const parsed = AppElementsWire.parseElementKey(id);
  return parsed !== null && parsed.kind !== "route" ? activeStateKey : undefined;
}

export function resolveBfcacheSegmentStateKey(
  id: string,
  identityMap: Readonly<Record<string, string>>,
  bfcacheIdMap: Readonly<Record<string, string>> | null,
): string | undefined {
  return identityMap[id] ?? bfcacheIdMap?.[id];
}

function BfcacheSlotBoundary({ content, id }: { content: React.ReactNode; id: string }) {
  const SegmentContext = BfcacheSegmentIdContext;
  const elements = React.useContext(ElementsContext);
  const identityMap = React.useContext(BfcacheIdentityMapContext);
  const bfcacheIdMap = React.useContext(BfcacheIdMapContext!);
  const activeStateKey = resolveBfcacheSegmentStateKey(id, identityMap, bfcacheIdMap);
  if (!SegmentContext) return <>{content}</>;
  // Missing or rejected identity metadata must not leave a segment unkeyed:
  // createNextBfcacheIdMap mints a fresh id for that case, so using the same id
  // here conservatively remounts React state instead of preserving stale state.
  if (activeStateKey === undefined) {
    return <SegmentContext.Provider value={id}>{content}</SegmentContext.Provider>;
  }

  // Without cacheComponents there is no Activity retention, but Next.js still
  // keys every active segment. Carrier identities only change when their owned
  // segment changes, so stable ancestors and named-slot shells retain state
  // while dynamic layouts and slot branches remount.
  if (!isCacheComponentsEnabled()) {
    return (
      <SegmentContext.Provider key={getNonCacheComponentsSegmentKey(id, activeStateKey)} value={id}>
        {content}
      </SegmentContext.Provider>
    );
  }

  return (
    <BfcacheActivitySlotBoundary
      activeStateKey={activeStateKey}
      content={content}
      elements={elements}
      id={id}
      SegmentContext={SegmentContext}
      stateKeyMap={identityMap}
    />
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
  const preservedIdentityIds = new Set<string>();

  for (const id of preserveElementIds) {
    if (Object.hasOwn(prev, id)) {
      const value = prev[id];
      if (value !== undefined) {
        merged[id] = value;
        preservedIdentityIds.add(id);
      }
    }
  }

  const slotKeys = new Set(
    [...Object.keys(prev), ...Object.keys(next)].filter(
      (key) => AppElementsWire.isSlotId(key) && !isNestedBfcacheSlotSegmentId(key),
    ),
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
        if (value !== undefined) {
          merged[key] = value;
          preservedIdentityIds.add(key);
        }
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
      preservedIdentityIds.add(id);
      // Membership is independent from identity proof. A retained nested
      // boundary still needs its synthetic address when the previous proof map
      // was absent or rejected, so the reducer can mint a conservative fresh
      // id instead of leaking the parent slot's id.
      for (const nestedId of Object.keys(prev)) {
        if (!isNestedBfcacheSlotSegmentIdFor(nestedId, id)) continue;
        const nestedValue = prev[nestedId];
        if (nestedValue !== undefined) merged[nestedId] = nestedValue;
        preservedIdentityIds.add(nestedId);
      }
    }
  }

  if (preservedIdentityIds.size > 0) {
    const previousIdentityValue = prev[APP_BFCACHE_SEGMENT_IDENTITIES_KEY];
    const nextIdentityValue = next[APP_BFCACHE_SEGMENT_IDENTITIES_KEY];
    const hasPreviousIdentities = isBfcacheSegmentIdentitiesMetadataValue(
      APP_BFCACHE_SEGMENT_IDENTITIES_KEY,
      previousIdentityValue,
    );
    const hasNextIdentities = isBfcacheSegmentIdentitiesMetadataValue(
      APP_BFCACHE_SEGMENT_IDENTITIES_KEY,
      nextIdentityValue,
    );
    const previousIdentities: Record<string, string> = hasPreviousIdentities
      ? { ...previousIdentityValue }
      : {};
    const mergedIdentities: Record<string, string> = hasNextIdentities
      ? { ...nextIdentityValue }
      : {};
    const identityIds = new Set([
      ...Object.keys(previousIdentities),
      ...Object.keys(mergedIdentities),
    ]);
    const preservedParentIds = new Set(preservedIdentityIds);
    for (const parentId of preservedParentIds) {
      for (const identityId of identityIds) {
        if (isNestedBfcacheSlotSegmentIdFor(identityId, parentId)) {
          preservedIdentityIds.add(identityId);
        }
      }
    }

    // An element and its identity are one preservation unit. Keeping previous
    // content beside the destination's identity would falsely prove that stale
    // client state belongs to the destination graph. If the previous payload
    // had no proof, remove any destination proof and let BFCache remint.
    for (const id of preservedIdentityIds) {
      const previousIdentity = previousIdentities[id];
      if (previousIdentity === undefined) {
        delete mergedIdentities[id];
      } else {
        mergedIdentities[id] = previousIdentity;
      }
    }
    if (hasPreviousIdentities || hasNextIdentities) {
      merged[APP_BFCACHE_SEGMENT_IDENTITIES_KEY] = mergedIdentities;
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
