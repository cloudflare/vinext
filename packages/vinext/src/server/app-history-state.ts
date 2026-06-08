import { AppElementsWire } from "./app-elements.js";
import type { TraverseDirection } from "./navigation-planner.js";
import { isNonNegativeSafeInteger } from "../utils/number.js";

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

type HistoryStateSnapshot<TState> = {
  bfcacheVersion: number;
  state: TState;
};

type HistoryStateSnapshotRestoreDecision<TState> =
  | {
      kind: "restore";
      state: TState;
      targetHistoryIndex: number;
    }
  | {
      kind: "skip";
      reason: "guarded" | "missing-history-index" | "missing-snapshot" | "stale-bfcache-version";
      targetHistoryIndex: number | null;
    };

export class HistoryStateSnapshotCache<TState> {
  readonly #maxEntries: number;
  readonly #snapshots = new Map<number, HistoryStateSnapshot<TState>>();

  constructor(options: { maxEntries: number }) {
    this.#maxEntries = options.maxEntries;
  }

  clear(): void {
    this.#snapshots.clear();
  }

  remember(options: { bfcacheVersion: number; historyIndex: number | null; state: TState }): void {
    if (options.historyIndex === null) return;

    this.#snapshots.delete(options.historyIndex);
    this.#snapshots.set(options.historyIndex, {
      bfcacheVersion: options.bfcacheVersion,
      state: options.state,
    });

    if (this.#snapshots.size <= this.#maxEntries) return;

    const oldestIndex = this.#snapshots.keys().next().value;
    if (typeof oldestIndex === "number") {
      this.#snapshots.delete(oldestIndex);
    }
  }

  resolveRestore(options: {
    currentBfcacheVersion: number;
    guarded: boolean;
    historyState: unknown;
  }): HistoryStateSnapshotRestoreDecision<TState> {
    const targetHistoryIndex = readHistoryStateTraversalIndex(options.historyState);
    if (targetHistoryIndex === null) {
      return { kind: "skip", reason: "missing-history-index", targetHistoryIndex };
    }

    const snapshot = this.#snapshots.get(targetHistoryIndex);
    if (!snapshot) {
      return { kind: "skip", reason: "missing-snapshot", targetHistoryIndex };
    }
    if (options.guarded) {
      return { kind: "skip", reason: "guarded", targetHistoryIndex };
    }
    if (snapshot.bfcacheVersion !== options.currentBfcacheVersion) {
      this.#snapshots.delete(targetHistoryIndex);
      return { kind: "skip", reason: "stale-bfcache-version", targetHistoryIndex };
    }

    return { kind: "restore", state: snapshot.state, targetHistoryIndex };
  }
}

export class RestorableClientStateController<TState> {
  #currentBfcacheVersion: number;
  #pendingCacheInvalidationGuards = 0;
  readonly #snapshots: HistoryStateSnapshotCache<TState>;

  constructor(options: { initialHistoryState: unknown; maxHistoryStateSnapshots: number }) {
    const initialHistoryBfcacheVersion = readHistoryStateBfcacheVersion(
      options.initialHistoryState,
    );
    // A new browser document does not retain Next's in-memory BFCache entries.
    // Treat bfcache ids persisted by an older document as stale so a hard
    // reload cannot restore/collide with pre-reload route identities.
    this.#currentBfcacheVersion =
      initialHistoryBfcacheVersion === null ? 0 : initialHistoryBfcacheVersion + 1;
    this.#snapshots = new HistoryStateSnapshotCache<TState>({
      maxEntries: options.maxHistoryStateSnapshots,
    });
  }

  get currentBfcacheVersion(): number {
    return this.#currentBfcacheVersion;
  }

  beginCacheInvalidationGuard(): () => void {
    this.#pendingCacheInvalidationGuards += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#pendingCacheInvalidationGuards = Math.max(0, this.#pendingCacheInvalidationGuards - 1);
    };
  }

  isCacheInvalidationGuarded(): boolean {
    return this.#pendingCacheInvalidationGuards > 0;
  }

  isCurrentBfcacheVersion(historyState: unknown): boolean {
    return isHistoryStateBfcacheVersionCurrent(historyState, this.#currentBfcacheVersion);
  }

  readCurrentBfcacheVersionHistoryIds(historyState: unknown): BfcacheIdMap | null {
    if (this.isCacheInvalidationGuarded()) return null;
    const ids = readHistoryStateBfcacheIds(historyState);
    if (ids === null) return null;
    return this.isCurrentBfcacheVersion(historyState) ? ids : null;
  }

  #invalidateBfcacheIds(): void {
    this.#currentBfcacheVersion += 1;
  }

  invalidateClientState(): void {
    this.#snapshots.clear();
    this.#invalidateBfcacheIds();
  }

  rememberHistoryStateSnapshot(options: { historyIndex: number | null; state: TState }): void {
    this.#snapshots.remember({
      bfcacheVersion: this.#currentBfcacheVersion,
      historyIndex: options.historyIndex,
      state: options.state,
    });
  }

  resolveHistoryStateSnapshotRestore(
    historyState: unknown,
  ): HistoryStateSnapshotRestoreDecision<TState> {
    return this.#snapshots.resolveRestore({
      currentBfcacheVersion: this.#currentBfcacheVersion,
      guarded: this.isCacheInvalidationGuarded(),
      historyState,
    });
  }
}

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
