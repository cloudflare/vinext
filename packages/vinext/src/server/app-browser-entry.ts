/// <reference types="vite/client" />

import {
  createElement,
  startTransition,
  use,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  createFromFetch,
  createFromReadableStream,
  createTemporaryReferenceSet,
  encodeReply,
  setServerCallback,
} from "@vitejs/plugin-rsc/browser";
import { flushSync } from "react-dom";
import { hydrateRoot } from "react-dom/client";
import "../client/instrumentation-client.js";
import { notifyAppRouterTransitionStart } from "../client/instrumentation-client-state.js";
import {
  __basePath,
  appRouterInstance,
  commitClientNavigationState,
  consumePrefetchResponseForNavigation,
  createCachedRscResponseSnapshot,
  createClientNavigationRenderSnapshot,
  getClientNavigationRenderContext,
  getBfcacheIdMapContext,
  getPrefetchCache,
  invalidatePrefetchCache,
  decodeRedirectError,
  isRedirectError,
  pushHistoryStateWithoutNotify,
  replaceClientParamsWithoutNotify,
  replaceHistoryStateWithoutNotify,
  resolvePrefetchCacheEntryMountedSlotsHeader,
  restoreRscResponse,
  saveScrollPosition,
  setClientParams,
  setPendingPathname,
  setMountedSlotsHeader,
  setNavigationContext,
  useRouter,
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
import { retryScrollTo, scrollToHashTargetOnNextFrame } from "vinext/shims/hash-scroll";
import { AppRouterScrollCommitProvider } from "vinext/shims/app-router-scroll";
import {
  beginAppRouterScrollIntent,
  consumeAppRouterScrollIntent,
  type AppRouterScrollIntent,
} from "vinext/shims/app-router-scroll-state";
import { installWindowNext } from "../client/window-next.js";
import {
  chunksToReadableStream,
  createProgressiveRscStream,
  getVinextBrowserGlobal,
} from "./app-browser-stream.js";
import {
  clearHardNavigationLoopGuard,
  createAppBrowserNavigationController,
  createBasePathStrippedPathAndSearch,
  createSnapshotPathAndSearch,
  type HistoryUpdateMode,
  type NavigationPayloadOutcome,
  type PendingBrowserRouterState,
} from "./app-browser-navigation-controller.js";
import { AppBrowserMpaNavigationScheduler } from "./app-browser-mpa-navigation.js";
import {
  resolveManifestNavigationInterceptionContext,
  resolveMiddlewareRewriteNavigationInterceptionContext,
} from "./app-browser-interception-context.js";
import {
  createDiscardedServerActionRefreshScheduler,
  createServerActionInitiationSnapshot,
  isServerActionResult,
  normalizeServerActionThrownValue,
  parseServerActionRevalidationHeader,
  readInvalidServerActionResponseError,
  resolveServerActionRedirectCompatibilityHardNavigationTarget,
  shouldCheckRscCompatibilityForServerActionResponse,
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
  createBfcacheSegmentStateKeyMap,
  createInitialBfcacheIdMap,
  isCacheRestorableAppPayloadMetadata,
  readHistoryStatePreviousNextUrl,
  resolveInterceptionContextFromPreviousNextUrl,
  resolveServerActionRequestState,
  type AppNavigationPayloadOrigin,
  type AppRouterState,
  type HistoryTraversalIntent,
  type OperationLane,
} from "./app-browser-state.js";
import { AppBrowserHistoryController } from "./app-browser-history-controller.js";
import {
  createVisitedResponseCacheEntry,
  isVisitedResponseCacheEntryFresh,
  type VisitedResponseCacheEntry,
} from "./app-visited-response-cache.js";
import {
  createPopstateRestoreHandler,
  restoreSynchronousPopstateScrollPosition,
} from "./app-browser-popstate.js";
import { DevRecoveryBoundary, RedirectBoundary } from "vinext/shims/error-boundary";
import { AppRouterContext } from "vinext/shims/internal/app-router-context";
import { BfcacheStateKeyMapContext, ElementsContext, Slot } from "vinext/shims/slot";
import type { RouteManifest } from "../routing/app-route-graph.js";
import { createOnUncaughtError, prodOnCaughtError } from "./app-browser-error.js";
import { createClientReuseManifestHeaderFromVisibleAppState } from "./app-browser-client-reuse-manifest.js";
import {
  devOnCaughtError,
  devOnUncaughtError,
  dismissOverlay,
  installDevErrorOverlay,
  installViteHmrErrorHandler,
  reportInitialDevServerErrors,
} from "./dev-error-overlay.js";
import { DANGEROUS_URL_BLOCK_MESSAGE, isDangerousScheme } from "vinext/shims/url-safety";
import { throwOnServerActionNotFound } from "./server-action-not-found.js";
import {
  createRscRequestHeaders,
  createRscRequestUrl,
  createServerActionRequestUrl,
  getVinextRscCompatibilityId,
  resolveRscCompatibilityNavigationDecision,
  VINEXT_RSC_COMPATIBILITY_ID_HEADER,
  VINEXT_RSC_CONTENT_TYPE,
} from "./app-rsc-cache-busting.js";
import { APP_RSC_RENDER_MODE_REFRESH_PRESERVE_UI } from "./app-rsc-render-mode.js";
import {
  createOptimisticRouteTemplate,
  getOptimisticPrefetchSourceKey,
  getOptimisticRouteTemplateKey,
  resolveOptimisticNavigationPayload,
  type OptimisticRouteTemplate,
} from "./app-optimistic-routing.js";
import {
  ACTION_REDIRECT_HEADER,
  ACTION_REDIRECT_STATUS_HEADER,
  ACTION_REDIRECT_TYPE_HEADER,
  VINEXT_CLIENT_REUSE_MANIFEST_HEADER,
  VINEXT_PARAMS_HEADER,
  VINEXT_RSC_REDIRECT_HEADER,
} from "./headers.js";
import { removeStylesheetLinksCoveredByInlineCss } from "./app-inline-css-client.js";
import { navigationPlanner } from "./navigation-planner.js";

type SearchParamInput = ConstructorParameters<typeof URLSearchParams>[0];

type ServerActionResult = AppBrowserServerActionResult<AppWireElements>;

type NavigationKind = "navigate" | "traverse" | "refresh";
type MpaNavigationState = {
  href: string;
  historyUpdateMode: HistoryUpdateMode;
  kind: "mpa-navigation";
};

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

const MAX_VISITED_RESPONSE_CACHE_SIZE = 50;
const CLIENT_RSC_COMPATIBILITY_ID = getVinextRscCompatibilityId();
const optimisticRouteTemplates = new Map<string, OptimisticRouteTemplate>();
const optimisticRouteTemplateSources = new Set<string>();
const optimisticRouteTemplateLearning = new Map<string, Promise<void>>();
function getBrowserRouteManifest(): RouteManifest | null {
  return getNavigationRuntime()?.bootstrap.routeManifest ?? null;
}

const MAX_HISTORY_STATE_SNAPSHOTS = 50;
const historyController = new AppBrowserHistoryController({
  initialHistoryState: window.history.state,
  maxHistoryStateSnapshots: MAX_HISTORY_STATE_SNAPSHOTS,
  readHistoryState: () => window.history.state,
  readCurrentHref: () => window.location.href,
  pushHistoryState: (state, href) => pushHistoryStateWithoutNotify(state, "", href),
  replaceHistoryState: (state, href) => replaceHistoryStateWithoutNotify(state, "", href),
  readVisibleNavigationMetadata: () => {
    if (!hasBrowserRouterState()) return null;
    const routerState = getBrowserRouterState();
    return { bfcacheIds: routerState.bfcacheIds, previousNextUrl: routerState.previousNextUrl };
  },
});

const browserNavigationController = createAppBrowserNavigationController({
  basePath: __basePath,
  getRouteManifest: getBrowserRouteManifest,
  syncHistoryStatePreviousNextUrl: (previousNextUrl, bfcacheIds) =>
    historyController.syncCurrentHistoryStatePreviousNextUrl(previousNextUrl, bfcacheIds),
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
const ACTION_HTTP_FALLBACK_ROBOTS_META_ATTR = "data-vinext-action-http-fallback";

function syncServerActionHttpFallbackHead(status: number | null): void {
  document.head
    .querySelectorAll(`meta[${ACTION_HTTP_FALLBACK_ROBOTS_META_ATTR}="robots"]`)
    .forEach((node) => node.remove());

  if (status !== 404) return;

  const robots = document.createElement("meta");
  robots.name = "robots";
  robots.content = "noindex";
  robots.setAttribute(ACTION_HTTP_FALLBACK_ROBOTS_META_ATTR, "robots");
  document.head.appendChild(robots);
}
const BfcacheIdMapContext = getBfcacheIdMapContext();

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
  value: AppRouterState | Promise<AppRouterState> | MpaNavigationState,
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
const mpaNavigationScheduler = new AppBrowserMpaNavigationScheduler();
const unresolvedMpaNavigation = new Promise<never>(() => {});
const RSC_HMR_SETTLE_DELAY_MS = 150;
let latestRscHmrUpdateId = 0;
// Single-slot latch tracking the navId of the most recent synchronous
// popstate snapshot restore. activeNavigationId is strictly monotonic, so
// shouldSkipScrollRestore can only match the most-recently restored
// navigation. This is intentionally not a per-navigation set — a future
// asynchronous scroll restore for an older navId is already stale.
let synchronousPopstateScrollRestoreNavigationId: number | null = null;

// Vite can notify the browser about an RSC HMR update before the dev server's
// request runner has swapped to the invalidated module graph. Give the
// invalidated graph a short settle window so HMR sees the same payload a
// direct refresh would see.
function waitForRscHmrSettle(delayMs = RSC_HMR_SETTLE_DELAY_MS): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, delayMs);
  });
}

function restoreHistoryStateSnapshot(historyState: unknown): boolean {
  const navId = browserNavigationController.getActiveNavigationId();
  let restored = false;
  flushSync(() => {
    restored = historyController.restoreHistorySnapshot({
      historyState,
      stageClientParams,
      approveVisibleRestore: ({ state, beforeCommit }) =>
        browserNavigationController.restoreHistorySnapshotVisibleState({
          beforeCommit,
          navId,
          state,
          targetHref: window.location.href,
        }),
    });
  });
  if (!restored) return false;

  commitClientNavigationState();
  return true;
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
  historyController.invalidateRestorableClientState();
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
  if (resolvePrefetchCacheEntryMountedSlotsHeader(options.entry) !== options.mountedSlotsHeader) {
    return false;
  }
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
  bfcacheIds: Readonly<Record<string, string>>;
  href: string;
  historyUpdateMode: HistoryUpdateMode | undefined;
  navId: number;
  params: Record<string, string | string[]>;
  previousNextUrl: string | null;
  targetHistoryIndex?: number | null;
}): () => void {
  const {
    bfcacheIds,
    href,
    historyUpdateMode,
    navId,
    params,
    previousNextUrl,
    targetHistoryIndex,
  } = options;

  return () => {
    // Only update URL if this is still the active navigation.
    // A newer navigation would have superseded this navigation id.
    if (!browserNavigationController.isCurrentNavigation(navId)) {
      // This transition was superseded before commit; balance the active
      // snapshot counter without clearing pendingPathname ownership.
      commitClientNavigationState(undefined, { releaseSnapshot: true });
      return;
    }

    historyController.commitNavigationHistory({
      bfcacheIds,
      href,
      historyUpdateMode,
      previousNextUrl,
      stageClientParams: () => stageClientParams(params),
      targetHistoryIndex,
    });

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
  scrollIntent: AppRouterScrollIntent | null | undefined = null,
  restoredBfcacheIds: Readonly<Record<string, string>> | null = null,
  reuseCurrentBfcacheIds: boolean = true,
): Promise<NavigationPayloadOutcome> {
  syncServerActionHttpFallbackHead(null);
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
      scrollIntent,
      restoredBfcacheIds,
      reuseCurrentBfcacheIds,
      targetHistoryIndex: traversalIntent === null ? undefined : traversalIntent.targetHistoryIndex,
      targetHref,
      navId,
    });
  } catch (error) {
    pendingNavigationRecoveryHref = null;
    throw error;
  }
}

function resolveActionRedirectTarget(
  response: Response,
): { href: string; type: string; status: number } | null {
  const actionRedirect = response.headers.get(ACTION_REDIRECT_HEADER);
  if (!actionRedirect) return null;

  if (isDangerousScheme(actionRedirect)) {
    console.error(DANGEROUS_URL_BLOCK_MESSAGE);
    return null;
  }

  try {
    let redirectUrl: URL;
    if (actionRedirect.startsWith("/") || /^[a-z]+:/i.test(actionRedirect)) {
      redirectUrl = new URL(actionRedirect, window.location.href);
    } else {
      const baseParsed = new URL(window.location.href);
      let baseDir = baseParsed.pathname;
      if (!baseDir.endsWith("/")) {
        baseDir = baseDir + "/";
      }
      redirectUrl = new URL(actionRedirect, `${baseParsed.origin}${baseDir}${baseParsed.search}`);
    }

    if (redirectUrl.origin !== window.location.origin) {
      browserNavigationController.performHardNavigation(actionRedirect);
      return null;
    }
    const statusHeader = response.headers.get(ACTION_REDIRECT_STATUS_HEADER);
    const status = statusHeader ? parseInt(statusHeader, 10) : 307;
    return {
      href: redirectUrl.href,
      type: response.headers.get(ACTION_REDIRECT_TYPE_HEADER) ?? "push",
      status,
    };
  } catch {
    browserNavigationController.performHardNavigation(actionRedirect);
    return null;
  }
}

class ServerActionRedirectError extends Error {
  readonly digest: string;
  readonly handled = true;

  constructor(target: { href: string; type: string; status: number }) {
    super("NEXT_REDIRECT");
    const redirectUrl = new URL(target.href, window.location.href);
    const redirectHref = redirectUrl.pathname + redirectUrl.search + redirectUrl.hash;
    const redirectType = target.type === "push" ? "push" : "replace";
    this.digest = `NEXT_REDIRECT;${redirectType};${encodeURIComponent(redirectHref)};${target.status};`;
  }
}

function createServerActionRedirectError(target: {
  href: string;
  type: string;
  status: number;
}): Error {
  return new ServerActionRedirectError(target);
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

  // `isVisitedResponseCacheEntryFresh` is the single source of truth for
  // freshness and returns `false` for `navigationKind === "refresh"`, so a
  // refresh falls through to the miss path below.
  if (
    isVisitedResponseCacheEntryFresh(cached, {
      navigationKind,
      now: Date.now(),
    })
  ) {
    // LRU: promote to most-recently-used
    visitedResponseCache.delete(cacheKey);
    visitedResponseCache.set(cacheKey, cached);
    return cached;
  }

  // Stale (or refresh) entries are evicted on read. A refresh intentionally
  // drops any prior snapshot here — the navigation re-fetches and re-stores a
  // fresh one, so leaving the old entry around would only risk a later
  // non-refresh navigation reusing a snapshot the user explicitly refreshed.
  visitedResponseCache.delete(cacheKey);
  return null;
}

function deleteVisitedResponse(rscUrl: string, interceptionContext: string | null): void {
  visitedResponseCache.delete(AppElementsWire.encodeCacheKey(rscUrl, interceptionContext));
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
  visitedResponseCache.set(
    cacheKey,
    createVisitedResponseCacheEntry({
      now,
      params,
      response: snapshot,
    }),
  );
}

// Build the absolute current-document href the early-intent planner compares
// against the navigation target. The committed snapshot carries a base-stripped
// pathname plus parsed search params; the planner re-strips the base (a no-op on
// an already-stripped path) so both sides reduce to the same canonical form.
function clientNavigationSnapshotHref(snapshot: ClientNavigationRenderSnapshot): string {
  return `${window.location.origin}${createSnapshotPathAndSearch(snapshot)}`;
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
      // Fallback: when the current page is a declared interception source and
      // the target URL still matches the declared target prefix, send the
      // current pathname as context so the server can fire interception for
      // middleware-rewritten targets. The client manifest check above only
      // matches the pre-middleware target URL against the declared pattern;
      // when middleware adds a segment (e.g. locale prefix), the pre-rewrite
      // URL is shorter than the pattern and the match fails. Sending the
      // current pathname lets the server re-check after applying the rewrite.
      //
      // We gate on source plus target prefix rather than always sending
      // context, to preserve prefetch cache reuse for ordinary navigations
      // where interception cannot apply.
      const middlewareRewriteInterceptionContext =
        resolveMiddlewareRewriteNavigationInterceptionContext({
          basePath: __basePath,
          currentPathname: window.location.pathname,
          routeManifest: getBrowserRouteManifest(),
          targetPathname,
        });
      if (middlewareRewriteInterceptionContext !== null) {
        const currentHrefForFallback = window.location.pathname + window.location.search;
        return {
          interceptionContext: middlewareRewriteInterceptionContext,
          previousNextUrl: currentHrefForFallback,
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

function isMpaNavigationState(
  value: AppRouterState | Promise<AppRouterState> | MpaNavigationState,
): value is MpaNavigationState {
  return (
    value !== null &&
    typeof value === "object" &&
    "kind" in value &&
    value.kind === "mpa-navigation"
  );
}

function performMpaNavigation(href: string, historyUpdateMode: HistoryUpdateMode): void {
  // Match Next's MPA path by suspending forever, but delay the actual location
  // mutation just enough for the old tree to commit the pending transition
  // signal before unload.
  mpaNavigationScheduler.navigate(window, href, historyUpdateMode);
}

function AppRouterRedirectBridge({ children }: { children?: React.ReactNode }) {
  const router = useRouter();

  useEffect(() => {
    const handleUnhandledRedirect = (event: ErrorEvent | PromiseRejectionEvent): void => {
      const error = "reason" in event ? event.reason : event.error;
      if (!isRedirectError(error)) return;

      const result = decodeRedirectError(error.digest);
      if (!result) return;

      event.preventDefault();
      startTransition(() => {
        if (result.type === "push") {
          router.push(result.url);
        } else {
          router.replace(result.url);
        }
      });
    };

    window.addEventListener("error", handleUnhandledRedirect);
    window.addEventListener("unhandledrejection", handleUnhandledRedirect);

    return () => {
      window.removeEventListener("error", handleUnhandledRedirect);
      window.removeEventListener("unhandledrejection", handleUnhandledRedirect);
    };
  }, [router]);

  return children ?? null;
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
  const [treeStateValue, setTreeStateValue] = useState<
    AppRouterState | Promise<AppRouterState> | MpaNavigationState
  >(() => ({
    activeOperation: null,
    // Intentional Next.js parity: a hard reload starts a new browser
    // document without the prior in-memory router state. Hydrate
    // the new document on the zero sentinel and rely on the document-scoped
    // bfcache version gate to reject stale ids persisted by previous
    // documents.
    bfcacheIds: createInitialBfcacheIdMap(resolvedElements),
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
  }));
  if (isMpaNavigationState(treeStateValue)) {
    performMpaNavigation(treeStateValue.href, treeStateValue.historyUpdateMode);
    throw unresolvedMpaNavigation;
  }
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
    const setAppRouterStateValue = (value: AppRouterState | Promise<AppRouterState>) => {
      setTreeStateValue(value);
    };
    const detach = browserNavigationController.attachBrowserRouterState(
      setAppRouterStateValue,
      stateRef,
    );
    registerNavigationRuntimeFunctions({
      navigateExternal: (href, historyUpdateMode) => {
        setTreeStateValue({
          href,
          historyUpdateMode,
          kind: "mpa-navigation",
        });
        return new Promise<void>(() => {});
      },
    });
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
      registerNavigationRuntimeFunctions({ navigateExternal: undefined });
      detach();
      setMountedSlotsHeader(null);
    };
  }, [setTreeStateValue]);

  // This effect snapshots treeState against the controller's current traversal
  // index but only depends on [treeState]. The ordering works because the
  // traversal-index commit runs inside the navigation commit effect (before
  // setTreeStateValue fires), so the index is already current when this layout
  // effect runs for the new treeState. If the commit ordering ever changes, the
  // snapshot index may not match the traversed history entry, causing
  // resolveRestore to read the wrong index on back.
  useLayoutEffect(() => {
    historyController.rememberHistoryStateSnapshot(treeState);
  }, [treeState]);

  useLayoutEffect(() => {
    setMountedSlotsHeader(getMountedSlotIdsHeader(stateRef.current.elements));
    removeStylesheetLinksCoveredByInlineCss();
    getNavigationRuntime()?.functions.pingVisibleLinks?.();
  }, [treeState.elements]);

  useLayoutEffect(() => {
    if (treeState.renderId !== 0) {
      return;
    }

    historyController.writeHydratedHistoryMetadata({
      bfcacheIds: treeState.bfcacheIds,
      previousNextUrl: treeState.previousNextUrl,
    });
  }, [treeState.bfcacheIds, treeState.previousNextUrl, treeState.renderId]);

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
  const bfcacheStateKeys = useMemo(
    () =>
      createBfcacheSegmentStateKeyMap({
        elements: treeState.elements,
        pathname: treeState.navigationSnapshot.pathname,
      }),
    [treeState.elements, treeState.navigationSnapshot.pathname],
  );
  const stateKeyTree = createElement(
    BfcacheStateKeyMapContext.Provider,
    { value: bfcacheStateKeys },
    routeTree,
  );
  const bfcacheTree = BfcacheIdMapContext
    ? createElement(BfcacheIdMapContext.Provider, { value: treeState.bfcacheIds }, stateKeyTree)
    : stateKeyTree;
  const redirectedTree = createElement(AppRouterRedirectBridge, null, bfcacheTree);
  const innerTree = AppRouterContext
    ? createElement(AppRouterContext.Provider, { value: appRouterInstance }, redirectedTree)
    : redirectedTree;

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

  const scrollScopedTree = createElement(
    AppRouterScrollCommitProvider,
    { commitId: treeState.renderId },
    committedTree,
  );

  const ClientNavigationRenderContext = getClientNavigationRenderContext();
  if (!ClientNavigationRenderContext) {
    return scrollScopedTree;
  }

  return createElement(
    ClientNavigationRenderContext.Provider,
    { value: treeState.navigationSnapshot },
    scrollScopedTree,
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

function restorePopstateScrollPosition(
  state: unknown,
  options?: {
    shouldContinue?: () => boolean;
  },
): void {
  const shouldContinue = options?.shouldContinue ?? (() => true);
  if (!shouldContinue()) return;

  if (!(state && typeof state === "object" && "__vinext_scrollY" in state)) {
    if (window.location.hash) {
      scrollToHashTargetOnNextFrame(window.location.hash);
    }
    return;
  }

  const y = Number(state.__vinext_scrollY);
  const x = "__vinext_scrollX" in state ? Number(state.__vinext_scrollX) : 0;

  retryScrollTo(x, y, { minFrames: 1, shouldContinue });
}

function isSameAppRoutePopstateTarget(href: string): boolean {
  if (!hasBrowserRouterState()) return false;

  const target = new URL(href, window.location.origin);
  const routerState = getBrowserRouterState();

  return (
    createBasePathStrippedPathAndSearch(target, __basePath) ===
    createSnapshotPathAndSearch(routerState.navigationSnapshot)
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
  const serverActionCallback: Parameters<typeof setServerCallback>[0] = async (id, args) => {
    syncServerActionHttpFallbackHead(null);
    const temporaryReferences = createTemporaryReferenceSet();
    // Carry the interception context + mounted slots from the current router
    // state so the server-action re-render rebuilds the intercepted tree
    // instead of replacing it with the direct page. Parity with Next.js,
    // which sends `Next-URL` on action POSTs when the current tree contains
    // an interception route.
    const actionInitiation = createActionInitiationSnapshot();
    // Keep history aligned with the captured snapshot. Action POST headers
    // read from actionInitiation, not from history, after this point.
    historyController.syncCurrentHistoryStatePreviousNextUrl(
      actionInitiation.routerState.previousNextUrl,
      actionInitiation.routerState.bfcacheIds,
    );
    const body = await encodeReply(args, { temporaryReferences });
    const { headers } = resolveServerActionRequestState({
      actionId: id,
      basePath: __basePath,
      elements: actionInitiation.routerState.elements,
      previousNextUrl: actionInitiation.routerState.previousNextUrl,
    });

    const fetchResponse = await fetch(createServerActionRequestUrl(actionInitiation.path), {
      method: "POST",
      headers,
      body,
    });

    // Surface an `UnrecognizedActionError` so client `catch` blocks can detect
    // client/server deployment skew via `unstable_isUnrecognizedActionError`.
    throwOnServerActionNotFound(fetchResponse, id);

    const hasActionRedirect = fetchResponse.headers.has(ACTION_REDIRECT_HEADER);
    const actionRedirectTarget = resolveActionRedirectTarget(fetchResponse);
    if (hasActionRedirect && !actionRedirectTarget) {
      return undefined;
    }

    const actionRedirectCompatibilityHardNavigationTarget =
      resolveServerActionRedirectCompatibilityHardNavigationTarget({
        actionRedirectHref: actionRedirectTarget?.href ?? null,
        clientCompatibilityId: CLIENT_RSC_COMPATIBILITY_ID,
        response: fetchResponse,
      });
    if (actionRedirectCompatibilityHardNavigationTarget) {
      clearClientNavigationCaches();
      browserNavigationController.performHardNavigation(
        actionRedirectCompatibilityHardNavigationTarget,
        actionRedirectTarget?.type === "push" ? "assign" : "replace",
      );
      return undefined;
    }

    if (
      !actionRedirectTarget &&
      shouldCheckRscCompatibilityForServerActionResponse(fetchResponse) &&
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
    if (revalidation !== "none") {
      // The revalidation header is the server's cache-invalidation signal. Clear
      // restorable BFCache ids and snapshots before body decoding so no pending
      // traversal can synchronously restore visible state from the old
      // client-state epoch.
      clearClientNavigationCaches();
    }
    const invalidResponseError = await readInvalidServerActionResponseError(
      fetchResponse.clone(),
      actionRedirectTarget !== null,
    );
    if (invalidResponseError) {
      throw invalidResponseError;
    }
    if (
      actionRedirectTarget &&
      !shouldCheckRscCompatibilityForServerActionResponse(fetchResponse)
    ) {
      browserNavigationController.performHardNavigation(actionRedirectTarget.href);
      return undefined;
    }
    const flightResponse =
      fetchResponse.status === 303
        ? new Response(fetchResponse.body, {
            headers: fetchResponse.headers,
            status: 200,
            statusText: "OK",
          })
        : fetchResponse;
    const result = await createFromFetch<ServerActionResult | AppWireElements>(
      Promise.resolve(flightResponse),
      { temporaryReferences },
    );
    if (
      revalidation === "none" &&
      shouldClearClientNavigationCachesForServerActionResult(result, revalidation)
    ) {
      clearClientNavigationCaches();
    }

    if (actionRedirectTarget) {
      if (isServerActionResult(result) && result.root !== undefined) {
        const decoded = AppElementsWire.decode(result.root);
        const hashIdx = actionRedirectTarget.href.indexOf("#");
        const hash = hashIdx !== -1 ? actionRedirectTarget.href.slice(hashIdx) : "";
        const actionScrollIntent = beginAppRouterScrollIntent(hash || null);
        if (actionRedirectTarget.type === "push") {
          saveScrollPosition();
        }
        void renderNavigationPayload(
          Promise.resolve(decoded),
          createClientNavigationRenderSnapshot(
            actionRedirectTarget.href,
            actionInitiation.routerState.navigationSnapshot.params,
          ),
          actionRedirectTarget.href,
          actionInitiation.navigationId,
          actionRedirectTarget.type === "push" ? "push" : "replace",
          {},
          null,
          null,
          FRESH_APP_NAVIGATION_PAYLOAD_ORIGIN,
          actionRedirectTarget.type === "push" ? "navigate" : "replace",
          "server-action",
          null,
          actionScrollIntent,
        ).catch(() => {
          browserNavigationController.performHardNavigation(actionRedirectTarget.href);
        });
        // Action redirects must throw a redirect error to abort the action call and
        // propagate the redirect to the caller. Unlike Next.js which can suspend
        // form actions on the client, vinext commits the SPA redirect navigation
        // asynchronously in the background; returning a pending promise would suspend
        // the React tree and block the background navigation's state update from committing.
        throw createServerActionRedirectError(actionRedirectTarget);
      }

      browserNavigationController.performHardNavigation(actionRedirectTarget.href);
      return undefined;
    }

    const hasSameUrlRerenderPayload = isServerActionResult(result) && result.root !== undefined;
    syncServerActionHttpFallbackHead(hasSameUrlRerenderPayload ? null : fetchResponse.status);

    // Server actions stay on the same URL and use commitSameUrlNavigatePayload()
    // for merge-based dispatch. This path does not call
    // activateNavigationSnapshot() because there is no URL change to commit, so
    // hooks continue reading the live external-store values directly. If server
    // actions ever trigger URL changes via RSC payload (instead of hard
    // redirects), this would need renderNavigationPayload().
    if (isServerActionResult(result)) {
      if (result.root !== undefined) {
        const returnValue =
          result.returnValue && !result.returnValue.ok
            ? {
                ok: false,
                data: normalizeServerActionThrownValue(
                  result.returnValue.data,
                  fetchResponse.status,
                ),
              }
            : result.returnValue;
        return commitSameUrlNavigatePayload(
          Promise.resolve(AppElementsWire.decode(result.root)),
          actionInitiation,
          returnValue,
          revalidation,
        );
      }

      if (result.returnValue) {
        if (!result.returnValue.ok) {
          throw normalizeServerActionThrownValue(result.returnValue.data, fetchResponse.status);
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
  };

  setServerCallback((id, args) => {
    const releaseCacheInvalidationGuard = historyController.beginCacheInvalidationGuard();
    return Promise.resolve()
      .then(() => serverActionCallback(id, args))
      .finally(releaseCacheInvalidationGuard);
  });
}

async function main(): Promise<void> {
  registerServerActionCallback();

  if (import.meta.env.DEV) {
    installDevErrorOverlay();
    installViteHmrErrorHandler(import.meta.hot);
    reportInitialDevServerErrors();
  }

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
  const root = decodeAppElementsPromise(createFromReadableStream<AppWireElements>(rscStream));
  const initialNavigationSnapshot = createClientNavigationRenderSnapshot(
    window.location.href,
    latestClientParams,
  );
  historyController.writeBootstrapHistoryMetadata();

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
        onCaughtError: prodOnCaughtError,
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
    scrollIntent?: AppRouterScrollIntent | null,
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
        ? (traversalIntent ?? historyController.resolveTraversalIntent(window.history.state))
        : null;
    const performHardNavigationForScrollIntent = (targetHref: string): boolean => {
      consumeAppRouterScrollIntent(scrollIntent ?? null);
      return browserNavigationController.performHardNavigation(targetHref);
    };
    // Traversal restores history-state ids before identity matching. Any
    // redirect hop that changes currentHref must null this before commit so
    // stale ids from the pre-redirect history entry cannot win.
    // Both restoredBfcacheIds and reuseCurrentBfcacheIds are snapshotted at
    // navigation-start. If the bfcache epoch changes or a server-action
    // guard is released before the async traverse resolves, these captured
    // values may be stale — consistent with the existing restoredBfcacheIds
    // pattern, and not a regression.
    let restoredBfcacheIds =
      navigationKind === "traverse"
        ? historyController.readCurrentBfcacheVersionHistoryIds(
            activeTraversalIntent?.historyState ?? window.history.state,
          )
        : null;
    const reuseCurrentBfcacheIds =
      navigationKind !== "traverse" ||
      (!historyController.isCacheInvalidationGuarded() &&
        historyController.isCurrentBfcacheVersion(
          activeTraversalIntent?.historyState ?? window.history.state,
        ));
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
          historyController.syncCurrentHistoryStatePreviousNextUrl(
            requestPreviousNextUrl,
            getBrowserRouterState().bfcacheIds,
          );
        }

        // Set this navigation as the pending pathname, overwriting any previous.
        // Pass navId so only this navigation (or a newer one) can clear it later.
        setPendingPathname(url.pathname, navId);

        const routerStateAtNavStart = getBrowserRouterState();
        const elementsAtNavStart = routerStateAtNavStart.elements;
        const mountedSlotsHeader = getMountedSlotIdsHeader(elementsAtNavStart);
        // Next.js refetches page segments for same-page search changes even
        // when a visible Link prefetched the target. Search params are a page
        // input, so a cached full-route payload is not authoritative here.
        // Ref: packages/next/src/client/components/router-reducer/ppr-navigations.ts
        //
        // The planner owns the early-intent classification; hash-only changes are
        // already short-circuited before reaching this loop, so for a "navigate"
        // here the decision is always a flight navigation and only its
        // cache-bypass bit is consumed.
        const earlyIntentDecision =
          navigationKind === "navigate"
            ? navigationPlanner.classifyEarlyNavigationIntent({
                basePath: __basePath,
                currentHref: clientNavigationSnapshotHref(routerStateAtNavStart.navigationSnapshot),
                // This loop only consumes the flight-navigation cache policy;
                // hash-only intents already return before a request is queued.
                mode: "push",
                scroll: false,
                targetHref: url.href,
              })
            : null;
        const shouldBypassNavigationCache =
          earlyIntentDecision?.kind === "flightNavigation" &&
          earlyIntentDecision.bypassNavigationCache;
        // The client reuse manifest is excluded from VINEXT_RSC_VARY_HEADER, so
        // it never affects the cache-busting URL. Defer producing it until the
        // visited-response cache miss is confirmed below — its producer iterates
        // the visible layout ids and binary-searches a byte budget, which is
        // pure waste on the cache-hit soft-nav path.
        const requestHeaders = createRscRequestHeaders({
          interceptionContext: requestInterceptionContext,
          mountedSlotsHeader,
          renderMode:
            navigationKind === "refresh" ? APP_RSC_RENDER_MODE_REFRESH_PRESERVE_UI : undefined,
        });
        const rscUrl = await createRscRequestUrl(url.pathname + url.search, requestHeaders);
        const cachedRoute = shouldBypassNavigationCache
          ? null
          : getVisitedResponse(
              rscUrl,
              requestInterceptionContext,
              mountedSlotsHeader,
              navigationKind,
            );
        if (cachedRoute) {
          const cachedFetchDecision = navigationPlanner.classifyRscFetchResult({
            clientCompatibilityId: CLIENT_RSC_COMPATIBILITY_ID,
            compatibilityIdHeader: cachedRoute.response.compatibilityIdHeader ?? null,
            currentHref,
            effectiveHistoryUpdateMode: currentHistoryMode ?? "replace",
            hasBody: true,
            isRscContentType: true,
            origin: window.location.origin,
            redirectDepth: redirectCount,
            requestPreviousNextUrl,
            responseOk: true,
            responseUrl: cachedRoute.response.url,
            source: "cached",
            streamedRedirectTarget: null,
          });
          if (cachedFetchDecision.kind === "hardNavigate") {
            if (cachedFetchDecision.reason === "redirectDepthExhausted") {
              console.error(
                "[vinext] Too many RSC redirects — aborting navigation to prevent infinite loop.",
              );
            }
            performHardNavigationForScrollIntent(cachedFetchDecision.url);
            return;
          }
          if (cachedFetchDecision.kind === "followRedirect") {
            if (navigationKind === "traverse") {
              restoredBfcacheIds = null;
            }
            currentHref = cachedFetchDecision.redirect.href;
            currentHistoryMode = cachedFetchDecision.redirect.historyUpdateMode;
            currentPrevNextUrl = cachedFetchDecision.redirect.previousNextUrl;
            redirectCount = cachedFetchDecision.redirect.redirectDepth;
            continue;
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
          const cachedRenderOutcome = await renderNavigationPayload(
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
            scrollIntent,
            restoredBfcacheIds,
            reuseCurrentBfcacheIds,
          );
          if (cachedRenderOutcome === "no-commit") {
            deleteVisitedResponse(rscUrl, requestInterceptionContext);
            continue;
          }
          return;
        }

        // Continue using the slot state captured at navigation start for fetches
        // and prefetch compatibility decisions.

        let navResponse: Response | undefined;
        let navResponseExpiresAt: number | undefined;
        let navResponseUrl: string | null = null;
        if (navigationKind !== "refresh" && !shouldBypassNavigationCache) {
          const prefetchedResponse = await consumePrefetchResponseForNavigation(
            rscUrl,
            requestInterceptionContext,
            mountedSlotsHeader,
            {
              shouldConsume: () => browserNavigationController.isCurrentNavigation(navId),
            },
          );
          if (!browserNavigationController.isCurrentNavigation(navId)) return;
          if (prefetchedResponse) {
            navResponse = restoreRscResponse(prefetchedResponse, false);
            navResponseExpiresAt = prefetchedResponse.expiresAt;
            navResponseUrl = prefetchedResponse.url;
          }
        }

        // The optimistic shell is intentionally not gated by
        // `shouldBypassNavigationCache`. A same-page search change can still
        // render an optimistic shell from cached route templates before the
        // real fetch commits, but that shell is a detached commit (see below)
        // that is always superseded by the authoritative fetch — the same as
        // cross-route navigations — so it never persists stale page content.
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
                scrollIntent,
                restoredBfcacheIds,
                reuseCurrentBfcacheIds,
              ).catch((error) => {
                if (browserNavigationController.isCurrentNavigation(navId)) {
                  console.error("[vinext] Optimistic RSC navigation error:", error);
                }
              });
            }
          }
        }

        if (!navResponse) {
          // Produce the client reuse manifest only now that prefetch/optimistic
          // paths did not satisfy the navigation and a real request is required.
          // Computed from the nav-start router state so it matches the snapshot
          // the request would have carried if produced earlier.
          if (navigationKind === "navigate") {
            const clientReuseManifestHeader =
              createClientReuseManifestHeaderFromVisibleAppState(routerStateAtNavStart);
            if (clientReuseManifestHeader !== null) {
              requestHeaders.set(VINEXT_CLIENT_REUSE_MANIFEST_HEADER, clientReuseManifestHeader);
            }
          }
          navResponse = await fetch(rscUrl, {
            headers: requestHeaders,
            credentials: "include",
          });
        }

        if (!browserNavigationController.isCurrentNavigation(navId)) return;

        const navContentType = navResponse.headers.get("content-type") ?? "";
        const liveFetchDecision = navigationPlanner.classifyRscFetchResult({
          clientCompatibilityId: CLIENT_RSC_COMPATIBILITY_ID,
          compatibilityIdHeader: navResponse.headers.get(VINEXT_RSC_COMPATIBILITY_ID_HEADER),
          currentHref,
          effectiveHistoryUpdateMode: currentHistoryMode ?? "replace",
          hasBody: navResponse.body !== null,
          isRscContentType: navContentType.startsWith(VINEXT_RSC_CONTENT_TYPE),
          origin: window.location.origin,
          redirectDepth: redirectCount,
          requestPreviousNextUrl,
          responseOk: navResponse.ok,
          responseUrl: navResponseUrl ?? navResponse.url,
          source: "live",
          streamedRedirectTarget: navResponse.headers.get(VINEXT_RSC_REDIRECT_HEADER),
        });
        if (liveFetchDecision.kind === "hardNavigate") {
          if (liveFetchDecision.discardBody) {
            void navResponse.body?.cancel().catch(() => {});
          }
          if (liveFetchDecision.reason === "redirectDepthExhausted") {
            console.error(
              "[vinext] Too many RSC redirects — aborting navigation to prevent infinite loop.",
            );
          }
          if (liveFetchDecision.reason === "streamedRedirectLoop") {
            console.error(
              "[vinext] RSC streamed redirect resolved to the current URL — aborting navigation to prevent infinite loop.",
            );
          }
          performHardNavigationForScrollIntent(liveFetchDecision.url);
          return;
        }

        if (liveFetchDecision.kind === "followRedirect") {
          if (liveFetchDecision.discardBody) {
            void navResponse.body?.cancel().catch(() => {});
          }
          if (navigationKind === "traverse") {
            restoredBfcacheIds = null;
          }
          currentHref = liveFetchDecision.redirect.href;
          currentHistoryMode = liveFetchDecision.redirect.historyUpdateMode;
          currentPrevNextUrl = liveFetchDecision.redirect.previousNextUrl;
          redirectCount = liveFetchDecision.redirect.redirectDepth;
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
        // The cache branch is read alongside React's branch, but persistence is
        // best-effort after a successful visible commit. A failed snapshot must
        // degrade future back/forward reuse, not recover by reloading the page
        // the user already reached.
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
          scrollIntent,
          restoredBfcacheIds,
          reuseCurrentBfcacheIds,
        );
        if (renderOutcome !== "committed") return;
        // Don't cache the response if this navigation was superseded during
        // renderNavigationPayload's await — the elements were never dispatched.
        if (!browserNavigationController.isCurrentNavigation(navId)) return;
        // Store the visited response only after renderNavigationPayload succeeds.
        // If we stored it before and renderNavigationPayload threw, a future
        // back/forward navigation could replay a snapshot from a navigation that
        // never actually rendered successfully.
        try {
          const renderedElements = await rscPayload;
          const metadata = AppElementsWire.readMetadata(renderedElements);
          if (!isCacheRestorableAppPayloadMetadata(metadata)) {
            void cacheBufferPromise.catch(() => {});
            return;
          }
          const cacheBuffer = await cacheBufferPromise;
          storeVisitedResponseSnapshot(
            rscUrl,
            resolveVisitedResponseInterceptionContext(
              requestInterceptionContext,
              metadata.interceptionContext,
            ),
            {
              ...createCachedRscResponseSnapshot(navResponse, cacheBuffer, navResponseUrl),
              ...(navResponseExpiresAt !== undefined ? { expiresAt: navResponseExpiresAt } : {}),
              mountedSlotsHeader: getMountedSlotIdsHeader(renderedElements),
            },
            navParams,
          );
        } catch {
          // The visible navigation already committed. A cache snapshot failure
          // only affects future reuse; it must not reload the page.
        }
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
      performHardNavigationForScrollIntent(currentHref);
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
    commitHashNavigation: (href, historyUpdateMode, scroll) =>
      historyController.commitHashOnlyNavigation(href, historyUpdateMode, scroll),
    navigate: navigateRsc,
  });

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
    shouldSkipScrollRestore: (navId) => synchronousPopstateScrollRestoreNavigationId === navId,
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
      historyController.commitTraversalIndexFromHistoryState(event.state);
      restorePopstateScrollPosition(event.state);
      return;
    }
    handlePopstate(event);
    // Synchronous snapshot restore supersedes the in-flight async RSC traverse.
    //
    // handlePopstate calls navigate() which starts an async RSC traversal:
    // renderNavigationPayload captures startedState (visibleCommitVersion N)
    // and awaits nextElements, yielding at least one microtask.
    //
    // restoreHistoryStateSnapshot runs synchronously (flushSync, no await) in
    // the same task, commits the cached history snapshot, and bumps
    // visibleCommitVersion to N+1.
    //
    // When the async traverse resolves,
    // resolvePendingNavigationCommitDispositionDecision sees
    // startedVisibleCommitVersion (N) !== currentState.visibleCommitVersion
    // (N+1) and returns staleOperation → no-commit, discarding the fresh
    // RSC payload in favor of the cached client snapshot.
    //
    // This matches Next's in-memory bfcache behaviour (no refetch on back).
    // The ordering is deterministic only because restoreHistoryStateSnapshot
    // is synchronous while the async traverse always yields.
    if (restoreHistoryStateSnapshot(event.state)) {
      restoreSynchronousPopstateScrollPosition(
        {
          getActiveNavigationId: () => browserNavigationController.getActiveNavigationId(),
          isCurrentNavigation: (navId) => browserNavigationController.isCurrentNavigation(navId),
          markScrollRestoreConsumed: (navId) => {
            synchronousPopstateScrollRestoreNavigationId = navId;
          },
          restorePopstateScrollPosition,
        },
        event.state,
      );
    }
  });

  if (import.meta.hot) {
    const applyRscHmrUpdate = async (updateId: number): Promise<void> => {
      if (updateId !== latestRscHmrUpdateId) return;

      // Root layout errors can leave the browser on a document-level error
      // shell. A normal RSC tree replacement can't reliably reconstruct the
      // original document from there, so let the next HMR update reload the
      // current URL. If the edit fixed the error the page comes back clean; if
      // not, initial dev server errors re-populate the overlay.
      if (document.documentElement.id === "__next_error__") {
        window.location.reload();
        return;
      }

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
      if (updateId !== latestRscHmrUpdateId) return;
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
    };

    const handleRscUpdate = async (updateId: number): Promise<void> => {
      try {
        await waitForRscHmrSettle();
        await applyRscHmrUpdate(updateId);
      } catch (error) {
        console.error("[vinext] RSC HMR error:", error);
      }
    };

    import.meta.hot.on("rsc:update", () => {
      const updateId = ++latestRscHmrUpdateId;
      void handleRscUpdate(updateId);
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
  window.addEventListener("pageshow", (event) => {
    isPageUnloading = false;
    if (event.persisted) {
      mpaNavigationScheduler.reset();
    }
  });
  void main();
}
