import { AppElementsWire } from "./app-elements.js";
import type { TraverseDirection } from "./navigation-planner.js";

const VINEXT_PREVIOUS_NEXT_URL_HISTORY_STATE_KEY = "__vinext_previousNextUrl";
const VINEXT_HISTORY_INDEX_HISTORY_STATE_KEY = "__vinext_historyIndex";
const VINEXT_BFCACHE_IDS_HISTORY_STATE_KEY = "__vinext_bfcacheIds";
const VINEXT_BFCACHE_VERSION_HISTORY_STATE_KEY = "__vinext_bfcacheVersion";

type HistoryStateRecord = {
  [key: string]: unknown;
};

export type BfcacheIdMap = Readonly<Record<string, string>>;

export type HistoryTraversalIntent = {
  direction: TraverseDirection;
  historyState: unknown;
  targetHistoryIndex: number | null;
};

function cloneHistoryState(state: unknown): HistoryStateRecord {
  if (!state || typeof state !== "object") {
    return {};
  }

  const nextState: HistoryStateRecord = {};
  for (const [key, value] of Object.entries(state)) {
    nextState[key] = value;
  }
  return nextState;
}

function readHistoryStateRecord(state: unknown): Record<string, unknown> | null {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    return null;
  }
  return state as Record<string, unknown>;
}

export function createHistoryStateWithPreviousNextUrl(
  state: unknown,
  previousNextUrl: string | null,
): HistoryStateRecord | null {
  return createHistoryStateWithNavigationMetadata(state, { previousNextUrl });
}

export function createHistoryStateWithNavigationMetadata(
  state: unknown,
  metadata: {
    bfcacheIds?: BfcacheIdMap | null;
    bfcacheVersion?: number | null;
    previousNextUrl: string | null;
    traversalIndex?: number | null;
  },
): HistoryStateRecord | null {
  const nextState = cloneHistoryState(state);
  const bfcacheIdsWereCleared =
    metadata.bfcacheIds !== undefined &&
    (metadata.bfcacheIds === null || Object.keys(metadata.bfcacheIds).length === 0);

  if (metadata.previousNextUrl === null) {
    delete nextState[VINEXT_PREVIOUS_NEXT_URL_HISTORY_STATE_KEY];
  } else {
    nextState[VINEXT_PREVIOUS_NEXT_URL_HISTORY_STATE_KEY] = metadata.previousNextUrl;
  }

  if (metadata.traversalIndex !== undefined) {
    if (isNonNegativeSafeInteger(metadata.traversalIndex)) {
      nextState[VINEXT_HISTORY_INDEX_HISTORY_STATE_KEY] = metadata.traversalIndex;
    } else {
      delete nextState[VINEXT_HISTORY_INDEX_HISTORY_STATE_KEY];
    }
  }

  if (metadata.bfcacheIds !== undefined) {
    if (bfcacheIdsWereCleared) {
      delete nextState[VINEXT_BFCACHE_IDS_HISTORY_STATE_KEY];
      delete nextState[VINEXT_BFCACHE_VERSION_HISTORY_STATE_KEY];
    } else {
      nextState[VINEXT_BFCACHE_IDS_HISTORY_STATE_KEY] = { ...metadata.bfcacheIds };
    }
  }

  if (metadata.bfcacheVersion !== undefined) {
    if (bfcacheIdsWereCleared) {
      delete nextState[VINEXT_BFCACHE_VERSION_HISTORY_STATE_KEY];
    } else if (isNonNegativeSafeInteger(metadata.bfcacheVersion)) {
      nextState[VINEXT_BFCACHE_VERSION_HISTORY_STATE_KEY] = metadata.bfcacheVersion;
    } else {
      delete nextState[VINEXT_BFCACHE_VERSION_HISTORY_STATE_KEY];
    }
  }

  return Object.keys(nextState).length > 0 ? nextState : null;
}

export function createExternalHistoryStatePreservingMetadata(
  callerState: unknown,
  currentHistoryState: unknown,
): unknown {
  const previousNextUrl = readHistoryStatePreviousNextUrl(currentHistoryState);
  const traversalIndex = readHistoryStateTraversalIndex(currentHistoryState);
  const bfcacheIds = readHistoryStateBfcacheIds(currentHistoryState);
  const bfcacheVersion = readHistoryStateBfcacheVersion(currentHistoryState);

  if (previousNextUrl === null && traversalIndex === null && bfcacheIds === null) {
    return callerState;
  }

  return createHistoryStateWithNavigationMetadata(callerState, {
    bfcacheIds,
    bfcacheVersion: bfcacheIds === null ? undefined : bfcacheVersion,
    previousNextUrl,
    traversalIndex,
  });
}

export function readHistoryStatePreviousNextUrl(state: unknown): string | null {
  const value = readHistoryStateRecord(state)?.[VINEXT_PREVIOUS_NEXT_URL_HISTORY_STATE_KEY];
  return typeof value === "string" ? value : null;
}

export function isBfcacheSegmentId(id: string): boolean {
  const parsed = AppElementsWire.parseElementKey(id);
  return (
    parsed?.kind === "layout" ||
    parsed?.kind === "page" ||
    parsed?.kind === "slot" ||
    parsed?.kind === "template"
  );
}

export function readHistoryStateBfcacheIds(state: unknown): BfcacheIdMap | null {
  const value = readHistoryStateRecord(state)?.[VINEXT_BFCACHE_IDS_HISTORY_STATE_KEY];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const ids: Record<string, string> = {};
  for (const [key, id] of Object.entries(value)) {
    if (!isBfcacheSegmentId(key) || typeof id !== "string") {
      return null;
    }
    ids[key] = id;
  }
  return ids;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function readHistoryStateBfcacheVersion(state: unknown): number | null {
  const value = readHistoryStateRecord(state)?.[VINEXT_BFCACHE_VERSION_HISTORY_STATE_KEY];
  return isNonNegativeSafeInteger(value) ? value : null;
}

/**
 * Whether a history entry's stored bfcache version matches the document's
 * current version. A missing/invalid stored version (null) is NEVER current:
 * coercing it to 0 would let un-versioned entries (older builds / external
 * pushState) pass the gate on a fresh document whose current version is 0,
 * defeating the document-scoped stale-id rejection. App-written entries always
 * carry an explicit version, so the legitimate first-document path (0 === 0)
 * still matches.
 */
export function isHistoryStateBfcacheVersionCurrent(
  state: unknown,
  currentVersion: number,
): boolean {
  const version = readHistoryStateBfcacheVersion(state);
  return version !== null && version === currentVersion;
}

export function createHashOnlyHistoryStatePreservingNavigationMetadata(state: unknown): unknown {
  const previousNextUrl = readHistoryStatePreviousNextUrl(state);
  const bfcacheIds = readHistoryStateBfcacheIds(state);
  const bfcacheVersion = readHistoryStateBfcacheVersion(state);

  if (previousNextUrl === null && bfcacheIds === null) {
    return null;
  }

  // Traversal indices are assigned by the App Router browser entry's
  // commitHashOnlyNavigation path. This shim fallback only preserves metadata
  // that can be safely transported without the browser router runtime.
  return createHistoryStateWithNavigationMetadata(null, {
    bfcacheIds,
    bfcacheVersion: bfcacheIds === null ? undefined : bfcacheVersion,
    previousNextUrl,
  });
}

export function readHistoryStateTraversalIndex(state: unknown): number | null {
  const value = readHistoryStateRecord(state)?.[VINEXT_HISTORY_INDEX_HISTORY_STATE_KEY];
  return isNonNegativeSafeInteger(value) ? value : null;
}

export function resolveHistoryTraversalIntent(options: {
  currentHistoryIndex: number | null;
  historyState: unknown;
}): HistoryTraversalIntent {
  const targetHistoryIndex = readHistoryStateTraversalIndex(options.historyState);
  let direction: TraverseDirection = "unknown";

  if (options.currentHistoryIndex !== null && targetHistoryIndex !== null) {
    if (targetHistoryIndex < options.currentHistoryIndex) {
      direction = "back";
    } else if (targetHistoryIndex > options.currentHistoryIndex) {
      direction = "forward";
    }
  }

  return {
    direction,
    historyState: options.historyState,
    targetHistoryIndex,
  };
}
