import { AppElementsWire, type AppElements, type AppElementsSlotBinding } from "./app-elements.js";
import {
  countConsumedPathnameSegments,
  isInvisibleSegment,
  normalizePathnameForRouteMatch,
  splitPathSegments,
} from "../routing/utils.js";
import { normalizePath } from "./normalize-path.js";
import { INITIAL_BFCACHE_ID } from "./app-bfcache-id.js";
import type { BfcacheIdMap } from "./app-history-state.js";

export type BfcacheStateKeyMap = Readonly<Record<string, string>>;

export type InitialBfcacheMaps = Readonly<{
  bfcacheIds: BfcacheIdMap;
  stateKeys: BfcacheStateKeyMap;
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

function getVisibleTreePathSegments(treePath: string): string[] {
  // Tree paths contain raw filesystem segments (route groups, parallel @slots,
  // and "." default segments). Only URL-visible segments consume a pathname
  // segment when deriving the identity prefix. Missing @slot or "." here
  // over-counts consumed segments and remints ids for persistent layouts.
  return splitPathSegments(treePath).filter((segment) => !isInvisibleSegment(segment));
}

function getTreePathIdentityPrefix(pathname: string, treePath: string): string {
  const pathnameSegments = splitPathSegments(pathname);
  const consumedPathnameSegments = countConsumedPathnameSegments(
    getVisibleTreePathSegments(treePath),
    pathnameSegments.length,
  );

  if (consumedPathnameSegments === 0) return "/";
  return `/${pathnameSegments.slice(0, consumedPathnameSegments).join("/")}`;
}

type AppElementsMetadata = ReturnType<typeof AppElementsWire.readMetadata>;
type AppElementsWireElementKey = NonNullable<ReturnType<typeof AppElementsWire.parseElementKey>>;
type BfcacheSegmentElementKey = Exclude<AppElementsWireElementKey, { kind: "route" }>;

/**
 * Metadata parsed once per element map, with an index that keeps per-slot
 * identity lookup O(1) rather than scanning every binding for every slot.
 */
type ParsedAppElementsMetadata = {
  metadata: AppElementsMetadata;
  slotBindingsBySlotId: ReadonlyMap<string, AppElementsSlotBinding>;
};

function indexAppElementsMetadata(metadata: AppElementsMetadata): ParsedAppElementsMetadata {
  const slotBindingsBySlotId = new Map<string, AppElementsSlotBinding>();
  for (const binding of metadata.slotBindings) {
    slotBindingsBySlotId.set(binding.slotId, binding);
  }
  return { metadata, slotBindingsBySlotId };
}

function readAppElementsMetadata(elements: AppElements): ParsedAppElementsMetadata | null {
  let metadata: AppElementsMetadata;
  try {
    metadata = AppElementsWire.readMetadata(elements);
  } catch {
    // Some low-level tests pass partial element maps without metadata.
    return null;
  }
  return indexAppElementsMetadata(metadata);
}

function parseBfcacheSegmentKey(id: string): BfcacheSegmentElementKey | null {
  const parsed = AppElementsWire.parseElementKey(id);
  return parsed !== null && parsed.kind !== "route" ? parsed : null;
}

function createActiveSlotIdentity(
  id: string,
  parsed: ParsedAppElementsMetadata | null,
): string | null {
  const activeSlotBinding = parsed?.slotBindingsBySlotId.get(id);
  if (activeSlotBinding?.activeRouteId != null) {
    return `${id}@${activeSlotBinding.activeRouteId}`;
  }

  const interception = parsed?.metadata.interception;
  if (interception?.slotId !== id) return null;
  return `${id}@${interception.targetRouteId}`;
}

/**
 * Derive BFCache identity from AppElements wire keys. Keep wire-key parsing
 * contained here until vinext has a route-manifest authority equivalent to
 * Next.js CacheNode or segment-cache state.
 */
function createBfcacheSegmentIdentity(
  id: string,
  parsed: BfcacheSegmentElementKey,
  options: {
    metadata: ParsedAppElementsMetadata | null;
    pathname: string;
  },
): string | null {
  if (parsed.kind === "page") {
    return `${id}@${options.pathname}`;
  }

  if (parsed.kind === "slot") {
    const activeSlotIdentity = createActiveSlotIdentity(id, options.metadata);
    if (activeSlotIdentity !== null) return activeSlotIdentity;
    return `${id}@${getTreePathIdentityPrefix(options.pathname, parsed.treePath)}`;
  }

  if (parsed.kind === "layout" || parsed.kind === "template") {
    return `${id}@${getTreePathIdentityPrefix(options.pathname, parsed.treePath)}`;
  }

  return null;
}

function collectBfcacheSegmentIdCandidates(
  elements: AppElements,
  metadata = readAppElementsMetadata(elements),
): Set<string> {
  const ids = new Set(Object.keys(elements));
  for (const layoutId of metadata?.metadata.layoutIds ?? []) {
    ids.add(layoutId);
  }
  return ids;
}

export function createInitialBfcacheIdMap(elements: AppElements): BfcacheIdMap {
  const bfcacheIds: Record<string, string> = {};
  for (const id of collectBfcacheSegmentIdCandidates(elements)) {
    if (parseBfcacheSegmentKey(id) !== null) {
      bfcacheIds[id] = INITIAL_BFCACHE_ID;
    }
  }
  return bfcacheIds;
}

function normalizeBfcachePathname(pathname: string): string {
  // Preserve encoded delimiters such as %2F as segment data.
  const normalized = normalizePath(normalizePathnameForRouteMatch(pathname));
  return normalized.length > 1 ? normalized.replace(/\/$/, "") : normalized;
}

export function createBfcacheSegmentStateKeyMap(options: {
  elements: AppElements;
  pathname: string;
}): BfcacheStateKeyMap {
  const metadata = readAppElementsMetadata(options.elements);
  const normalizedPathname = normalizeBfcachePathname(options.pathname);
  const stateKeys: Record<string, string> = {};

  for (const id of collectBfcacheSegmentIdCandidates(options.elements, metadata)) {
    const parsed = parseBfcacheSegmentKey(id);
    if (parsed === null) continue;
    const stateKey = createBfcacheSegmentIdentity(id, parsed, {
      metadata,
      pathname: normalizedPathname,
    });
    if (stateKey !== null) stateKeys[id] = stateKey;
  }

  return stateKeys;
}

export function createInitialBfcacheMaps(options: {
  elements: AppElements;
  metadata: AppElementsMetadata;
  pathname: string;
}): InitialBfcacheMaps {
  const metadata = indexAppElementsMetadata(options.metadata);
  const ids = collectBfcacheSegmentIdCandidates(options.elements, metadata);
  const normalizedPathname = normalizeBfcachePathname(options.pathname);
  const bfcacheIds: Record<string, string> = {};
  const stateKeys: Record<string, string> = {};

  for (const id of ids) {
    const parsed = parseBfcacheSegmentKey(id);
    if (parsed === null) continue;
    bfcacheIds[id] = INITIAL_BFCACHE_ID;
    const stateKey = createBfcacheSegmentIdentity(id, parsed, {
      metadata,
      pathname: normalizedPathname,
    });
    if (stateKey !== null) stateKeys[id] = stateKey;
  }

  return { bfcacheIds, stateKeys };
}

export function createNextBfcacheIdMap(options: {
  current: BfcacheIdMap;
  currentElements: AppElements;
  currentPathname: string;
  elements: AppElements;
  nextPathname: string;
  restored?: BfcacheIdMap | null;
  reuseCurrent?: boolean;
}): BfcacheIdMap {
  const current = options.reuseCurrent === false ? {} : options.current;
  for (const value of Object.values(current)) rememberBfcacheId(value);
  for (const value of Object.values(options.restored ?? {})) rememberBfcacheId(value);

  const currentMetadata = readAppElementsMetadata(options.currentElements);
  const nextMetadata = readAppElementsMetadata(options.elements);
  const currentPathname = normalizeBfcachePathname(options.currentPathname);
  const nextPathname = normalizeBfcachePathname(options.nextPathname);
  const ids: Record<string, string> = {};
  for (const id of collectBfcacheSegmentIdCandidates(options.elements, nextMetadata)) {
    const parsed = parseBfcacheSegmentKey(id);
    if (parsed === null) continue;
    const currentIdentity = createBfcacheSegmentIdentity(id, parsed, {
      metadata: currentMetadata,
      pathname: currentPathname,
    });
    const nextIdentity = createBfcacheSegmentIdentity(id, parsed, {
      metadata: nextMetadata,
      pathname: nextPathname,
    });
    const currentValue = currentIdentity === nextIdentity ? current[id] : undefined;
    // History restoration wins, then identity-compatible reuse, then a fresh
    // id. Redirected traversals must clear stale restored ids before this call.
    const value = options.restored?.[id] ?? currentValue ?? mintBfcacheId();
    ids[id] = value;
    rememberBfcacheId(value);
  }

  return ids;
}

export function preserveBfcacheIdsForMergedElements(options: {
  elements: AppElements;
  next: BfcacheIdMap;
  previous: BfcacheIdMap;
}): BfcacheIdMap {
  const ids: Record<string, string> = {};
  for (const id of collectBfcacheSegmentIdCandidates(options.elements)) {
    if (parseBfcacheSegmentKey(id) === null) continue;
    const value = options.next[id] ?? options.previous[id];
    if (value === undefined) continue;
    ids[id] = value;
    // Keep future mints ahead of ids restored by reducer-level preservation.
    rememberBfcacheId(value);
  }

  return ids;
}
