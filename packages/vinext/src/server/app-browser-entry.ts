/// <reference types="vite/client" />

import { createElement, use, useLayoutEffect, useRef, useState } from "react";
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
  type CachedRscResponse,
  type ClientNavigationRenderSnapshot,
} from "vinext/shims/navigation";
import { stripBasePath } from "../utils/base-path.js";
import {
  chunksToReadableStream,
  createProgressiveRscStream,
  getVinextBrowserGlobal,
} from "./app-browser-stream.js";
import {
  createAppBrowserNavigationController,
  type HistoryUpdateMode,
  type PendingBrowserRouterState,
} from "./app-browser-navigation-controller.js";
import {
  AppElementsWire,
  getMountedSlotIdsHeader,
  resolveVisitedResponseInterceptionContext,
  type AppElements,
  type AppWireElements,
} from "./app-elements.js";
import {
  createHistoryStateWithPreviousNextUrl,
  readHistoryStatePreviousNextUrl,
  resolveInterceptionContextFromPreviousNextUrl,
  resolveServerActionRequestState,
  type AppRouterState,
  type OperationLane,
} from "./app-browser-state.js";
import { DevRecoveryBoundary } from "vinext/shims/error-boundary";
import { ElementsContext, Slot } from "vinext/shims/slot";
import { createOnUncaughtError } from "./app-browser-error.js";
import {
  devOnCaughtError,
  devOnUncaughtError,
  dismissOverlay,
  installDevErrorOverlay,
} from "./dev-error-overlay.js";
import { DANGEROUS_URL_BLOCK_MESSAGE, isDangerousScheme } from "vinext/shims/url-safety";
import {
  getServerActionNotFoundClientMessage,
  isServerActionNotFoundResponse,
} from "./server-action-not-found.js";
import {
  createRscRequestHeaders,
  createRscRequestUrl,
  stripRscCacheBustingSearchParam,
  stripRscSuffix,
  VINEXT_RSC_CONTENT_TYPE,
  VINEXT_RSC_MOUNTED_SLOTS_HEADER,
} from "./app-rsc-cache-busting.js";

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

function toOperationLane(kind: NavigationKind): OperationLane {
  switch (kind) {
    case "navigate":
      return "navigation";
    case "refresh":
      return "refresh";
    case "traverse":
      return "traverse";
    default: {
      const _exhaustive: never = kind;
      throw new Error("[vinext] Unknown navigation kind: " + String(_exhaustive));
    }
  }
}

type VisitedResponseCacheEntry = {
  params: Record<string, string | string[]>;
  expiresAt: number;
  response: CachedRscResponse;
};

const MAX_VISITED_RESPONSE_CACHE_SIZE = 50;
const VISITED_RESPONSE_CACHE_TTL = 5 * 60_000;
const MAX_TRAVERSAL_CACHE_TTL = 30 * 60_000;
const browserNavigationController = createAppBrowserNavigationController();
const NavigationCommitSignal = browserNavigationController.NavigationCommitSignal;

// Parses a URI-encoded JSON value carried in a response header (e.g.
// `X-Vinext-Params`). Returns `null` on missing or malformed input so callers
// can fall back to their own defaults. Silent by design — these headers are
// best-effort hydration data and a parse failure should not break navigation.
function parseEncodedJsonHeader<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(decodeURIComponent(value)) as T;
  } catch {
    return null;
  }
}

function isRouterStatePromise(
  value: AppRouterState | Promise<AppRouterState>,
): value is Promise<AppRouterState> {
  return value instanceof Promise;
}

let latestClientParams: Record<string, string | string[]> = {};
const visitedResponseCache = new Map<string, VisitedResponseCacheEntry>();
// Sticky bit: stays true once BrowserRoot has committed at least once. Used by
// the HMR handler to distinguish "still hydrating" (wait) from "was up, then
// torn down by a render error" (full reload to recover).
let browserRouterStateHasEverCommitted = false;
// Most recent navigation target that has been dispatched but not yet committed.
// Read by the onUncaughtError handler so a render error tearing down the tree
// can land the browser on the URL the user was actually navigating to, instead
// of stranding them on the previous URL with a blank page. Cleared once the
// commit effect runs (URL update succeeded) or the navigation is superseded.
let pendingNavigationRecoveryHref: string | null = null;

function isServerActionResult(value: unknown): value is ServerActionResult {
  return !!value && typeof value === "object" && "root" in value;
}

function getBrowserRouterState(): AppRouterState {
  return browserNavigationController.getBrowserRouterState();
}

function hasBrowserRouterState(): boolean {
  return browserNavigationController.hasBrowserRouterState();
}

function waitForBrowserRouterStateReady(): Promise<void> {
  return browserNavigationController.waitForBrowserRouterStateReady();
}

function beginPendingBrowserRouterState(): PendingBrowserRouterState {
  return browserNavigationController.beginPendingBrowserRouterState();
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

function createNavigationCommitEffect(options: {
  href: string;
  historyUpdateMode: HistoryUpdateMode | undefined;
  navId: number;
  params: Record<string, string | string[]>;
  previousNextUrl: string | null;
}): () => void {
  const { href, historyUpdateMode, navId, params, previousNextUrl } = options;

  return () => {
    // Only update URL if this is still the active navigation.
    // A newer navigation would have superseded this navigation id.
    if (!browserNavigationController.isCurrentNavigation(navId)) {
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

    // URL has been updated; the recovery hard-nav target is no longer needed.
    pendingNavigationRecoveryHref = null;
    commitClientNavigationState(navId);
  };
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
  operationLane: OperationLane = "navigation",
): Promise<void> {
  try {
    return await browserNavigationController.renderNavigationPayload({
      actionType,
      createNavigationCommitEffect: (options) => {
        pendingNavigationRecoveryHref = options.href;
        return createNavigationCommitEffect(options);
      },
      historyUpdateMode,
      navigationSnapshot,
      nextElements: payload,
      operationLane,
      params,
      pendingRouterState,
      previousNextUrl,
      targetHref,
      navId,
      useTransition,
    });
  } catch (error) {
    pendingNavigationRecoveryHref = null;
    throw error;
  }
}

async function commitSameUrlNavigatePayload(
  nextElements: Promise<AppElements>,
  returnValue?: ServerActionResult["returnValue"],
): Promise<unknown> {
  const navigationSnapshot = createClientNavigationRenderSnapshot(
    window.location.href,
    latestClientParams,
  );
  return browserNavigationController.commitSameUrlNavigatePayload(
    nextElements,
    navigationSnapshot,
    returnValue,
  );
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
  const cacheKey = AppElementsWire.encodeCacheKey(rscUrl, interceptionContext);
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
  const cacheKey = AppElementsWire.encodeCacheKey(rscUrl, interceptionContext);
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

// Dev-only callback invoked when DevRecoveryBoundary catches. The replaced
// subtree means NavigationCommitSignal's useLayoutEffect never fires, so the
// URL update for the in-flight navigation would otherwise be lost. Force-drain
// the queued pre-paint effect for this renderId so the URL still moves to the
// navigation target, the dev overlay shows which URL is broken, and HMR's
// rsc:update fetches the right payload after the bug is fixed.
function handleDevRecoveryBoundaryCatch(resetKey: number): void {
  // React's onCaughtError option already routes the error to the dev overlay.
  // Our job here is purely to drive the URL update for the in-flight
  // navigation that this failed render belonged to.
  browserNavigationController.drainPrePaintEffects(resetKey);
}

function decodeAppElementsPromise(payload: Promise<AppWireElements>): Promise<AppElements> {
  // Wrap in Promise.resolve() because createFromReadableStream() returns a
  // React Flight thenable whose .then() returns undefined (not a new Promise).
  // Without the wrap, chaining .then() produces undefined → use() crashes.
  return Promise.resolve(payload).then((elements) => AppElementsWire.decode(elements));
}

function BrowserRoot({
  initialElements,
  initialNavigationSnapshot,
}: {
  initialElements: Promise<AppElements>;
  initialNavigationSnapshot: ClientNavigationRenderSnapshot;
}) {
  const resolvedElements = use(initialElements);
  const initialMetadata = AppElementsWire.readMetadata(resolvedElements);
  const [treeStateValue, setTreeStateValue] = useState<AppRouterState | Promise<AppRouterState>>({
    activeOperation: null,
    elements: resolvedElements,
    interceptionContext: initialMetadata.interceptionContext,
    layoutFlags: initialMetadata.layoutFlags,
    navigationSnapshot: initialNavigationSnapshot,
    previousNextUrl: null,
    renderId: 0,
    rootLayoutTreePath: initialMetadata.rootLayoutTreePath,
    routeId: initialMetadata.routeId,
    visibleCommitVersion: 0,
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
    const detach = browserNavigationController.attachBrowserRouterState(
      setTreeStateValue,
      stateRef,
    );
    browserRouterStateHasEverCommitted = true;
    return () => {
      detach();
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

  const innerTree = createElement(
    NavigationCommitSignal,
    { renderId: treeState.renderId },
    createElement(
      ElementsContext.Provider,
      { value: treeState.elements },
      createElement(Slot, { id: treeState.routeId }),
    ),
  );

  // In dev, wrap the route tree in a top-level recovery boundary. A render
  // error (e.g. a slot's RSC reference rejects) is caught here instead of
  // tearing down BrowserRoot, so HMR can dispatch the next payload —
  // identified by an incremented renderId, which doubles as the boundary's
  // reset key — without a full page reload. The dev overlay (a separate
  // React root) shows the error itself.
  //
  // onCatch drains the pending pre-paint effect for the failed render so
  // the URL update bound to that navigation still runs. Without this, a
  // soft-nav whose target throws would leave the browser on the previous
  // URL, hiding which route is broken and mis-targeting the next HMR
  // payload (which fetches RSC for window.location.pathname).
  //
  // This file is .ts, not .tsx — children are passed positionally to satisfy
  // both the createElement overload and eslint's no-children-prop rule.
  const committedTree = import.meta.env.DEV
    ? createElement(
        DevRecoveryBoundary,
        {
          resetKey: treeState.renderId,
          onCatch: handleDevRecoveryBoundaryCatch,
        },
        innerTree,
      )
    : innerTree;

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

  const rscHeaders = createRscRequestHeaders();
  const rscResponse = await fetch(
    await createRscRequestUrl(window.location.pathname + window.location.search, rscHeaders),
    { credentials: "include", headers: rscHeaders },
  );

  if (!rscResponse.ok) {
    return recoverFromBadInitialRscResponse(`returned ${rscResponse.status}`);
  }
  // Guard against proxies/CDNs that return 200 with a rewritten Content-Type
  // (e.g. text/html instead of text/x-component). Such responses cannot be
  // parsed as RSC and would throw the same opaque parse error this fallback
  // exists to prevent.
  const contentType = rscResponse.headers.get("content-type") ?? "";
  if (!contentType.startsWith(VINEXT_RSC_CONTENT_TYPE)) {
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

  // Ignore malformed param headers and continue with hydration. The original
  // try/catch also swallowed errors from applyClientParams; preserve that.
  const parsedParams = parseEncodedJsonHeader<Record<string, string | string[]>>(
    rscResponse.headers.get("X-Vinext-Params"),
  );
  const params: Record<string, string | string[]> = parsedParams ?? {};
  if (parsedParams) {
    try {
      applyClientParams(parsedParams);
    } catch {
      // Ignore — matches the previous combined try/catch behavior.
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

    const fetchResponse = await fetch(
      await createRscRequestUrl(window.location.pathname + window.location.search, headers),
      {
        method: "POST",
        headers,
        body,
      },
    );

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
        Promise.resolve(AppElementsWire.decode(result.root)),
        result.returnValue,
      );
    }

    return commitSameUrlNavigatePayload(Promise.resolve(AppElementsWire.decode(result)));
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
  if (import.meta.env.DEV) {
    installDevErrorOverlay();
  }

  const root = decodeAppElementsPromise(createFromReadableStream<AppWireElements>(rscStream));
  const initialNavigationSnapshot = createClientNavigationRenderSnapshot(
    window.location.href,
    latestClientParams,
  );
  replaceHistoryStateWithoutNotify(
    createHistoryStateWithPreviousNextUrl(window.history.state, null),
    "",
    window.location.href,
  );

  // In dev we route uncaught errors into the dev overlay rather than the
  // hard-nav recovery: the overlay is what the developer needs to see, and a
  // recovery nav would wipe it. In prod we keep the recovery hard-nav so the
  // user lands on a renderable URL with the actual error UI.
  const onUncaughtError = import.meta.env.DEV
    ? devOnUncaughtError
    : createOnUncaughtError(() => pendingNavigationRecoveryHref);
  window.__VINEXT_RSC_ROOT__ = hydrateRoot(
    document,
    createElement(BrowserRoot, {
      initialElements: root,
      initialNavigationSnapshot,
    }),
    import.meta.env.DEV
      ? { onCaughtError: devOnCaughtError, onUncaughtError }
      : { onUncaughtError },
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
    let pendingRouterState: PendingBrowserRouterState | null = null;
    // Hoist navId above try so the catch and finally blocks can reference it.
    const navId = browserNavigationController.beginNavigation();

    // Loop variables for inline redirect following. On a redirect, these are
    // updated and the loop continues without returning or re-entering navigateRsc,
    // so a single pendingRouterState spans all hops and isPending never flashes.
    let currentHref = href;
    let currentHistoryMode = historyUpdateMode;
    let currentPrevNextUrl = previousNextUrlOverride;
    let redirectCount = redirectDepth;

    try {
      if (programmaticTransition && hasBrowserRouterState()) {
        pendingRouterState = beginPendingBrowserRouterState();
      } else {
        await waitForBrowserRouterStateReady();
        if (!browserNavigationController.isCurrentNavigation(navId)) return;

        if (programmaticTransition) {
          pendingRouterState = beginPendingBrowserRouterState();
        }
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
        const requestHeaders = createRscRequestHeaders({
          interceptionContext: requestInterceptionContext,
        });
        if (mountedSlotsHeader) {
          requestHeaders.set(VINEXT_RSC_MOUNTED_SLOTS_HEADER, mountedSlotsHeader);
        }
        const rscUrl = await createRscRequestUrl(url.pathname + url.search, requestHeaders);
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
          if (!browserNavigationController.isCurrentNavigation(navId)) return;
          const cachedParams = cachedRoute.params;
          // createClientNavigationRenderSnapshot is synchronous (URL parsing + param
          // wrapping only) — no stale-navigation recheck needed between here and the
          // next await.
          const cachedNavigationSnapshot = createClientNavigationRenderSnapshot(
            currentHref,
            cachedParams,
          );
          const cachedPayload = decodeAppElementsPromise(
            createFromFetch<AppWireElements>(
              Promise.resolve(restoreRscResponse(cachedRoute.response)),
            ),
          );
          if (!browserNavigationController.isCurrentNavigation(navId)) return;
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
            toOperationLane(navigationKind),
          );
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
          navResponse = await fetch(rscUrl, {
            headers: requestHeaders,
            credentials: "include",
          });
        }

        if (!browserNavigationController.isCurrentNavigation(navId)) return;

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
            stripRscCacheBustingSearchParam(parsed);
            const origUrl = new URL(currentHref, window.location.origin);
            let pathname = stripRscSuffix(parsed.pathname);
            // createRscRequestUrl strips trailing slash before appending .rsc,
            // so the response URL loses it on the round-trip. Restore it when
            // the original href had one so sites with trailingSlash:true don't
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
        stripRscCacheBustingSearchParam(finalUrl);
        const requestedUrl = new URL(rscUrl, window.location.origin);

        if (finalUrl.pathname !== requestedUrl.pathname) {
          // Server-side redirect: update the URL in history and loop to fetch
          // the destination without settling pendingRouterState. This keeps
          // isPending true across all redirect hops instead of flashing false.
          const destinationPath = stripRscSuffix(finalUrl.pathname) + finalUrl.search;
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

        // navParams falls back to {} on a missing or malformed header.
        const navParams: Record<string, string | string[]> =
          parseEncodedJsonHeader<Record<string, string | string[]>>(
            navResponse.headers.get("X-Vinext-Params"),
          ) ?? {};
        // Build snapshot from local params, not latestClientParams
        const navigationSnapshot = createClientNavigationRenderSnapshot(currentHref, navParams);

        const responseSnapshot = await snapshotRscResponse(navResponse);

        if (!browserNavigationController.isCurrentNavigation(navId)) return;

        const rscPayload = decodeAppElementsPromise(
          createFromFetch<AppWireElements>(Promise.resolve(restoreRscResponse(responseSnapshot))),
        );

        if (!browserNavigationController.isCurrentNavigation(navId)) return;

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
          toOperationLane(navigationKind),
        );
        // Don't cache the response if this navigation was superseded during
        // renderNavigationPayload's await — the elements were never dispatched.
        if (!browserNavigationController.isCurrentNavigation(navId)) return;
        // Store the visited response only after renderNavigationPayload succeeds.
        // If we stored it before and renderNavigationPayload threw, a future
        // back/forward navigation could replay a snapshot from a navigation that
        // never actually rendered successfully.
        const resolvedElements = await rscPayload;
        const metadata = AppElementsWire.readMetadata(resolvedElements);
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
      // Don't hard-navigate to a stale URL if this navigation was superseded by
      // a newer one — the newer navigation is already in flight and would be clobbered.
      if (!browserNavigationController.isCurrentNavigation(navId)) return;
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
      browserNavigationController.finalizeNavigation(navId, pendingRouterState);
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
        // If BrowserRoot has been mounted before but isn't now, a render
        // error tore down the tree (e.g. a server route threw). HMR can't
        // dispatch into a missing setter, and waitForBrowserRouterStateReady
        // would block forever — the tree won't remount until the page reloads.
        // Trigger that reload so the user's fix actually lands without a
        // manual refresh. Cleared after a successful mount, so this only
        // fires once per teardown.
        if (
          browserRouterStateHasEverCommitted &&
          !browserNavigationController.hasBrowserRouterState()
        ) {
          window.location.reload();
          return;
        }
        // HMR can also fire before BrowserRoot's layout effect publishes
        // the browser router state (e.g. saving a file while the initial RSC
        // stream is still suspended). Wait for readiness, then re-check the
        // mounted state — readiness can race with cleanup, which nulls it again.
        // Skip silently when the tree is not currently mounted; the next
        // HMR push or full reload will reconcile.
        await waitForBrowserRouterStateReady();
        if (!browserNavigationController.hasBrowserRouterState()) {
          return;
        }
        clearClientNavigationCaches();
        const navigationSnapshot = createClientNavigationRenderSnapshot(
          window.location.href,
          latestClientParams,
        );
        // Clear stale errors from the dev overlay before dispatching the
        // fresh tree. If the new tree renders cleanly, the overlay stays
        // empty; if it throws again, devOnCaughtError/devOnUncaughtError
        // re-populates it. Without this, an old "DropZone is not defined"
        // error would linger after the developer fixed the bug.
        dismissOverlay();
        // Interception context on HMR re-renders is intentionally deferred:
        // preserving intercepted modal state across HMR reloads is out of scope
        // for the previousNextUrl mechanism.
        const hmrHeaders = createRscRequestHeaders();
        await browserNavigationController.hmrReplaceTree(
          decodeAppElementsPromise(
            createFromFetch<AppWireElements>(
              fetch(
                await createRscRequestUrl(
                  window.location.pathname + window.location.search,
                  hmrHeaders,
                ),
                { headers: hmrHeaders },
              ),
            ),
          ),
          navigationSnapshot,
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
