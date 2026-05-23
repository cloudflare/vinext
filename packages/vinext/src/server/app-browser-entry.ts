/// <reference types="vite/client" />

import { createElement, startTransition, use, useLayoutEffect, useRef, useState } from "react";
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
  appRouterInstance,
  commitClientNavigationState,
  consumePrefetchResponse,
  createCachedRscResponseSnapshot,
  createClientNavigationRenderSnapshot,
  getClientNavigationRenderContext,
  getPrefetchCache,
  invalidatePrefetchCache,
  navigateClientSide,
  pushHistoryStateWithoutNotify,
  replaceClientParamsWithoutNotify,
  replaceHistoryStateWithoutNotify,
  restoreRscResponse,
  setClientParams,
  setPendingPathname,
  setMountedSlotsHeader,
  setNavigationContext,
  type CachedRscResponse,
  type ClientNavigationRenderSnapshot,
  type PrefetchCacheEntry,
} from "vinext/shims/navigation";
import {
  getNavigationRuntime,
  registerNavigationRuntimeBootstrap,
  registerNavigationRuntimeFunctions,
  type NavigationRuntimeNavigate,
  type NavigationRuntimeRscBootstrap,
} from "../client/navigation-runtime.js";
import { scrollToHashTargetOnNextFrame } from "vinext/shims/hash-scroll";
import { installWindowNext } from "../client/window-next.js";
import {
  chunksToReadableStream,
  createProgressiveRscStream,
  getVinextBrowserGlobal,
} from "./app-browser-stream.js";
import {
  createAppBrowserNavigationController,
  clearHardNavigationLoopGuard,
  type HistoryUpdateMode,
  type NavigationPayloadOutcome,
  type PendingBrowserRouterState,
} from "./app-browser-navigation-controller.js";
import { resolveManifestNavigationInterceptionContext } from "./app-browser-interception-context.js";
import {
  createDiscardedServerActionRefreshScheduler,
  createServerActionInitiationSnapshot,
  isServerActionResult,
  parseServerActionRevalidationHeader,
  resolveServerActionRedirectLocation,
  shouldClearClientNavigationCachesForServerActionResult,
  type ServerActionRevalidationKind,
  type AppBrowserServerActionResult,
} from "./app-browser-action-result.js";
import {
  consumeInitialFormState,
  createVinextHydrateRootOptions,
  hydrateRootInTransition,
} from "./app-browser-hydration.js";
import {
  AppElementsWire,
  getMountedSlotIdsHeader,
  resolveVisitedResponseInterceptionContext,
  type AppElements,
  type AppWireElements,
} from "./app-elements.js";
import {
  FRESH_APP_NAVIGATION_PAYLOAD_ORIGIN,
  VISITED_CACHE_APP_NAVIGATION_PAYLOAD_ORIGIN,
  createHistoryStateWithNavigationMetadata,
  createHistoryStateWithPreviousNextUrl,
  readHistoryStatePreviousNextUrl,
  readHistoryStateTraversalIndex,
  isCacheRestorableAppPayloadMetadata,
  resolveHistoryTraversalIntent,
  resolveInterceptionContextFromPreviousNextUrl,
  resolveServerActionRequestState,
  type AppNavigationPayloadOrigin,
  type AppRouterState,
  type HistoryTraversalIntent,
  type OperationLane,
} from "./app-browser-state.js";
import { createPopstateRestoreHandler } from "./app-browser-popstate.js";
import { DevRecoveryBoundary, RedirectBoundary } from "vinext/shims/error-boundary";
import { AppRouterContext } from "vinext/shims/internal/app-router-context";
import { ElementsContext, Slot } from "vinext/shims/slot";
import type { RouteManifest } from "../routing/app-route-graph.js";
import { stripBasePath } from "../utils/base-path.js";
import { createOnUncaughtError } from "./app-browser-error.js";
import {
  devOnCaughtError,
  devOnUncaughtError,
  dismissOverlay,
  installDevErrorOverlay,
} from "./dev-error-overlay.js";
import { DANGEROUS_URL_BLOCK_MESSAGE, isDangerousScheme } from "vinext/shims/url-safety";
import { throwOnServerActionNotFound } from "./server-action-not-found.js";
import {
  createRscRequestHeaders,
  createRscRequestUrl,
  getVinextRscCompatibilityId,
  resolveHardNavigationTargetFromRscResponse,
  resolveRscCompatibilityNavigationDecision,
  VINEXT_RSC_COMPATIBILITY_ID_HEADER,
  VINEXT_RSC_CONTENT_TYPE,
} from "./app-rsc-cache-busting.js";
import { APP_RSC_RENDER_MODE_REFRESH_PRESERVE_UI } from "./app-rsc-render-mode.js";
import {
  MAX_RSC_REDIRECT_DEPTH,
  resolveRscRedirectLifecycleHop,
} from "./app-browser-rsc-redirect.js";
import {
  createOptimisticRouteTemplate,
  getOptimisticPrefetchSourceKey,
  getOptimisticRouteTemplateKey,
  resolveOptimisticNavigationPayload,
  type OptimisticRouteTemplate,
} from "./app-optimistic-routing.js";
import {
  ACTION_REDIRECT_HEADER,
  ACTION_REDIRECT_TYPE_HEADER,
  VINEXT_MOUNTED_SLOTS_HEADER,
  VINEXT_PARAMS_HEADER,
  VINEXT_RSC_REDIRECT_HEADER,
} from "./headers.js";

type SearchParamInput = ConstructorParameters<typeof URLSearchParams>[0];

type ServerActionResult = AppBrowserServerActionResult<AppWireElements>;

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
const CLIENT_RSC_COMPATIBILITY_ID = getVinextRscCompatibilityId();
const optimisticRouteTemplates = new Map<string, OptimisticRouteTemplate>();
const optimisticRouteTemplateSources = new Set<string>();
const optimisticRouteTemplateLearning = new Map<string, Promise<void>>();
function getBrowserRouteManifest(): RouteManifest | null {
  return getNavigationRuntime()?.bootstrap.routeManifest ?? null;
}

const browserNavigationController = createAppBrowserNavigationController({
  getRouteManifest: getBrowserRouteManifest,
  syncHistoryStatePreviousNextUrl: syncCurrentHistoryStatePreviousNextUrl,
});
const discardedServerActionRefreshScheduler = createDiscardedServerActionRefreshScheduler({
  runRefresh() {
    clearClientNavigationCaches();
    void getNavigationRuntime()?.functions.navigate?.(
      window.location.href,
      0,
      "refresh",
      undefined,
      undefined,
      true,
    );
  },
});
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
let currentHistoryTraversalIndex: number | null =
  readHistoryStateTraversalIndex(window.history.state) ?? 0;
let nextHistoryTraversalIndex: number = currentHistoryTraversalIndex;

function allocateNavigationHistoryTraversalIndex(
  historyUpdateMode: HistoryUpdateMode | undefined,
): number | null {
  switch (historyUpdateMode) {
    case "push":
      return nextHistoryTraversalIndex + 1;
    case "replace":
      return currentHistoryTraversalIndex;
    case undefined:
      return null;
    default: {
      const _exhaustive: never = historyUpdateMode;
      throw new Error("[vinext] Unknown history update mode: " + String(_exhaustive));
    }
  }
}

function commitHistoryTraversalIndex(index: number | null): void {
  currentHistoryTraversalIndex = index;
  if (index !== null) {
    // Keep allocation anchored to the highest app-owned entry we know about.
    // Traversing to metadata-less entries makes the current index unknown, but
    // the next app-owned push should still continue from known app history.
    nextHistoryTraversalIndex = Math.max(nextHistoryTraversalIndex, index);
  }
}

function commitHashOnlyNavigation(
  href: string,
  historyUpdateMode: Exclude<HistoryUpdateMode, undefined>,
  scroll: boolean,
): void {
  const navigationHistoryIndex = allocateNavigationHistoryTraversalIndex(historyUpdateMode);
  const previousNextUrl = hasBrowserRouterState()
    ? getBrowserRouterState().previousNextUrl
    : readHistoryStatePreviousNextUrl(window.history.state);
  const historyState = createHistoryStateWithNavigationMetadata(
    createHashOnlyNavigationBaseHistoryState(historyUpdateMode, scroll),
    {
      previousNextUrl,
      traversalIndex: navigationHistoryIndex,
    },
  );

  if (historyUpdateMode === "replace") {
    replaceHistoryStateWithoutNotify(historyState, "", href);
  } else {
    pushHistoryStateWithoutNotify(historyState, "", href);
  }
  commitHistoryTraversalIndex(navigationHistoryIndex);
}

function createHashOnlyNavigationBaseHistoryState(
  historyUpdateMode: Exclude<HistoryUpdateMode, undefined>,
  scroll: boolean,
): unknown {
  if (historyUpdateMode !== "replace") {
    return null;
  }
  return scroll ? stripVinextScrollState(window.history.state) : window.history.state;
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

function commitTraversalIndexFromHistoryState(historyState: unknown): void {
  commitHistoryTraversalIndex(readHistoryStateTraversalIndex(historyState));
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
  // between staging and commit. Server action snapshots capture the committed
  // browser router state at invocation time, so they do not read this mutable
  // module-level value after their async request boundary.
  latestClientParams = params;
  replaceClientParamsWithoutNotify(params);
}

function clearVisitedResponseCache(): void {
  visitedResponseCache.clear();
}

function clearPrefetchState(): void {
  invalidatePrefetchCache();
  optimisticRouteTemplates.clear();
  optimisticRouteTemplateSources.clear();
  optimisticRouteTemplateLearning.clear();
}

function clearClientNavigationCaches(): void {
  clearVisitedResponseCache();
  clearPrefetchState();
}

function isSettledPrefetchCacheEntry(
  entry: PrefetchCacheEntry,
): entry is PrefetchCacheEntry & { snapshot: CachedRscResponse } {
  return (
    entry.outcome === "cache-seeded" && entry.pending === undefined && entry.snapshot !== undefined
  );
}

function parsePrefetchCacheKey(cacheKey: string): {
  interceptionContext: string | null;
  rscUrl: string;
} {
  const separatorIndex = cacheKey.indexOf("\0");
  if (separatorIndex === -1) {
    return { interceptionContext: null, rscUrl: cacheKey };
  }
  return {
    interceptionContext: cacheKey.slice(separatorIndex + 1),
    rscUrl: cacheKey.slice(0, separatorIndex),
  };
}

async function learnOptimisticRouteTemplateFromPrefetch(options: {
  cacheKey: string;
  entry: PrefetchCacheEntry & { snapshot: CachedRscResponse };
  interceptionContext: string | null;
  mountedSlotsHeader: string | null;
  routeManifest: RouteManifest;
}): Promise<boolean> {
  const source = parsePrefetchCacheKey(options.cacheKey);
  if (source.interceptionContext !== options.interceptionContext) return false;
  if ((options.entry.snapshot.mountedSlotsHeader ?? null) !== options.mountedSlotsHeader)
    return false;
  if (options.interceptionContext !== null) return false;

  const elements = await decodeAppElementsPromise(
    createFromFetch<AppWireElements>(Promise.resolve(restoreRscResponse(options.entry.snapshot))),
  );
  const template = createOptimisticRouteTemplate({
    allowLoadingShell: options.entry.optimisticRouteShell === true,
    basePath: __basePath,
    elements,
    href: options.entry.snapshot.url || source.rscUrl,
    interceptionContext: options.interceptionContext,
    mountedSlotsHeader: options.mountedSlotsHeader,
    routeManifest: options.routeManifest,
  });
  if (template === null) return false;

  optimisticRouteTemplates.set(
    getOptimisticRouteTemplateKey({
      interceptionContext: options.interceptionContext,
      mountedSlotsHeader: options.mountedSlotsHeader,
      routeId: template.routeId,
    }),
    template,
  );
  return true;
}

async function learnOptimisticRouteTemplatesFromPrefetchCache(options: {
  interceptionContext: string | null;
  mountedSlotsHeader: string | null;
  routeManifest: RouteManifest | null;
}): Promise<void> {
  if (options.routeManifest === null) return;

  const learning: Promise<void>[] = [...optimisticRouteTemplateLearning.values()];
  for (const [cacheKey, entry] of getPrefetchCache()) {
    const sourceKey = getOptimisticPrefetchSourceKey({
      cacheKey,
      interceptionContext: options.interceptionContext,
      mountedSlotsHeader: options.mountedSlotsHeader,
    });
    if (optimisticRouteTemplateSources.has(sourceKey)) continue;
    if (optimisticRouteTemplateLearning.has(sourceKey)) continue;
    if (!isSettledPrefetchCacheEntry(entry)) continue;

    const promise = learnOptimisticRouteTemplateFromPrefetch({
      cacheKey,
      entry,
      interceptionContext: options.interceptionContext,
      mountedSlotsHeader: options.mountedSlotsHeader,
      routeManifest: options.routeManifest,
    })
      .then((learned) => {
        if (learned) optimisticRouteTemplateSources.add(sourceKey);
      })
      .finally(() => {
        optimisticRouteTemplateLearning.delete(sourceKey);
      });
    optimisticRouteTemplateLearning.set(sourceKey, promise);
    learning.push(promise);
  }

  if (learning.length === 0) return;
  await Promise.allSettled(learning);
}

function syncCurrentHistoryStatePreviousNextUrl(previousNextUrl: string | null): void {
  if (readHistoryStatePreviousNextUrl(window.history.state) === previousNextUrl) {
    return;
  }

  const nextHistoryState = createHistoryStateWithPreviousNextUrl(
    window.history.state,
    previousNextUrl,
  );
  // First attempt: use replaceHistoryStateWithoutNotify which fires no popstate
  // or hashchange events. If the browser accepted the state update (checked via
  // readHistoryStatePreviousNextUrl), we're done. The double-read is needed
  // because some browsers (notably Safari) can silently coalesce or ignore
  // replaceState calls when called in rapid succession (e.g. back-to-back
  // navigation commits). The fallback fires only when the state didn't stick.
  replaceHistoryStateWithoutNotify(nextHistoryState, "", window.location.href);
  if (readHistoryStatePreviousNextUrl(window.history.state) === previousNextUrl) {
    return;
  }
  window.history.replaceState(nextHistoryState, "", window.location.href);
}

function createActionInitiationSnapshot() {
  const routerState = getBrowserRouterState();
  return createServerActionInitiationSnapshot({
    href: window.location.href,
    navigationId: browserNavigationController.getActiveNavigationId(),
    routerState,
  });
}

type ActionInitiationSnapshot = ReturnType<typeof createActionInitiationSnapshot>;

function createNavigationCommitEffect(options: {
  href: string;
  historyUpdateMode: HistoryUpdateMode | undefined;
  navId: number;
  params: Record<string, string | string[]>;
  previousNextUrl: string | null;
  targetHistoryIndex?: number | null;
}): () => void {
  const { href, historyUpdateMode, navId, params, previousNextUrl, targetHistoryIndex } = options;

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
    const preserveExistingState = historyUpdateMode === "replace";
    const navigationHistoryIndex =
      targetHistoryIndex !== undefined
        ? targetHistoryIndex
        : allocateNavigationHistoryTraversalIndex(historyUpdateMode);
    const historyState = createHistoryStateWithNavigationMetadata(
      preserveExistingState ? window.history.state : null,
      {
        previousNextUrl,
        traversalIndex: navigationHistoryIndex,
      },
    );

    let wroteHistoryState = false;
    if (historyUpdateMode === "replace" && window.location.href !== targetHref) {
      stageClientParams(params);
      replaceHistoryStateWithoutNotify(historyState, "", href);
      wroteHistoryState = true;
      commitHistoryTraversalIndex(navigationHistoryIndex);
    } else if (historyUpdateMode === "push" && window.location.href !== targetHref) {
      stageClientParams(params);
      pushHistoryStateWithoutNotify(historyState, "", href);
      wroteHistoryState = true;
      commitHistoryTraversalIndex(navigationHistoryIndex);
    }

    if (!wroteHistoryState) {
      syncCurrentHistoryStatePreviousNextUrl(previousNextUrl);
      stageClientParams(params);
      if (targetHistoryIndex !== undefined) {
        commitHistoryTraversalIndex(targetHistoryIndex);
      }
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
  payloadOrigin: AppNavigationPayloadOrigin,
  actionType: "navigate" | "replace" | "traverse" = "navigate",
  operationLane: OperationLane = "navigation",
  traversalIntent: HistoryTraversalIntent | null = null,
): Promise<NavigationPayloadOutcome> {
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
      payloadOrigin,
      params,
      pendingRouterState,
      previousNextUrl,
      targetHistoryIndex: traversalIntent === null ? undefined : traversalIntent.targetHistoryIndex,
      targetHref,
      navId,
    });
  } catch (error) {
    pendingNavigationRecoveryHref = null;
    throw error;
  }
}

async function commitSameUrlNavigatePayload(
  nextElements: Promise<AppElements>,
  actionInitiation: ActionInitiationSnapshot,
  returnValue?: ServerActionResult["returnValue"],
  revalidation: ServerActionRevalidationKind = "none",
): Promise<unknown> {
  const navigationSnapshot = createClientNavigationRenderSnapshot(
    actionInitiation.href,
    actionInitiation.routerState.navigationSnapshot.params,
  );
  return browserNavigationController.commitSameUrlNavigatePayload(
    nextElements,
    navigationSnapshot,
    returnValue,
    actionInitiation.routerState,
    {
      onDiscardedRevalidation() {
        discardedServerActionRefreshScheduler.schedule();
      },
      revalidation,
      startedNavigationId: actionInitiation.navigationId,
      targetHref: actionInitiation.href,
    },
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
  targetPathname: string,
  previousNextUrlOverride?: string | null,
  traverseHistoryState?: unknown,
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

  // Three branches for "navigate":
  // 1. previousNextUrl !== null → a committed intercepted navigation set this
  //    in browser state (requires proof). This is the proven interception path.
  // 2. route manifest declares current URL can intercept target URL → ask the
  //    server for an intercepted payload using manifest route facts only.
  // 3. otherwise, send no interception context.
  switch (navigationKind) {
    case "navigate": {
      const currentPreviousNextUrl = getBrowserRouterState().previousNextUrl;
      if (currentPreviousNextUrl !== null) {
        return {
          interceptionContext: resolveInterceptionContextFromPreviousNextUrl(
            currentPreviousNextUrl,
            __basePath,
          ),
          previousNextUrl: currentPreviousNextUrl,
        };
      }
      const manifestInterceptionContext = resolveManifestNavigationInterceptionContext({
        basePath: __basePath,
        currentPathname: window.location.pathname,
        routeManifest: getBrowserRouteManifest(),
        targetPathname,
      });
      if (manifestInterceptionContext !== null) {
        return {
          interceptionContext: manifestInterceptionContext,
          previousNextUrl: window.location.pathname + window.location.search,
        };
      }
      return {
        interceptionContext: null,
        previousNextUrl: null,
      };
    }
    case "traverse": {
      const previousNextUrl = readHistoryStatePreviousNextUrl(
        traverseHistoryState ?? window.history.state,
      );
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
    interception: initialMetadata.interception,
    interceptionContext: initialMetadata.interceptionContext,
    layoutIds: initialMetadata.layoutIds,
    layoutFlags: initialMetadata.layoutFlags,
    navigationSnapshot: initialNavigationSnapshot,
    previousNextUrl: null,
    renderId: 0,
    rootLayoutTreePath: initialMetadata.rootLayoutTreePath,
    routeId: initialMetadata.routeId,
    slotBindings: initialMetadata.slotBindings,
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
  // performing module writes during render. The navigation runtime is registered
  // after hydrateRoot() returns; by then this layout effect has already run for
  // the hydration commit, so getBrowserRouterState() never observes a null ref.
  useLayoutEffect(() => {
    const detach = browserNavigationController.attachBrowserRouterState(
      setTreeStateValue,
      stateRef,
    );
    browserRouterStateHasEverCommitted = true;
    // App Router uses this timestamp as first committed tree readiness: the
    // browser router state is attached and link/router interactions can safely
    // observe the committed tree. It is intentionally later than hydrateRoot()
    // returning.
    const hydratedAt = performance.now();
    window.__VINEXT_HYDRATED_AT = hydratedAt;
    window.__NEXT_HYDRATED = true;
    window.__NEXT_HYDRATED_AT = hydratedAt;
    window.__NEXT_HYDRATED_CB?.();
    return () => {
      detach();
      setMountedSlotsHeader(null);
    };
  }, [setTreeStateValue]);

  useLayoutEffect(() => {
    setMountedSlotsHeader(getMountedSlotIdsHeader(stateRef.current.elements));
    getNavigationRuntime()?.functions.pingVisibleLinks?.();
  }, [treeState.elements]);

  useLayoutEffect(() => {
    if (treeState.renderId !== 0) {
      return;
    }

    replaceHistoryStateWithoutNotify(
      createHistoryStateWithNavigationMetadata(window.history.state, {
        previousNextUrl: treeState.previousNextUrl,
        traversalIndex: currentHistoryTraversalIndex,
      }),
      "",
      window.location.href,
    );
  }, [treeState.previousNextUrl, treeState.renderId]);

  const routeTree = createElement(
    RedirectBoundary,
    null,
    createElement(
      NavigationCommitSignal,
      { renderId: treeState.renderId },
      createElement(
        ElementsContext.Provider,
        { value: treeState.elements },
        createElement(Slot, { id: treeState.routeId }),
      ),
    ),
  );
  const innerTree = AppRouterContext
    ? createElement(AppRouterContext.Provider, { value: appRouterInstance }, routeTree)
    : routeTree;

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

function restorePopstateScrollPosition(state: unknown): void {
  if (!(state && typeof state === "object" && "__vinext_scrollY" in state)) {
    if (window.location.hash) {
      scrollToHashTargetOnNextFrame(window.location.hash);
    }
    return;
  }

  const y = Number(state.__vinext_scrollY);
  const x = "__vinext_scrollX" in state ? Number(state.__vinext_scrollX) : 0;

  requestAnimationFrame(() => {
    window.scrollTo(x, y);
  });
}

function isSameAppRoutePopstateTarget(href: string): boolean {
  if (!hasBrowserRouterState()) return false;

  const target = new URL(href, window.location.origin);
  const routerState = getBrowserRouterState();
  const targetPathname = stripBasePath(target.pathname, __basePath);
  const targetSearch = new URLSearchParams(target.search).toString();
  const currentSearch = routerState.navigationSnapshot.searchParams.toString();

  return (
    targetPathname === routerState.navigationSnapshot.pathname && targetSearch === currentSearch
  );
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
// hydration bootstrap without registering RSC navigation globals —
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
  const runtimeRsc = getNavigationRuntime()?.bootstrap.rsc;

  if (runtimeRsc || vinext.__VINEXT_RSC_CHUNKS__ || vinext.__VINEXT_RSC_DONE__) {
    // Reaching the embedded-RSC branch means the server successfully rendered
    // the page — any prior reload flag for this path is stale and must be
    // cleared so a future failure gets its own fresh recovery attempt.
    clearReloadFlag();
    clearHardNavigationLoopGuard();

    if (runtimeRsc) {
      applyRuntimeRscBootstrap(runtimeRsc);
      if (runtimeRsc.done) {
        registerNavigationRuntimeBootstrap({ rsc: undefined });
        return chunksToReadableStream(runtimeRsc.rsc);
      }
      // The progressive stream must capture this bootstrap object before any
      // cleanup clears it from the runtime.
      return createProgressiveRscStream();
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
  clearHardNavigationLoopGuard();

  // Ignore malformed param headers and continue with hydration. The original
  // try/catch also swallowed errors from applyClientParams; preserve that.
  const parsedParams = parseEncodedJsonHeader<Record<string, string | string[]>>(
    rscResponse.headers.get(VINEXT_PARAMS_HEADER),
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

function applyRuntimeRscBootstrap(rsc: NavigationRuntimeRscBootstrap): void {
  const params = rsc.params ?? {};
  if (rsc.params) {
    applyClientParams(rsc.params);
  }
  if (rsc.nav) {
    restoreHydrationNavigationContext(rsc.nav.pathname, rsc.nav.searchParams, params);
  }
}

function registerServerActionCallback(): void {
  setServerCallback(async (id, args) => {
    const temporaryReferences = createTemporaryReferenceSet();

    // Carry the interception context + mounted slots from the current router
    // state so the server-action re-render rebuilds the intercepted tree
    // instead of replacing it with the direct page. Parity with Next.js,
    // which sends `Next-URL` on action POSTs when the current tree contains
    // an interception route.
    const actionInitiation = createActionInitiationSnapshot();
    // Keep history aligned with the captured snapshot. Action POST headers
    // read from actionInitiation, not from history, after this point.
    syncCurrentHistoryStatePreviousNextUrl(actionInitiation.routerState.previousNextUrl);
    const body = await encodeReply(args, { temporaryReferences });
    const { headers } = resolveServerActionRequestState({
      actionId: id,
      basePath: __basePath,
      elements: actionInitiation.routerState.elements,
      previousNextUrl: actionInitiation.routerState.previousNextUrl,
    });

    const fetchResponse = await fetch(await createRscRequestUrl(actionInitiation.path, headers), {
      method: "POST",
      headers,
      body,
    });

    // Surface an `UnrecognizedActionError` so client `catch` blocks can detect
    // client/server deployment skew via `unstable_isUnrecognizedActionError`.
    throwOnServerActionNotFound(fetchResponse, id);

    const actionRedirect = fetchResponse.headers.get(ACTION_REDIRECT_HEADER);
    if (actionRedirect) {
      if (isDangerousScheme(actionRedirect)) {
        console.error(DANGEROUS_URL_BLOCK_MESSAGE);
        return undefined;
      }

      const redirectType = fetchResponse.headers.get(ACTION_REDIRECT_TYPE_HEADER) ?? "push";
      const historyUpdateMode = redirectType === "push" ? "push" : "replace";
      const hardNavigationMode = historyUpdateMode === "push" ? "assign" : "replace";
      let redirectLocation: ReturnType<typeof resolveServerActionRedirectLocation>;
      try {
        redirectLocation = resolveServerActionRedirectLocation({
          currentHref: actionInitiation.href,
          location: actionRedirect,
          origin: window.location.origin,
        });
      } catch {
        clearClientNavigationCaches();
        browserNavigationController.performHardNavigation(actionRedirect, hardNavigationMode);
        return undefined;
      }

      clearClientNavigationCaches();
      startTransition(() => {
        void navigateClientSide(redirectLocation.href, historyUpdateMode, true, true);
      });
      return undefined;
    }

    if (
      resolveRscCompatibilityNavigationDecision({
        clientCompatibilityId: CLIENT_RSC_COMPATIBILITY_ID,
        currentHref: actionInitiation.href,
        origin: window.location.origin,
        responseCompatibilityId: fetchResponse.headers.get(VINEXT_RSC_COMPATIBILITY_ID_HEADER),
        responseUrl: fetchResponse.url,
      }).kind === "hard-navigate"
    ) {
      browserNavigationController.performHardNavigation(actionInitiation.href);
      return undefined;
    }

    const revalidation = parseServerActionRevalidationHeader(fetchResponse.headers);
    const result = await createFromFetch<ServerActionResult | AppWireElements>(
      Promise.resolve(fetchResponse),
      { temporaryReferences },
    );
    if (shouldClearClientNavigationCachesForServerActionResult(result, revalidation)) {
      clearClientNavigationCaches();
    }

    // Server actions stay on the same URL and use commitSameUrlNavigatePayload()
    // for merge-based dispatch. This path does not call
    // activateNavigationSnapshot() because there is no URL change to commit, so
    // hooks continue reading the live external-store values directly. If server
    // actions ever trigger URL changes via RSC payload (instead of hard
    // redirects), this would need renderNavigationPayload().
    if (isServerActionResult(result)) {
      if (result.root !== undefined) {
        return commitSameUrlNavigatePayload(
          Promise.resolve(AppElementsWire.decode(result.root)),
          actionInitiation,
          result.returnValue,
          revalidation,
        );
      }

      if (result.returnValue) {
        if (!result.returnValue.ok) {
          throw result.returnValue.data;
        }
        return result.returnValue.data;
      }

      return undefined;
    }

    return commitSameUrlNavigatePayload(
      Promise.resolve(AppElementsWire.decode(result)),
      actionInitiation,
      undefined,
      revalidation,
    );
  });
}

async function main(): Promise<void> {
  registerServerActionCallback();

  const rscStream = await readInitialRscStream();
  // null signals that readInitialRscStream aborted hydration — either because
  // a reload is in flight (first-attempt recovery) or the endpoint is
  // persistently broken (post-reload). Bootstrap is a separate synchronous
  // helper so the null-branch structurally cannot reach any RSC bootstrap
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
    createHistoryStateWithNavigationMetadata(window.history.state, {
      previousNextUrl: null,
      traversalIndex: currentHistoryTraversalIndex,
    }),
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
  const formState = consumeInitialFormState(getVinextBrowserGlobal());
  const hydrateRootOptions = import.meta.env.DEV
    ? createVinextHydrateRootOptions({
        formState,
        onCaughtError: devOnCaughtError,
        onUncaughtError,
      })
    : createVinextHydrateRootOptions({
        formState,
        onUncaughtError,
      });
  window.__VINEXT_RSC_ROOT__ = hydrateRootInTransition({
    children: createElement(BrowserRoot, {
      initialElements: root,
      initialNavigationSnapshot,
    }),
    container: document,
    hydrateRoot,
    options: hydrateRootOptions,
    startTransition,
  });

  const navigateRsc: NavigationRuntimeNavigate = async function navigateRsc(
    href: string,
    redirectDepth = 0,
    navigationKind: NavigationKind = "navigate",
    historyUpdateMode?: HistoryUpdateMode,
    previousNextUrlOverride?: string | null,
    programmaticTransition = false,
    traversalIntent?: HistoryTraversalIntent,
  ): Promise<void> {
    let pendingRouterState: PendingBrowserRouterState | null = null;
    // Hoist navId above try so the catch and finally blocks can reference it.
    const navId = browserNavigationController.beginNavigation();
    discardedServerActionRefreshScheduler.markNavigationStart();

    // Loop variables for inline redirect following. On a redirect, these are
    // updated and the loop continues without returning or re-entering navigateRsc,
    // so a single pendingRouterState spans all hops and isPending never flashes.
    let currentHref = href;
    let currentHistoryMode = historyUpdateMode;
    let currentPrevNextUrl = previousNextUrlOverride;
    let redirectCount = redirectDepth;
    let detachedNavigationCommits = false;
    const activeTraversalIntent =
      navigationKind === "traverse"
        ? (traversalIntent ??
          resolveHistoryTraversalIntent({
            currentHistoryIndex: currentHistoryTraversalIndex,
            historyState: window.history.state,
          }))
        : null;

    try {
      const shouldUsePendingRouterState = programmaticTransition;
      if (shouldUsePendingRouterState && hasBrowserRouterState()) {
        pendingRouterState = beginPendingBrowserRouterState();
      } else {
        await waitForBrowserRouterStateReady();
        if (!browserNavigationController.isCurrentNavigation(navId)) return;

        if (shouldUsePendingRouterState) {
          pendingRouterState = beginPendingBrowserRouterState();
        }
      }

      while (true) {
        const url = new URL(currentHref, window.location.origin);
        const requestState = getRequestState(
          navigationKind,
          url.pathname,
          currentPrevNextUrl,
          activeTraversalIntent?.historyState,
        );
        const requestInterceptionContext = requestState.interceptionContext;
        const requestPreviousNextUrl = requestState.previousNextUrl;
        if (navigationKind === "refresh") {
          syncCurrentHistoryStatePreviousNextUrl(requestPreviousNextUrl);
        }

        // Set this navigation as the pending pathname, overwriting any previous.
        // Pass navId so only this navigation (or a newer one) can clear it later.
        setPendingPathname(url.pathname, navId);

        const elementsAtNavStart = getBrowserRouterState().elements;
        const mountedSlotsHeader = getMountedSlotIdsHeader(elementsAtNavStart);
        const requestHeaders = createRscRequestHeaders({
          interceptionContext: requestInterceptionContext,
          renderMode:
            navigationKind === "refresh" ? APP_RSC_RENDER_MODE_REFRESH_PRESERVE_UI : undefined,
        });
        if (mountedSlotsHeader) {
          requestHeaders.set(VINEXT_MOUNTED_SLOTS_HEADER, mountedSlotsHeader);
        }
        const rscUrl = await createRscRequestUrl(url.pathname + url.search, requestHeaders);
        const cachedRoute = getVisitedResponse(
          rscUrl,
          requestInterceptionContext,
          mountedSlotsHeader,
          navigationKind,
        );
        if (cachedRoute) {
          const compatibilityDecision = resolveRscCompatibilityNavigationDecision({
            clientCompatibilityId: CLIENT_RSC_COMPATIBILITY_ID,
            currentHref,
            origin: window.location.origin,
            responseCompatibilityId: cachedRoute.response.compatibilityIdHeader,
            responseUrl: cachedRoute.response.url,
          });
          if (compatibilityDecision.kind === "hard-navigate") {
            browserNavigationController.performHardNavigation(
              compatibilityDecision.hardNavigationTarget,
            );
            return;
          }
          // Check stale-navigation before and after createFromFetch. The pre-check
          // avoids wasted parse work; the post-check catches supersessions that
          // occur during the await. createFromFetch on a buffered response is fast
          // but still async, so the window exists. The non-cached path (below) places
          // its heavyweight async steps (fetch, body.tee + createFromFetch on the
          // live RSC branch) between navId checks consistently; the cached path omits
          // the check between createClientNavigationRenderSnapshot (synchronous) and
          // createFromFetch because there is no await in that gap.
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
            detachedNavigationCommits ? null : pendingRouterState,
            VISITED_CACHE_APP_NAVIGATION_PAYLOAD_ORIGIN,
            toActionType(navigationKind),
            toOperationLane(navigationKind),
            activeTraversalIntent,
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

        if (!navResponse && navigationKind === "navigate") {
          const routeManifest = getBrowserRouteManifest();
          await learnOptimisticRouteTemplatesFromPrefetchCache({
            interceptionContext: requestInterceptionContext,
            mountedSlotsHeader,
            routeManifest,
          });
          if (!browserNavigationController.isCurrentNavigation(navId)) return;

          if (routeManifest !== null) {
            const optimisticPayload = resolveOptimisticNavigationPayload({
              basePath: __basePath,
              href: currentHref,
              interceptionContext: requestInterceptionContext,
              mountedSlotsHeader,
              routeManifest,
              templates: optimisticRouteTemplates,
            });

            if (optimisticPayload !== null) {
              detachedNavigationCommits = true;
              const optimisticNavigationSnapshot = createClientNavigationRenderSnapshot(
                currentHref,
                optimisticPayload.params,
              );
              // The optimistic shell is a detached commit for this navigation.
              // It uses the same navId gate as the real payload, while the real
              // payload skips pending-router-state reuse via
              // detachedNavigationCommits. That keeps late optimistic errors or
              // transitions from mutating a newer navigation or sharing mutable
              // pending state with the authoritative render.
              void renderNavigationPayload(
                Promise.resolve(optimisticPayload.elements),
                optimisticNavigationSnapshot,
                currentHref,
                navId,
                currentHistoryMode,
                optimisticPayload.params,
                requestPreviousNextUrl,
                null,
                FRESH_APP_NAVIGATION_PAYLOAD_ORIGIN,
                toActionType(navigationKind),
                toOperationLane(navigationKind),
                activeTraversalIntent,
              ).catch((error) => {
                if (browserNavigationController.isCurrentNavigation(navId)) {
                  console.error("[vinext] Optimistic RSC navigation error:", error);
                }
              });
            }
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
          browserNavigationController.performHardNavigation(
            resolveHardNavigationTargetFromRscResponse(
              responseUrl,
              currentHref,
              window.location.origin,
            ),
          );
          return;
        }

        const compatibilityDecision = resolveRscCompatibilityNavigationDecision({
          clientCompatibilityId: CLIENT_RSC_COMPATIBILITY_ID,
          currentHref,
          origin: window.location.origin,
          responseCompatibilityId: navResponse.headers.get(VINEXT_RSC_COMPATIBILITY_ID_HEADER),
          responseUrl: navResponseUrl ?? navResponse.url,
        });
        if (compatibilityDecision.kind === "hard-navigate") {
          browserNavigationController.performHardNavigation(
            compatibilityDecision.hardNavigationTarget,
          );
          return;
        }

        const redirectDecision = resolveRscRedirectLifecycleHop({
          currentHref,
          historyUpdateMode: currentHistoryMode ?? "replace",
          origin: window.location.origin,
          redirectDepth: redirectCount,
          requestPreviousNextUrl,
          responseUrl: navResponseUrl ?? navResponse.url,
        });

        if (redirectDecision.kind === "terminal-hard-navigation") {
          if (redirectDecision.reason === "maxRedirectsExceeded") {
            console.error(
              "[vinext] Too many RSC redirects — aborting navigation to prevent infinite loop.",
            );
          }
          browserNavigationController.performHardNavigation(redirectDecision.href);
          return;
        }

        if (redirectDecision.kind === "follow") {
          // Server-side redirect: keep the redirect chain inside this operation
          // and defer URL/history mutation to the eventual approved commit.
          // This keeps isPending true across all hops and avoids publishing a
          // destination URL before its RSC payload is lifecycle-approved.
          currentHref = redirectDecision.href;
          currentHistoryMode = redirectDecision.historyUpdateMode;
          currentPrevNextUrl = redirectDecision.previousNextUrl;
          redirectCount = redirectDecision.redirectDepth;
          continue;
        }

        // RSC redirect encoded as 200 + flight payload (the server's response
        // for `redirect()` thrown from a server component during RSC rendering;
        // see issue #1347 and `buildAppPageSpecialErrorResponse`). The flight
        // body carries the canonical `NEXT_REDIRECT;...` digest for clients
        // that decode it through React's RedirectBoundary, but vinext's
        // browser-navigation loop catches it ahead of decode via this
        // side-channel header so the redirect-following loop above can drain
        // the body and continue without bouncing through the catch path.
        // Reusing the same loop variables keeps `pendingRouterState` and the
        // outer `useTransition` pending state continuous across the hop —
        // matching the pre-1347 fetch-auto-follow-307 behavior.
        const flightRedirectTarget = navResponse.headers.get(VINEXT_RSC_REDIRECT_HEADER);
        if (flightRedirectTarget) {
          // Drain the response body so the underlying connection is released.
          // We do this best-effort: the destination's `.rsc` fetch on the next
          // loop iteration will replace this response entirely.
          void navResponse.body?.cancel().catch(() => {});
          const resolvedTarget = new URL(flightRedirectTarget, window.location.origin);
          if (resolvedTarget.origin !== window.location.origin) {
            browserNavigationController.performHardNavigation(resolvedTarget.href);
            return;
          }
          if (redirectCount >= MAX_RSC_REDIRECT_DEPTH) {
            console.error(
              "[vinext] Too many RSC redirects — aborting navigation to prevent infinite loop.",
            );
            browserNavigationController.performHardNavigation(resolvedTarget.href);
            return;
          }
          currentHref = `${resolvedTarget.pathname}${resolvedTarget.search}${resolvedTarget.hash}`;
          redirectCount += 1;
          continue;
        }

        // navParams falls back to {} on a missing or malformed header.
        const navParams: Record<string, string | string[]> =
          parseEncodedJsonHeader<Record<string, string | string[]>>(
            navResponse.headers.get(VINEXT_PARAMS_HEADER),
          ) ?? {};
        // Build snapshot from local params, not latestClientParams
        const navigationSnapshot = createClientNavigationRenderSnapshot(currentHref, navParams);

        // Tee the response body so React can consume it incrementally —
        // shell parses fast, and any Suspense boundary inside (e.g. the
        // route's loading.tsx) shows its fallback while the rest of the
        // RSC stream resolves. Buffering with `await response.arrayBuffer()`
        // here would block the commit until the page's slowest server
        // promise resolved, hiding the loading state entirely.
        //
        // The cache branch is read in the background so the visited-
        // response snapshot lands as soon as the full stream completes,
        // without holding up React's commit.
        const navBody = navResponse.body;
        if (!navBody) {
          // Already validated above (`!navResponse.body` triggers a hard
          // navigation), so this branch is unreachable — kept for type
          // narrowing only.
          return;
        }
        const [reactBranch, cacheBranch] = navBody.tee();
        const reactResponse = new Response(reactBranch, {
          status: navResponse.status,
          headers: navResponse.headers,
        });
        const cacheBufferPromise = new Response(cacheBranch).arrayBuffer();

        if (!browserNavigationController.isCurrentNavigation(navId)) return;

        const rscPayload = decodeAppElementsPromise(
          createFromFetch<AppWireElements>(Promise.resolve(reactResponse)),
        );

        if (!browserNavigationController.isCurrentNavigation(navId)) return;

        const renderOutcome = await renderNavigationPayload(
          rscPayload,
          navigationSnapshot,
          currentHref,
          navId,
          currentHistoryMode,
          navParams,
          requestPreviousNextUrl,
          detachedNavigationCommits ? null : pendingRouterState,
          FRESH_APP_NAVIGATION_PAYLOAD_ORIGIN,
          toActionType(navigationKind),
          toOperationLane(navigationKind),
          activeTraversalIntent,
        );
        if (renderOutcome !== "committed") return;
        // Don't cache the response if this navigation was superseded during
        // renderNavigationPayload's await — the elements were never dispatched.
        if (!browserNavigationController.isCurrentNavigation(navId)) return;
        // Store the visited response only after renderNavigationPayload succeeds.
        // If we stored it before and renderNavigationPayload threw, a future
        // back/forward navigation could replay a snapshot from a navigation that
        // never actually rendered successfully.
        const resolvedElements = await rscPayload;
        const metadata = AppElementsWire.readMetadata(resolvedElements);
        if (!isCacheRestorableAppPayloadMetadata(metadata)) {
          void cacheBufferPromise.catch(() => {});
          return;
        }
        void cacheBufferPromise
          .then((cacheBuffer) => {
            storeVisitedResponseSnapshot(
              rscUrl,
              resolveVisitedResponseInterceptionContext(
                requestInterceptionContext,
                metadata.interceptionContext,
              ),
              createCachedRscResponseSnapshot(navResponse, cacheBuffer, navResponseUrl),
              navParams,
            );
          })
          .catch(() => {});
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
      browserNavigationController.performHardNavigation(currentHref);
    } finally {
      // Single settlement site: covers normal return, early returns on stale-id
      // checks, and error paths. The finally runs even when the catch returns.
      // settlePendingBrowserRouterState is idempotent via the settled flag.
      browserNavigationController.finalizeNavigation(navId, pendingRouterState);
      discardedServerActionRefreshScheduler.markNavigationSettled();
    }
  };

  // Exposed through one typed runtime seam so next/navigation, Link, Form, and
  // the browser entry share a single App Router capability contract.
  registerNavigationRuntimeFunctions({
    clearNavigationCaches: clearClientNavigationCaches,
    commitHashNavigation: commitHashOnlyNavigation,
    navigate: navigateRsc,
  });

  if ("scrollRestoration" in history) {
    history.scrollRestoration = "manual";
  }

  // Note: This popstate handler runs for App Router (RSC navigation available).
  // It coordinates scroll restoration with the pending RSC navigation.
  // Pages Router scroll restoration is handled in shims/navigation.ts:1289 with
  // microtask-based deferral for compatibility with non-RSC navigation.
  // See: https://github.com/vercel/next.js/discussions/41934#discussioncomment-4602607
  const handlePopstate = createPopstateRestoreHandler({
    getActiveNavigationId: browserNavigationController.getActiveNavigationId.bind(
      browserNavigationController,
    ),
    getPendingNavigation: () => window.__VINEXT_RSC_PENDING__,
    getNavigate: () => getNavigationRuntime()?.functions.navigate,
    isCurrentNavigation: browserNavigationController.isCurrentNavigation.bind(
      browserNavigationController,
    ),
    notifyAppRouterTransitionStart: (href) => {
      notifyAppRouterTransitionStart(href, "traverse");
    },
    restorePopstateScrollPosition,
    setPendingNavigation: (pendingNavigation) => {
      window.__VINEXT_RSC_PENDING__ = pendingNavigation;
    },
  });

  window.addEventListener("popstate", (event) => {
    // The browser has already applied the history entry by the time popstate
    // fires. App Router state does not include hashes, so matching the
    // committed pathname/search proves this traversal does not need a new RSC
    // payload. This covers both /page#target -> /page and /page -> /page#target.
    // Notify the transition start so observers still see the URL change, then
    // restore scroll directly and skip the RSC dispatch.
    const href = window.location.href;
    if (isSameAppRoutePopstateTarget(href)) {
      notifyAppRouterTransitionStart(href, "traverse");
      commitTraversalIndexFromHistoryState(event.state);
      restorePopstateScrollPosition(event.state);
      return;
    }
    handlePopstate(event);
  });

  if (import.meta.hot) {
    const handleRscUpdate = async (): Promise<void> => {
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
    };

    import.meta.hot.on("rsc:update", () => {
      void handleRscUpdate();
    });
  }
}

if (typeof document !== "undefined") {
  // Install `window.next` as early as possible so any client component that
  // synchronously dereferences it during hydration (or any third-party
  // library script tag that loads before the React tree mounts) sees the
  // expected shape. Mirrors Next.js's app-bootstrap.ts (line 13) which sets
  // `window.next = { version, appDir: true }` before the React runtime
  // initializes, and `app-router-instance.ts` (line 510) which assigns
  // `router: publicAppRouterInstance` at module load.
  installWindowNext({ appDir: true, router: appRouterInstance });

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
