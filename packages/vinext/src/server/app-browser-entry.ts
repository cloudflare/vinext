/// <reference types="vite/client" />

import {
  createElement,
  startTransition,
  use,
  useLayoutEffect,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
} from "react";
import {
  createFromFetch,
  createFromReadableStream,
  createTemporaryReferenceSet,
  encodeReply,
  setServerCallback,
} from "@vitejs/plugin-rsc/browser";
import { hydrateRoot } from "react-dom/client";
import "../client/instrumentation-client.js";
import { notifyAppRouterTransitionStart } from "../client/instrumentation-client-state.js";
import {
  __basePath,
  activateNavigationSnapshot,
  clearPendingPathname,
  commitClientNavigationState,
  consumePrefetchResponse,
  createClientNavigationRenderSnapshot,
  getCurrentNextUrl,
  getCurrentInterceptionContext,
  getClientNavigationRenderContext,
  getClientNavigationState,
  getPrefetchCache,
  getPrefetchedUrls,
  pushHistoryStateWithoutNotify,
  replaceClientParamsWithoutNotify,
  replaceHistoryStateWithoutNotify,
  restoreRscResponse,
  setClientParams,
  setPendingPathname,
  snapshotRscResponse,
  setMountedSlotsHeader,
  setNavigationContext,
  toRscUrl,
  type CachedRscResponse,
  type ClientNavigationRenderSnapshot,
} from "../shims/navigation.js";
import { stripBasePath } from "../utils/base-path.js";
import {
  chunksToReadableStream,
  createProgressiveRscStream,
  getVinextBrowserGlobal,
} from "./app-browser-stream.js";
import {
  createAppPayloadCacheKey,
  getMountedSlotIdsHeader,
  normalizeAppElements,
  readAppElementsMetadata,
  resolveVisitedResponseInterceptionContext,
  type AppElements,
  type AppWireElements,
  type LayoutFlags,
} from "./app-elements.js";
import {
  createHistoryStateWithPreviousNextUrl,
  createPendingNavigationCommit,
  readHistoryStatePreviousNextUrl,
  resolveAndClassifyNavigationCommit,
  resolveInterceptionContextFromPreviousNextUrl,
  resolvePendingNavigationCommitDisposition,
  resolveServerActionRequestState,
  routerReducer,
  type AppRouterAction,
  type AppRouterState,
} from "./app-browser-state.js";
import { ElementsContext, Slot } from "../shims/slot.js";
import { devOnCaughtError } from "./app-browser-error.js";
import { DANGEROUS_URL_BLOCK_MESSAGE, isDangerousScheme } from "../shims/url-safety.js";
import {
  getServerActionNotFoundClientMessage,
  isServerActionNotFoundResponse,
} from "./server-action-not-found.js";

type SearchParamInput = ConstructorParameters<typeof URLSearchParams>[0];

type ServerActionResult = {
  root: AppWireElements;
  returnValue?: {
    ok: boolean;
    data: unknown;
  };
};

type NavigationKind = "navigate" | "traverse" | "refresh";

// Maps NavigationKind to the AppRouterAction type used by the reducer.
// "refresh" is intentionally treated as "navigate" (merge, preserve absent slots).
// Both call sites must stay in sync — update here if NavigationKind gains new values.
function toActionType(kind: NavigationKind): "navigate" | "traverse" {
  return kind === "traverse" ? "traverse" : "navigate";
}

type HistoryUpdateMode = "push" | "replace";
type VisitedResponseCacheEntry = {
  params: Record<string, string | string[]>;
  expiresAt: number;
  response: CachedRscResponse;
};

const MAX_VISITED_RESPONSE_CACHE_SIZE = 50;
const VISITED_RESPONSE_CACHE_TTL = 5 * 60_000;
const MAX_TRAVERSAL_CACHE_TTL = 30 * 60_000;

// These are plain module-level variables, unlike ClientNavigationState in
// navigation.ts which uses Symbol.for to survive multiple Vite module instances.
// The browser entry is loaded exactly once (via the RSC plugin's generated
// bootstrap), so module-level state is safe here. If that assumption ever
// changes, these should be migrated to a Symbol.for-backed global.
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
type PendingBrowserRouterState = {
  promise: Promise<AppRouterState>;
  resolve: (state: AppRouterState) => void;
  settled: boolean;
};

function isRouterStatePromise(
  value: AppRouterState | Promise<AppRouterState>,
): value is Promise<AppRouterState> {
  return value instanceof Promise;
}

let setBrowserRouterState: Dispatch<AppRouterState | Promise<AppRouterState>> | null = null;
let browserRouterStateRef: { current: AppRouterState } | null = null;
let activePendingBrowserRouterState: PendingBrowserRouterState | null = null;
let latestClientParams: Record<string, string | string[]> = {};
const visitedResponseCache = new Map<string, VisitedResponseCacheEntry>();

function isServerActionResult(value: unknown): value is ServerActionResult {
  return !!value && typeof value === "object" && "root" in value;
}

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

function beginPendingBrowserRouterState(): PendingBrowserRouterState {
  const setter = getBrowserRouterStateSetter();

  if (activePendingBrowserRouterState && !activePendingBrowserRouterState.settled) {
    activePendingBrowserRouterState.settled = true;
    activePendingBrowserRouterState.resolve(getBrowserRouterState());
  }

  let resolve!: (state: AppRouterState) => void;
  const promise = new Promise<AppRouterState>((resolvePromise) => {
    resolve = resolvePromise;
  });

  const pending: PendingBrowserRouterState = {
    promise,
    resolve,
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

function applyClientParams(params: Record<string, string | string[]>): void {
  latestClientParams = params;
  setClientParams(params);
}

function stageClientParams(params: Record<string, string | string[]>): void {
  // NB: latestClientParams diverges from ClientNavigationState.clientParams
  // between staging and commit. Server action snapshots (same-URL
  // commitSameUrlNavigatePayload() calls inside registerServerActionCallback)
  // read latestClientParams, so a
  // server action fired during this window would get the pending (not yet
  // committed) params. This is acceptable because the commit effect fires
  // before hooks observe the new URL state, keeping the window vanishingly small.
  latestClientParams = params;
  replaceClientParamsWithoutNotify(params);
}

function clearVisitedResponseCache(): void {
  visitedResponseCache.clear();
}

function clearPrefetchState(): void {
  getPrefetchCache().clear();
  getPrefetchedUrls().clear();
}

function clearClientNavigationCaches(): void {
  clearVisitedResponseCache();
  clearPrefetchState();
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
    if (id <= upToRenderId) {
      pendingNavigationPrePaintEffects.delete(id);
      if (id === upToRenderId) {
        // Winning navigation: run its actual pre-paint effect
        effect();
      } else {
        // Superseded navigation: balance its activateNavigationSnapshot().
        // Pass undefined navId intentionally so this cleanup cannot clear
        // pendingPathname owned by the current active navigation.
        commitClientNavigationState(undefined, { releaseSnapshot: true });
      }
    }
  }
}

function createNavigationCommitEffect(
  href: string,
  historyUpdateMode: HistoryUpdateMode | undefined,
  navId: number,
  params: Record<string, string | string[]>,
  previousNextUrl: string | null,
): () => void {
  return () => {
    // Only update URL if this is still the active navigation.
    // A newer navigation would have incremented activeNavigationId.
    if (navId !== activeNavigationId) {
      // This transition was superseded before commit; balance the active
      // snapshot counter without clearing pendingPathname ownership.
      commitClientNavigationState(undefined, { releaseSnapshot: true });
      return;
    }

    const targetHref = new URL(href, window.location.origin).href;
    stageClientParams(params);
    const preserveExistingState = historyUpdateMode === "replace";
    const historyState = createHistoryStateWithPreviousNextUrl(
      preserveExistingState ? window.history.state : null,
      previousNextUrl,
    );

    if (historyUpdateMode === "replace" && window.location.href !== targetHref) {
      replaceHistoryStateWithoutNotify(historyState, "", href);
    } else if (historyUpdateMode === "push" && window.location.href !== targetHref) {
      pushHistoryStateWithoutNotify(historyState, "", href);
    }

    commitClientNavigationState(navId);
  };
}

function evictVisitedResponseCacheIfNeeded(): void {
  while (visitedResponseCache.size >= MAX_VISITED_RESPONSE_CACHE_SIZE) {
    const oldest = visitedResponseCache.keys().next().value;
    if (oldest === undefined) {
      return;
    }
    visitedResponseCache.delete(oldest);
  }
}

function getVisitedResponse(
  rscUrl: string,
  interceptionContext: string | null,
  mountedSlotsHeader: string | null,
  navigationKind: NavigationKind,
): VisitedResponseCacheEntry | null {
  const cacheKey = createAppPayloadCacheKey(rscUrl, interceptionContext);
  const cached = visitedResponseCache.get(cacheKey);
  if (!cached) {
    return null;
  }

  if ((cached.response.mountedSlotsHeader ?? null) !== mountedSlotsHeader) {
    visitedResponseCache.delete(cacheKey);
    return null;
  }

  if (navigationKind === "refresh") {
    return null;
  }

  if (navigationKind === "traverse") {
    const createdAt = cached.expiresAt - VISITED_RESPONSE_CACHE_TTL;
    if (Date.now() - createdAt >= MAX_TRAVERSAL_CACHE_TTL) {
      visitedResponseCache.delete(cacheKey);
      return null;
    }
    // LRU: promote to most-recently-used (delete + re-insert moves to end of Map)
    visitedResponseCache.delete(cacheKey);
    visitedResponseCache.set(cacheKey, cached);
    return cached;
  }

  if (cached.expiresAt > Date.now()) {
    // LRU: promote to most-recently-used
    visitedResponseCache.delete(cacheKey);
    visitedResponseCache.set(cacheKey, cached);
    return cached;
  }

  visitedResponseCache.delete(cacheKey);
  return null;
}

function storeVisitedResponseSnapshot(
  rscUrl: string,
  interceptionContext: string | null,
  snapshot: CachedRscResponse,
  params: Record<string, string | string[]>,
): void {
  const cacheKey = createAppPayloadCacheKey(rscUrl, interceptionContext);
  visitedResponseCache.delete(cacheKey);
  evictVisitedResponseCacheIfNeeded();
  const now = Date.now();
  visitedResponseCache.set(cacheKey, {
    params,
    expiresAt: now + VISITED_RESPONSE_CACHE_TTL,
    response: snapshot,
  });
}

type NavigationRequestState = {
  interceptionContext: string | null;
  previousNextUrl: string | null;
};

function getRequestState(
  navigationKind: NavigationKind,
  previousNextUrlOverride?: string | null,
): NavigationRequestState {
  if (previousNextUrlOverride !== undefined) {
    return {
      interceptionContext: resolveInterceptionContextFromPreviousNextUrl(
        previousNextUrlOverride,
        __basePath,
      ),
      previousNextUrl: previousNextUrlOverride,
    };
  }

  switch (navigationKind) {
    case "navigate":
      return {
        interceptionContext: getCurrentInterceptionContext(),
        previousNextUrl: getCurrentNextUrl(),
      };
    case "traverse": {
      const previousNextUrl = readHistoryStatePreviousNextUrl(window.history.state);
      return {
        interceptionContext: resolveInterceptionContextFromPreviousNextUrl(
          previousNextUrl,
          __basePath,
        ),
        previousNextUrl,
      };
    }
    case "refresh": {
      const currentPreviousNextUrl = getBrowserRouterState().previousNextUrl;
      return {
        interceptionContext: resolveInterceptionContextFromPreviousNextUrl(
          currentPreviousNextUrl,
          __basePath,
        ),
        previousNextUrl: currentPreviousNextUrl,
      };
    }
    default: {
      const _exhaustive: never = navigationKind;
      throw new Error("[vinext] Unknown navigation kind: " + String(_exhaustive));
    }
  }
}

function createRscRequestHeaders(interceptionContext: string | null): Headers {
  const headers = new Headers({ Accept: "text/x-component" });
  if (interceptionContext !== null) {
    headers.set("X-Vinext-Interception-Context", interceptionContext);
  }
  return headers;
}

/**
 * Resolve all pending navigation commits with renderId <= the committed renderId.
 * Note: Map iteration handles concurrent deletion safely — entries are visited in
 * insertion order and deletion doesn't affect the iterator's view of remaining entries.
 * This pattern is also used in drainPrePaintEffects with the same semantics.
 */
function resolveCommittedNavigations(renderId: number): void {
  for (const [pendingId, resolve] of pendingNavigationCommits) {
    if (pendingId <= renderId) {
      pendingNavigationCommits.delete(pendingId);
      resolve();
    }
  }
}

function NavigationCommitSignal({
  renderId,
  children,
}: {
  renderId: number;
  children?: ReactNode;
}) {
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

function normalizeAppElementsPromise(payload: Promise<AppWireElements>): Promise<AppElements> {
  // Wrap in Promise.resolve() because createFromReadableStream() returns a
  // React Flight thenable whose .then() returns undefined (not a new Promise).
  // Without the wrap, chaining .then() produces undefined → use() crashes.
  return Promise.resolve(payload).then((elements) => normalizeAppElements(elements));
}

async function commitSameUrlNavigatePayload(
  nextElements: Promise<AppElements>,
  returnValue?: ServerActionResult["returnValue"],
): Promise<unknown> {
  const navigationSnapshot = createClientNavigationRenderSnapshot(
    window.location.href,
    latestClientParams,
  );
  const currentState = getBrowserRouterState();
  const startedNavigationId = activeNavigationId;
  const { disposition, pending } = await resolveAndClassifyNavigationCommit({
    activeNavigationId,
    currentState,
    navigationSnapshot,
    nextElements,
    renderId: ++nextNavigationRenderId,
    startedNavigationId,
    type: "navigate",
  });

  // Known limitation: if a same-URL navigation fully commits while this
  // server action is awaiting createPendingNavigationCommit(), the action
  // can still dispatch its older payload afterward. The old pre-2c code had
  // the same race, and Next.js has similar behavior. Tightening this would
  // need a stronger commit-version gate than activeNavigationId alone.
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

function BrowserRoot({
  initialElements,
  initialNavigationSnapshot,
}: {
  initialElements: Promise<AppElements>;
  initialNavigationSnapshot: ClientNavigationRenderSnapshot;
}) {
  const resolvedElements = use(initialElements);
  const initialMetadata = readAppElementsMetadata(resolvedElements);
  const [treeStateValue, setTreeStateValue] = useState<AppRouterState | Promise<AppRouterState>>({
    elements: resolvedElements,
    interceptionContext: initialMetadata.interceptionContext,
    layoutFlags: initialMetadata.layoutFlags,
    navigationSnapshot: initialNavigationSnapshot,
    previousNextUrl: null,
    renderId: 0,
    rootLayoutTreePath: initialMetadata.rootLayoutTreePath,
    routeId: initialMetadata.routeId,
  });
  const treeState = isRouterStatePromise(treeStateValue) ? use(treeStateValue) : treeStateValue;

  // Keep the latest router state in a ref so external callers (navigate(),
  // server actions, HMR) always read the current state. Safe: those readers
  // run from events/effects, never from React render itself.
  // Note: stateRef.current is written during render, not in an effect, to
  // avoid a stale-read window between commit and layout effects. This mirrors
  // the same render-phase ref update pattern used by Next.js's own router.
  const stateRef = useRef(treeState);
  stateRef.current = treeState;

  // Publish the stable ref object and dispatch during layout commit. This keeps
  // the module-level escape hatches aligned with React's committed tree without
  // performing module writes during render. __VINEXT_RSC_NAVIGATE__ is assigned
  // after hydrateRoot() returns; by then this layout effect has already run for
  // the hydration commit, so getBrowserRouterState() never observes a null ref.
  useLayoutEffect(() => {
    setBrowserRouterState = setTreeStateValue;
    browserRouterStateRef = stateRef;
    return () => {
      if (setBrowserRouterState === setTreeStateValue) {
        setBrowserRouterState = null;
      }
      if (browserRouterStateRef === stateRef) {
        browserRouterStateRef = null;
      }
      setMountedSlotsHeader(null);
    };
  }, [setTreeStateValue]);

  useLayoutEffect(() => {
    setMountedSlotsHeader(getMountedSlotIdsHeader(stateRef.current.elements));
  }, [treeState.elements]);

  useLayoutEffect(() => {
    if (treeState.renderId !== 0) {
      return;
    }

    replaceHistoryStateWithoutNotify(
      createHistoryStateWithPreviousNextUrl(window.history.state, treeState.previousNextUrl),
      "",
      window.location.href,
    );
  }, [treeState.previousNextUrl, treeState.renderId]);

  const committedTree = createElement(
    NavigationCommitSignal,
    { renderId: treeState.renderId },
    createElement(
      ElementsContext.Provider,
      { value: treeState.elements },
      createElement(Slot, { id: treeState.routeId }),
    ),
  );

  const ClientNavigationRenderContext = getClientNavigationRenderContext();
  if (!ClientNavigationRenderContext) {
    return committedTree;
  }

  return createElement(
    ClientNavigationRenderContext.Provider,
    { value: treeState.navigationSnapshot },
    committedTree,
  );
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

async function renderNavigationPayload(
  payload: Promise<AppElements>,
  navigationSnapshot: ClientNavigationRenderSnapshot,
  targetHref: string,
  navId: number,
  historyUpdateMode: HistoryUpdateMode | undefined,
  params: Record<string, string | string[]>,
  previousNextUrl: string | null,
  pendingRouterState: PendingBrowserRouterState | null,
  useTransition = true,
  actionType: "navigate" | "replace" | "traverse" = "navigate",
): Promise<void> {
  const renderId = ++nextNavigationRenderId;
  const committed = new Promise<void>((resolve) => {
    pendingNavigationCommits.set(renderId, resolve);
  });

  let snapshotActivated = false;
  try {
    const currentState = getBrowserRouterState();
    const pending = await createPendingNavigationCommit({
      currentState,
      nextElements: payload,
      navigationSnapshot,
      previousNextUrl,
      renderId,
      type: actionType,
    });

    const disposition = resolvePendingNavigationCommitDisposition({
      activeNavigationId,
      currentRootLayoutTreePath: currentState.rootLayoutTreePath,
      nextRootLayoutTreePath: pending.rootLayoutTreePath,
      startedNavigationId: navId,
    });

    if (disposition === "skip") {
      settlePendingBrowserRouterState(pendingRouterState);
      const resolve = pendingNavigationCommits.get(renderId);
      pendingNavigationCommits.delete(renderId);
      resolve?.();
      return;
    }

    if (disposition === "hard-navigate") {
      settlePendingBrowserRouterState(pendingRouterState);
      pendingNavigationCommits.delete(renderId);
      window.location.assign(targetHref);
      return;
    }

    queuePrePaintNavigationEffect(
      renderId,
      createNavigationCommitEffect(
        targetHref,
        historyUpdateMode,
        navId,
        params,
        pending.previousNextUrl,
      ),
    );
    activateNavigationSnapshot();
    snapshotActivated = true;
    dispatchBrowserTree(
      pending.action.elements,
      navigationSnapshot,
      renderId,
      actionType,
      pending.interceptionContext,
      pending.action.layoutFlags,
      pending.previousNextUrl,
      pending.routeId,
      pending.rootLayoutTreePath,
      pendingRouterState,
      useTransition,
    );
  } catch (error) {
    // Clean up pending state on error. Only decrement the snapshot counter
    // if activateNavigationSnapshot() was actually called — if
    // createPendingNavigationCommit() threw, the counter was never
    // incremented so decrementing would underflow it.
    pendingNavigationPrePaintEffects.delete(renderId);
    const resolve = pendingNavigationCommits.get(renderId);
    pendingNavigationCommits.delete(renderId);
    if (snapshotActivated) {
      commitClientNavigationState(navId);
    }
    settlePendingBrowserRouterState(pendingRouterState);
    resolve?.();
    throw error;
  }

  return committed;
}

function restoreHydrationNavigationContext(
  pathname: string,
  searchParams: SearchParamInput,
  params: Record<string, string | string[]>,
): void {
  setNavigationContext({
    pathname,
    searchParams: new URLSearchParams(searchParams),
    params,
  });
}

function decodeHashFragment(fragment: string): string {
  try {
    return decodeURIComponent(fragment);
  } catch {
    return fragment;
  }
}

function scrollToHashTarget(hash: string): void {
  const fragment = decodeHashFragment(hash.startsWith("#") ? hash.slice(1) : hash);

  requestAnimationFrame(() => {
    if (fragment === "" || fragment === "top") {
      window.scrollTo(0, 0);
      return;
    }

    const idElement = document.getElementById(fragment);
    if (idElement) {
      idElement.scrollIntoView({ behavior: "auto" });
      return;
    }

    document.getElementsByName(fragment)[0]?.scrollIntoView({ behavior: "auto" });
  });
}

function restorePopstateScrollPosition(state: unknown): void {
  if (!(state && typeof state === "object" && "__vinext_scrollY" in state)) {
    if (window.location.hash) {
      scrollToHashTarget(window.location.hash);
    }
    return;
  }

  const y = Number(state.__vinext_scrollY);
  const x = "__vinext_scrollX" in state ? Number(state.__vinext_scrollX) : 0;

  requestAnimationFrame(() => {
    window.scrollTo(x, y);
  });
}

// Set on pagehide so the RSC navigation catch block can distinguish expected
// fetch aborts (triggered by the unload itself) from real errors worth logging.
let isPageUnloading = false;

const RSC_RELOAD_KEY = "__vinext_rsc_initial_reload__";

// sessionStorage can throw SecurityError in strict-mode iframes, storage-
// disabled browsers, and some Safari private-browsing configurations. Wrap
// every access so a recovery path for one error does not crash hydration.
function readReloadFlag(): string | null {
  try {
    return sessionStorage.getItem(RSC_RELOAD_KEY);
  } catch {
    return null;
  }
}
function writeReloadFlag(path: string): void {
  try {
    sessionStorage.setItem(RSC_RELOAD_KEY, path);
  } catch {}
}
function clearReloadFlag(): void {
  try {
    sessionStorage.removeItem(RSC_RELOAD_KEY);
  } catch {}
}

// A non-ok or wrong-content-type RSC response during initial hydration means
// the server cannot deliver a valid RSC payload for this URL. Parsing the
// response as RSC causes an opaque parse failure. On the first attempt,
// reload once so the server has a chance to render the correct error page
// as HTML. On the second attempt (detected via the sessionStorage flag), the
// endpoint is persistently broken. Returns null so main() aborts the
// hydration bootstrap without registering `__VINEXT_RSC_*` globals —
// including during the brief window between reload() firing and the page
// actually unloading — so external probes never see a half-hydrated page.
function recoverFromBadInitialRscResponse(reason: string): null {
  const currentPath = window.location.pathname + window.location.search;
  if (readReloadFlag() === currentPath) {
    clearReloadFlag();
    console.error(
      `[vinext] Initial RSC fetch ${reason} after reload; aborting hydration. ` +
        "Server-rendered HTML remains visible; client components will not hydrate.",
    );
    return null;
  }
  writeReloadFlag(currentPath);
  // Verify the write persisted. In storage-denied environments (strict-mode
  // iframes, locked-down enterprise policies), every getItem returns null and
  // every setItem silently no-ops, so the reload-loop guard cannot survive
  // the reload — the page would loop forever. Abort instead so the user at
  // least sees the server-rendered HTML.
  if (readReloadFlag() !== currentPath) {
    console.error(
      `[vinext] Initial RSC fetch ${reason}; sessionStorage unavailable so the ` +
        "reload-loop guard cannot persist — aborting hydration. " +
        "Server-rendered HTML remains visible; client components will not hydrate.",
    );
    return null;
  }
  // One-shot diagnostic so a production reload is traceable. Only fires once
  // per broken path thanks to the sessionStorage flag above; not noisy.
  console.warn(
    `[vinext] Initial RSC fetch ${reason}; reloading once to let the server render the HTML error page`,
  );
  window.location.reload();
  return null;
}

async function readInitialRscStream(): Promise<ReadableStream<Uint8Array> | null> {
  const vinext = getVinextBrowserGlobal();

  if (vinext.__VINEXT_RSC__ || vinext.__VINEXT_RSC_CHUNKS__ || vinext.__VINEXT_RSC_DONE__) {
    // Reaching the embedded-RSC branch means the server successfully rendered
    // the page — any prior reload flag for this path is stale and must be
    // cleared so a future failure gets its own fresh recovery attempt.
    clearReloadFlag();

    if (vinext.__VINEXT_RSC__) {
      const embedData = vinext.__VINEXT_RSC__;
      delete vinext.__VINEXT_RSC__;

      const params = embedData.params ?? {};
      if (embedData.params) {
        applyClientParams(embedData.params);
      }
      if (embedData.nav) {
        restoreHydrationNavigationContext(
          embedData.nav.pathname,
          embedData.nav.searchParams,
          params,
        );
      }

      return chunksToReadableStream(embedData.rsc);
    }

    const params = vinext.__VINEXT_RSC_PARAMS__ ?? {};
    if (vinext.__VINEXT_RSC_PARAMS__) {
      applyClientParams(vinext.__VINEXT_RSC_PARAMS__);
    }
    if (vinext.__VINEXT_RSC_NAV__) {
      restoreHydrationNavigationContext(
        vinext.__VINEXT_RSC_NAV__.pathname,
        vinext.__VINEXT_RSC_NAV__.searchParams,
        params,
      );
    }

    return createProgressiveRscStream();
  }

  const rscResponse = await fetch(toRscUrl(window.location.pathname + window.location.search));

  if (!rscResponse.ok) {
    return recoverFromBadInitialRscResponse(`returned ${rscResponse.status}`);
  }
  // Guard against proxies/CDNs that return 200 with a rewritten Content-Type
  // (e.g. text/html instead of text/x-component). Such responses cannot be
  // parsed as RSC and would throw the same opaque parse error this fallback
  // exists to prevent.
  const contentType = rscResponse.headers.get("content-type") ?? "";
  if (!contentType.startsWith("text/x-component")) {
    return recoverFromBadInitialRscResponse(
      `returned non-RSC content-type "${contentType || "(missing)"}"`,
    );
  }
  // Missing body (e.g. 204 No Content, or an edge worker that returned ok
  // headers without piping the stream) fails the same way downstream.
  // Matches Next.js' `!res.body` branch in fetch-server-response.ts.
  if (!rscResponse.body) {
    return recoverFromBadInitialRscResponse("returned empty body");
  }
  // Successful RSC response clears the guard so a subsequent reload of the
  // same path after a transient failure still gets one recovery attempt.
  clearReloadFlag();

  let params: Record<string, string | string[]> = {};
  const paramsHeader = rscResponse.headers.get("X-Vinext-Params");
  if (paramsHeader) {
    try {
      params = JSON.parse(decodeURIComponent(paramsHeader)) as Record<string, string | string[]>;
      applyClientParams(params);
    } catch {
      // Ignore malformed param headers and continue with hydration.
    }
  }

  restoreHydrationNavigationContext(window.location.pathname, window.location.search, params);

  return rscResponse.body;
}

function registerServerActionCallback(): void {
  setServerCallback(async (id, args) => {
    const temporaryReferences = createTemporaryReferenceSet();
    const body = await encodeReply(args, { temporaryReferences });

    // Carry the interception context + mounted slots from the current router
    // state so the server-action re-render rebuilds the intercepted tree
    // instead of replacing it with the direct page. Parity with Next.js,
    // which sends `Next-URL` on action POSTs when the current tree contains
    // an interception route.
    const currentState = getBrowserRouterState();
    const { headers } = resolveServerActionRequestState({
      actionId: id,
      basePath: __basePath,
      elements: currentState.elements,
      previousNextUrl: currentState.previousNextUrl,
    });

    const fetchResponse = await fetch(toRscUrl(window.location.pathname + window.location.search), {
      method: "POST",
      headers,
      body,
    });

    if (isServerActionNotFoundResponse(fetchResponse)) {
      throw new Error(getServerActionNotFoundClientMessage(id));
    }

    const actionRedirect = fetchResponse.headers.get("x-action-redirect");
    if (actionRedirect) {
      if (isDangerousScheme(actionRedirect)) {
        console.error(DANGEROUS_URL_BLOCK_MESSAGE);
        return undefined;
      }

      // Check for external URLs that need a hard redirect.
      try {
        const redirectUrl = new URL(actionRedirect, window.location.origin);
        if (redirectUrl.origin !== window.location.origin) {
          window.location.href = actionRedirect;
          return undefined;
        }
      } catch {
        // Fall through to hard redirect below if URL parsing fails.
      }

      // Use hard redirect for all action redirects because vinext's server
      // currently returns an empty body for redirect responses. RSC navigation
      // requires a valid RSC payload. This is a known parity gap with Next.js,
      // which pre-renders the redirect target's RSC payload.
      const redirectType = fetchResponse.headers.get("x-action-redirect-type") ?? "replace";
      if (redirectType === "push") {
        window.location.assign(actionRedirect);
      } else {
        window.location.replace(actionRedirect);
      }
      return undefined;
    }

    clearClientNavigationCaches();

    const result = await createFromFetch<ServerActionResult | AppWireElements>(
      Promise.resolve(fetchResponse),
      { temporaryReferences },
    );

    // Server actions stay on the same URL and use commitSameUrlNavigatePayload()
    // for merge-based dispatch. This path does not call
    // activateNavigationSnapshot() because there is no URL change to commit, so
    // hooks continue reading the live external-store values directly. If server
    // actions ever trigger URL changes via RSC payload (instead of hard
    // redirects), this would need renderNavigationPayload().
    if (isServerActionResult(result)) {
      return commitSameUrlNavigatePayload(
        Promise.resolve(normalizeAppElements(result.root)),
        result.returnValue,
      );
    }

    return commitSameUrlNavigatePayload(Promise.resolve(normalizeAppElements(result)));
  });
}

async function main(): Promise<void> {
  registerServerActionCallback();

  const rscStream = await readInitialRscStream();
  // null signals that readInitialRscStream aborted hydration — either because
  // a reload is in flight (first-attempt recovery) or the endpoint is
  // persistently broken (post-reload). Bootstrap is a separate synchronous
  // helper so the null-branch structurally cannot reach any __VINEXT_RSC_*
  // global assignment, even if a future refactor interposes async work here.
  if (rscStream === null) return;
  bootstrapHydration(rscStream);
}

function bootstrapHydration(rscStream: ReadableStream<Uint8Array>): void {
  const root = normalizeAppElementsPromise(createFromReadableStream<AppWireElements>(rscStream));
  const initialNavigationSnapshot = createClientNavigationRenderSnapshot(
    window.location.href,
    latestClientParams,
  );
  replaceHistoryStateWithoutNotify(
    createHistoryStateWithPreviousNextUrl(window.history.state, null),
    "",
    window.location.href,
  );

  window.__VINEXT_RSC_ROOT__ = hydrateRoot(
    document,
    createElement(BrowserRoot, {
      initialElements: root,
      initialNavigationSnapshot,
    }),
    import.meta.env.DEV ? { onCaughtError: devOnCaughtError } : undefined,
  );
  window.__VINEXT_HYDRATED_AT = performance.now();

  window.__VINEXT_RSC_NAVIGATE__ = async function navigateRsc(
    href: string,
    redirectDepth = 0,
    navigationKind: NavigationKind = "navigate",
    historyUpdateMode?: HistoryUpdateMode,
    previousNextUrlOverride?: string | null,
    programmaticTransition = false,
  ): Promise<void> {
    let _snapshotPending = false;
    let pendingRouterState: PendingBrowserRouterState | null = null;
    // Hoist navId above try so the catch and finally blocks can reference it.
    const navId = ++activeNavigationId;

    // Loop variables for inline redirect following. On a redirect, these are
    // updated and the loop continues without returning or re-entering navigateRsc,
    // so a single pendingRouterState spans all hops and isPending never flashes.
    let currentHref = href;
    let currentHistoryMode = historyUpdateMode;
    let currentPrevNextUrl = previousNextUrlOverride;
    let redirectCount = redirectDepth;

    try {
      if (programmaticTransition) {
        pendingRouterState = beginPendingBrowserRouterState();
      }

      while (true) {
        if (redirectCount > 10) {
          console.error(
            "[vinext] Too many RSC redirects — aborting navigation to prevent infinite loop.",
          );
          window.location.href = currentHref;
          return;
        }

        const url = new URL(currentHref, window.location.origin);
        const rscUrl = toRscUrl(url.pathname + url.search);
        const requestState = getRequestState(navigationKind, currentPrevNextUrl);
        const requestInterceptionContext = requestState.interceptionContext;
        const requestPreviousNextUrl = requestState.previousNextUrl;

        // Compare against previous pending navigation first, then committed state.
        // This avoids isSameRoute misclassification during rapid back-to-back clicks.
        const navState = getClientNavigationState();
        const currentPath =
          navState?.pendingPathname ??
          navState?.cachedPathname ??
          stripBasePath(window.location.pathname, __basePath);

        const targetPath = stripBasePath(url.pathname, __basePath);
        const isSameRoute = targetPath === currentPath;

        // Set this navigation as the pending pathname, overwriting any previous.
        // Pass navId so only this navigation (or a newer one) can clear it later.
        setPendingPathname(url.pathname, navId);

        const elementsAtNavStart = getBrowserRouterState().elements;
        const mountedSlotsHeader = getMountedSlotIdsHeader(elementsAtNavStart);
        const cachedRoute = getVisitedResponse(
          rscUrl,
          requestInterceptionContext,
          mountedSlotsHeader,
          navigationKind,
        );
        if (cachedRoute) {
          // Check stale-navigation before and after createFromFetch. The pre-check
          // avoids wasted parse work; the post-check catches supersessions that
          // occur during the await. createFromFetch on a buffered response is fast
          // but still async, so the window exists. The non-cached path (below) places
          // its heavyweight async steps (fetch, snapshotRscResponse, createFromFetch)
          // between navId checks consistently; the cached path omits the check between
          // createClientNavigationRenderSnapshot (synchronous) and createFromFetch
          // because there is no await in that gap.
          if (navId !== activeNavigationId) return;
          const cachedParams = cachedRoute.params;
          // createClientNavigationRenderSnapshot is synchronous (URL parsing + param
          // wrapping only) — no stale-navigation recheck needed between here and the
          // next await.
          const cachedNavigationSnapshot = createClientNavigationRenderSnapshot(
            currentHref,
            cachedParams,
          );
          const cachedPayload = normalizeAppElementsPromise(
            createFromFetch<AppWireElements>(
              Promise.resolve(restoreRscResponse(cachedRoute.response)),
            ),
          );
          if (navId !== activeNavigationId) return;
          _snapshotPending = true; // Set before renderNavigationPayload
          try {
            await renderNavigationPayload(
              cachedPayload,
              cachedNavigationSnapshot,
              currentHref,
              navId,
              currentHistoryMode,
              cachedParams,
              requestPreviousNextUrl,
              pendingRouterState,
              isSameRoute,
              toActionType(navigationKind),
            );
          } finally {
            // Always clear _snapshotPending so the outer catch does not
            // double-decrement if renderNavigationPayload throws.
            _snapshotPending = false;
          }
          return;
        }

        // Continue using the slot state captured at navigation start for fetches
        // and prefetch compatibility decisions.

        let navResponse: Response | undefined;
        let navResponseUrl: string | null = null;
        if (navigationKind !== "refresh") {
          const prefetchedResponse = consumePrefetchResponse(
            rscUrl,
            requestInterceptionContext,
            mountedSlotsHeader,
          );
          if (prefetchedResponse) {
            navResponse = restoreRscResponse(prefetchedResponse, false);
            navResponseUrl = prefetchedResponse.url;
          }
        }

        if (!navResponse) {
          const requestHeaders = createRscRequestHeaders(requestInterceptionContext);
          if (mountedSlotsHeader) {
            requestHeaders.set("X-Vinext-Mounted-Slots", mountedSlotsHeader);
          }
          navResponse = await fetch(rscUrl, {
            headers: requestHeaders,
            credentials: "include",
          });
        }

        if (navId !== activeNavigationId) return;

        // Any response that isn't a valid RSC payload (non-ok status,
        // missing/rewritten Content-Type, or missing body) means the server
        // returned something we cannot parse — typically an HTML error page
        // or a proxy-rewritten response. Parsing such a body as an RSC stream
        // throws a cryptic "Connection closed" error. Match Next.js behavior
        // (fetch-server-response.ts:211, `!isFlightResponse || !res.ok || !res.body`):
        // hard-navigate to the response URL so the server can render the correct
        // error page as HTML. The outer finally handles
        // settlePendingBrowserRouterState and clearPendingPathname on this
        // return path.
        //
        // Prefer the post-redirect response URL over `currentHref`: on a
        // redirect chain like `/old` → 307 → `/new` → 500, the browser's
        // fetch already followed the redirect, so `navResponse.url` is the
        // failing `/new` destination. Hard-navigating there directly avoids
        // bouncing off `/old` just to re-follow the same 307, which would
        // flash the wrong URL in the address bar and mis-key analytics.
        // Matches Next.js' `doMpaNavigation(responseUrl.toString())`. Falls
        // back to `currentHref` when no response URL is available.
        const navContentType = navResponse.headers.get("content-type") ?? "";
        const isRscResponse = navContentType.startsWith("text/x-component");
        if (!navResponse.ok || !isRscResponse || !navResponse.body) {
          const responseUrl = navResponseUrl ?? navResponse.url;
          let hardNavTarget = currentHref;
          if (responseUrl) {
            const parsed = new URL(responseUrl, window.location.origin);
            const origUrl = new URL(currentHref, window.location.origin);
            let pathname = parsed.pathname.replace(/\.rsc$/, "");
            // toRscUrl strips trailing slash before appending .rsc, so the
            // response URL loses it on the round-trip. Restore it when the
            // original href had one so sites with trailingSlash:true don't
            // incur an extra 308 to the canonical form on the error path.
            if (
              origUrl.pathname.length > 1 &&
              origUrl.pathname.endsWith("/") &&
              !pathname.endsWith("/")
            ) {
              pathname += "/";
            }
            hardNavTarget = pathname + parsed.search;
            // Preserve the hash from the user's clicked href — a .rsc response
            // URL never carries a fragment, so dropping it would silently strip
            // `/foo#section` down to `/foo`.
            if (origUrl.hash) hardNavTarget += origUrl.hash;
          }
          window.location.href = hardNavTarget;
          return;
        }

        const finalUrl = new URL(navResponseUrl ?? navResponse.url, window.location.origin);
        const requestedUrl = new URL(rscUrl, window.location.origin);

        if (finalUrl.pathname !== requestedUrl.pathname) {
          // Server-side redirect: update the URL in history and loop to fetch
          // the destination without settling pendingRouterState. This keeps
          // isPending true across all redirect hops instead of flashing false.
          const destinationPath = finalUrl.pathname.replace(/\.rsc$/, "") + finalUrl.search;
          replaceHistoryStateWithoutNotify(
            createHistoryStateWithPreviousNextUrl(null, requestPreviousNextUrl),
            "",
            destinationPath,
          );

          currentHref = destinationPath;
          // URL already written above; the commit effect must not push/replace again.
          currentHistoryMode = undefined;
          currentPrevNextUrl = requestPreviousNextUrl;
          redirectCount += 1;
          continue;
        }

        let navParams: Record<string, string | string[]> = {};
        const paramsHeader = navResponse.headers.get("X-Vinext-Params");
        if (paramsHeader) {
          try {
            navParams = JSON.parse(decodeURIComponent(paramsHeader)) as Record<
              string,
              string | string[]
            >;
          } catch {
            // navParams stays as {}
          }
        }
        // Build snapshot from local params, not latestClientParams
        const navigationSnapshot = createClientNavigationRenderSnapshot(currentHref, navParams);

        const responseSnapshot = await snapshotRscResponse(navResponse);

        if (navId !== activeNavigationId) return;

        const rscPayload = normalizeAppElementsPromise(
          createFromFetch<AppWireElements>(Promise.resolve(restoreRscResponse(responseSnapshot))),
        );

        if (navId !== activeNavigationId) return;

        _snapshotPending = true; // Set before renderNavigationPayload
        try {
          await renderNavigationPayload(
            rscPayload,
            navigationSnapshot,
            currentHref,
            navId,
            currentHistoryMode,
            navParams,
            requestPreviousNextUrl,
            pendingRouterState,
            isSameRoute,
            toActionType(navigationKind),
          );
        } finally {
          // Always clear _snapshotPending after renderNavigationPayload returns or
          // throws. renderNavigationPayload's inner catch already calls
          // commitClientNavigationState() on synchronous errors and re-throws, so
          // the outer catch must not call it again. Clearing here prevents the outer
          // catch from double-decrementing navigationSnapshotActiveCount.
          _snapshotPending = false;
        }
        // Don't cache the response if this navigation was superseded during
        // renderNavigationPayload's await — the elements were never dispatched.
        if (navId !== activeNavigationId) return;
        // Store the visited response only after renderNavigationPayload succeeds.
        // If we stored it before and renderNavigationPayload threw, a future
        // back/forward navigation could replay a snapshot from a navigation that
        // never actually rendered successfully.
        const resolvedElements = await rscPayload;
        const metadata = readAppElementsMetadata(resolvedElements);
        storeVisitedResponseSnapshot(
          rscUrl,
          resolveVisitedResponseInterceptionContext(
            requestInterceptionContext,
            metadata.interceptionContext,
          ),
          responseSnapshot,
          navParams,
        );
        return;
      }
    } catch (error) {
      // Only decrement counter if snapshot was activated but not yet committed.
      // renderNavigationPayload clears _snapshotPending (via its inner try-finally)
      // before re-throwing, so this guard correctly skips the double-decrement case.
      if (_snapshotPending) {
        _snapshotPending = false;
        commitClientNavigationState(navId);
      }
      // Don't hard-navigate to a stale URL if this navigation was superseded by
      // a newer one — the newer navigation is already in flight and would be clobbered.
      if (navId !== activeNavigationId) return;
      // Suppress the diagnostic when the page is unloading: a hard-nav or anchor
      // click tears down the document and aborts any in-flight RSC fetch, which
      // surfaces here as an error. The page is already going away, so the log
      // is just noise. Mirrors Next.js' isPageUnloading pattern.
      if (!isPageUnloading) {
        console.error("[vinext] RSC navigation error:", error);
      }
      window.location.href = currentHref;
    } finally {
      // Single settlement site: covers normal return, early returns on stale-id
      // checks, and error paths. The finally runs even when the catch returns.
      // settlePendingBrowserRouterState is idempotent via the settled flag.
      settlePendingBrowserRouterState(pendingRouterState);
      // Clear pendingPathname on all exit paths. On the success path this fires
      // before the RAF commit effect, but commitClientNavigationState() in the
      // commit effect clears it again — that double-clear is idempotent. Skipped
      // when superseded so a newer navigation's pendingPathname is not disturbed.
      if (navId === activeNavigationId) {
        clearPendingPathname(navId);
      }
    }
  };

  if ("scrollRestoration" in history) {
    history.scrollRestoration = "manual";
  }

  // Note: This popstate handler runs for App Router (RSC navigation available).
  // It coordinates scroll restoration with the pending RSC navigation.
  // Pages Router scroll restoration is handled in shims/navigation.ts:1289 with
  // microtask-based deferral for compatibility with non-RSC navigation.
  // See: https://github.com/vercel/next.js/discussions/41934#discussioncomment-4602607
  window.addEventListener("popstate", (event) => {
    notifyAppRouterTransitionStart(window.location.href, "traverse");
    const pendingNavigation =
      window.__VINEXT_RSC_NAVIGATE__?.(window.location.href, 0, "traverse") ?? Promise.resolve();
    window.__VINEXT_RSC_PENDING__ = pendingNavigation;
    void pendingNavigation.finally(() => {
      restorePopstateScrollPosition(event.state);
      if (window.__VINEXT_RSC_PENDING__ === pendingNavigation) {
        window.__VINEXT_RSC_PENDING__ = null;
      }
    });
  });

  if (import.meta.hot) {
    import.meta.hot.on("rsc:update", async () => {
      try {
        clearClientNavigationCaches();
        const navigationSnapshot = createClientNavigationRenderSnapshot(
          window.location.href,
          latestClientParams,
        );
        // Interception context on HMR re-renders is intentionally deferred:
        // preserving intercepted modal state across HMR reloads is out of scope
        // for the previousNextUrl mechanism.
        const pending = await createPendingNavigationCommit({
          currentState: getBrowserRouterState(),
          nextElements: normalizeAppElementsPromise(
            createFromFetch<AppWireElements>(
              fetch(toRscUrl(window.location.pathname + window.location.search)),
            ),
          ),
          navigationSnapshot,
          renderId: ++nextNavigationRenderId,
          type: "replace",
        });
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
      } catch (error) {
        console.error("[vinext] RSC HMR error:", error);
      }
    });
  }
}

if (typeof document !== "undefined") {
  window.addEventListener("pagehide", () => {
    isPageUnloading = true;
  });
  // Reset on pageshow so a bfcache-restored document does not resume with
  // the flag stuck at true, which would silently swallow every subsequent
  // RSC navigation error for the lifetime of that tab. Matches Next.js'
  // fetch-server-response.ts handler pair.
  window.addEventListener("pageshow", () => {
    isPageUnloading = false;
  });
  void main();
}
