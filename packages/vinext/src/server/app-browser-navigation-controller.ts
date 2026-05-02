import { startTransition, useLayoutEffect, type Dispatch, type ReactNode } from "react";
import {
  activateNavigationSnapshot,
  clearPendingPathname,
  commitClientNavigationState,
} from "vinext/shims/navigation";
import type { ClientNavigationRenderSnapshot } from "vinext/shims/navigation";
import {
  createPendingNavigationCommit,
  resolveAndClassifyNavigationCommit,
  resolvePendingNavigationCommitDisposition,
  routerReducer,
  type AppRouterAction,
  type AppRouterState,
} from "./app-browser-state.js";
import type { AppElements, LayoutFlags } from "./app-elements.js";

export type HistoryUpdateMode = "push" | "replace";

export type PendingBrowserRouterState = {
  promise: Promise<AppRouterState>;
  resolve: (state: AppRouterState) => void;
  settled: boolean;
};

type BrowserNavigationCommitEffectFactory = (options: {
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
    params: Record<string, string | string[]>;
    pendingRouterState: PendingBrowserRouterState | null;
    previousNextUrl: string | null;
    targetHref: string;
    navId: number;
    useTransition?: boolean;
  }): Promise<void>;
  commitSameUrlNavigatePayload(
    nextElements: Promise<AppElements>,
    navigationSnapshot: ClientNavigationRenderSnapshot,
    returnValue?: { ok: boolean; data: unknown },
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

export function createAppBrowserNavigationController(
  deps: BrowserNavigationControllerDeps = {},
): BrowserNavigationController {
  const commitClientNavigationStateImpl =
    deps.commitClientNavigationState ?? commitClientNavigationState;

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
    action: AppRouterAction,
  ): void {
    if (!pending || pending.settled) return;

    pending.settled = true;
    pending.resolve(routerReducer(getBrowserRouterState(), action));

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
      renderId,
      type: "replace",
    });

    // createPendingNavigationCommit awaits the new RSC payload. While
    // suspended, the prior broken render can unmount BrowserRoot. Re-check
    // before dispatching so a racing unmount doesn't surface as an
    // initialized-setter error.
    if (!hasBrowserRouterState()) return;

    dispatchBrowserTree(
      pending.action.elements,
      navigationSnapshot,
      pending.action.renderId,
      "replace",
      pending.interceptionContext,
      pending.action.layoutFlags,
      pending.previousNextUrl,
      pending.routeId,
      pending.rootLayoutTreePath,
      null,
      false,
    );
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

  function dispatchBrowserTree(
    elements: AppElements,
    navigationSnapshot: ClientNavigationRenderSnapshot,
    renderId: number,
    actionType: "navigate" | "replace" | "traverse",
    interceptionContext: string | null,
    layoutFlags: LayoutFlags,
    previousNextUrl: string | null,
    routeId: string,
    rootLayoutTreePath: string | null,
    pendingRouterState: PendingBrowserRouterState | null,
    useTransitionMode: boolean,
  ): void {
    const setter = getBrowserRouterStateSetter();
    const action: AppRouterAction = {
      elements,
      interceptionContext,
      layoutFlags,
      navigationSnapshot,
      previousNextUrl,
      renderId,
      rootLayoutTreePath,
      routeId,
      type: actionType,
    };

    const applyAction = () => {
      if (pendingRouterState) {
        // The programmatic navigation is already running inside React.startTransition
        // (from router.push/replace/refresh), so resolving the deferred promise is
        // sufficient — no additional startTransition wrapper is needed below.
        resolvePendingBrowserRouterState(pendingRouterState, action);
        return;
      }

      setter(routerReducer(getBrowserRouterState(), action));
    };

    if (useTransitionMode) {
      startTransition(applyAction);
    } else {
      applyAction();
    }
  }

  async function renderNavigationPayload(options: {
    actionType: "navigate" | "replace" | "traverse";
    createNavigationCommitEffect: BrowserNavigationCommitEffectFactory;
    historyUpdateMode: HistoryUpdateMode | undefined;
    navigationSnapshot: ClientNavigationRenderSnapshot;
    nextElements: Promise<AppElements>;
    params: Record<string, string | string[]>;
    pendingRouterState: PendingBrowserRouterState | null;
    previousNextUrl: string | null;
    targetHref: string;
    navId: number;
    useTransition?: boolean;
  }): Promise<void> {
    const renderId = allocateRenderId();
    let resolveCommitted: (() => void) | undefined;
    const committed = new Promise<void>((resolve) => {
      resolveCommitted = resolve;
      pendingNavigationCommits.set(renderId, resolve);
    });

    let snapshotActivated = false;
    try {
      const currentState = getBrowserRouterState();
      const pending = await createPendingNavigationCommit({
        currentState,
        nextElements: options.nextElements,
        navigationSnapshot: options.navigationSnapshot,
        previousNextUrl: options.previousNextUrl,
        renderId,
        type: options.actionType,
      });

      const disposition = resolvePendingNavigationCommitDisposition({
        activeNavigationId,
        currentRootLayoutTreePath: currentState.rootLayoutTreePath,
        nextRootLayoutTreePath: pending.rootLayoutTreePath,
        startedNavigationId: options.navId,
      });

      if (disposition === "skip") {
        settlePendingBrowserRouterState(options.pendingRouterState);
        pendingNavigationCommits.delete(renderId);
        resolveCommitted?.();
        return;
      }

      if (disposition === "hard-navigate") {
        settlePendingBrowserRouterState(options.pendingRouterState);
        pendingNavigationCommits.delete(renderId);
        window.location.assign(options.targetHref);
        return;
      }

      queuePrePaintNavigationEffect(
        renderId,
        options.createNavigationCommitEffect({
          href: options.targetHref,
          historyUpdateMode: options.historyUpdateMode,
          navId: options.navId,
          params: options.params,
          previousNextUrl: pending.previousNextUrl,
        }),
      );
      activateNavigationSnapshot();
      snapshotActivated = true;
      dispatchBrowserTree(
        pending.action.elements,
        options.navigationSnapshot,
        renderId,
        options.actionType,
        pending.interceptionContext,
        pending.action.layoutFlags,
        pending.previousNextUrl,
        pending.routeId,
        pending.rootLayoutTreePath,
        options.pendingRouterState,
        options.useTransition ?? true,
      );
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

    return committed;
  }

  async function commitSameUrlNavigatePayload(
    nextElements: Promise<AppElements>,
    navigationSnapshot: ClientNavigationRenderSnapshot,
    returnValue?: { ok: boolean; data: unknown },
  ): Promise<unknown> {
    const currentState = getBrowserRouterState();
    const startedNavigationId = activeNavigationId;
    // Known limitation: if a same-URL navigation fully commits while this
    // server action is awaiting resolveAndClassifyNavigationCommit(), the action
    // can still dispatch its older payload afterward. The old pre-2c code had
    // the same race, and Next.js has similar behavior. Tightening this would
    // need a stronger commit-version gate than activeNavigationId alone.
    const { disposition, pending } = await resolveAndClassifyNavigationCommit({
      activeNavigationId,
      currentState,
      navigationSnapshot,
      nextElements,
      renderId: allocateRenderId(),
      startedNavigationId,
      type: "navigate",
    });

    if (disposition === "hard-navigate") {
      window.location.assign(window.location.href);
      return undefined;
    }

    if (disposition === "dispatch") {
      dispatchBrowserTree(
        pending.action.elements,
        navigationSnapshot,
        pending.action.renderId,
        "navigate",
        pending.interceptionContext,
        pending.action.layoutFlags,
        pending.previousNextUrl,
        pending.routeId,
        pending.rootLayoutTreePath,
        null,
        false,
      );
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
