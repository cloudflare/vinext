import { AppElementsWire, type AppElements } from "./app-elements.js";
import { INITIAL_BFCACHE_ID } from "./app-bfcache-id.js";
import { isBfcacheSegmentId, type BfcacheIdMap } from "./app-history-state.js";
import {
  isNestedBfcacheSlotSegmentIdFor,
  type BfcacheSegmentIdentity,
} from "./bfcache-identity.js";

export type BfcacheSegmentIdentityMap = Readonly<Record<string, BfcacheSegmentIdentity>>;

export type InitialBfcacheMaps = Readonly<{
  bfcacheIds: BfcacheIdMap;
  identities: BfcacheSegmentIdentityMap;
}>;

// Monotonic within a single browser document. Full reloads reset the counter,
// while the document-scoped version gate prevents old history ids from
// colliding with freshly minted ids.
let nextBfcacheId = 0;

function rememberBfcacheId(value: string): void {
  // The hydration sentinel is the raw "0" value and intentionally does not
  // advance the counter; fresh ids start at "_b_1_".
  const match = /^_b_(\d+)_$/.exec(value);
  if (!match) return;
  nextBfcacheId = Math.max(nextBfcacheId, Number(match[1]));
}

function mintBfcacheId(): string {
  nextBfcacheId += 1;
  return `_b_${nextBfcacheId}_`;
}

type AppElementsMetadata = ReturnType<typeof AppElementsWire.readMetadata>;

function readAppElementsMetadata(elements: AppElements): AppElementsMetadata | null {
  try {
    return AppElementsWire.readMetadata(elements);
  } catch {
    // Some low-level tests pass partial element maps without metadata.
    return null;
  }
}

function collectBfcacheSegmentIds(
  elements: AppElements,
  metadata?: AppElementsMetadata | null,
): string[] {
  const ids = new Set(Object.keys(elements));
  const parsedMetadata = metadata === undefined ? readAppElementsMetadata(elements) : metadata;
  for (const layoutId of parsedMetadata?.layoutIds ?? []) {
    ids.add(layoutId);
  }
  for (const identityId of Object.keys(parsedMetadata?.bfcacheSegmentIdentities ?? {})) {
    ids.add(identityId);
  }
  return Array.from(ids).filter(isBfcacheSegmentId);
}

export function createInitialBfcacheIdMap(elements: AppElements): BfcacheIdMap {
  const bfcacheIds: Record<string, string> = {};
  for (const id of collectBfcacheSegmentIds(elements)) {
    bfcacheIds[id] = INITIAL_BFCACHE_ID;
  }
  return bfcacheIds;
}

export function createBfcacheSegmentIdentityMap(options: {
  elements: AppElements;
}): BfcacheSegmentIdentityMap {
  const metadata = readAppElementsMetadata(options.elements);
  return metadata?.bfcacheSegmentIdentities ?? {};
}

export function createInitialBfcacheMaps(options: {
  elements: AppElements;
  metadata: AppElementsMetadata;
}): InitialBfcacheMaps {
  const metadata = options.metadata;
  const bfcacheIds: Record<string, string> = {};

  for (const id of collectBfcacheSegmentIds(options.elements, metadata)) {
    bfcacheIds[id] = INITIAL_BFCACHE_ID;
  }

  return { bfcacheIds, identities: metadata.bfcacheSegmentIdentities };
}

export function createNextBfcacheIdMap(options: {
  current: BfcacheIdMap;
  currentElements: AppElements;
  elements: AppElements;
  restored?: BfcacheIdMap | null;
  reuseCurrent?: boolean;
}): BfcacheIdMap {
  const current = options.reuseCurrent === false ? {} : options.current;
  for (const value of Object.values(current)) rememberBfcacheId(value);
  for (const value of Object.values(options.restored ?? {})) rememberBfcacheId(value);

  const currentMetadata = readAppElementsMetadata(options.currentElements);
  const nextMetadata = readAppElementsMetadata(options.elements);
  const ids: Record<string, string> = {};
  for (const id of collectBfcacheSegmentIds(options.elements, nextMetadata)) {
    const currentIdentity = currentMetadata?.bfcacheSegmentIdentities[id];
    const nextIdentity = nextMetadata?.bfcacheSegmentIdentities[id];
    const currentValue =
      currentIdentity !== undefined && currentIdentity === nextIdentity ? current[id] : undefined;
    // History restoration wins, then identity-compatible reuse, then a fresh
    // id. A destination without identity proof cannot safely accept a restored
    // history id. Redirected traversals must clear stale restored ids before
    // this call.
    const restoredValue = nextIdentity === undefined ? undefined : options.restored?.[id];
    const value = restoredValue ?? currentValue ?? mintBfcacheId();
    ids[id] = value;
    rememberBfcacheId(value);
  }

  return ids;
}

export function preserveBfcacheIdsForMergedElements(options: {
  elements: AppElements;
  next: BfcacheIdMap;
  previous: BfcacheIdMap;
  preservedElementIds?: readonly string[];
  preservePreviousIds?: readonly string[];
}): BfcacheIdMap {
  const ids: Record<string, string> = {};
  const preservePreviousIds = new Set(options.preservePreviousIds ?? []);
  const preservedElementIds = new Set(options.preservedElementIds ?? []);
  const preservedParentIds = [...preservedElementIds];
  const identities = createBfcacheSegmentIdentityMap({ elements: options.elements });
  for (const id of collectBfcacheSegmentIds(options.elements)) {
    const isPreservedNestedSegment = preservedParentIds.some((parentId) =>
      isNestedBfcacheSlotSegmentIdFor(id, parentId),
    );
    const value =
      (preservedElementIds.has(id) || isPreservedNestedSegment) && identities[id] === undefined
        ? mintBfcacheId()
        : preservePreviousIds.has(id) || isPreservedNestedSegment
          ? (options.previous[id] ?? options.next[id])
          : (options.next[id] ?? options.previous[id]);
    if (value === undefined) continue;
    ids[id] = value;
    // Keep future mints ahead of ids restored by reducer-level preservation.
    rememberBfcacheId(value);
  }

  return ids;
}
