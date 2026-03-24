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
import {
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
import {
  chunksToReadableStream,
  createProgressiveRscStream,
  getVinextBrowserGlobal,
} from "./app-browser-stream.js";

type SearchParamInput = ConstructorParameters<typeof URLSearchParams>[0];

interface ServerActionResult {
  root: ReactNode;
  returnValue?: {
    ok: boolean;
    data: unknown;
  };
}

type BrowserTreeState = {
  renderId: number;
  node: ReactNode | Promise<ReactNode>;
  navigationSnapshot: ClientNavigationRenderSnapshot;
};
type NavigationKind = "navigate" | "traverse" | "refresh";
type HistoryUpdateMode = "push" | "replace";
interface VisitedResponseCacheEntry {
  params: Record<string, string | string[]>;
  createdAt: number;
  regularExpiresAt: number;
  response: Awaited<ReturnType<typeof snapshotRscResponse>>;
}

const MAX_VISITED_RESPONSE_CACHE_SIZE = 50;
const TRAVERSE_MAX_STALENESS = 5 * 60_000; // 5 minutes for back/forward
const VISITED_RESPONSE_CACHE_TTL = 30_000;

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

function isThenable<T>(value: T | Promise<T>): value is Promise<T> {
  return (
    typeof value === "object" &&
    value !== null &&
    "then" in value &&
    typeof value.then === "function"
  );
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
 * mounts, so its pre-paint effect — which calls commitClientNavigationState
 * to decrement navigationSnapshotActiveCount — never fires. By draining all
 * effects ≤ the committed renderId here, the winning transition cleans up
 * after any superseded ones, keeping the counter balanced.
 */
function drainPrePaintEffects(upToRenderId: number): void {
  for (const [id, effect] of pendingNavigationPrePaintEffects) {
    if (id <= upToRenderId) {
      pendingNavigationPrePaintEffects.delete(id);
      if (id === upToRenderId) {
        // Only the winning navigation should mutate history — run its
        // full effect (history push/replace + counter decrement).
        effect();
      } else {
        // Superseded navigations were never rendered. Just balance the
        // snapshot counter without pushing phantom history entries.
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
    if (historyUpdateMode === "replace") {
      replaceHistoryStateWithoutNotify(null, "", href);
    } else if (historyUpdateMode === "push") {
      pushHistoryStateWithoutNotify(null, "", href);
    }

    commitClientNavigationState();
  };
}

function pruneVisitedResponseCache(now: number): void {
  for (const [rscUrl, entry] of visitedResponseCache) {
    if (entry.regularExpiresAt <= now) {
      visitedResponseCache.delete(rscUrl);
    }
  }
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
    // Back/forward bypasses the regular TTL for instant navigation,
    // but still enforces a max staleness to avoid serving very old data.
    if (Date.now() - cached.createdAt > TRAVERSE_MAX_STALENESS) {
      visitedResponseCache.delete(rscUrl);
      return null;
    }
    return cached;
  }

  if (cached.regularExpiresAt > Date.now()) {
    return cached;
  }

  visitedResponseCache.delete(rscUrl);
  return null;
}

function storeVisitedResponseSnapshot(
  rscUrl: string,
  snapshot: CachedRscResponse,
  params: Record<string, string | string[]> = latestClientParams,
): void {
  const now = Date.now();
  pruneVisitedResponseCache(now);
  visitedResponseCache.delete(rscUrl);
  evictVisitedResponseCacheIfNeeded();
  visitedResponseCache.set(rscUrl, {
    params,
    createdAt: now,
    regularExpiresAt: now + VISITED_RESPONSE_CACHE_TTL,
    response: snapshot,
  });
}

function resolveCommittedNavigations(renderId: number): void {
  for (const [pendingId, resolve] of pendingNavigationCommits) {
    if (pendingId <= renderId) {
      pendingNavigationCommits.delete(pendingId);
      resolve();
    }
  }
}

function NavigationCommitSignal({ children, renderId }: { children: ReactNode; renderId: number }) {
  useLayoutEffect(() => {
    // Drain pre-paint effects for this renderId AND any superseded ones
    // whose NavigationCommitSignal never mounted (see drainPrePaintEffects).
    drainPrePaintEffects(renderId);

    // Resolve the navigation commit promise after the browser commits
    // the next frame. requestAnimationFrame callbacks scheduled from
    // useLayoutEffect fire before the following frame's paint.
    const frame = requestAnimationFrame(() => {
      resolveCommittedNavigations(renderId);
    });

    return () => {
      cancelAnimationFrame(frame);
    };
  }, [renderId]);

  return children;
}

function BrowserRoot({
  initialNode,
  initialNavigationSnapshot,
}: {
  initialNode: ReactNode;
  initialNavigationSnapshot: ClientNavigationRenderSnapshot;
}) {
  const [treeState, setTreeState] = useState<BrowserTreeState>({
    renderId: 0,
    node: initialNode,
    navigationSnapshot: initialNavigationSnapshot,
  });

  useLayoutEffect(() => {
    // setTreeState is stable (React guarantee), and BrowserRoot is a
    // singleton that never unmounts. No cleanup needed — omitting it
    // avoids a Strict Mode double-invocation window where the setter
    // would briefly be null between cleanup and re-mount.
    setBrowserTreeState = setTreeState;
  }, []);

  const resolvedNode = isThenable(treeState.node) ? use(treeState.node) : treeState.node;

  const committedTree = createElement(NavigationCommitSignal, {
    children: resolvedNode,
    renderId: treeState.renderId,
  });

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
  useTransition: boolean,
): void {
  const setter = getBrowserTreeStateSetter();
  const applyUpdate = () => {
    setter({ renderId, node, navigationSnapshot });
  };

  if (useTransition) {
    startTransition(applyUpdate);
    return;
  }

  applyUpdate();
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

  // Activate the snapshot so hooks prefer the context value during the
  // transition render. Deactivated by commitClientNavigationState() in
  // the pre-paint effect after the transition commits.
  activateNavigationSnapshot();
  updateBrowserTree(payload, navigationSnapshot, renderId, useTransition);

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

// Simplified scroll restoration for App Router popstate. The full version
// in navigation.ts waits for __VINEXT_RSC_PENDING__ (needed for Pages Router
// where the popstate listener runs before the RSC handler). Here, the
// popstate handler awaits __VINEXT_RSC_NAVIGATE__ first, so scroll
// restoration runs after the new content is rendered.
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

    const result = await createFromFetch<ServerActionResult | ReactNode>(
      Promise.resolve(fetchResponse),
      { temporaryReferences },
    );

    // Clear navigation caches after the action succeeds — server actions
    // may have mutated data, making cached responses stale. We clear here
    // (not before the fetch) so failed actions don't unnecessarily
    // invalidate valid caches.
    clearClientNavigationCaches();

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
  const root = await createFromReadableStream<ReactNode>(rscStream);
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

    try {
      const url = new URL(href, window.location.origin);
      const rscUrl = toRscUrl(url.pathname + url.search);
      // Assign a unique ID for this navigation. If a newer navigation starts
      // before this one finishes (rapid clicks), we bail out after await
      // points to avoid pushing stale URLs to history.
      const navId = ++activeNavigationId;
      // Use startTransition for same-route navigations (searchParam changes)
      // so React keeps the old UI visible during the transition. For cross-route
      // navigations (different pathname), use synchronous updates — React's
      // startTransition hangs in Firefox when replacing the entire tree.
      const isSameRoute = url.pathname === window.location.pathname;
      const cachedRoute = getVisitedResponse(rscUrl, navigationKind);
      const navigationCommitEffect = createNavigationCommitEffect(href, historyUpdateMode);

      if (cachedRoute) {
        stageClientParams(cachedRoute.params);
        const cachedNavigationSnapshot = createClientNavigationRenderSnapshot(
          href,
          cachedRoute.params,
        );
        const cachedPayload = createFromFetch<ReactNode>(
          Promise.resolve(restoreRscResponse(cachedRoute.response)),
        );
        await renderNavigationPayload(
          cachedPayload,
          cachedNavigationSnapshot,
          navigationCommitEffect,
          isSameRoute,
        );
        return;
      }

      let navResponse: Response | undefined;
      let navResponseUrl: string | null = null;
      if (navigationKind !== "refresh") {
        const prefetchedResponse = consumePrefetchResponse(rscUrl);
        if (prefetchedResponse) {
          navResponse = restoreRscResponse(prefetchedResponse);
          navResponseUrl = prefetchedResponse.url;
        }
      }

      if (!navResponse) {
        navResponse = await fetch(rscUrl, {
          headers: { Accept: "text/x-component" },
          credentials: "include",
        });
      }

      // Bail out if a newer navigation started while we were fetching.
      if (navId !== activeNavigationId) return;

      const finalUrl = new URL(navResponseUrl ?? navResponse.url, window.location.origin);
      const requestedUrl = new URL(rscUrl, window.location.origin);

      if (finalUrl.pathname !== requestedUrl.pathname) {
        const destinationPath = finalUrl.pathname.replace(/\.rsc$/, "") + finalUrl.search;

        const navigate = window.__VINEXT_RSC_NAVIGATE__;
        if (!navigate) {
          window.location.href = destinationPath;
          return;
        }

        return navigate(destinationPath, redirectDepth + 1, navigationKind, historyUpdateMode);
      }

      let navParams: Record<string, string | string[]> = {};
      const paramsHeader = navResponse.headers.get("X-Vinext-Params");
      if (paramsHeader) {
        try {
          navParams = JSON.parse(decodeURIComponent(paramsHeader)) as Record<string, string | string[]>;
          stageClientParams(navParams);
        } catch {
          stageClientParams({});
        }
      } else {
        stageClientParams({});
      }
      const navigationSnapshot = createClientNavigationRenderSnapshot(href, latestClientParams);

      // Buffer the full RSC response before rendering. Without this, the flight
      // parser processes the stream progressively — chunks interleave across
      // microtask boundaries, causing React to commit a partially-resolved tree
      // (e.g. list content updates before heading hooks catch up). Buffering
      // ensures processBinaryChunk handles all flight rows in one synchronous
      // pass, matching how cached/prefetched responses already work.

      const responseSnapshot = await snapshotRscResponse(navResponse);

      // Bail out if a newer navigation started while buffering the response.
      if (navId !== activeNavigationId) return;

      storeVisitedResponseSnapshot(rscUrl, responseSnapshot, navParams);
      const rscPayload = createFromFetch<ReactNode>(
        Promise.resolve(restoreRscResponse(responseSnapshot)),
      );

      await renderNavigationPayload(
        rscPayload,
        navigationSnapshot,
        navigationCommitEffect,
        isSameRoute,
      );
    } catch (error) {
      // Deactivate the snapshot counter in case it was incremented before
      // the error — prevents hooks from permanently returning stale values.
      commitClientNavigationState();
      console.error("[vinext] RSC navigation error:", error);
      window.location.href = href;
    }
  };

  // Disable the browser's native scroll restoration so it doesn't fight
  // with our manual save/restore via __vinext_scrollY in history.state.
  // Without this, back/forward causes a visible scroll jump (browser
  // restores instantly) followed by a correction (our rAF-deferred restore).
  if ("scrollRestoration" in history) {
    history.scrollRestoration = "manual";
  }

  window.addEventListener("popstate", (event) => {
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
