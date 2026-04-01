/// <reference types="vite/client" />

import {
  createElement,
  startTransition,
  use,
  useLayoutEffect,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
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
  commitClientNavigationState,
  consumePrefetchResponse,
  createClientNavigationRenderSnapshot,
  getClientNavigationRenderContext,
  getPrefetchCache,
  getPrefetchedUrls,
  pushHistoryStateWithoutNotify,
  replaceClientParamsWithoutNotify,
  replaceHistoryStateWithoutNotify,
  restoreRscResponse,
  setClientParams,
  snapshotRscResponse,
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

type SearchParamInput = ConstructorParameters<typeof URLSearchParams>[0];

type ServerActionResult = {
  root: ReactNode;
  returnValue?: {
    ok: boolean;
    data: unknown;
  };
};

type BrowserTreeState = {
  renderId: number;
  node: ReactNode;
  navigationSnapshot: ClientNavigationRenderSnapshot;
};
type NavigationKind = "navigate" | "traverse" | "refresh";
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
let setBrowserTreeState: Dispatch<SetStateAction<BrowserTreeState>> | null = null;
let latestClientParams: Record<string, string | string[]> = {};
const visitedResponseCache = new Map<string, VisitedResponseCacheEntry>();

function isServerActionResult(value: unknown): value is ServerActionResult {
  return !!value && typeof value === "object" && "root" in value;
}

function getBrowserTreeStateSetter(): Dispatch<SetStateAction<BrowserTreeState>> {
  if (!setBrowserTreeState) {
    throw new Error("[vinext] Browser tree state is not initialized");
  }
  return setBrowserTreeState;
}

function applyClientParams(params: Record<string, string | string[]>): void {
  latestClientParams = params;
  setClientParams(params);
}

function stageClientParams(params: Record<string, string | string[]>): void {
  // NB: latestClientParams diverges from ClientNavigationState.clientParams
  // between staging and commit. Server action snapshots (updateBrowserTree
  // calls inside registerServerActionCallback) read latestClientParams, so a
  // server action fired during this window would get the pending (not yet
  // committed) params. This is acceptable because the commit effect fires
  // synchronously in the same React commit phase, keeping the window
  // vanishingly small.
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
        // Superseded navigation: balance its activateNavigationSnapshot()
        commitClientNavigationState();
      }
    }
  }
}

function createNavigationCommitEffect(
  href: string,
  historyUpdateMode: HistoryUpdateMode | undefined,
): () => void {
  return () => {
    const targetHref = new URL(href, window.location.origin).href;

    if (historyUpdateMode === "replace" && window.location.href !== targetHref) {
      replaceHistoryStateWithoutNotify(null, "", href);
    } else if (historyUpdateMode === "push" && window.location.href !== targetHref) {
      pushHistoryStateWithoutNotify(null, "", href);
    }

    commitClientNavigationState();
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
  navigationKind: NavigationKind,
): VisitedResponseCacheEntry | null {
  const cached = visitedResponseCache.get(rscUrl);
  if (!cached) {
    return null;
  }

  if (navigationKind === "refresh") {
    return null;
  }

  if (navigationKind === "traverse") {
    const createdAt = cached.expiresAt - VISITED_RESPONSE_CACHE_TTL;
    if (Date.now() - createdAt >= MAX_TRAVERSAL_CACHE_TTL) {
      visitedResponseCache.delete(rscUrl);
      return null;
    }
    // LRU: promote to most-recently-used (delete + re-insert moves to end of Map)
    visitedResponseCache.delete(rscUrl);
    visitedResponseCache.set(rscUrl, cached);
    return cached;
  }

  if (cached.expiresAt > Date.now()) {
    // LRU: promote to most-recently-used
    visitedResponseCache.delete(rscUrl);
    visitedResponseCache.set(rscUrl, cached);
    return cached;
  }

  visitedResponseCache.delete(rscUrl);
  return null;
}

function storeVisitedResponseSnapshot(
  rscUrl: string,
  snapshot: CachedRscResponse,
  params: Record<string, string | string[]>,
): void {
  visitedResponseCache.delete(rscUrl);
  evictVisitedResponseCacheIfNeeded();
  const now = Date.now();
  visitedResponseCache.set(rscUrl, {
    params,
    expiresAt: now + VISITED_RESPONSE_CACHE_TTL,
    response: snapshot,
  });
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

function BrowserRoot({
  initialNode,
  initialNavigationSnapshot,
}: {
  initialNode: ReactNode | Promise<ReactNode>;
  initialNavigationSnapshot: ClientNavigationRenderSnapshot;
}) {
  const resolvedNode = use(initialNode as Promise<ReactNode>);
  const [treeState, setTreeState] = useState<BrowserTreeState>({
    renderId: 0,
    node: resolvedNode,
    navigationSnapshot: initialNavigationSnapshot,
  });

  // Assign the module-level setter via useLayoutEffect instead of during render
  // to avoid side effects that React Strict Mode / concurrent features may
  // call multiple times. useLayoutEffect fires synchronously during commit,
  // before hydrateRoot returns to main(), so setBrowserTreeState is available
  // before __VINEXT_RSC_NAVIGATE__ is assigned. setTreeState is referentially
  // stable so the effect only runs on mount.
  useLayoutEffect(() => {
    setBrowserTreeState = setTreeState;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- setTreeState is referentially stable

  const committedTree = createElement(
    NavigationCommitSignal,
    { renderId: treeState.renderId },
    treeState.node,
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

function updateBrowserTree(
  node: ReactNode | Promise<ReactNode>,
  navigationSnapshot: ClientNavigationRenderSnapshot,
  renderId: number,
  useTransitionMode: boolean,
  snapshotActivated = false,
): void {
  const setter = getBrowserTreeStateSetter();

  const resolvedThenSet = (resolvedNode: ReactNode) => {
    setter({ renderId, node: resolvedNode, navigationSnapshot });
  };

  // Balance the activate/commit pairing if the async payload rejects after
  // activateNavigationSnapshot() was called. Only decrement when snapshotActivated
  // is true — server action callers skip renderNavigationPayload entirely and
  // never call activateNavigationSnapshot(), so decrementing there would corrupt
  // the counter for any concurrent RSC navigation.
  const handleAsyncError = () => {
    pendingNavigationPrePaintEffects.delete(renderId);
    const resolve = pendingNavigationCommits.get(renderId);
    pendingNavigationCommits.delete(renderId);
    if (snapshotActivated) {
      commitClientNavigationState();
    }
    resolve?.();
  };

  if (node != null && typeof (node as PromiseLike<ReactNode>).then === "function") {
    const thenable = node as PromiseLike<ReactNode>;
    if (useTransitionMode) {
      void thenable.then(
        (resolved) => startTransition(() => resolvedThenSet(resolved)),
        handleAsyncError,
      );
    } else {
      void thenable.then(resolvedThenSet, handleAsyncError);
    }
    return;
  }

  const syncNode = node as ReactNode;
  if (useTransitionMode) {
    startTransition(() => resolvedThenSet(syncNode));
    return;
  }

  resolvedThenSet(syncNode);
}

function renderNavigationPayload(
  payload: Promise<ReactNode> | ReactNode,
  navigationSnapshot: ClientNavigationRenderSnapshot,
  prePaintEffect: (() => void) | null = null,
  useTransition = true,
): Promise<void> {
  const renderId = ++nextNavigationRenderId;
  queuePrePaintNavigationEffect(renderId, prePaintEffect);

  const committed = new Promise<void>((resolve) => {
    pendingNavigationCommits.set(renderId, resolve);
  });

  activateNavigationSnapshot();

  // Wrap updateBrowserTree in try-catch to ensure counter is decremented
  // if a synchronous error occurs before the async promise chain is established.
  try {
    updateBrowserTree(payload, navigationSnapshot, renderId, useTransition, true);
  } catch (error) {
    // Clean up pending state and decrement counter on synchronous error.
    pendingNavigationPrePaintEffects.delete(renderId);
    const resolve = pendingNavigationCommits.get(renderId);
    pendingNavigationCommits.delete(renderId);
    commitClientNavigationState();
    resolve?.();
    throw error; // Re-throw to maintain error propagation
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

function restorePopstateScrollPosition(state: unknown): void {
  if (!(state && typeof state === "object" && "__vinext_scrollY" in state)) {
    return;
  }

  const y = Number(state.__vinext_scrollY);
  const x = "__vinext_scrollX" in state ? Number(state.__vinext_scrollX) : 0;

  requestAnimationFrame(() => {
    window.scrollTo(x, y);
  });
}

async function readInitialRscStream(): Promise<ReadableStream<Uint8Array>> {
  const vinext = getVinextBrowserGlobal();

  if (vinext.__VINEXT_RSC__ || vinext.__VINEXT_RSC_CHUNKS__ || vinext.__VINEXT_RSC_DONE__) {
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

  if (!rscResponse.body) {
    throw new Error("[vinext] Initial RSC response had no body");
  }

  return rscResponse.body;
}

function registerServerActionCallback(): void {
  setServerCallback(async (id, args) => {
    const temporaryReferences = createTemporaryReferenceSet();
    const body = await encodeReply(args, { temporaryReferences });

    const fetchResponse = await fetch(toRscUrl(window.location.pathname + window.location.search), {
      method: "POST",
      headers: { "x-rsc-action": id },
      body,
    });

    const actionRedirect = fetchResponse.headers.get("x-action-redirect");
    if (actionRedirect) {
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

    const result = await createFromFetch<ServerActionResult | ReactNode>(
      Promise.resolve(fetchResponse),
      { temporaryReferences },
    );

    // Note: Server actions update the tree via updateBrowserTree directly (not
    // renderNavigationPayload) because they stay on the same URL. This means
    // activateNavigationSnapshot is not called, so hooks use useSyncExternalStore
    // values directly. snapshotActivated is intentionally omitted (defaults false)
    // so handleAsyncError skips commitClientNavigationState() — decrementing an
    // unincremented counter would corrupt it for concurrent RSC navigations.
    // If server actions ever trigger URL changes via RSC payload (instead of hard
    // redirects), this would need renderNavigationPayload() + snapshotActivated=true.
    if (isServerActionResult(result)) {
      updateBrowserTree(
        result.root,
        createClientNavigationRenderSnapshot(window.location.href, latestClientParams),
        ++nextNavigationRenderId,
        false,
      );
      if (result.returnValue) {
        if (!result.returnValue.ok) throw result.returnValue.data;
        return result.returnValue.data;
      }
      return undefined;
    }

    // Same reasoning as above: snapshotActivated omitted intentionally.
    updateBrowserTree(
      result,
      createClientNavigationRenderSnapshot(window.location.href, latestClientParams),
      ++nextNavigationRenderId,
      false,
    );
    return result;
  });
}

async function main(): Promise<void> {
  registerServerActionCallback();

  const rscStream = await readInitialRscStream();
  const root = createFromReadableStream<ReactNode>(rscStream);
  const initialNavigationSnapshot = createClientNavigationRenderSnapshot(
    window.location.href,
    latestClientParams,
  );

  window.__VINEXT_RSC_ROOT__ = hydrateRoot(
    document,
    createElement(BrowserRoot, {
      initialNode: root,
      initialNavigationSnapshot,
    }),
    import.meta.env.DEV ? { onCaughtError() {} } : undefined,
  );
  window.__VINEXT_HYDRATED_AT = performance.now();

  window.__VINEXT_RSC_NAVIGATE__ = async function navigateRsc(
    href: string,
    redirectDepth = 0,
    navigationKind: NavigationKind = "navigate",
    historyUpdateMode?: HistoryUpdateMode,
  ): Promise<void> {
    if (redirectDepth > 10) {
      console.error(
        "[vinext] Too many RSC redirects — aborting navigation to prevent infinite loop.",
      );
      window.location.href = href;
      return;
    }

    let _snapshotPending = false;
    // Hoist navId above try so the catch block can guard against hard-navigating
    // to a stale URL when this navigation has already been superseded.
    const navId = ++activeNavigationId;
    try {
      const url = new URL(href, window.location.origin);
      const rscUrl = toRscUrl(url.pathname + url.search);
      // Use startTransition for same-route navigations (searchParam changes)
      // so React keeps the old UI visible during the transition. For cross-route
      // navigations (different pathname), use synchronous updates — React's
      // startTransition hangs in Firefox when replacing the entire tree.
      // NB: During rapid navigations, window.location.pathname may not reflect
      // the previous navigation's URL yet (URL commit is deferred). This could
      // cause misclassification (synchronous instead of startTransition or vice
      // versa), resulting in slightly less smooth transitions but correct behavior.
      const isSameRoute =
        stripBasePath(url.pathname, __basePath) ===
        stripBasePath(window.location.pathname, __basePath);
      const cachedRoute = getVisitedResponse(rscUrl, navigationKind);
      const navigationCommitEffect = createNavigationCommitEffect(href, historyUpdateMode);

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
        const cachedNavigationSnapshot = createClientNavigationRenderSnapshot(href, cachedParams);
        const cachedPayload = await createFromFetch<ReactNode>(
          Promise.resolve(restoreRscResponse(cachedRoute.response)),
        );
        if (navId !== activeNavigationId) return;
        // Stage params only after confirming this navigation hasn't been superseded.
        // Set _snapshotPending before stageClientParams: if renderNavigationPayload
        // throws synchronously, its inner catch calls commitClientNavigationState()
        // which would flush pendingClientParams for a route that never rendered.
        // Ordering _snapshotPending first makes the intent explicit — params are
        // staged as part of an in-flight snapshot, not as a standalone side-effect.
        _snapshotPending = true; // Set before renderNavigationPayload
        stageClientParams(cachedParams); // NB: if this throws, outer catch hard-navigates, resetting all JS state
        try {
          await renderNavigationPayload(
            cachedPayload,
            cachedNavigationSnapshot,
            navigationCommitEffect,
            isSameRoute,
          );
        } finally {
          // Always clear _snapshotPending so the outer catch does not
          // double-decrement if renderNavigationPayload throws.
          _snapshotPending = false;
        }
        return;
      }

      let navResponse: Response | undefined;
      let navResponseUrl: string | null = null;
      if (navigationKind !== "refresh") {
        const prefetchedResponse = consumePrefetchResponse(rscUrl);
        if (prefetchedResponse) {
          navResponse = restoreRscResponse(prefetchedResponse, false);
          navResponseUrl = prefetchedResponse.url;
        }
      }

      if (!navResponse) {
        navResponse = await fetch(rscUrl, {
          headers: { Accept: "text/x-component" },
          credentials: "include",
        });
      }

      if (navId !== activeNavigationId) return;

      const finalUrl = new URL(navResponseUrl ?? navResponse.url, window.location.origin);
      const requestedUrl = new URL(rscUrl, window.location.origin);

      if (finalUrl.pathname !== requestedUrl.pathname) {
        const destinationPath = finalUrl.pathname.replace(/\.rsc$/, "") + finalUrl.search;
        replaceHistoryStateWithoutNotify(null, "", destinationPath);

        const navigate = window.__VINEXT_RSC_NAVIGATE__;
        if (!navigate) {
          window.location.href = destinationPath;
          return;
        }

        // The URL has already been updated via replaceHistoryStateWithoutNotify above,
        // so the recursive navigation should NOT push/replace again. Pass undefined
        // for historyUpdateMode to make the commit effect a no-op for history updates.
        return navigate(destinationPath, redirectDepth + 1, navigationKind, undefined);
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
      const navigationSnapshot = createClientNavigationRenderSnapshot(href, navParams);

      const responseSnapshot = await snapshotRscResponse(navResponse);

      if (navId !== activeNavigationId) return;

      const rscPayload = await createFromFetch<ReactNode>(
        Promise.resolve(restoreRscResponse(responseSnapshot)),
      );

      if (navId !== activeNavigationId) return;

      // Stage params only after confirming this navigation hasn't been superseded
      // (avoids stale cache entries). Set _snapshotPending before stageClientParams
      // for the same reason as the cached path above: ensures params are only staged
      // as part of an in-flight snapshot.
      _snapshotPending = true; // Set before renderNavigationPayload
      stageClientParams(navParams); // NB: if this throws, outer catch hard-navigates, resetting all JS state
      try {
        await renderNavigationPayload(
          rscPayload,
          navigationSnapshot,
          navigationCommitEffect,
          isSameRoute,
        );
      } finally {
        // Always clear _snapshotPending after renderNavigationPayload returns or
        // throws. renderNavigationPayload's inner catch already calls
        // commitClientNavigationState() on synchronous errors and re-throws, so
        // the outer catch must not call it again. Clearing here prevents the outer
        // catch from double-decrementing navigationSnapshotActiveCount.
        _snapshotPending = false;
      }
      // Store the visited response only after renderNavigationPayload succeeds.
      // If we stored it before and renderNavigationPayload threw, a future
      // back/forward navigation could replay a snapshot from a navigation that
      // never actually rendered successfully.
      storeVisitedResponseSnapshot(rscUrl, responseSnapshot, navParams);
      return;
    } catch (error) {
      // Only decrement counter if snapshot was activated but not yet committed.
      // renderNavigationPayload clears _snapshotPending (via its inner try-finally)
      // before re-throwing, so this guard correctly skips the double-decrement case.
      if (_snapshotPending) {
        _snapshotPending = false;
        commitClientNavigationState();
      }
      // Don't hard-navigate to a stale URL if this navigation was superseded by
      // a newer one — the newer navigation is already in flight and would be clobbered.
      if (navId !== activeNavigationId) return;
      console.error("[vinext] RSC navigation error:", error);
      window.location.href = href;
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
        const rscPayload = await createFromFetch<ReactNode>(
          fetch(toRscUrl(window.location.pathname + window.location.search)),
        );
        // HMR updates skip renderNavigationPayload — no snapshot activated.
        updateBrowserTree(
          rscPayload,
          createClientNavigationRenderSnapshot(window.location.href, latestClientParams),
          ++nextNavigationRenderId,
          false,
        );
      } catch (error) {
        console.error("[vinext] RSC HMR error:", error);
      }
    });
  }
}

void main();
