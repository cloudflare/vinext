import { startTransition, useLayoutEffect, type Dispatch, type ReactNode } from "react";
import {
  activateNavigationSnapshot,
  clearPendingPathname,
  commitClientNavigationState,
} from "vinext/shims/navigation";
import type { ClientNavigationRenderSnapshot } from "vinext/shims/navigation";
import {
  createPendingNavigationCommit,
  type AppRouterState,
  type OperationLane,
} from "./app-browser-state.js";
import {
  applyApprovedVisibleCommit,
  approveHmrVisibleCommit,
  approvePendingNavigationCommit,
  resolveAndClassifyNavigationCommit,
  type ApprovedVisibleCommit,
} from "./app-browser-visible-commit.js";
import type { AppElements } from "./app-elements.js";

export type HistoryUpdateMode = "push" | "replace";

export type PendingBrowserRouterState = {
  promise: Promise<AppRouterState>;
  resolve: (state: AppRouterState) => void;
  settled: boolean;
};
export type NavigationPayloadOutcome = "committed" | "no-commit" | "hard-navigate";
type HardNavigationMode = "assign" | "replace";

type BrowserNavigationCommitEffectFactory = (options: {
  bfcacheIds: Readonly<Record<string, string>>;
  href: string;
  historyUpdateMode: HistoryUpdateMode | undefined;
  navId: number;
  params: Record<string, string | string[]>;
  previousNextUrl: string | null;
}) => () => void;

type BrowserRouterStateRef = {
  current: AppRouterState;
};

type BrowserNavigationControllerDeps = {
  commitClientNavigationState?: typeof commitClientNavigationState;
  performHardNavigation?: (href: string, mode?: HardNavigationMode) => boolean;
};

type BrowserNavigationController = {
  beginNavigation(): number;
  hasBrowserRouterState(): boolean;
  getBrowserRouterState(): AppRouterState;
  isCurrentNavigation(navId: number): boolean;
  waitForBrowserRouterStateReady(): Promise<void>;
  attachBrowserRouterState(
    setter: Dispatch<AppRouterState | Promise<AppRouterState>>,
    stateRef: BrowserRouterStateRef,
  ): () => void;
  beginPendingBrowserRouterState(): PendingBrowserRouterState;
  finalizeNavigation(navId: number, pending: PendingBrowserRouterState | null | undefined): void;
  renderNavigationPayload(options: {
    actionType: "navigate" | "replace" | "traverse";
    createNavigationCommitEffect: BrowserNavigationCommitEffectFactory;
    historyUpdateMode: HistoryUpdateMode | undefined;
    navigationSnapshot: ClientNavigationRenderSnapshot;
    nextElements: Promise<AppElements>;
    operationLane: OperationLane;
    params: Record<string, string | string[]>;
    pendingRouterState: PendingBrowserRouterState | null;
    previousNextUrl: string | null;
    restoredBfcacheIds?: Readonly<Record<string, string>> | null;
    targetHref: string;
    navId: number;
  }): Promise<NavigationPayloadOutcome>;
  commitSameUrlNavigatePayload(
    nextElements: Promise<AppElements>,
    navigationSnapshot: ClientNavigationRenderSnapshot,
    returnValue?: { ok: boolean; data: unknown },
    actionInitiationState?: AppRouterState,
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

export function createAppBrowserNavigationController(
  deps: BrowserNavigationControllerDeps = {},
): BrowserNavigationController {
  const commitClientNavigationStateImpl =
    deps.commitClientNavigationState ?? commitClientNavigationState;
  const performHardNavigation = deps.performHardNavigation ?? performHardNavigationWithLoopGuard;

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
  const pendingNavigationCommits = new Map<number, () => void>();
  const pendingNavigationPrePaintEffects = new Map<number, () => void>();

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
    activeNavigationId += 1;
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
      clearPendingPathname(navId);
    }
  }

  function resolvePendingBrowserRouterState(
    pending: PendingBrowserRouterState | null | undefined,
    commit: ApprovedVisibleCommit,
  ): void {
    if (!pending || pending.settled) return;

    pending.settled = true;
    pending.resolve(applyApprovedVisibleCommit(getBrowserRouterState(), commit));

    if (activePendingBrowserRouterState === pending) {
      activePendingBrowserRouterState = null;
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
   * Resolve all pending navigation commits with renderId <= the committed renderId.
   * Note: Map iteration handles concurrent deletion safely — entries are visited in
   * insertion order and deletion doesn't affect the iterator's view of remaining entries.
   * This pattern is also used in drainPrePaintEffects with the same semantics.
   */
  function resolveCommittedNavigations(renderId: number): void {
    for (const [pendingId, resolve] of pendingNavigationCommits) {
      if (pendingId > renderId) {
        continue;
      }

      pendingNavigationCommits.delete(pendingId);
      resolve();
    }
  }

  async function hmrReplaceTree(
    nextElements: Promise<AppElements>,
    navigationSnapshot: ClientNavigationRenderSnapshot,
  ): Promise<void> {
    if (!hasBrowserRouterState()) return;

    const currentState = getBrowserRouterState();
    const renderId = allocateRenderId();
    const pending = await createPendingNavigationCommit({
      currentState,
      nextElements,
      navigationSnapshot,
      operationLane: "hmr",
      renderId,
      type: "replace",
    });

    // createPendingNavigationCommit awaits the new RSC payload. While
    // suspended, the prior broken render can unmount BrowserRoot. Re-check
    // before dispatching so a racing unmount doesn't surface as an
    // initialized-setter error.
    if (!hasBrowserRouterState()) return;

    dispatchSynchronousVisibleCommit(approveHmrVisibleCommit(pending));
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
    useLayoutEffect(() => {
      drainPrePaintEffects(renderId);

      const frame = requestAnimationFrame(() => {
        resolveCommittedNavigations(renderId);
      });

      return () => {
        cancelAnimationFrame(frame);
        // Resolve pending commits to prevent callers from hanging if React
        // unmounts this component without committing (e.g., error boundary).
        resolveCommittedNavigations(renderId);
      };
    }, [renderId]);

    return children;
  }

  function dispatchApprovedVisibleCommit(
    commit: ApprovedVisibleCommit,
    pendingRouterState: PendingBrowserRouterState | null,
  ): void {
    const setter = getBrowserRouterStateSetter();

    if (pendingRouterState) {
      // The programmatic navigation is already running inside React.startTransition
      // (from router.push/replace/refresh/Link), so resolving the deferred promise
      // is sufficient.
      resolvePendingBrowserRouterState(pendingRouterState, commit);
      return;
    }

    startTransition(() => {
      setter(applyApprovedVisibleCommit(getBrowserRouterState(), commit));
    });
  }

  function dispatchSynchronousVisibleCommit(commit: ApprovedVisibleCommit): void {
    const setter = getBrowserRouterStateSetter();
    setter(applyApprovedVisibleCommit(getBrowserRouterState(), commit));
  }

  async function renderNavigationPayload(options: {
    actionType: "navigate" | "replace" | "traverse";
    createNavigationCommitEffect: BrowserNavigationCommitEffectFactory;
    historyUpdateMode: HistoryUpdateMode | undefined;
    navigationSnapshot: ClientNavigationRenderSnapshot;
    nextElements: Promise<AppElements>;
    operationLane: OperationLane;
    params: Record<string, string | string[]>;
    pendingRouterState: PendingBrowserRouterState | null;
    previousNextUrl: string | null;
    restoredBfcacheIds?: Readonly<Record<string, string>> | null;
    targetHref: string;
    navId: number;
  }): Promise<NavigationPayloadOutcome> {
    const renderId = allocateRenderId();
    let resolveCommitted: (() => void) | undefined;
    const committed = new Promise<void>((resolve) => {
      resolveCommitted = resolve;
      pendingNavigationCommits.set(renderId, resolve);
    });

    let snapshotActivated = false;
    try {
      const startedState = getBrowserRouterState();
      const pending = await createPendingNavigationCommit({
        currentState: startedState,
        nextElements: options.nextElements,
        navigationSnapshot: options.navigationSnapshot,
        operationLane: options.operationLane,
        previousNextUrl: options.previousNextUrl,
        renderId,
        restoredBfcacheIds: options.restoredBfcacheIds,
        type: options.actionType,
      });

      const approval = approvePendingNavigationCommit({
        activeNavigationId,
        currentState: getBrowserRouterState(),
        pending,
        startedNavigationId: options.navId,
        targetHref: options.targetHref,
      });

      if (approval.decision.disposition === "no-commit") {
        settlePendingBrowserRouterState(options.pendingRouterState);
        pendingNavigationCommits.delete(renderId);
        resolveCommitted?.();
        return "no-commit";
      }

      if (approval.decision.disposition === "hard-navigate") {
        settlePendingBrowserRouterState(options.pendingRouterState);
        pendingNavigationCommits.delete(renderId);
        return performHardNavigation(options.targetHref) ? "hard-navigate" : "no-commit";
      }

      const approvedCommit = approval.approvedCommit;
      if (approvedCommit === null) {
        throw new Error("[vinext] Commit decision did not approve a visible commit");
      }

      queuePrePaintNavigationEffect(
        renderId,
        options.createNavigationCommitEffect({
          href: options.targetHref,
          bfcacheIds: approvedCommit.action.bfcacheIds,
          historyUpdateMode: options.historyUpdateMode,
          navId: options.navId,
          params: options.params,
          previousNextUrl: approvedCommit.previousNextUrl,
        }),
      );
      activateNavigationSnapshot();
      snapshotActivated = true;
      dispatchApprovedVisibleCommit(approvedCommit, options.pendingRouterState);
    } catch (error) {
      pendingNavigationPrePaintEffects.delete(renderId);
      pendingNavigationCommits.delete(renderId);
      if (snapshotActivated) {
        commitClientNavigationStateImpl(options.navId);
      }
      settlePendingBrowserRouterState(options.pendingRouterState);
      resolveCommitted?.();
      throw error;
    }

    return committed.then(() => "committed");
  }

  async function commitSameUrlNavigatePayload(
    nextElements: Promise<AppElements>,
    navigationSnapshot: ClientNavigationRenderSnapshot,
    returnValue?: { ok: boolean; data: unknown },
    actionInitiationState?: AppRouterState,
  ): Promise<unknown> {
    const currentState = actionInitiationState ?? getBrowserRouterState();
    const startedNavigationId = activeNavigationId;
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
      operationLane: "server-action",
      startedNavigationId,
      targetHref: window.location.href,
      type: "navigate",
    });

    if (decision.disposition === "hard-navigate") {
      // Same-URL action hard navigations do not expose a navigation outcome to
      // callers. If the loop guard blocks, the degraded state is still the
      // existing return contract: no visible commit and no action value.
      performHardNavigation(window.location.href);
      return undefined;
    }

    if (approvedCommit) {
      // The helper approval and this continuation are separated by a microtask
      // boundary, so re-check lifecycle authority before mutating visible UI.
      const latestApproval = approvePendingNavigationCommit({
        activeNavigationId,
        currentState: getBrowserRouterState(),
        pending,
        startedNavigationId,
        targetHref: window.location.href,
      });

      if (latestApproval.decision.disposition === "hard-navigate") {
        // See the same-URL hard-navigation note above. The guard result is
        // deliberately not surfaced through the server-action return channel.
        performHardNavigation(window.location.href);
        return undefined;
      }

      if (latestApproval.approvedCommit) {
        dispatchSynchronousVisibleCommit(latestApproval.approvedCommit);
      }
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
    hasBrowserRouterState,
    getBrowserRouterState,
    isCurrentNavigation,
    waitForBrowserRouterStateReady,
    attachBrowserRouterState,
    beginPendingBrowserRouterState,
    finalizeNavigation,
    renderNavigationPayload,
    commitSameUrlNavigatePayload,
    hmrReplaceTree,
    drainPrePaintEffects,
    NavigationCommitSignal,
  };
}
