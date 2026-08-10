import {
  startTransition,
  useInsertionEffect,
  useLayoutEffect,
  type Dispatch,
  type ReactNode,
} from "react";
import { flushSync } from "react-dom";
import {
  activateNavigationSnapshot,
  clearPendingPathname,
  commitClientNavigationState,
  createSnapshotPathAndSearch,
  type ClientNavigationRenderSnapshot,
} from "vinext/shims/navigation";
import {
  claimAppRouterScrollIntentForCommit,
  consumeAppRouterScrollIntent,
  type AppRouterScrollIntent,
} from "vinext/shims/app-router-scroll-state";
import type { RouteManifest } from "../routing/app-route-graph.js";
import { stripBasePath } from "../utils/base-path.js";
import {
  FRESH_APP_NAVIGATION_PAYLOAD_ORIGIN,
  createPendingNavigationCommit,
  createPendingNavigationCommitFromElements,
  type AppNavigationPayloadOrigin,
  type AppRouterState,
  type OperationLane,
  type PendingNavigationCommit,
  type PendingOperationRecord,
} from "./app-browser-state.js";
import {
  applyApprovedVisibleCommit,
  approveHmrVisibleCommit,
  approvePendingNavigationCommit,
  resolveAndClassifyNavigationCommit,
  type ApprovedVisibleCommit,
} from "./app-browser-visible-commit.js";
import {
  resolveServerActionOperationLane,
  shouldScheduleRefreshForDiscardedServerAction,
  type ServerActionRevalidationKind,
} from "./app-browser-action-result.js";
import type { AppElements } from "./app-elements.js";
import type { NavigationRuntimeVisibleCommitMode } from "../client/navigation-runtime.js";
import {
  clearAppNavigationFailureTarget,
  getAppNavigationFailureTarget,
} from "../client/app-nav-failure-handler.js";

export type HistoryUpdateMode = "push" | "replace";

export type PendingBrowserRouterState = {
  promise: Promise<AppRouterState>;
  resolve: (state: AppRouterState) => void;
  settled: boolean;
};
export type NavigationPayloadOutcome = "committed" | "no-commit" | "hard-navigate";
type HardNavigationMode = "assign" | "replace";

type BrowserNavigationCommitEffect = () => void;

type BrowserNavigationCommitEffectFactory = (options: {
  bfcacheIds: Readonly<Record<string, string>>;
  href: string;
  historyUpdateMode: HistoryUpdateMode | undefined;
  navId: number;
  params: Record<string, string | string[]>;
  previousNextUrl: string | null;
  targetHistoryIndex?: number | null;
}) => BrowserNavigationCommitEffect;

type BrowserRouterStateRef = {
  current: AppRouterState;
};

type SameUrlServerActionLifecycleOptions = {
  onDiscardedRevalidation?: () => void;
  revalidation?: ServerActionRevalidationKind;
  startedNavigationId?: number;
  targetHref?: string;
};

type BrowserNavigationControllerDeps = {
  basePath?: string;
  commitClientNavigationState?: typeof commitClientNavigationState;
  performHardNavigation?: (href: string, mode?: HardNavigationMode) => boolean;
  getRouteManifest?: () => RouteManifest | null;
  syncHistoryStatePreviousNextUrl?: (
    previousNextUrl: string | null,
    bfcacheIds?: Readonly<Record<string, string>> | null,
  ) => void;
};

type BrowserNavigationPayloadOptions = {
  actionType: "navigate" | "replace" | "traverse";
  createNavigationCommitEffect: BrowserNavigationCommitEffectFactory;
  historyUpdateMode: HistoryUpdateMode | undefined;
  navigationCommitKind?: "authoritative" | "detached";
  navigationInitiationState: AppRouterState;
  navigationSnapshot: ClientNavigationRenderSnapshot;
  navId: number;
  nextElements: Promise<AppElements> | AppElements;
  onCommittedState?: (state: AppRouterState) => void;
  operationLane: OperationLane;
  params: Record<string, string | string[]>;
  payloadOrigin: AppNavigationPayloadOrigin;
  pendingRouterState: PendingBrowserRouterState | null;
  previousNextUrl: string | null;
  restoredBfcacheIds?: Readonly<Record<string, string>> | null;
  reuseCurrentBfcacheIds?: boolean;
  scrollIntent?: AppRouterScrollIntent | null;
  targetHistoryIndex?: number | null;
  targetHref: string;
  visibleCommitMode?: NavigationRuntimeVisibleCommitMode;
};

type BrowserNavigationController = {
  beginNavigation(): number;
  getActiveNavigationId(): number;
  hasBrowserRouterState(): boolean;
  getBrowserRouterState(): AppRouterState;
  isCurrentNavigation(navId: number): boolean;
  performHardNavigation(href: string, mode?: HardNavigationMode): boolean;
  waitForBrowserRouterStateReady(): Promise<void>;
  attachBrowserRouterState(
    setter: Dispatch<AppRouterState | Promise<AppRouterState>>,
    stateRef: BrowserRouterStateRef,
  ): () => void;
  beginPendingBrowserRouterState(): PendingBrowserRouterState;
  finalizeNavigation(navId: number, pending: PendingBrowserRouterState | null | undefined): void;
  restoreHistorySnapshotVisibleState(options: {
    beforeCommit?: () => void;
    navId: number;
    state: AppRouterState;
    targetHref: string;
  }): boolean;
  renderNavigationPayload(
    options: BrowserNavigationPayloadOptions,
  ): Promise<NavigationPayloadOutcome>;
  commitSameUrlNavigatePayload(
    nextElements: Promise<AppElements>,
    navigationSnapshot: ClientNavigationRenderSnapshot,
    returnValue?: { ok: boolean; data: unknown },
    actionInitiationState?: AppRouterState,
    lifecycleOptions?: SameUrlServerActionLifecycleOptions,
  ): Promise<unknown>;
  hmrReplaceTree(
    nextElements: Promise<AppElements>,
    navigationSnapshot: ClientNavigationRenderSnapshot,
  ): Promise<void>;
  /**
   * Force-drain the queued pre-paint effect for the given renderId without
   * waiting for NavigationCommitSignal to commit. Used by the dev recovery
   * boundary in app-browser-entry.ts: when a render error replaces
   * NavigationCommitSignal with the boundary's null fallback, its
   * useLayoutEffect never fires, so the URL update for the in-flight
   * navigation would otherwise be lost.
   */
  drainPrePaintEffects(renderId: number): void;
  clearCommittedNavigationFailureTargets(renderId: number): void;
  NavigationCommitSignal(
    this: void,
    {
      renderId,
      children,
    }: {
      renderId: number;
      children?: ReactNode;
    },
  ): ReactNode;
};

const HARD_NAVIGATION_LOOP_GUARD_KEY = "__vinext_hard_navigation_target__";

function normalizeBrowserHref(href: string): string {
  try {
    return new URL(href, window.location.href).href;
  } catch {
    return href;
  }
}

function readHardNavigationLoopGuard(): string | null {
  try {
    return window.sessionStorage.getItem(HARD_NAVIGATION_LOOP_GUARD_KEY);
  } catch {
    return null;
  }
}

function writeHardNavigationLoopGuard(targetHref: string): boolean {
  try {
    window.sessionStorage.setItem(HARD_NAVIGATION_LOOP_GUARD_KEY, targetHref);
    return window.sessionStorage.getItem(HARD_NAVIGATION_LOOP_GUARD_KEY) === targetHref;
  } catch {
    return false;
  }
}

export function clearHardNavigationLoopGuard(): void {
  try {
    window.sessionStorage.removeItem(HARD_NAVIGATION_LOOP_GUARD_KEY);
  } catch {}
}

function performHardNavigationWithLoopGuard(
  href: string,
  mode: HardNavigationMode = "assign",
): boolean {
  const targetHref = normalizeBrowserHref(href);
  const currentHref = normalizeBrowserHref(window.location.href);

  if (readHardNavigationLoopGuard() === targetHref && currentHref === targetHref) {
    clearHardNavigationLoopGuard();
    console.error(
      `[vinext] Prevented repeated hard navigation to ${targetHref}; ` +
        "leaving the current document in place to avoid a reload loop.",
    );
    return false;
  }

  const guardPersisted = writeHardNavigationLoopGuard(targetHref);
  if (!guardPersisted && currentHref === targetHref) {
    console.error(
      `[vinext] Hard navigation to ${targetHref} requires a reload-loop guard, ` +
        "but sessionStorage is unavailable; leaving the current document in place.",
    );
    return false;
  }
  // If storage is unavailable but the target is a different URL, the browser
  // can still make forward progress. Only same-target reloads need a persisted
  // guard because they can re-enter this exact recovery path indefinitely.

  if (mode === "replace") {
    window.location.replace(href);
  } else {
    window.location.assign(href);
  }
  return true;
}

export { createSnapshotPathAndSearch };

export function createBasePathStrippedPathAndSearch(url: URL, basePath: string): string {
  const pathname = stripBasePath(url.pathname, basePath);
  const query = new URLSearchParams(url.search).toString();
  return query === "" ? pathname : `${pathname}?${query}`;
}

function isSnapshotTargetHref(
  basePath: string,
  snapshot: ClientNavigationRenderSnapshot,
  targetHref: string,
): boolean {
  try {
    const baseHref = typeof window === "undefined" ? "http://localhost" : window.location.href;
    const targetUrl = new URL(targetHref, baseHref);
    return (
      createBasePathStrippedPathAndSearch(targetUrl, basePath) ===
      createSnapshotPathAndSearch(snapshot)
    );
  } catch {
    return false;
  }
}

export function createAppBrowserNavigationController(
  deps: BrowserNavigationControllerDeps = {},
): BrowserNavigationController {
  const basePath = deps.basePath ?? "";
  const commitClientNavigationStateImpl =
    deps.commitClientNavigationState ?? commitClientNavigationState;
  const performHardNavigation = deps.performHardNavigation ?? performHardNavigationWithLoopGuard;
  const getRouteManifest = deps.getRouteManifest ?? (() => null);
  const syncHistoryStatePreviousNextUrl = deps.syncHistoryStatePreviousNextUrl ?? (() => {});

  // These are plain module-level variables (inside the controller closure),
  // unlike ClientNavigationState which uses Symbol.for to survive multiple
  // Vite module instances. The browser entry is loaded exactly once (via the
  // RSC plugin's generated bootstrap), so the controller running in a single
  // module instance is safe. If that assumption ever changes, these should be
  // migrated to a Symbol.for-backed global.
  //
  // The most severe consequence of multiple instances would be Map fragmentation:
  // pendingNavigationCommits and pendingNavigationPrePaintEffects would split
  // across instances, so drainPrePaintEffects in one instance could never drain
  // effects queued by the other, permanently leaking navigationSnapshotActiveCount
  // and causing hooks to prefer stale snapshot values indefinitely.
  let nextNavigationRenderId = 0;
  let activeNavigationId = 0;
  let pendingUserNavigationId: number | null = null;
  let pendingUserNavigationLane: OperationLane | null = null;
  let latestHmrUpdateId = 0;
  const pendingNavigationCommits = new Map<
    number,
    {
      committedState: AppRouterState | null;
      onCommittedState?: (state: AppRouterState) => void;
      resolve: (committed: boolean) => void;
    }
  >();
  const pendingNavigationFailureTargets = new Map<number, URL>();
  const pendingNavigationPrePaintEffects = new Map<number, BrowserNavigationCommitEffect>();

  let setBrowserRouterState: Dispatch<AppRouterState | Promise<AppRouterState>> | null = null;
  let browserRouterStateRef: BrowserRouterStateRef | null = null;
  let activePendingBrowserRouterState: PendingBrowserRouterState | null = null;
  let resolveBrowserRouterStateReady: (() => void) | null = null;
  let browserRouterStateReadyPromise: Promise<void> | null = null;
  let browserRouterStateHasCommitted = false;

  function getBrowserRouterStateSetter(): Dispatch<AppRouterState | Promise<AppRouterState>> {
    if (!setBrowserRouterState) {
      throw new Error("[vinext] Browser router state setter is not initialized");
    }
    return setBrowserRouterState;
  }

  function getBrowserRouterState(): AppRouterState {
    if (!browserRouterStateRef) {
      throw new Error("[vinext] Browser router state is not initialized");
    }
    return browserRouterStateRef.current;
  }

  function waitForBrowserRouterStateReady(): Promise<void> {
    if (browserRouterStateRef || browserRouterStateHasCommitted) {
      return Promise.resolve();
    }

    if (!browserRouterStateReadyPromise) {
      browserRouterStateReadyPromise = new Promise((resolve) => {
        resolveBrowserRouterStateReady = resolve;
      });
    }

    return browserRouterStateReadyPromise;
  }

  function markBrowserRouterStateReady(): void {
    browserRouterStateHasCommitted = true;
    const resolveReady = resolveBrowserRouterStateReady;
    resolveBrowserRouterStateReady = null;
    browserRouterStateReadyPromise = null;
    resolveReady?.();
  }

  function beginNavigation(): number {
    // User navigation owns the next visible result. Revoke any HMR payload
    // already suspended on RSC resolution so it cannot commit first and make
    // the still-current navigation look stale by advancing visible state.
    latestHmrUpdateId += 1;
    activeNavigationId += 1;
    pendingUserNavigationId = activeNavigationId;
    pendingUserNavigationLane = null;
    return activeNavigationId;
  }

  function getActiveNavigationId(): number {
    return activeNavigationId;
  }

  function allocateRenderId(): number {
    nextNavigationRenderId += 1;
    return nextNavigationRenderId;
  }

  function hasBrowserRouterState(): boolean {
    return browserRouterStateRef !== null;
  }

  function isCurrentNavigation(navId: number): boolean {
    return navId === activeNavigationId;
  }

  function beginPendingBrowserRouterState(): PendingBrowserRouterState {
    const setter = getBrowserRouterStateSetter();

    if (activePendingBrowserRouterState && !activePendingBrowserRouterState.settled) {
      activePendingBrowserRouterState.settled = true;
      activePendingBrowserRouterState.resolve(getBrowserRouterState());
    }

    let resolvePending: ((state: AppRouterState) => void) | undefined;
    const promise = new Promise<AppRouterState>((resolve) => {
      resolvePending = resolve;
    });

    if (!resolvePending) {
      throw new Error("[vinext] Failed to initialize browser router promise");
    }

    const pending: PendingBrowserRouterState = {
      promise,
      resolve: resolvePending,
      settled: false,
    };

    activePendingBrowserRouterState = pending;
    setter(promise);

    return pending;
  }

  function settlePendingBrowserRouterState(
    pending: PendingBrowserRouterState | null | undefined,
  ): void {
    if (!pending || pending.settled) return;

    pending.settled = true;
    pending.resolve(getBrowserRouterState());

    if (activePendingBrowserRouterState === pending) {
      activePendingBrowserRouterState = null;
    }
  }

  function finalizeNavigation(
    navId: number,
    pending: PendingBrowserRouterState | null | undefined,
  ): void {
    settlePendingBrowserRouterState(pending);

    if (isCurrentNavigation(navId)) {
      pendingUserNavigationId = null;
      pendingUserNavigationLane = null;
      clearPendingPathname(navId);
    }
  }

  function queuePrePaintNavigationEffect(renderId: number, effect: (() => void) | null): void {
    if (!effect) {
      return;
    }
    pendingNavigationPrePaintEffects.set(renderId, effect);
  }

  /**
   * Run all queued pre-paint effects for renderIds up to and including the
   * given renderId. When React supersedes a startTransition update (rapid
   * clicks on same-route links), the superseded NavigationCommitSignal never
   * mounts, so its pre-paint effect never fires. By draining all effects
   * <= the committed renderId here, the winning transition cleans up after
   * any superseded ones, keeping the counter balanced.
   *
   * Invariant: each superseded navigation gets a commitClientNavigationState()
   * to balance the activateNavigationSnapshot() from its renderNavigationPayload call.
   */
  function drainPrePaintEffects(upToRenderId: number): void {
    for (const [id, effect] of pendingNavigationPrePaintEffects) {
      if (id > upToRenderId) {
        continue;
      }

      pendingNavigationPrePaintEffects.delete(id);
      if (id === upToRenderId) {
        effect();
      } else {
        // Superseded navigations still need to balance the snapshot counter.
        commitClientNavigationStateImpl(undefined, { releaseSnapshot: true });
      }
    }
  }

  /**
   * Settle all pending navigation renders through the supplied renderId. Only
   * the exact render whose layout effect ran is a successful commit; older
   * superseded renders and cleanup-only settlements resolve as no-commit.
   */
  function settleNavigationCommits(renderId: number, committed: boolean): void {
    for (const [pendingId, pendingCommit] of pendingNavigationCommits) {
      if (pendingId > renderId) {
        continue;
      }

      pendingNavigationCommits.delete(pendingId);
      const didCommit = committed && pendingId === renderId;
      if (didCommit && pendingCommit.committedState !== null) {
        pendingCommit.onCommittedState?.(pendingCommit.committedState);
      }
      pendingCommit.resolve(didCommit);
    }
  }

  function clearCommittedNavigationFailureTargets(renderId: number): void {
    for (const [pendingId, targetHref] of pendingNavigationFailureTargets) {
      if (pendingId > renderId) {
        continue;
      }

      pendingNavigationFailureTargets.delete(pendingId);
      clearAppNavigationFailureTarget(targetHref);
    }
  }

  async function hmrReplaceTree(
    nextElements: Promise<AppElements>,
    navigationSnapshot: ClientNavigationRenderSnapshot,
  ): Promise<void> {
    const hmrUpdateId = ++latestHmrUpdateId;
    const startedDuringUserNavigation = pendingUserNavigationLane === "navigation";
    if (!hasBrowserRouterState()) return;

    const currentState = getBrowserRouterState();
    const renderId = allocateRenderId();
    const pending = await createPendingNavigationCommit({
      currentState,
      nextElements,
      navigationSnapshot,
      operationLane: "hmr",
      payloadOrigin: FRESH_APP_NAVIGATION_PAYLOAD_ORIGIN,
      renderId,
      type: "replace",
    });

    if (hmrUpdateId !== latestHmrUpdateId || startedDuringUserNavigation) return;

    // createPendingNavigationCommit awaits the new RSC payload. While
    // suspended, the prior broken render can unmount BrowserRoot. Re-check
    // before dispatching so a racing unmount doesn't surface as an
    // initialized-setter error.
    if (!hasBrowserRouterState()) return;

    const approval = approveHmrVisibleCommit({
      currentState: getBrowserRouterState(),
      pending,
      routeManifest: deps.getRouteManifest?.() ?? null,
      targetHref: createSnapshotPathAndSearch(navigationSnapshot),
    });
    if (approval.approvedCommit) {
      dispatchSynchronousVisibleCommit(approval.approvedCommit);
    } else if (approval.decision.disposition === "hard-navigate") {
      performHardNavigation(createSnapshotPathAndSearch(navigationSnapshot));
    }
  }

  function NavigationCommitSignal(
    this: void,
    {
      renderId,
      children,
    }: {
      renderId: number;
      children?: ReactNode;
    },
  ): ReactNode {
    useInsertionEffect(() => {
      clearCommittedNavigationFailureTargets(renderId);
    }, [renderId]);

    useLayoutEffect(() => {
      drainPrePaintEffects(renderId);
      settleNavigationCommits(renderId, true);

      return () => {
        // Settle pending renders without publishing their candidate state when
        // React unmounts this component before its layout effect commits (for
        // example, when an error boundary replaces the navigation subtree).
        settleNavigationCommits(renderId, false);
      };
    }, [renderId]);

    return children;
  }

  function dispatchApprovedVisibleCommit(
    renderId: number,
    commit: ApprovedVisibleCommit,
    pendingRouterState: PendingBrowserRouterState | null,
    visibleCommitMode: NavigationRuntimeVisibleCommitMode,
  ): void {
    const setter = getBrowserRouterStateSetter();
    const pendingCommit = pendingNavigationCommits.get(renderId);

    const captureCandidateState = (state: AppRouterState): AppRouterState => {
      if (pendingCommit) {
        pendingCommit.committedState = state;
      }
      return state;
    };

    if (pendingRouterState) {
      // Programmatic navigation already runs inside React.startTransition, so
      // resolving the deferred promise is normally sufficient. A same-path
      // search+hash response whose visible tree is unchanged can be retained by
      // React without mounting the new NavigationCommitSignal, though. In that
      // narrow synchronous mode, publish the resolved state directly as well;
      // the signal's layout effect remains the authority for URL and scroll
      // effects, including when the response suspends or changes the tree.
      if (pendingRouterState.settled) return;
      const committedState = captureCandidateState(
        applyApprovedVisibleCommit(getBrowserRouterState(), commit),
      );
      pendingRouterState.settled = true;
      pendingRouterState.resolve(committedState);
      if (activePendingBrowserRouterState === pendingRouterState) {
        activePendingBrowserRouterState = null;
      }
      if (visibleCommitMode === "synchronous") {
        flushSync(() => {
          setter(committedState);
        });
      }
      return;
    }

    // This is intentionally distinct from dispatchSynchronousVisibleCommit
    // below: that path's callers (HMR, history traversal) already run inside a
    // synchronous event-handler/effect context where React flushes the plain
    // setter itself, whereas the gesture commit fires after an `await` inside a
    // held async transition and must be forced out with flushSync. Don't
    // consolidate the two.
    if (visibleCommitMode === "synchronous") {
      flushSync(() => {
        const committedState = captureCandidateState(
          applyApprovedVisibleCommit(getBrowserRouterState(), commit),
        );
        setter(committedState);
      });
      return;
    }

    startTransition(() => {
      const committedState = captureCandidateState(
        applyApprovedVisibleCommit(getBrowserRouterState(), commit),
      );
      setter(committedState);
    });
  }

  function dispatchSynchronousVisibleCommit(commit: ApprovedVisibleCommit): void {
    const setter = getBrowserRouterStateSetter();
    setter(applyApprovedVisibleCommit(getBrowserRouterState(), commit));
  }

  function createRestoredHistorySnapshotCommit(options: {
    currentState: AppRouterState;
    renderId: number;
    restoredState: AppRouterState;
  }): PendingNavigationCommit {
    const operation: PendingOperationRecord = {
      id: options.renderId,
      lane: "traverse",
      startedVisibleCommitVersion: options.currentState.visibleCommitVersion,
      state: "pending",
    };

    return {
      action: {
        bfcacheIds: options.restoredState.bfcacheIds,
        elements: options.restoredState.elements,
        interception: options.restoredState.interception,
        interceptionContext: options.restoredState.interceptionContext,
        layoutFlags: options.restoredState.layoutFlags,
        layoutIds: options.restoredState.layoutIds,
        navigationSnapshot: options.restoredState.navigationSnapshot,
        operation,
        previousNextUrl: options.restoredState.previousNextUrl,
        renderId: options.renderId,
        rootLayoutTreePath: options.restoredState.rootLayoutTreePath,
        reuseCurrentBfcacheIds: false,
        routeId: options.restoredState.routeId,
        skippedLayoutIds: [],
        slotBindings: options.restoredState.slotBindings,
        type: "traverse",
      },
      interception: options.restoredState.interception,
      interceptionContext: options.restoredState.interceptionContext,
      previousNextUrl: options.restoredState.previousNextUrl,
      rootLayoutTreePath: options.restoredState.rootLayoutTreePath,
      routeId: options.restoredState.routeId,
      restoredHistorySnapshot: true,
      skippedLayoutIds: [],
    };
  }

  function restoreHistorySnapshotVisibleState(options: {
    beforeCommit?: () => void;
    navId: number;
    state: AppRouterState;
    targetHref: string;
  }): boolean {
    if (!isSnapshotTargetHref(basePath, options.state.navigationSnapshot, options.targetHref)) {
      return false;
    }

    const currentState = getBrowserRouterState();
    const pending = createRestoredHistorySnapshotCommit({
      currentState,
      renderId: allocateRenderId(),
      restoredState: options.state,
    });
    const approval = approvePendingNavigationCommit({
      activeNavigationId,
      currentState,
      pending,
      routeManifest: getRouteManifest(),
      startedNavigationId: options.navId,
      targetHref: options.targetHref,
    });

    if (approval.approvedCommit === null) {
      return false;
    }

    options.beforeCommit?.();
    dispatchSynchronousVisibleCommit(approval.approvedCommit);
    return true;
  }

  function notifyDiscardedServerActionRevalidation(
    lifecycleOptions: SameUrlServerActionLifecycleOptions | undefined,
  ): void {
    const revalidation = lifecycleOptions?.revalidation ?? "none";
    if (!shouldScheduleRefreshForDiscardedServerAction(revalidation)) return;

    lifecycleOptions?.onDiscardedRevalidation?.();
  }

  function isSamePathSearchHashCommit(targetHref: string): boolean {
    if (typeof window === "undefined") return false;

    try {
      const currentUrl = new URL(window.location.href);
      const targetUrl = new URL(targetHref, currentUrl.href);
      return (
        targetUrl.origin === currentUrl.origin &&
        targetUrl.pathname === currentUrl.pathname &&
        targetUrl.search !== currentUrl.search &&
        targetUrl.hash !== ""
      );
    } catch {
      return false;
    }
  }

  function shouldForceSynchronousCommit(options: BrowserNavigationPayloadOptions): boolean {
    if (options.actionType === "traverse") return false;
    if (options.historyUpdateMode === undefined) return false;
    if (options.scrollIntent?.hash == null) return false;
    return isSamePathSearchHashCommit(options.targetHref);
  }

  async function renderNavigationPayload(
    options: BrowserNavigationPayloadOptions,
  ): Promise<NavigationPayloadOutcome> {
    if (options.navId === pendingUserNavigationId) {
      pendingUserNavigationLane = options.operationLane;
    }

    const renderId = allocateRenderId();
    const failureTarget = getAppNavigationFailureTarget(options.targetHref);
    if (failureTarget) {
      pendingNavigationFailureTargets.set(renderId, failureTarget);
    }
    let resolveCommitted: ((committed: boolean) => void) | undefined;
    const committed = new Promise<boolean>((resolve) => {
      resolveCommitted = resolve;
      pendingNavigationCommits.set(renderId, {
        committedState: null,
        onCommittedState: options.onCommittedState,
        resolve,
      });
    });

    let snapshotActivated = false;
    try {
      // Preparation is historical: identities and the started commit version
      // come from the initiating state. Approval below intentionally stays live
      // so superseding navigations and unrelated visible commits still reject.
      const pendingOptions = {
        currentState: options.navigationInitiationState,
        navigationCommitKind: options.navigationCommitKind,
        navigationId: options.navId,
        navigationSnapshot: options.navigationSnapshot,
        operationLane: options.operationLane,
        payloadOrigin: options.payloadOrigin,
        previousNextUrl: options.previousNextUrl,
        renderId,
        restoredBfcacheIds: options.restoredBfcacheIds,
        reuseCurrentBfcacheIds: options.reuseCurrentBfcacheIds,
        type: options.actionType,
      };
      const pending =
        options.nextElements instanceof Promise
          ? await createPendingNavigationCommit({
              ...pendingOptions,
              nextElements: options.nextElements,
            })
          : createPendingNavigationCommitFromElements({
              ...pendingOptions,
              nextElements: options.nextElements,
            });

      const approval = approvePendingNavigationCommit({
        activeNavigationId,
        currentState: getBrowserRouterState(),
        pending,
        routeManifest: getRouteManifest(),
        startedNavigationId: options.navId,
        targetHref: options.targetHref,
      });

      if (approval.decision.disposition === "no-commit") {
        settlePendingBrowserRouterState(options.pendingRouterState);
        pendingNavigationFailureTargets.delete(renderId);
        if (failureTarget) {
          clearAppNavigationFailureTarget(failureTarget);
        }
        pendingNavigationCommits.delete(renderId);
        resolveCommitted?.(false);
        consumeAppRouterScrollIntent(options.scrollIntent ?? null);
        return "no-commit";
      }

      if (approval.decision.disposition === "hard-navigate") {
        settlePendingBrowserRouterState(options.pendingRouterState);
        pendingNavigationFailureTargets.delete(renderId);
        pendingNavigationCommits.delete(renderId);
        consumeAppRouterScrollIntent(options.scrollIntent ?? null);
        if (performHardNavigation(options.targetHref)) {
          return "hard-navigate";
        }
        if (failureTarget) {
          clearAppNavigationFailureTarget(failureTarget);
        }
        return "no-commit";
      }

      const approvedCommit = approval.approvedCommit;
      if (approvedCommit === null) {
        throw new Error("[vinext] Commit decision did not approve a visible commit");
      }

      queuePrePaintNavigationEffect(
        renderId,
        options.createNavigationCommitEffect({
          bfcacheIds: approvedCommit.action.bfcacheIds,
          href: options.targetHref,
          historyUpdateMode: options.historyUpdateMode,
          navId: options.navId,
          params: options.params,
          previousNextUrl: approvedCommit.previousNextUrl,
          targetHistoryIndex: options.targetHistoryIndex,
        }),
      );
      claimAppRouterScrollIntentForCommit(options.scrollIntent, renderId);
      activateNavigationSnapshot();
      snapshotActivated = true;
      dispatchApprovedVisibleCommit(
        renderId,
        approvedCommit,
        options.pendingRouterState,
        shouldForceSynchronousCommit(options)
          ? "synchronous"
          : (options.visibleCommitMode ?? "transition"),
      );
    } catch (error) {
      pendingNavigationFailureTargets.delete(renderId);
      pendingNavigationPrePaintEffects.delete(renderId);
      pendingNavigationCommits.delete(renderId);
      if (snapshotActivated) {
        commitClientNavigationStateImpl(options.navId);
      }
      settlePendingBrowserRouterState(options.pendingRouterState);
      resolveCommitted?.(false);
      throw error;
    }

    return committed.then((didCommit) => (didCommit ? "committed" : "no-commit"));
  }

  async function commitSameUrlNavigatePayload(
    nextElements: Promise<AppElements>,
    navigationSnapshot: ClientNavigationRenderSnapshot,
    returnValue?: { ok: boolean; data: unknown },
    actionInitiationState?: AppRouterState,
    lifecycleOptions?: SameUrlServerActionLifecycleOptions,
  ): Promise<unknown> {
    const currentState = actionInitiationState ?? getBrowserRouterState();
    const startedNavigationId = lifecycleOptions?.startedNavigationId ?? activeNavigationId;
    const targetHref = lifecycleOptions?.targetHref ?? window.location.href;
    const {
      approvedCommit,
      decision,
      pending,
      // Intentionally retained as #726-OPS-01 trace-shell scaffolding. The
      // same-URL action path can consume this trace once later lifecycle gates
      // need an observable commit explanation.
      trace: _navigationTrace,
    } = await resolveAndClassifyNavigationCommit({
      activeNavigationId,
      currentState,
      getActiveNavigationId: () => activeNavigationId,
      getCurrentStateForApproval: getBrowserRouterState,
      navigationSnapshot,
      nextElements,
      renderId: allocateRenderId(),
      operationLane: resolveServerActionOperationLane(lifecycleOptions?.revalidation ?? "none"),
      payloadOrigin: FRESH_APP_NAVIGATION_PAYLOAD_ORIGIN,
      startedNavigationId,
      routeManifest: getRouteManifest(),
      targetHref,
      type: "navigate",
    });

    if (decision.disposition === "hard-navigate") {
      // Same-URL action hard navigations do not expose a navigation outcome to
      // callers. If the loop guard blocks, the degraded state is still the
      // existing return contract: no visible commit and no action value.
      performHardNavigation(targetHref);
      return undefined;
    }

    if (approvedCommit) {
      // The helper approval and this continuation are separated by a microtask
      // boundary, so re-check lifecycle authority before mutating visible UI.
      const latestApproval = approvePendingNavigationCommit({
        activeNavigationId,
        currentState: getBrowserRouterState(),
        pending,
        routeManifest: getRouteManifest(),
        startedNavigationId,
        targetHref,
      });

      if (latestApproval.decision.disposition === "hard-navigate") {
        // See the same-URL hard-navigation note above. The guard result is
        // deliberately not surfaced through the server-action return channel.
        performHardNavigation(targetHref);
        return undefined;
      }

      if (latestApproval.approvedCommit) {
        const approvedRevalidationCommit = latestApproval.approvedCommit;
        startTransition(() => {
          dispatchSynchronousVisibleCommit(approvedRevalidationCommit);
        });
        syncHistoryStatePreviousNextUrl(
          approvedRevalidationCommit.previousNextUrl,
          approvedRevalidationCommit.action.bfcacheIds,
        );
      } else {
        notifyDiscardedServerActionRevalidation(lifecycleOptions);
      }
    } else if (decision.disposition === "no-commit") {
      notifyDiscardedServerActionRevalidation(lifecycleOptions);
    }

    // Same-URL server actions still return their action value even if the UI
    // update was skipped due to a superseding navigation. That preserves the
    // existing caller contract; a future Phase 2 router state model could make
    // skipped UI updates observable to the caller without conflating them here.
    if (returnValue) {
      if (!returnValue.ok) {
        throw returnValue.data;
      }
      return returnValue.data;
    }

    return undefined;
  }

  function attachBrowserRouterState(
    setter: Dispatch<AppRouterState | Promise<AppRouterState>>,
    stateRef: BrowserRouterStateRef,
  ): () => void {
    setBrowserRouterState = setter;
    browserRouterStateRef = stateRef;
    markBrowserRouterStateReady();

    return () => {
      if (setBrowserRouterState === setter) {
        setBrowserRouterState = null;
      }
      if (browserRouterStateRef === stateRef) {
        browserRouterStateRef = null;
        browserRouterStateHasCommitted = false;
      }
    };
  }

  return {
    beginNavigation,
    getActiveNavigationId,
    hasBrowserRouterState,
    getBrowserRouterState,
    isCurrentNavigation,
    performHardNavigation,
    waitForBrowserRouterStateReady,
    attachBrowserRouterState,
    beginPendingBrowserRouterState,
    finalizeNavigation,
    restoreHistorySnapshotVisibleState,
    renderNavigationPayload,
    commitSameUrlNavigatePayload,
    hmrReplaceTree,
    drainPrePaintEffects,
    clearCommittedNavigationFailureTargets,
    NavigationCommitSignal,
  };
}
