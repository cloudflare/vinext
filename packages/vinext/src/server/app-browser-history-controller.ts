import {
  RestorableClientStateController,
  clearHistoryStateTreeSnapshotId,
  createAppOwnedHistoryState,
  createExternalHistoryStatePreservingMetadata,
  createHistoryStateWithNavigationMetadata,
  createHistoryStateWithTreeSnapshotClaim,
  createHistoryStateWithTreeSnapshotId,
  isExternalHistoryState,
  isHistoryStateTreeSnapshotClaimed,
  readHistoryStateActiveRoutePaths,
  readHistoryStateBfcacheIds,
  readHistoryStatePreviousNextUrl,
  readHistoryStateTraversalIndex,
  readHistoryStateTreeSnapshotId,
  resolveHistoryTraversalIntent,
  type BfcacheIdMap,
  type HistoryTraversalIntent,
} from "./app-history-state.js";
import type { RouterHistoryWriteLanding } from "vinext/shims/navigation";
import type { AppRouterState } from "./app-browser-state.js";
import type { HistoryUpdateMode } from "./app-browser-navigation-controller.js";

/**
 * Visible router-state metadata at the instant a hash-only navigation commits.
 * `null` means the browser router tree has not committed yet, so the controller
 * falls back to reading the same facts off the live history entry.
 */
type VisibleNavigationMetadata = {
  activeRoutePaths: readonly string[] | null;
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
  /** Wraps `pushHistoryStateWithoutNotify(state, "", href, land)`. */
  pushHistoryState: (state: unknown, href: string, land?: RouterHistoryWriteLanding) => void;
  /** Wraps `replaceHistoryStateWithoutNotify(state, "", href, land)`. */
  replaceHistoryState: (state: unknown, href?: string, land?: RouterHistoryWriteLanding) => void;
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
  preferExternalSnapshot?: boolean;
  stageClientParams: (params: Record<string, string | string[]>) => void;
  approveVisibleRestore: (candidate: RestorableSnapshotCandidate) => boolean;
};

type CommitNavigationHistoryOptions = {
  activeRoutePaths: readonly string[];
  bfcacheIds: BfcacheIdMap;
  href: string;
  historyUpdateMode: HistoryUpdateMode | undefined;
  previousNextUrl: string | null;
  targetHistoryIndex?: number | null;
  stageClientParams: () => void;
};

export function createCanonicalBrowserHistoryHref(href: string): string {
  const url = new URL(href);
  return `${url.pathname}${url.search}${url.hash}`;
}

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
  // Unlike traversal-index snapshots, a tree explicitly copied by raw/hash
  // history can remain reachable for the document lifetime. Keep one current
  // candidate and promote only ids claimed by those history writes; ordinary
  // renders are released when the candidate advances.
  readonly #treeSnapshots = new Map<string, AppRouterState>();
  readonly #treeSnapshotClaimCounts = new Map<string, number>();
  readonly #treeSnapshotClaimByHistoryIndex = new Map<number, string>();
  // History state outlives the document, but the trees its ids name live only
  // in this document's memory. A per-document prefix keeps an id that an
  // earlier document wrote (before a reload or hard navigation) from naming a
  // tree of this one; such an entry falls back to rendering its URL.
  readonly #treeSnapshotIdPrefix = createDocumentTreeSnapshotIdPrefix();
  readonly #readHistoryState: () => unknown;
  readonly #readCurrentHref: () => string;
  readonly #pushHistoryState: (
    state: unknown,
    href: string,
    land?: RouterHistoryWriteLanding,
  ) => void;
  readonly #replaceHistoryState: (
    state: unknown,
    href?: string,
    land?: RouterHistoryWriteLanding,
  ) => void;
  readonly #readVisibleNavigationMetadata: () => VisibleNavigationMetadata | null;

  // Highest app-owned traversal index we know about (`#next`) versus the index
  // of the currently committed entry (`#current`). Traversing to a metadata-less
  // entry makes `#current` unknown (null), but the next app-owned push must
  // still continue from the highest known app history.
  #currentHistoryTraversalIndex: number | null;
  #nextHistoryTraversalIndex: number;
  #currentTreeSnapshotId: string | null = null;
  #nextTreeSnapshotId = 0;
  #treeSnapshotIdPendingFreshState: string | null = null;
  // Entries a raw push copied before their tree was remembered. The next
  // remembered tree is theirs too, so it is also stored at their indices.
  readonly #historyIndicesAwaitingTreeSnapshot = new Set<number>();
  // Whether a committed render (hydration, a navigation once its history write
  // has landed, or a traversal, snapshot restore or refresh commit) has yet to
  // remember its tree. Only then does an entry without a live tree await it.
  #treeSnapshotPending = true;
  // The entry a raw push made while that render was pending. If it is still
  // the current entry when the tree is remembered, it claims the tree, like a
  // raw push made on a settled page.
  #historyIndexAwaitingTreeClaim: number | null = null;

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
    const historyTreeSnapshotId = readHistoryStateTreeSnapshotId(this.#readHistoryState());
    this.#treeSnapshotIdPendingFreshState =
      historyTreeSnapshotId !== null && this.#treeSnapshots.has(historyTreeSnapshotId)
        ? historyTreeSnapshotId
        : null;
  }

  rememberHistoryStateSnapshot(state: AppRouterState): void {
    // An authoritative render completes the optimistic shell its navigation
    // committed first. In Next.js both share one tree whose data fills in, so
    // every entry that remembered the shell (including the shell's own entry
    // after a shallow history write moved on) must restore the full tree.
    const previousState = this.readCurrentTreeSnapshot();
    const previousOperation = previousState?.activeOperation;
    if (
      previousState &&
      previousOperation?.navigationCommitKind === "detached" &&
      state.activeOperation?.navigationCommitKind === "authoritative" &&
      state.activeOperation.navigationId === previousOperation.navigationId
    ) {
      this.#restorableClientState.replaceHistoryStateSnapshots(previousState, state);
    }
    // The snapshot cache evicts the oldest insertion first, so the older
    // entries awaiting this tree go in before the current one.
    for (const historyIndex of this.#historyIndicesAwaitingTreeSnapshot) {
      this.#restorableClientState.rememberHistoryStateSnapshot({ historyIndex, state });
    }
    this.#historyIndicesAwaitingTreeSnapshot.clear();
    this.#restorableClientState.rememberHistoryStateSnapshot({
      historyIndex: this.#currentHistoryTraversalIndex,
      state,
    });
    this.#treeSnapshotPending = false;
    const historyTreeSnapshotId = readHistoryStateTreeSnapshotId(this.#readHistoryState());
    // A refresh, revalidation, or HMR render updates the backing state for the
    // copied tree that was visible when client caches were invalidated. Reuse
    // that identity exactly once so every raw history entry that copied it sees
    // fresh server elements. Ordinary renders allocate a distinct identity;
    // otherwise same-index replace navigations could overwrite an older copied
    // tree that remains reachable in forward history.
    const updatesExistingTree =
      historyTreeSnapshotId !== null &&
      this.#treeSnapshots.has(historyTreeSnapshotId) &&
      (historyTreeSnapshotId === this.#treeSnapshotIdPendingFreshState ||
        this.#treeSnapshotClaimCounts.has(historyTreeSnapshotId));
    const treeSnapshotId = updatesExistingTree
      ? historyTreeSnapshotId
      : `${this.#treeSnapshotIdPrefix}:${this.#nextTreeSnapshotId++}`;
    this.#treeSnapshotIdPendingFreshState = null;
    const previousTreeSnapshotId = this.#currentTreeSnapshotId;
    this.#currentTreeSnapshotId = treeSnapshotId;
    this.#treeSnapshots.set(treeSnapshotId, state);
    const claimingHistoryIndex = this.#historyIndexAwaitingTreeClaim;
    this.#historyIndexAwaitingTreeClaim = null;
    const claimsTree =
      claimingHistoryIndex !== null &&
      claimingHistoryIndex === this.#currentHistoryTraversalIndex &&
      claimingHistoryIndex === readHistoryStateTraversalIndex(this.#readHistoryState());
    if (claimsTree) {
      this.#claimTreeSnapshotAtHistoryIndex(claimingHistoryIndex, treeSnapshotId);
    }
    if (
      previousTreeSnapshotId !== null &&
      previousTreeSnapshotId !== treeSnapshotId &&
      !this.#treeSnapshotClaimCounts.has(previousTreeSnapshotId)
    ) {
      this.#treeSnapshots.delete(previousTreeSnapshotId);
    }
    if (claimsTree) {
      this.#replaceHistoryState(
        createHistoryStateWithTreeSnapshotClaim(
          createHistoryStateWithTreeSnapshotId(this.#readHistoryState(), treeSnapshotId),
          true,
        ),
      );
    } else if (historyTreeSnapshotId !== treeSnapshotId) {
      this.#replaceHistoryState(
        createHistoryStateWithTreeSnapshotId(this.#readHistoryState(), treeSnapshotId),
      );
    }
  }

  /** The router state of the most recently committed render, if any. */
  readCurrentTreeSnapshot(): AppRouterState | null {
    if (this.#currentTreeSnapshotId === null) return null;
    return this.#treeSnapshots.get(this.#currentTreeSnapshotId) ?? null;
  }

  isCurrentExternalHistoryTree(historyState: unknown): boolean {
    const treeSnapshotId = readHistoryStateTreeSnapshotId(historyState);
    return treeSnapshotId !== null && treeSnapshotId === this.#currentTreeSnapshotId;
  }

  /** Records the raw/hash history entry that now claims the live tree. */
  claimCurrentHistoryTreeSnapshot(
    historyUpdateMode: HistoryUpdateMode,
    previousHistoryState: unknown,
  ): void {
    let historyState = this.#readHistoryState();
    const treeSnapshotId = readHistoryStateTreeSnapshotId(historyState);
    if (treeSnapshotId === null || !this.#treeSnapshots.has(treeSnapshotId)) {
      // With no live tree to claim (a push from a history wrapper right after
      // the router's push, from a layout effect before the root remembers the
      // tree, or from an entry whose tree was released), the pushed entry
      // still needs its own traversal index. While a render has yet to
      // remember its tree, both it and the entry it copied need that tree.
      if (historyUpdateMode === "push") {
        const previousHistoryIndex = readHistoryStateTraversalIndex(previousHistoryState);
        if (previousHistoryIndex !== null && this.#treeSnapshotPending) {
          this.#historyIndicesAwaitingTreeSnapshot.add(previousHistoryIndex);
        }
        // Like any push, this drops the forward entries' claims.
        this.#releaseForwardTreeSnapshotClaims();
        const historyIndex = this.#nextHistoryTraversalIndex + 1;
        this.#replaceHistoryState(
          createHistoryStateWithNavigationMetadata(historyState, {
            previousNextUrl: readHistoryStatePreviousNextUrl(historyState),
            traversalIndex: historyIndex,
          }),
        );
        this.commitHistoryTraversalIndex(historyIndex);
        this.#historyIndexAwaitingTreeClaim = this.#treeSnapshotPending ? historyIndex : null;
      }
      return;
    }

    let historyIndex: number | null;
    if (historyUpdateMode === "push") {
      this.#releaseForwardTreeSnapshotClaims();
      historyIndex = this.#nextHistoryTraversalIndex + 1;
    } else {
      historyIndex =
        readHistoryStateTraversalIndex(previousHistoryState) ?? this.#currentHistoryTraversalIndex;
    }
    if (historyIndex === null) return;

    historyState = createHistoryStateWithTreeSnapshotClaim(
      createHistoryStateWithNavigationMetadata(historyState, {
        previousNextUrl: readHistoryStatePreviousNextUrl(historyState),
        traversalIndex: historyIndex,
      }),
      true,
    );
    this.#replaceHistoryState(historyState);
    this.#claimTreeSnapshotAtHistoryIndex(historyIndex, treeSnapshotId);
    this.commitHistoryTraversalIndex(historyIndex);
  }

  /**
   * Applies only the claim cleanup caused by a successful raw History API write
   * whose caller state is already app-owned. The browser write intentionally
   * bypasses external-tree claiming (matching Next.js' `data?.__NA` path), but
   * it still overwrites or truncates entries that may own retained snapshots.
   * Every cleanup operation is idempotent so duplicate runtime delivery is safe.
   */
  commitAppOwnedHistoryStateWrite(
    historyUpdateMode: HistoryUpdateMode,
    previousHistoryState: unknown,
  ): void {
    if (historyUpdateMode === "push") {
      this.#releaseForwardTreeSnapshotClaims();
      return;
    }

    if (
      !isExternalHistoryState(previousHistoryState) &&
      !isHistoryStateTreeSnapshotClaimed(previousHistoryState)
    ) {
      return;
    }
    const previousHistoryIndex =
      readHistoryStateTraversalIndex(previousHistoryState) ?? this.#currentHistoryTraversalIndex;
    if (previousHistoryIndex !== null) {
      this.#releaseTreeSnapshotClaimAtHistoryIndex(previousHistoryIndex);
    }
  }

  #claimTreeSnapshotAtHistoryIndex(historyIndex: number, treeSnapshotId: string): void {
    const previousTreeSnapshotId = this.#treeSnapshotClaimByHistoryIndex.get(historyIndex);
    if (previousTreeSnapshotId === treeSnapshotId) return;
    if (previousTreeSnapshotId !== undefined) {
      this.#releaseTreeSnapshotClaim(previousTreeSnapshotId);
    }
    this.#treeSnapshotClaimByHistoryIndex.set(historyIndex, treeSnapshotId);
    this.#treeSnapshotClaimCounts.set(
      treeSnapshotId,
      (this.#treeSnapshotClaimCounts.get(treeSnapshotId) ?? 0) + 1,
    );
  }

  #releaseTreeSnapshotClaimAtHistoryIndex(historyIndex: number): void {
    const treeSnapshotId = this.#treeSnapshotClaimByHistoryIndex.get(historyIndex);
    if (treeSnapshotId === undefined) return;
    this.#treeSnapshotClaimByHistoryIndex.delete(historyIndex);
    this.#releaseTreeSnapshotClaim(treeSnapshotId);
  }

  #releaseForwardTreeSnapshotClaims(): void {
    const currentHistoryIndex = this.#currentHistoryTraversalIndex;
    if (currentHistoryIndex === null) return;
    for (const historyIndex of this.#treeSnapshotClaimByHistoryIndex.keys()) {
      if (historyIndex > currentHistoryIndex) {
        this.#releaseTreeSnapshotClaimAtHistoryIndex(historyIndex);
      }
    }
  }

  #releaseTreeSnapshotClaim(treeSnapshotId: string): void {
    const claimCount = this.#treeSnapshotClaimCounts.get(treeSnapshotId);
    if (claimCount === undefined) return;
    if (claimCount > 1) {
      this.#treeSnapshotClaimCounts.set(treeSnapshotId, claimCount - 1);
      return;
    }
    this.#treeSnapshotClaimCounts.delete(treeSnapshotId);
    if (treeSnapshotId !== this.#currentTreeSnapshotId) {
      this.#treeSnapshots.delete(treeSnapshotId);
    }
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
    const activeRoutePaths = visible
      ? visible.activeRoutePaths
      : readHistoryStateActiveRoutePaths(historyState);
    const nextHistoryState = createHistoryStateWithTreeSnapshotClaim(
      createHistoryStateWithNavigationMetadata(
        this.#createHashOnlyNavigationBaseHistoryState(historyUpdateMode, scroll),
        {
          activeRoutePaths,
          bfcacheIds,
          bfcacheVersion:
            bfcacheIds === null ? undefined : this.#restorableClientState.currentBfcacheVersion,
          previousNextUrl,
          traversalIndex: navigationHistoryIndex,
        },
      ),
      true,
    );

    const historyIndex = this.#writeNavigationHistoryState(
      historyUpdateMode,
      nextHistoryState,
      href,
      navigationHistoryIndex,
      false,
    );
    const treeSnapshotId = readHistoryStateTreeSnapshotId(nextHistoryState);
    if (historyIndex !== null && treeSnapshotId !== null) {
      this.#claimTreeSnapshotAtHistoryIndex(historyIndex, treeSnapshotId);
    }
  }

  /**
   * Writes an app-owned push or replace entry and returns the traversal index
   * it landed at. A history wrapper installed after boot can make its own
   * writes before forwarding this one. When those moved the indices, the index
   * is assigned as the write lands: a push goes after them, and a replace takes
   * the index of the entry it actually overwrites. The index is committed as
   * soon as the write succeeds, so a push the wrapper makes after forwarding
   * goes after it.
   */
  #writeNavigationHistoryState(
    historyUpdateMode: HistoryUpdateMode,
    state: unknown,
    href: string,
    allocatedIndex: number | null,
    // Set for navigation commits, whose render remembers a tree next.
    rendersTree: boolean,
  ): number | null {
    const allocatedCurrentIndex = this.#currentHistoryTraversalIndex;
    const allocatedNextIndex = this.#nextHistoryTraversalIndex;
    const releaseClaims = (overwrittenHistoryState: unknown): void => {
      if (historyUpdateMode === "push") {
        this.#releaseForwardTreeSnapshotClaims();
        return;
      }
      if (!rendersTree) return;
      const overwrittenIndex =
        readHistoryStateTraversalIndex(overwrittenHistoryState) ??
        this.#currentHistoryTraversalIndex;
      if (overwrittenIndex !== null) {
        this.#releaseTreeSnapshotClaimAtHistoryIndex(overwrittenIndex);
      }
    };

    let landedIndex: number | null | undefined;
    let landingStarted = false;
    const land: RouterHistoryWriteLanding = (data) => {
      landingStarted = true;
      const indicesMoved =
        this.#currentHistoryTraversalIndex !== allocatedCurrentIndex ||
        this.#nextHistoryTraversalIndex !== allocatedNextIndex;
      const index = indicesMoved
        ? this.allocateNavigationHistoryTraversalIndex(historyUpdateMode)
        : allocatedIndex;
      const overwrittenHistoryState = this.#readHistoryState();
      return {
        data:
          index === allocatedIndex
            ? data
            : createHistoryStateWithNavigationMetadata(data, {
                previousNextUrl: readHistoryStatePreviousNextUrl(data),
                traversalIndex: index,
              }),
        // Runs only once the browser accepted the write, so a write that
        // throws keeps every claim.
        commit: () => {
          releaseClaims(overwrittenHistoryState);
          // A wrapper's push after this write copies this entry, which then
          // awaits the tree this navigation renders; a push before it does not.
          if (rendersTree) this.#treeSnapshotPending = true;
          landedIndex = index;
          this.commitHistoryTraversalIndex(index);
        },
      };
    };

    const historyStateBeforeWrite = this.#readHistoryState();
    if (historyUpdateMode === "push") {
      this.#pushHistoryState(state, href, land);
    } else {
      this.#replaceHistoryState(state, href, land);
    }
    if (landedIndex !== undefined) return landedIndex;
    // The browser rejected the forwarded write and a wrapper caught the error
    // without a retry that landed.
    if (landingStarted) return null;

    // The write never reached the patched History API method (a wrapper wrote
    // different data, or called the browser's method itself), so it landed
    // with the allocated index. Writes the wrapper made before or after
    // forwarding can share this index.
    releaseClaims(historyStateBeforeWrite);
    if (rendersTree) this.#treeSnapshotPending = true;
    this.commitHistoryTraversalIndex(allocatedIndex);
    return allocatedIndex;
  }

  #createHashOnlyNavigationBaseHistoryState(
    historyUpdateMode: HistoryUpdateMode,
    scroll: boolean,
  ): unknown {
    const historyState = this.#readHistoryState();
    if (historyUpdateMode !== "replace") {
      const treeState = createHistoryStateWithTreeSnapshotId(
        null,
        readHistoryStateTreeSnapshotId(historyState),
      );
      return isExternalHistoryState(historyState)
        ? createExternalHistoryStatePreservingMetadata(treeState, historyState)
        : treeState;
    }
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
    const currentHistoryState = this.#readHistoryState();
    const origin = new URL(currentHref).origin;
    const targetHref = new URL(options.href, origin).href;
    const preserveExistingState = options.historyUpdateMode === "replace";
    const replacesClaimedOrExternalTree =
      preserveExistingState &&
      (isExternalHistoryState(currentHistoryState) ||
        isHistoryStateTreeSnapshotClaimed(currentHistoryState));
    const navigationHistoryIndex =
      options.targetHistoryIndex !== undefined
        ? options.targetHistoryIndex
        : this.allocateNavigationHistoryTraversalIndex(options.historyUpdateMode);
    const historyState = clearHistoryStateTreeSnapshotId(
      createAppOwnedHistoryState(
        createHistoryStateWithNavigationMetadata(
          preserveExistingState ? currentHistoryState : null,
          {
            activeRoutePaths: options.activeRoutePaths,
            bfcacheIds: options.bfcacheIds,
            bfcacheVersion: this.#restorableClientState.currentBfcacheVersion,
            previousNextUrl: options.previousNextUrl,
            traversalIndex: navigationHistoryIndex,
          },
        ),
      ),
    );

    let wroteHistoryState = false;
    if (
      options.historyUpdateMode === "replace" &&
      (currentHref !== targetHref || replacesClaimedOrExternalTree)
    ) {
      options.stageClientParams();
      this.#writeNavigationHistoryState(
        "replace",
        historyState,
        options.href,
        navigationHistoryIndex,
        true,
      );
      wroteHistoryState = true;
    } else if (options.historyUpdateMode === "push" && currentHref !== targetHref) {
      options.stageClientParams();
      this.#writeNavigationHistoryState(
        "push",
        historyState,
        options.href,
        navigationHistoryIndex,
        true,
      );
      wroteHistoryState = true;
    }

    if (!wroteHistoryState) {
      this.#treeSnapshotPending = true;
      // Traversal and refresh commits may keep the URL unchanged, but still
      // persist the latest bfcache id map for future history restoration.
      this.syncCurrentHistoryStatePreviousNextUrl(
        options.previousNextUrl,
        options.bfcacheIds,
        options.activeRoutePaths,
      );
      options.stageClientParams();
      if (options.targetHistoryIndex !== undefined) {
        this.commitHistoryTraversalIndex(options.targetHistoryIndex);
      }
    }
  }

  syncCurrentHistoryStatePreviousNextUrl(
    previousNextUrl: string | null,
    bfcacheIds?: BfcacheIdMap | null,
    activeRoutePaths?: readonly string[] | null,
  ): void {
    if (
      this.#isHistoryStateNavigationMetadataInSync(
        this.#readHistoryState(),
        previousNextUrl,
        bfcacheIds,
        activeRoutePaths,
      )
    ) {
      return;
    }

    const nextHistoryState = createHistoryStateWithNavigationMetadata(this.#readHistoryState(), {
      activeRoutePaths,
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
    // Do not pass the current URL for a state-only update. Chromium keeps
    // userinfo in document.URL while stripping it from location.href; passing
    // that credential-free absolute URL would make replaceState reject the
    // otherwise valid metadata write with SecurityError (#2614).
    this.#replaceHistoryState(nextHistoryState);
    if (
      this.#isHistoryStateNavigationMetadataInSync(
        this.#readHistoryState(),
        previousNextUrl,
        bfcacheIds,
        activeRoutePaths,
      )
    ) {
      return;
    }
    this.#replaceHistoryState(nextHistoryState);
  }

  #isHistoryStateNavigationMetadataInSync(
    state: unknown,
    previousNextUrl: string | null,
    bfcacheIds?: BfcacheIdMap | null,
    activeRoutePaths?: readonly string[] | null,
  ): boolean {
    return (
      readHistoryStatePreviousNextUrl(state) === previousNextUrl &&
      (activeRoutePaths === undefined ||
        areStringArraysEqual(readHistoryStateActiveRoutePaths(state), activeRoutePaths)) &&
      (bfcacheIds === undefined ||
        (areBfcacheIdMapsEqual(readHistoryStateBfcacheIds(state), bfcacheIds) &&
          this.#restorableClientState.isCurrentBfcacheVersion(state)))
    );
  }

  /** Initial history write performed before hydration starts. */
  writeBootstrapHistoryMetadata(): void {
    this.#replaceHistoryState(
      clearHistoryStateTreeSnapshotId(
        createAppOwnedHistoryState(
          createHistoryStateWithNavigationMetadata(this.#readHistoryState(), {
            previousNextUrl: null,
            traversalIndex: this.#currentHistoryTraversalIndex,
          }),
        ),
      ),
      createCanonicalBrowserHistoryHref(this.#readCurrentHref()),
    );
  }

  /** History write performed on the first committed (hydrated) render. */
  writeHydratedHistoryMetadata(options: {
    activeRoutePaths: readonly string[];
    bfcacheIds: BfcacheIdMap;
    previousNextUrl: string | null;
  }): void {
    this.#replaceHistoryState(
      createAppOwnedHistoryState(
        createHistoryStateWithNavigationMetadata(this.#readHistoryState(), {
          activeRoutePaths: options.activeRoutePaths,
          bfcacheIds: options.bfcacheIds,
          bfcacheVersion: this.#restorableClientState.currentBfcacheVersion,
          previousNextUrl: options.previousNextUrl,
          traversalIndex: this.#currentHistoryTraversalIndex,
        }),
      ),
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
    const restoreTreeSnapshot = (): boolean => {
      const treeSnapshotId = readHistoryStateTreeSnapshotId(options.historyState);
      const state = treeSnapshotId === null ? undefined : this.#treeSnapshots.get(treeSnapshotId);
      if (!state) return false;

      return options.approveVisibleRestore({
        state,
        beforeCommit: () => {
          this.commitTraversalIndexFromHistoryState(options.historyState);
          this.#treeSnapshotPending = true;
          options.stageClientParams(state.navigationSnapshot.params);
        },
      });
    };

    if (options.preferExternalSnapshot) {
      return restoreTreeSnapshot();
    }

    const decision = this.#restorableClientState.resolveHistoryStateSnapshotRestore(
      options.historyState,
    );
    if (decision.kind === "skip") {
      return restoreTreeSnapshot();
    }

    return options.approveVisibleRestore({
      state: decision.state,
      beforeCommit: () => {
        this.commitHistoryTraversalIndex(decision.targetHistoryIndex);
        this.#treeSnapshotPending = true;
        options.stageClientParams(decision.state.navigationSnapshot.params);
      },
    });
  }
}

function createDocumentTreeSnapshotIdPrefix(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function areStringArraysEqual(a: readonly string[] | null, b: readonly string[] | null): boolean {
  if (a === b) return true;
  if (a === null || b === null || a.length !== b.length) return false;
  return a.every((value, index) => b[index] === value);
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
