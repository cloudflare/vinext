import {
  RestorableClientStateController,
  createHistoryStateWithNavigationMetadata,
  readHistoryStateBfcacheIds,
  readHistoryStatePreviousNextUrl,
  readHistoryStateTraversalIndex,
  resolveHistoryTraversalIntent,
  type BfcacheIdMap,
  type HistoryTraversalIntent,
} from "./app-history-state.js";
import type { AppRouterState } from "./app-browser-state.js";
import type { HistoryUpdateMode } from "./app-browser-navigation-controller.js";

/**
 * Visible router-state metadata at the instant a hash-only navigation commits.
 * `null` means the browser router tree has not committed yet, so the controller
 * falls back to reading the same facts off the live history entry.
 */
type VisibleNavigationMetadata = {
  bfcacheIds: BfcacheIdMap | null;
  previousNextUrl: string | null;
};

type AppBrowserHistoryControllerDeps = {
  initialHistoryState: unknown;
  maxHistoryStateSnapshots: number;
  /** Reads `window.history.state`. Injected so the controller stays unit-testable. */
  readHistoryState: () => unknown;
  /** Reads `window.location.href`. Injected so the controller stays unit-testable. */
  readCurrentHref: () => string;
  /** Wraps `pushHistoryStateWithoutNotify(state, "", href)`. */
  pushHistoryState: (state: unknown, href: string) => void;
  /** Wraps `replaceHistoryStateWithoutNotify(state, "", href)`. */
  replaceHistoryState: (state: unknown, href: string) => void;
  readVisibleNavigationMetadata: () => VisibleNavigationMetadata | null;
};

/**
 * Candidate visible state resolved from a restorable history snapshot, handed to
 * the entry's approved-visible-restore callback. The controller resolves the
 * candidate and owns the traversal-index commit; the entry owns the actual
 * `AppBrowserNavigationController.restoreHistorySnapshotVisibleState()` call and
 * the `ApprovedVisibleCommit` boundary.
 */
export type RestorableSnapshotCandidate = {
  state: AppRouterState;
  beforeCommit: () => void;
};

type RestoreHistorySnapshotOptions = {
  historyState: unknown;
  stageClientParams: (params: Record<string, string | string[]>) => void;
  approveVisibleRestore: (candidate: RestorableSnapshotCandidate) => boolean;
};

type CommitNavigationHistoryOptions = {
  bfcacheIds: BfcacheIdMap;
  href: string;
  historyUpdateMode: HistoryUpdateMode | undefined;
  previousNextUrl: string | null;
  targetHistoryIndex?: number | null;
  stageClientParams: () => void;
};

function stripVinextScrollState(state: unknown): unknown {
  if (!state || typeof state !== "object") {
    return state;
  }

  const nextState: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(state)) {
    if (key === "__vinext_scrollX" || key === "__vinext_scrollY") {
      continue;
    }
    nextState[key] = value;
  }

  return Object.keys(nextState).length > 0 ? nextState : null;
}

/**
 * Owns App Router browser-history metadata and traversal bookkeeping behind a
 * typed seam: traversal index allocation/commit, push/replace/traverse/hash-only
 * history-state writes, BFCache epoch/snapshot invalidation through
 * `RestorableClientStateController`, and restorable-snapshot candidate
 * resolution.
 *
 * Ownership boundary: this is not a second router or visible-state authority. It
 * resolves history facts and delegates visible restoration through an injected
 * approved-commit callback. It never sets router state directly, never imports
 * `applyApprovedVisibleCommit()`, and never bypasses the `ApprovedVisibleCommit`
 * boundary owned by `AppBrowserNavigationController`.
 */
export class AppBrowserHistoryController {
  readonly #restorableClientState: RestorableClientStateController<AppRouterState>;
  readonly #readHistoryState: () => unknown;
  readonly #readCurrentHref: () => string;
  readonly #pushHistoryState: (state: unknown, href: string) => void;
  readonly #replaceHistoryState: (state: unknown, href: string) => void;
  readonly #readVisibleNavigationMetadata: () => VisibleNavigationMetadata | null;

  // Highest app-owned traversal index we know about (`#next`) versus the index
  // of the currently committed entry (`#current`). Traversing to a metadata-less
  // entry makes `#current` unknown (null), but the next app-owned push must
  // still continue from the highest known app history.
  #currentHistoryTraversalIndex: number | null;
  #nextHistoryTraversalIndex: number;

  constructor(deps: AppBrowserHistoryControllerDeps) {
    this.#readHistoryState = deps.readHistoryState;
    this.#readCurrentHref = deps.readCurrentHref;
    this.#pushHistoryState = deps.pushHistoryState;
    this.#replaceHistoryState = deps.replaceHistoryState;
    this.#readVisibleNavigationMetadata = deps.readVisibleNavigationMetadata;
    this.#restorableClientState = new RestorableClientStateController<AppRouterState>({
      initialHistoryState: deps.initialHistoryState,
      maxHistoryStateSnapshots: deps.maxHistoryStateSnapshots,
    });
    this.#currentHistoryTraversalIndex =
      readHistoryStateTraversalIndex(deps.initialHistoryState) ?? 0;
    this.#nextHistoryTraversalIndex = this.#currentHistoryTraversalIndex;
  }

  get currentHistoryTraversalIndex(): number | null {
    return this.#currentHistoryTraversalIndex;
  }

  allocateNavigationHistoryTraversalIndex(
    historyUpdateMode: HistoryUpdateMode | undefined,
  ): number | null {
    switch (historyUpdateMode) {
      case "push":
        return this.#nextHistoryTraversalIndex + 1;
      case "replace":
        return this.#currentHistoryTraversalIndex;
      case undefined:
        return null;
      default: {
        const _exhaustive: never = historyUpdateMode;
        throw new Error("[vinext] Unknown history update mode: " + String(_exhaustive));
      }
    }
  }

  commitHistoryTraversalIndex(index: number | null): void {
    this.#currentHistoryTraversalIndex = index;
    if (index !== null) {
      this.#nextHistoryTraversalIndex = Math.max(this.#nextHistoryTraversalIndex, index);
    }
  }

  commitTraversalIndexFromHistoryState(historyState: unknown): void {
    this.commitHistoryTraversalIndex(readHistoryStateTraversalIndex(historyState));
  }

  resolveTraversalIntent(historyState: unknown): HistoryTraversalIntent {
    return resolveHistoryTraversalIntent({
      currentHistoryIndex: this.#currentHistoryTraversalIndex,
      historyState,
    });
  }

  // --- BFCache epoch + cache-invalidation delegation ---

  readCurrentBfcacheVersionHistoryIds(historyState: unknown): BfcacheIdMap | null {
    return this.#restorableClientState.readCurrentBfcacheVersionHistoryIds(historyState);
  }

  isCacheInvalidationGuarded(): boolean {
    return this.#restorableClientState.isCacheInvalidationGuarded();
  }

  isCurrentBfcacheVersion(historyState: unknown): boolean {
    return this.#restorableClientState.isCurrentBfcacheVersion(historyState);
  }

  beginCacheInvalidationGuard(): () => void {
    return this.#restorableClientState.beginCacheInvalidationGuard();
  }

  invalidateRestorableClientState(): void {
    this.#restorableClientState.invalidateClientState();
  }

  rememberHistoryStateSnapshot(state: AppRouterState): void {
    this.#restorableClientState.rememberHistoryStateSnapshot({
      historyIndex: this.#currentHistoryTraversalIndex,
      state,
    });
  }

  // --- History metadata writes ---

  commitHashOnlyNavigation(
    href: string,
    historyUpdateMode: HistoryUpdateMode,
    scroll: boolean,
  ): void {
    const navigationHistoryIndex = this.allocateNavigationHistoryTraversalIndex(historyUpdateMode);
    const historyState = this.#readHistoryState();
    const visible = this.#readVisibleNavigationMetadata();
    const previousNextUrl = visible
      ? visible.previousNextUrl
      : readHistoryStatePreviousNextUrl(historyState);
    const bfcacheIds = visible
      ? visible.bfcacheIds
      : this.#restorableClientState.readCurrentBfcacheVersionHistoryIds(historyState);
    const nextHistoryState = createHistoryStateWithNavigationMetadata(
      this.#createHashOnlyNavigationBaseHistoryState(historyUpdateMode, scroll),
      {
        bfcacheIds,
        bfcacheVersion:
          bfcacheIds === null ? undefined : this.#restorableClientState.currentBfcacheVersion,
        previousNextUrl,
        traversalIndex: navigationHistoryIndex,
      },
    );

    if (historyUpdateMode === "replace") {
      this.#replaceHistoryState(nextHistoryState, href);
    } else {
      this.#pushHistoryState(nextHistoryState, href);
    }
    this.commitHistoryTraversalIndex(navigationHistoryIndex);
  }

  #createHashOnlyNavigationBaseHistoryState(
    historyUpdateMode: HistoryUpdateMode,
    scroll: boolean,
  ): unknown {
    if (historyUpdateMode !== "replace") {
      return null;
    }
    const historyState = this.#readHistoryState();
    return scroll ? stripVinextScrollState(historyState) : historyState;
  }

  /**
   * Writes the history entry for an approved push/replace/traverse commit and
   * advances the traversal index. `stageClientParams` runs at the exact point it
   * ran inline in the browser-entry commit effect so client-param staging stays
   * ordered relative to the history write. Mirrors Next.js committing tree state
   * into the history entry during the navigation commit.
   */
  commitNavigationHistory(options: CommitNavigationHistoryOptions): void {
    const currentHref = this.#readCurrentHref();
    const origin = new URL(currentHref).origin;
    const targetHref = new URL(options.href, origin).href;
    const preserveExistingState = options.historyUpdateMode === "replace";
    const navigationHistoryIndex =
      options.targetHistoryIndex !== undefined
        ? options.targetHistoryIndex
        : this.allocateNavigationHistoryTraversalIndex(options.historyUpdateMode);
    const historyState = createHistoryStateWithNavigationMetadata(
      preserveExistingState ? this.#readHistoryState() : null,
      {
        bfcacheIds: options.bfcacheIds,
        bfcacheVersion: this.#restorableClientState.currentBfcacheVersion,
        previousNextUrl: options.previousNextUrl,
        traversalIndex: navigationHistoryIndex,
      },
    );

    let wroteHistoryState = false;
    if (options.historyUpdateMode === "replace" && currentHref !== targetHref) {
      options.stageClientParams();
      this.#replaceHistoryState(historyState, options.href);
      wroteHistoryState = true;
      this.commitHistoryTraversalIndex(navigationHistoryIndex);
    } else if (options.historyUpdateMode === "push" && currentHref !== targetHref) {
      options.stageClientParams();
      this.#pushHistoryState(historyState, options.href);
      wroteHistoryState = true;
      this.commitHistoryTraversalIndex(navigationHistoryIndex);
    }

    if (!wroteHistoryState) {
      // Traversal and refresh commits may keep the URL unchanged, but still
      // persist the latest bfcache id map for future history restoration.
      this.syncCurrentHistoryStatePreviousNextUrl(options.previousNextUrl, options.bfcacheIds);
      options.stageClientParams();
      if (options.targetHistoryIndex !== undefined) {
        this.commitHistoryTraversalIndex(options.targetHistoryIndex);
      }
    }
  }

  syncCurrentHistoryStatePreviousNextUrl(
    previousNextUrl: string | null,
    bfcacheIds?: BfcacheIdMap | null,
  ): void {
    if (
      this.#isHistoryStateNavigationMetadataInSync(
        this.#readHistoryState(),
        previousNextUrl,
        bfcacheIds,
      )
    ) {
      return;
    }

    const nextHistoryState = createHistoryStateWithNavigationMetadata(this.#readHistoryState(), {
      bfcacheIds,
      bfcacheVersion:
        bfcacheIds === undefined ? undefined : this.#restorableClientState.currentBfcacheVersion,
      previousNextUrl,
    });
    // First attempt: a notify-suppressing replaceState fires no popstate or
    // hashchange. If the browser accepted it (re-read below), we're done. The
    // double-read covers Safari silently coalescing back-to-back replaceState
    // calls (e.g. rapid navigation commits); the fallback fires only when the
    // state did not stick. The retry stays on the same notify-suppressing path
    // rather than the patched window.history.replaceState, because this is a
    // URL-unchanged metadata sync (refresh or traversal commit) that must not
    // run the patched-path side effects.
    this.#replaceHistoryState(nextHistoryState, this.#readCurrentHref());
    if (
      this.#isHistoryStateNavigationMetadataInSync(
        this.#readHistoryState(),
        previousNextUrl,
        bfcacheIds,
      )
    ) {
      return;
    }
    this.#replaceHistoryState(nextHistoryState, this.#readCurrentHref());
  }

  #isHistoryStateNavigationMetadataInSync(
    state: unknown,
    previousNextUrl: string | null,
    bfcacheIds?: BfcacheIdMap | null,
  ): boolean {
    return (
      readHistoryStatePreviousNextUrl(state) === previousNextUrl &&
      (bfcacheIds === undefined ||
        (areBfcacheIdMapsEqual(readHistoryStateBfcacheIds(state), bfcacheIds) &&
          this.#restorableClientState.isCurrentBfcacheVersion(state)))
    );
  }

  /** Initial history write performed before hydration starts. */
  writeBootstrapHistoryMetadata(): void {
    this.#replaceHistoryState(
      createHistoryStateWithNavigationMetadata(this.#readHistoryState(), {
        previousNextUrl: null,
        traversalIndex: this.#currentHistoryTraversalIndex,
      }),
      this.#readCurrentHref(),
    );
  }

  /** History write performed on the first committed (hydrated) render. */
  writeHydratedHistoryMetadata(options: {
    bfcacheIds: BfcacheIdMap;
    previousNextUrl: string | null;
  }): void {
    this.#replaceHistoryState(
      createHistoryStateWithNavigationMetadata(this.#readHistoryState(), {
        bfcacheIds: options.bfcacheIds,
        bfcacheVersion: this.#restorableClientState.currentBfcacheVersion,
        previousNextUrl: options.previousNextUrl,
        traversalIndex: this.#currentHistoryTraversalIndex,
      }),
      this.#readCurrentHref(),
    );
  }

  // --- Restorable snapshot restore ---

  /**
   * Resolves a restorable snapshot candidate for the given history entry and
   * commits the traversal index after, and only after, the injected
   * approved-visible-restore callback succeeds. The traversal-index commit and
   * client-param staging run inside `beforeCommit`, which the
   * `AppBrowserNavigationController` invokes only once the `ApprovedVisibleCommit`
   * is approved. Returns false when no snapshot is restorable or the restore is
   * not approved.
   */
  restoreHistorySnapshot(options: RestoreHistorySnapshotOptions): boolean {
    const decision = this.#restorableClientState.resolveHistoryStateSnapshotRestore(
      options.historyState,
    );
    if (decision.kind === "skip") {
      return false;
    }

    return options.approveVisibleRestore({
      state: decision.state,
      beforeCommit: () => {
        this.commitHistoryTraversalIndex(decision.targetHistoryIndex);
        options.stageClientParams(decision.state.navigationSnapshot.params);
      },
    });
  }
}

function areBfcacheIdMapsEqual(a: BfcacheIdMap | null, b: BfcacheIdMap | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  const aEntries = Object.entries(a);
  const bEntries = Object.entries(b);
  if (aEntries.length !== bEntries.length) return false;
  // Equal lengths make this bidirectional: if every a entry exists in b with
  // the same value, b cannot contain an extra distinct key.
  return aEntries.every(([key, value]) => b[key] === value);
}
