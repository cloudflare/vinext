/**
 * next/navigation shim
 *
 * App Router navigation hooks. These work on both server (RSC) and client.
 * Server-side: reads from a request context set by the RSC handler.
 * Client-side: reads from browser Location API and provides navigation.
 */

// Use namespace import for RSC safety: the react-server condition doesn't export
// createContext/useContext/useSyncExternalStore as named exports, and strict ESM
// would throw at link time for missing bindings. With `import * as React`, the
// bindings are just `undefined` on the namespace object and we can guard at runtime.
import * as React from "react";
import {
  getNavigationRuntime,
  hasAppNavigationRuntime,
  type NavigationRuntimeVisibleCommitMode,
} from "../client/navigation-runtime.js";
import { notifyAppRouterTransitionStart } from "../client/instrumentation-client-state.js";
import {
  clearAppNavigationFailureTarget,
  stageAppNavigationFailureTarget,
} from "../client/app-nav-failure-handler.js";
import { INITIAL_BFCACHE_ID, PUBLIC_INITIAL_BFCACHE_ID } from "../server/app-bfcache-id.js";
import { AppElementsWire } from "../server/app-elements.js";
import { resolveManifestNavigationInterceptionContext } from "../server/app-browser-interception-context.js";
import {
  createExternalHistoryStatePreservingMetadata,
  createHashOnlyHistoryStatePreservingNavigationMetadata,
} from "../server/app-history-state.js";
import {
  createRscRequestHeaders,
  createRscRequestUrl,
  stripRscCacheBustingSearchParam,
  VINEXT_RSC_COMPATIBILITY_ID_HEADER,
  VINEXT_RSC_CONTENT_TYPE,
} from "../server/app-rsc-cache-busting.js";
import { hasPendingAppRouterPageRedirect } from "../server/app-browser-mpa-navigation.js";
import {
  VINEXT_DYNAMIC_STALE_TIME_HEADER,
  VINEXT_MOUNTED_SLOTS_HEADER,
  VINEXT_PARAMS_HEADER,
} from "../server/headers.js";
import {
  isAbsoluteOrProtocolRelativeUrl,
  toBrowserNavigationHref,
  toSameOriginAppPath,
  withBasePath,
} from "./url-utils.js";
import { navigationPlanner } from "../server/navigation-planner.js";
import { stripBasePath } from "../utils/base-path.js";
import { isBotUserAgent } from "../utils/html-limited-bots.js";
import { ReadonlyURLSearchParams } from "./readonly-url-search-params.js";
import { assertSafeNavigationUrl } from "./url-safety.js";
import { markPprFallbackShellDynamicBoundary } from "./ppr-fallback-shell.js";
import { AppRouterContext, type AppRouterInstance } from "./internal/app-router-context.js";
import { getPagesNavigationContext as _getPagesNavigationContext } from "./internal/pages-router-accessor.js";
import { resolveHybridClientRouteOwner } from "./internal/hybrid-client-route-owner.js";
import { retryScrollTo, scrollToHashTarget } from "./hash-scroll.js";
import {
  beginAppRouterScrollIntent,
  clearAppRouterScrollIntent,
  consumeAppRouterScrollIntent,
  getPendingAppRouterScrollIntent,
  type AppRouterScrollIntent,
} from "./app-router-scroll-state.js";
import {
  clearClientHydrationContext,
  getBfcacheIdMapContext,
  getBfcacheSegmentIdContext,
  getLayoutSegmentContext,
  getNavigationContext,
  registerServerInsertedHTMLCallback,
  type NavigationContext,
} from "./navigation-context-state.js";

export {
  type NavigationContext,
  type NavigationStateAccessors,
  type SegmentMap,
  GLOBAL_ACCESSORS_KEY,
  ServerInsertedHTMLContext,
  _registerStateAccessors,
  clearServerInsertedHTML,
  flushServerInsertedHTML,
  getBfcacheIdMapContext,
  getBfcacheSegmentIdContext,
  getLayoutSegmentContext,
  getNavigationContext,
  renderServerInsertedHTML,
  setNavigationContext,
} from "./navigation-context-state.js";

export {
  BailoutToCSRError,
  DynamicServerError,
  HTTP_ERROR_FALLBACK_ERROR_CODE,
  RedirectType,
  decodeRedirectError,
  forbidden,
  getAccessFallbackHTTPStatus,
  isBailoutToCSRError,
  isDynamicServerError,
  isHTTPAccessFallbackError,
  isNextRouterError,
  isRedirectError,
  notFound,
  permanentRedirect,
  redirect,
  unauthorized,
  unstable_rethrow,
} from "./navigation-errors.js";

// ─── Layout segment context ───────────────────────────────────────────────────
// Stores the child segments below the current layout. Each layout wraps its
// children with a provider whose value is the remaining route tree segments
// (including route groups, with dynamic params resolved to actual values).
// Created lazily because `React.createContext` is NOT available in the
// react-server condition of React. In the RSC environment, this remains null.
// The contexts and request-state bridge live in navigation-context-state.ts so
// the browser and server facades share one lightweight implementation.

/**
 * Read the child segments for a parallel route below the current layout.
 * Returns [] if no context is available (RSC environment, outside React tree)
 * or if the requested key is not present in the segment map.
 */
/* oxlint-disable eslint-plugin-react-hooks/rules-of-hooks */
function useChildSegments(parallelRoutesKey: string = "children"): string[] {
  const ctx = getLayoutSegmentContext();
  if (!ctx) return [];
  // useContext is safe here because if createContext exists, useContext does too.
  // This branch is only taken in SSR/Browser, never in RSC.
  // Try/catch for unit tests that call this hook outside a React render tree.
  try {
    const segmentMap = React.useContext(ctx);
    return (segmentMap[parallelRoutesKey] ?? []).filter(
      (segment) => !segment.startsWith("__PAGE__"),
    );
  } catch {
    return [];
  }
}
/* oxlint-enable eslint-plugin-react-hooks/rules-of-hooks */

// ---------------------------------------------------------------------------
// Server-side request context (set by the RSC entry before rendering)
// ---------------------------------------------------------------------------

const _READONLY_SEARCH_PARAMS = Symbol("vinext.navigation.readonlySearchParams");
const _READONLY_SEARCH_PARAMS_SOURCE = Symbol("vinext.navigation.readonlySearchParamsSource");
const _READONLY_SEARCH_PARAMS_SOURCE_KEY = Symbol(
  "vinext.navigation.readonlySearchParamsSourceKey",
);

type NavigationContextWithReadonlyCache = NavigationContext & {
  [_READONLY_SEARCH_PARAMS]?: ReadonlyURLSearchParams;
  [_READONLY_SEARCH_PARAMS_SOURCE]?: URLSearchParams;
  [_READONLY_SEARCH_PARAMS_SOURCE_KEY]?: string;
};

// ---------------------------------------------------------------------------
// Pages Router compat source.
//
// `next/navigation` is the App Router API surface, but Next.js exposes the
// same hook names to Pages Router pages as a compat shim. In Next.js this is
// done by wrapping pages with SearchParamsContext / PathParamsContext /
// PathnameContext providers populated from the Pages Router's state — see:
// .nextjs-ref/packages/next/src/server/render.tsx
// .nextjs-ref/packages/next/src/client/index.tsx
// .nextjs-ref/packages/next/src/shared/lib/router/adapters.tsx
//
// vinext drives these hooks from a module-level navigation context instead of
// React Context, so we fall back to a Pages Router accessor when no App
// Router context is set. The accessor is published by next/router via a
// global Symbol.for handle (see packages/vinext/src/shims/router.ts); we do
// NOT import router.ts here because doing so would force navigation.ts to be
// loaded for every consumer of next/router, triggering window.history
// patches in unit tests that only want the router shim.
// ---------------------------------------------------------------------------

const PAGES_NAVIGATION_NOTIFY_KEY = Symbol.for("vinext.navigation.pagesNavigationNotify");
type _GlobalWithPagesNotify = typeof globalThis & {
  [PAGES_NAVIGATION_NOTIFY_KEY]?: () => void;
};

// ---------------------------------------------------------------------------
// Client-side state
// ---------------------------------------------------------------------------

const isServer = typeof window === "undefined";

/** basePath from next.config.js, injected by the plugin at build time */
export const __basePath: string = process.env.__NEXT_ROUTER_BASEPATH ?? "";

// ---------------------------------------------------------------------------
// RSC prefetch cache utilities (shared between link.tsx and browser entry)
// ---------------------------------------------------------------------------

/** Maximum number of entries in the RSC prefetch cache. */
export const MAX_PREFETCH_CACHE_SIZE = 50;

/**
 * TTL for prefetch cache entries in ms.
 *
 * Mirrors Next.js' `STATIC_STALETIME_MS` derivation. The plugin injects
 * `process.env.__NEXT_CLIENT_ROUTER_STATIC_STALETIME` from
 * `experimental.staleTimes.static` (in seconds) at build time; we convert
 * to ms here.
 *
 * Falls back to vinext's historical default of 30s when the env var is
 * absent (e.g. unit tests that import this module without going through
 * the plugin's `define` pipeline). When the plugin is active and the user
 * has not set `experimental.staleTimes`, Next.js' 300s default applies
 * (see `resolveStaleTimes` in `config/next-config.ts`).
 */
function resolveClientRouterStaleTime(raw: string | undefined, fallbackMs: number): number {
  if (raw === undefined || raw === "") return fallbackMs;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) return fallbackMs;
  return seconds * 1000;
}

export const DYNAMIC_NAVIGATION_CACHE_TTL = resolveClientRouterStaleTime(
  process.env.__NEXT_CLIENT_ROUTER_DYNAMIC_STALETIME,
  30_000,
);
export const PREFETCH_CACHE_TTL = resolveClientRouterStaleTime(
  process.env.__NEXT_CLIENT_ROUTER_STATIC_STALETIME,
  30_000,
);
const MIN_PREFETCH_STALE_TIME_MS = 30_000;

/** A buffered RSC response stored as an ArrayBuffer for replay. */
export type CachedRscResponse = {
  compatibilityIdHeader?: string | null;
  buffer: ArrayBuffer;
  contentType: string;
  dynamicStaleTimeSeconds?: number;
  expiresAt?: number;
  mountedSlotsHeader?: string | null;
  paramsHeader: string | null;
  url: string;
};

export type PrefetchOptions = {
  kind?: unknown;
  onInvalidate?: () => void;
};

export type PrefetchCacheEntry = {
  cacheForNavigation?: boolean;
  expiresAt?: number;
  invalidationTimer?: ReturnType<typeof setTimeout>;
  mountedSlotsHeader?: string | null;
  onInvalidateCallbacks?: Set<() => void>;
  optimisticRouteShell?: boolean;
  outcome: "pending" | "cache-seeded";
  snapshot?: CachedRscResponse;
  pending?: Promise<void>;
  timestamp: number;
};

export function getCurrentInterceptionContext(): string | null {
  if (isServer) {
    return null;
  }

  return stripBasePath(window.location.pathname, __basePath);
}

export function getPrefetchInterceptionContext(targetHref: string): string | null {
  if (isServer) {
    return null;
  }

  let targetUrl: URL;
  try {
    targetUrl = new URL(targetHref, window.location.href);
  } catch {
    return null;
  }

  return resolveManifestNavigationInterceptionContext({
    basePath: __basePath,
    currentPathname: window.location.pathname,
    routeManifest: getNavigationRuntime()?.bootstrap.routeManifest ?? null,
    targetPathname: targetUrl.pathname,
  });
}

export function getCurrentNextUrl(): string {
  if (isServer) {
    return "/";
  }

  return window.location.pathname + window.location.search;
}

/** Get or create the shared in-memory RSC prefetch cache on window. */
export function getPrefetchCache(): Map<string, PrefetchCacheEntry> {
  if (isServer) return new Map();
  if (!window.__VINEXT_RSC_PREFETCH_CACHE__) {
    window.__VINEXT_RSC_PREFETCH_CACHE__ = new Map<string, PrefetchCacheEntry>();
  }
  return window.__VINEXT_RSC_PREFETCH_CACHE__;
}

/**
 * Get or create the shared set of already-prefetched RSC URLs on window.
 * Keyed by interception-aware cache key so distinct source routes do not alias.
 */
export function getPrefetchedUrls(): Set<string> {
  if (isServer) return new Set();
  if (!window.__VINEXT_RSC_PREFETCHED_URLS__) {
    window.__VINEXT_RSC_PREFETCHED_URLS__ = new Set<string>();
  }
  return window.__VINEXT_RSC_PREFETCHED_URLS__;
}

function isDynamicStaleTimeSeconds(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0
  );
}

function isCacheExpiresAt(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function parseDynamicStaleTimeSeconds(value: string | null): number | undefined {
  if (value === null || value === "") return undefined;
  const seconds = Number(value);
  return isDynamicStaleTimeSeconds(seconds) ? seconds : undefined;
}

export function resolveCachedRscResponseTtlMs(
  cached: Pick<CachedRscResponse, "dynamicStaleTimeSeconds">,
  fallbackTtlMs: number,
): number {
  const seconds = cached.dynamicStaleTimeSeconds;
  if (!isDynamicStaleTimeSeconds(seconds)) {
    return fallbackTtlMs;
  }
  return seconds * 1000;
}

export function resolveCachedRscResponseExpiresAt(
  timestamp: number,
  cached: Pick<CachedRscResponse, "dynamicStaleTimeSeconds" | "expiresAt">,
  fallbackTtlMs: number,
): number {
  if (isCacheExpiresAt(cached.expiresAt)) {
    return cached.expiresAt;
  }
  return timestamp + resolveCachedRscResponseTtlMs(cached, fallbackTtlMs);
}

function resolvePrefetchedRscResponseExpiresAt(
  timestamp: number,
  cached: Pick<CachedRscResponse, "dynamicStaleTimeSeconds" | "expiresAt">,
  fallbackTtlMs: number,
): number {
  if (isCacheExpiresAt(cached.expiresAt)) {
    return cached.expiresAt;
  }
  const seconds = cached.dynamicStaleTimeSeconds;
  if (!isDynamicStaleTimeSeconds(seconds)) {
    return timestamp + Math.max(fallbackTtlMs, MIN_PREFETCH_STALE_TIME_MS);
  }
  return timestamp + Math.max(seconds * 1000, MIN_PREFETCH_STALE_TIME_MS);
}

function resolvePrefetchCacheEntryExpiresAt(entry: PrefetchCacheEntry): number {
  if (entry.expiresAt !== undefined) return entry.expiresAt;
  if (entry.snapshot) {
    return resolveCachedRscResponseExpiresAt(entry.timestamp, entry.snapshot, PREFETCH_CACHE_TTL);
  }
  return entry.timestamp + PREFETCH_CACHE_TTL;
}

export function resolvePrefetchCacheEntryMountedSlotsHeader(
  entry: PrefetchCacheEntry,
): string | null {
  if (entry.mountedSlotsHeader !== undefined) return entry.mountedSlotsHeader;
  return entry.snapshot?.mountedSlotsHeader ?? null;
}

function normalizeRscCacheLookupUrl(rscUrl: string): string | null {
  try {
    const url = new URL(rscUrl, "http://vinext.local");
    stripRscCacheBustingSearchParam(url);
    return `${url.pathname}${url.search}`;
  } catch {
    return null;
  }
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

function isPrefetchCacheEntryCompatibleWithMountedSlots(
  entry: PrefetchCacheEntry,
  mountedSlotsHeader: string | null,
): boolean {
  // The two clauses are load-bearing, not redundant. `resolvePrefetch...Header`
  // prefers the entry's pinned request-time slot context (falling back to the
  // snapshot header only when unset), while the second clause matches the
  // server-declared snapshot header. They diverge only when the entry pins a
  // request-time context that disagrees with the response (the
  // `prefetchRscResponse` case); accepting either preserves the "request-time OR
  // server-declared slot context" reuse semantics.
  if (resolvePrefetchCacheEntryMountedSlotsHeader(entry) === mountedSlotsHeader) {
    return true;
  }
  return (entry.snapshot?.mountedSlotsHeader ?? null) === mountedSlotsHeader;
}

function findPrefetchCacheEntryForNavigation(
  rscUrl: string,
  interceptionContext: string | null,
  mountedSlotsHeader: string | null,
): { cacheKey: string; entry: PrefetchCacheEntry } | null {
  const exactCacheKey = AppElementsWire.encodeCacheKey(rscUrl, interceptionContext);
  const cache = getPrefetchCache();
  const exactEntry = cache.get(exactCacheKey);
  if (
    exactEntry &&
    exactEntry.cacheForNavigation !== false &&
    isPrefetchCacheEntryCompatibleWithMountedSlots(exactEntry, mountedSlotsHeader)
  ) {
    return { cacheKey: exactCacheKey, entry: exactEntry };
  }

  const normalizedTarget = normalizeRscCacheLookupUrl(rscUrl);
  if (normalizedTarget === null) return null;

  for (const [cacheKey, entry] of cache) {
    if (cacheKey === exactCacheKey) continue;
    if (entry.cacheForNavigation === false) continue;

    const source = parsePrefetchCacheKey(cacheKey);
    if (source.interceptionContext !== interceptionContext) continue;
    if (normalizeRscCacheLookupUrl(source.rscUrl) !== normalizedTarget) continue;
    if (!isPrefetchCacheEntryCompatibleWithMountedSlots(entry, mountedSlotsHeader)) continue;

    return { cacheKey, entry };
  }

  return null;
}

export function hasPrefetchCacheEntryForNavigation(
  rscUrl: string,
  interceptionContext: string | null = null,
  mountedSlotsHeader: string | null = null,
  options: { notifyInvalidation?: boolean } = {},
): boolean {
  const match = findPrefetchCacheEntryForNavigation(
    rscUrl,
    interceptionContext,
    mountedSlotsHeader,
  );
  if (match === null) return false;

  if (match.entry.pending !== undefined) return true;
  if (resolvePrefetchCacheEntryExpiresAt(match.entry) > Date.now()) return true;

  deletePrefetchCacheEntry(
    getPrefetchCache(),
    getPrefetchedUrls(),
    match.cacheKey,
    match.entry,
    options.notifyInvalidation ?? true,
  );
  return false;
}

/**
 * Evict prefetch cache entries if at capacity.
 * First sweeps expired entries, then falls back to FIFO eviction.
 */
function evictPrefetchCacheIfNeeded(): void {
  const cache = getPrefetchCache();
  if (cache.size < MAX_PREFETCH_CACHE_SIZE) return;

  const now = Date.now();
  const prefetched = getPrefetchedUrls();

  for (const [key, entry] of cache) {
    if (resolvePrefetchCacheEntryExpiresAt(entry) <= now) {
      deletePrefetchCacheEntry(cache, prefetched, key, entry, true);
    }
  }

  while (cache.size >= MAX_PREFETCH_CACHE_SIZE) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) {
      const entry = cache.get(oldest);
      if (entry) {
        deletePrefetchCacheEntry(cache, prefetched, oldest, entry, true);
      } else {
        cache.delete(oldest);
        prefetched.delete(oldest);
      }
    } else {
      break;
    }
  }
}

function clearPrefetchInvalidation(entry: PrefetchCacheEntry): void {
  if (entry.invalidationTimer !== undefined) {
    clearTimeout(entry.invalidationTimer);
    entry.invalidationTimer = undefined;
  }
}

function notifyPrefetchInvalidated(entry: PrefetchCacheEntry): void {
  clearPrefetchInvalidation(entry);
  const callbacks = entry.onInvalidateCallbacks;
  entry.onInvalidateCallbacks = undefined;
  if (callbacks === undefined) return;

  for (const onInvalidate of callbacks) {
    try {
      onInvalidate();
    } catch (error) {
      if (typeof reportError === "function") {
        reportError(error);
      } else {
        console.error(error);
      }
    }
  }
}

function deletePrefetchCacheEntry(
  cache: Map<string, PrefetchCacheEntry>,
  prefetched: Set<string>,
  cacheKey: string,
  entry: PrefetchCacheEntry,
  notify: boolean,
): void {
  cache.delete(cacheKey);
  prefetched.delete(cacheKey);
  if (notify) {
    notifyPrefetchInvalidated(entry);
  } else {
    clearPrefetchInvalidation(entry);
    entry.onInvalidateCallbacks = undefined;
  }
}

function invalidatePrefetchCacheEntry(cacheKey: string): void {
  const cache = getPrefetchCache();
  const entry = cache.get(cacheKey);
  if (!entry) return;
  deletePrefetchCacheEntry(cache, getPrefetchedUrls(), cacheKey, entry, true);
}

function schedulePrefetchInvalidation(cacheKey: string, entry: PrefetchCacheEntry): void {
  if (entry.onInvalidateCallbacks === undefined || entry.onInvalidateCallbacks.size === 0) return;

  clearPrefetchInvalidation(entry);
  const delay = Math.max(0, resolvePrefetchCacheEntryExpiresAt(entry) - Date.now());
  entry.invalidationTimer = setTimeout(() => {
    invalidatePrefetchCacheEntry(cacheKey);
  }, delay);
}

function addPrefetchInvalidationCallback(
  entry: PrefetchCacheEntry,
  onInvalidate: (() => void) | undefined,
): void {
  if (onInvalidate === undefined) return;
  if (entry.onInvalidateCallbacks === undefined) {
    entry.onInvalidateCallbacks = new Set();
  }
  entry.onInvalidateCallbacks.add(onInvalidate);
}

function attachPrefetchInvalidationCallback(
  cacheKey: string,
  onInvalidate: (() => void) | undefined,
): void {
  if (onInvalidate === undefined) return;
  const entry = getPrefetchCache().get(cacheKey);
  if (!entry) return;
  addPrefetchInvalidationCallback(entry, onInvalidate);
  if (entry.outcome === "cache-seeded") {
    schedulePrefetchInvalidation(cacheKey, entry);
  }
}

export function invalidatePrefetchCache(): void {
  const cache = getPrefetchCache();
  const prefetched = getPrefetchedUrls();
  for (const [cacheKey, entry] of cache) {
    deletePrefetchCacheEntry(cache, prefetched, cacheKey, entry, true);
  }
  prefetched.clear();
  if (!isServer) {
    getNavigationRuntime()?.functions.pingVisibleLinks?.();
  }
}

export function seedPrefetchResponseSnapshot(
  rscUrl: string,
  snapshot: CachedRscResponse,
  interceptionContext: string | null = null,
  mountedSlotsHeader: string | null = null,
  fallbackTtlMs: number = DYNAMIC_NAVIGATION_CACHE_TTL,
): void {
  const cacheKey = AppElementsWire.encodeCacheKey(rscUrl, interceptionContext);
  const cache = getPrefetchCache();
  const existing = cache.get(cacheKey);
  if (existing) {
    deletePrefetchCacheEntry(cache, getPrefetchedUrls(), cacheKey, existing, false);
  }
  evictPrefetchCacheIfNeeded();
  const timestamp = Date.now();
  const entry: PrefetchCacheEntry = {
    cacheForNavigation: true,
    expiresAt: resolveCachedRscResponseExpiresAt(timestamp, snapshot, fallbackTtlMs),
    mountedSlotsHeader,
    outcome: "cache-seeded",
    snapshot,
    timestamp,
  };
  cache.set(cacheKey, entry);
  getPrefetchedUrls().add(cacheKey);
  schedulePrefetchInvalidation(cacheKey, entry);
}

export function deletePrefetchResponseSnapshot(
  rscUrl: string,
  snapshot: CachedRscResponse,
  interceptionContext: string | null = null,
): void {
  const cacheKey = AppElementsWire.encodeCacheKey(rscUrl, interceptionContext);
  const cache = getPrefetchCache();
  const entry = cache.get(cacheKey);
  if (entry?.snapshot !== snapshot) return;
  deletePrefetchCacheEntry(cache, getPrefetchedUrls(), cacheKey, entry, false);
}

/**
 * Store a prefetched RSC response in the cache by snapshotting it to an
 * ArrayBuffer.  The snapshot completes asynchronously; during that window
 * the entry is marked `pending` so consumePrefetchResponse() will skip it
 * (the caller falls back to a fresh fetch, which is acceptable).
 *
 * Prefer prefetchRscResponse() for new call-sites — it handles the full
 * prefetch lifecycle including dedup and explicit slot context.
 * storePrefetchResponse() is kept for backward compatibility and test
 * helpers. It is slot-unaware: the snapshot's mountedSlotsHeader comes
 * from the response headers, not the caller, so consumePrefetchResponse
 * may reject the entry if the caller's slot context differs.
 *
 * NB: Caller is responsible for managing getPrefetchedUrls() — this
 * function only stores the response in the prefetch cache.
 */
export function storePrefetchResponse(
  rscUrl: string,
  response: Response,
  interceptionContext: string | null = null,
  options?: PrefetchOptions,
): void {
  const cacheKey = AppElementsWire.encodeCacheKey(rscUrl, interceptionContext);
  evictPrefetchCacheIfNeeded();
  const entry: PrefetchCacheEntry = {
    mountedSlotsHeader: null,
    outcome: "pending",
    timestamp: Date.now(),
  };
  addPrefetchInvalidationCallback(entry, options?.onInvalidate);
  entry.pending = snapshotRscResponse(response)
    .then((snapshot) => {
      entry.mountedSlotsHeader = snapshot.mountedSlotsHeader ?? null;
      entry.snapshot = snapshot;
      entry.expiresAt = resolveCachedRscResponseExpiresAt(
        entry.timestamp,
        snapshot,
        PREFETCH_CACHE_TTL,
      );
    })
    .catch(() => {
      deletePrefetchCacheEntry(getPrefetchCache(), getPrefetchedUrls(), cacheKey, entry, false);
    })
    .finally(() => {
      entry.pending = undefined;
      if (entry.snapshot) {
        entry.outcome = "cache-seeded";
        schedulePrefetchInvalidation(cacheKey, entry);
      }
    });
  getPrefetchCache().set(cacheKey, entry);
}

export function createCachedRscResponseSnapshot(
  response: Response,
  buffer: ArrayBuffer,
  responseUrl: string | null = null,
): CachedRscResponse {
  const dynamicStaleTimeSeconds = parseDynamicStaleTimeSeconds(
    response.headers.get(VINEXT_DYNAMIC_STALE_TIME_HEADER),
  );
  return {
    compatibilityIdHeader: response.headers.get(VINEXT_RSC_COMPATIBILITY_ID_HEADER),
    buffer,
    contentType: response.headers.get("content-type") ?? VINEXT_RSC_CONTENT_TYPE,
    ...(dynamicStaleTimeSeconds !== undefined ? { dynamicStaleTimeSeconds } : {}),
    mountedSlotsHeader: response.headers.get(VINEXT_MOUNTED_SLOTS_HEADER),
    paramsHeader: response.headers.get(VINEXT_PARAMS_HEADER),
    url: responseUrl ?? response.url,
  };
}

/**
 * Snapshot an RSC response to an ArrayBuffer for caching and replay.
 * Consumes the response body and stores it with content-type and URL metadata.
 */
export async function snapshotRscResponse(response: Response): Promise<CachedRscResponse> {
  return createCachedRscResponseSnapshot(response, await response.arrayBuffer());
}

/**
 * Reconstruct a Response from a cached RSC snapshot.
 * Creates a new Response with the original ArrayBuffer so createFromFetch
 * can consume the stream from scratch.
 *
 * NOTE: The reconstructed Response always has `url === ""` — the Response
 * constructor does not accept a `url` option, and `response.url` is read-only
 * set by the fetch infrastructure. Callers that need the original URL should
 * read it from `cached.url` directly rather than from the restored Response.
 *
 * @param copy - When true (default), copies the ArrayBuffer so the cached
 *   snapshot remains replayable (needed for the visited-response cache).
 *   Pass false for single-consumption paths (e.g. prefetch cache entries
 *   that are deleted after consumption) to avoid the extra allocation.
 */
export function restoreRscResponse(cached: CachedRscResponse, copy = true): Response {
  const headers = new Headers({ "content-type": cached.contentType });
  if (cached.mountedSlotsHeader != null) {
    headers.set(VINEXT_MOUNTED_SLOTS_HEADER, cached.mountedSlotsHeader);
  }
  if (cached.compatibilityIdHeader != null) {
    headers.set(VINEXT_RSC_COMPATIBILITY_ID_HEADER, cached.compatibilityIdHeader);
  }
  if (isDynamicStaleTimeSeconds(cached.dynamicStaleTimeSeconds)) {
    headers.set(VINEXT_DYNAMIC_STALE_TIME_HEADER, String(cached.dynamicStaleTimeSeconds));
  }
  if (cached.paramsHeader != null) {
    headers.set(VINEXT_PARAMS_HEADER, cached.paramsHeader);
  }

  return new Response(copy ? cached.buffer.slice(0) : cached.buffer, {
    status: 200,
    headers,
  });
}

/**
 * Prefetch an RSC response and snapshot it for later consumption.
 * Stores the in-flight promise so immediate clicks can await it instead
 * of firing a duplicate fetch.
 * Enforces a maximum cache size to prevent unbounded memory growth on
 * link-heavy pages.
 */
export function prefetchRscResponse(
  rscUrl: string,
  fetchPromise: Promise<Response>,
  interceptionContext: string | null = null,
  mountedSlotsHeader: string | null = null,
  options?: PrefetchOptions,
  behavior: {
    cacheForNavigation?: boolean;
    fallbackTtlMs?: number;
    optimisticRouteShell?: boolean;
  } = {},
): void {
  const cacheKey = AppElementsWire.encodeCacheKey(rscUrl, interceptionContext);
  const cache = getPrefetchCache();
  const prefetched = getPrefetchedUrls();
  const now = Date.now();

  const entry: PrefetchCacheEntry = {
    cacheForNavigation: behavior.cacheForNavigation ?? true,
    mountedSlotsHeader,
    optimisticRouteShell: behavior.optimisticRouteShell === true,
    outcome: "pending",
    timestamp: now,
  };
  addPrefetchInvalidationCallback(entry, options?.onInvalidate);

  entry.pending = fetchPromise
    .then(async (response) => {
      if (response.ok) {
        entry.snapshot = await snapshotRscResponse(response);
        entry.expiresAt = resolvePrefetchedRscResponseExpiresAt(
          entry.timestamp,
          entry.snapshot,
          behavior.fallbackTtlMs ?? PREFETCH_CACHE_TTL,
        );
      } else {
        deletePrefetchCacheEntry(cache, prefetched, cacheKey, entry, false);
      }
    })
    .catch(() => {
      deletePrefetchCacheEntry(cache, prefetched, cacheKey, entry, false);
    })
    .finally(() => {
      entry.pending = undefined;
      if (entry.snapshot) {
        entry.outcome = "cache-seeded";
        schedulePrefetchInvalidation(cacheKey, entry);
      }
    });

  // Insert the new entry before evicting. FIFO evicts from the front of the
  // Map (oldest insertion order), so the just-appended entry is safe — only
  // entries inserted before it are candidates for removal.
  cache.set(cacheKey, entry);
  evictPrefetchCacheIfNeeded();
}

/**
 * Consume a prefetched response for a given rscUrl.
 * Only returns settled (non-pending) snapshots synchronously.
 * Returns null if the entry is still in flight or doesn't exist.
 */
export function consumePrefetchResponse(
  rscUrl: string,
  interceptionContext: string | null = null,
  mountedSlotsHeader: string | null = null,
): CachedRscResponse | null {
  const cache = getPrefetchCache();
  const exactCacheKey = AppElementsWire.encodeCacheKey(rscUrl, interceptionContext);
  const exactEntry = cache.get(exactCacheKey);
  if (
    exactEntry &&
    exactEntry.cacheForNavigation !== false &&
    !isPrefetchCacheEntryCompatibleWithMountedSlots(exactEntry, mountedSlotsHeader)
  ) {
    deletePrefetchCacheEntry(cache, getPrefetchedUrls(), exactCacheKey, exactEntry, false);
  }

  const match = findPrefetchCacheEntryForNavigation(
    rscUrl,
    interceptionContext,
    mountedSlotsHeader,
  );
  if (!match) return null;
  const { cacheKey, entry } = match;

  // Skip in-flight snapshots and error-path residue where pending cleared
  // without a successful transition to a cache-seeded entry.
  if (entry.pending || entry.outcome !== "cache-seeded") return null;
  if (entry.cacheForNavigation === false) return null;

  deletePrefetchCacheEntry(cache, getPrefetchedUrls(), cacheKey, entry, false);

  if (entry.snapshot) {
    if (!isPrefetchCacheEntryCompatibleWithMountedSlots(entry, mountedSlotsHeader)) {
      // Entry was already removed above. Slot mismatch means the prefetch
      // used stale slot context and cannot be safely reused.
      return null;
    }
    if (resolvePrefetchCacheEntryExpiresAt(entry) <= Date.now()) {
      return null;
    }
    // Only synthesize `expiresAt` onto the returned snapshot when the entry (or
    // its snapshot) already carried one. Entries that never had an explicit
    // expiry must round-trip unchanged so callers/tests can assert the raw
    // snapshot — don't collapse this into an unconditional spread.
    if (entry.expiresAt !== undefined || entry.snapshot.expiresAt !== undefined) {
      return {
        ...entry.snapshot,
        expiresAt: resolvePrefetchCacheEntryExpiresAt(entry),
      };
    }
    return entry.snapshot;
  }

  return null;
}

/**
 * Consume a prefetched response for navigation. Unlike the synchronous cache
 * read above, this waits for an already-started prefetch snapshot before
 * deciding whether to fetch again. That preserves the ownership invariant set
 * up by prefetchRscResponse(): a pending cache entry means this URL already has
 * one in-flight network request that navigation should share.
 */
type ConsumePrefetchResponseForNavigationOptions = {
  shouldConsume?: () => boolean;
};

export async function consumePrefetchResponseForNavigation(
  rscUrl: string,
  interceptionContext: string | null = null,
  mountedSlotsHeader: string | null = null,
  options?: ConsumePrefetchResponseForNavigationOptions,
): Promise<CachedRscResponse | null> {
  const cache = getPrefetchCache();
  const match = findPrefetchCacheEntryForNavigation(
    rscUrl,
    interceptionContext,
    mountedSlotsHeader,
  );
  if (!match) return null;
  const { cacheKey, entry } = match;

  if (entry.pending !== undefined) {
    await entry.pending.catch(() => {});
    if (cache.get(cacheKey) !== entry) return null;
  }

  if (options?.shouldConsume?.() === false) return null;

  return consumePrefetchResponse(rscUrl, interceptionContext, mountedSlotsHeader);
}

// ---------------------------------------------------------------------------
// Client navigation state — stored on a Symbol.for global to survive
// multiple Vite module instances loading this file through different IDs.
// ---------------------------------------------------------------------------

type NavigationListener = () => void;
const _CLIENT_NAV_STATE_KEY = Symbol.for("vinext.clientNavigationState");
const _MOUNTED_SLOTS_HEADER_KEY = Symbol.for("vinext.mountedSlotsHeader");

type ClientNavigationState = {
  listeners: Set<NavigationListener>;
  cachedSearch: string;
  cachedReadonlySearchParams: ReadonlyURLSearchParams;
  cachedPathname: string;
  clientParams: Record<string, string | string[]>;
  clientParamsJson: string;
  pendingClientParams: Record<string, string | string[]> | null;
  pendingClientParamsJson: string | null;
  pendingPathname: string | null;
  pendingPathnameNavId: number | null;
  originalPushState: typeof window.history.pushState;
  originalReplaceState: typeof window.history.replaceState;
  patchInstalled: boolean;
  hasPendingNavigationUpdate: boolean;
  suppressUrlNotifyCount: number;
  navigationSnapshotActiveCount: number;
};

type CommitClientNavigationStateOptions = {
  releaseSnapshot?: boolean;
};

type ClientNavigationGlobal = typeof globalThis & {
  [_CLIENT_NAV_STATE_KEY]?: ClientNavigationState;
  [_MOUNTED_SLOTS_HEADER_KEY]?: string | null;
};

export function setMountedSlotsHeader(header: string | null): void {
  if (isServer) return;
  const globalState = window as ClientNavigationGlobal;
  globalState[_MOUNTED_SLOTS_HEADER_KEY] = header;
}

export function getMountedSlotsHeader(): string | null {
  if (isServer) return null;
  const globalState = window as ClientNavigationGlobal;
  return globalState[_MOUNTED_SLOTS_HEADER_KEY] ?? null;
}

export function getClientNavigationState(): ClientNavigationState | null {
  if (isServer) return null;

  const globalState = window as ClientNavigationGlobal;
  globalState[_CLIENT_NAV_STATE_KEY] ??= {
    listeners: new Set<NavigationListener>(),
    cachedSearch: window.location.search,
    cachedReadonlySearchParams: new ReadonlyURLSearchParams(window.location.search),
    cachedPathname: stripBasePath(window.location.pathname, __basePath),
    clientParams: {},
    clientParamsJson: "{}",
    pendingClientParams: null,
    pendingClientParamsJson: null,
    pendingPathname: null,
    pendingPathnameNavId: null,
    // NB: These capture the currently installed history methods, not guaranteed
    // native ones. If a third-party library (analytics, router) has already patched
    // history methods before this module loads, we intentionally preserve that
    // wrapper. With Symbol.for global state, the first module instance to load wins.
    originalPushState: window.history.pushState.bind(window.history),
    originalReplaceState: window.history.replaceState.bind(window.history),
    patchInstalled: false,
    hasPendingNavigationUpdate: false,
    suppressUrlNotifyCount: 0,
    navigationSnapshotActiveCount: 0,
  };

  return globalState[_CLIENT_NAV_STATE_KEY]!;
}

function notifyNavigationListeners(): void {
  const state = getClientNavigationState();
  if (!state) return;
  for (const fn of state.listeners) fn();
}

if (!isServer) {
  (globalThis as _GlobalWithPagesNotify)[PAGES_NAVIGATION_NOTIFY_KEY] = notifyNavigationListeners;
}

// Cached URLSearchParams, pathname, etc. for referential stability
// useSyncExternalStore compares snapshots with Object.is — avoid creating
// new instances on every render (infinite re-renders).
let _cachedEmptyServerSearchParams: ReadonlyURLSearchParams | null = null;
const _readonlyPagesSearchParamsCache = new WeakMap<URLSearchParams, ReadonlyURLSearchParams>();
let _cachedReadonlyPagesSearchParamsKey: string | null = null;
let _cachedReadonlyPagesSearchParams: ReadonlyURLSearchParams | null = null;

function getReadonlyPagesSearchParams(searchParams: URLSearchParams): ReadonlyURLSearchParams {
  // Two-level cache. The per-object WeakMap gives referential stability for a
  // single URLSearchParams instance across renders. The string-keyed slot is
  // also load-bearing: across the Pages Router pre-ready → ready transition the
  // context swaps in a NEW URLSearchParams object even when the query string is
  // unchanged, and returning the same wrapper for an equal string keeps
  // `useSearchParams()` Object.is-stable so a `[searchParams]` effect does not
  // re-fire spuriously. Under concurrent SSR one request can read another
  // request's string-keyed wrapper, but that is harmless: ReadonlyURLSearchParams
  // is immutable and equal-string wrappers are interchangeable.
  const cached = _readonlyPagesSearchParamsCache.get(searchParams);
  if (cached) return cached;

  const key = searchParams.toString();
  if (_cachedReadonlyPagesSearchParamsKey === key && _cachedReadonlyPagesSearchParams) {
    _readonlyPagesSearchParamsCache.set(searchParams, _cachedReadonlyPagesSearchParams);
    return _cachedReadonlyPagesSearchParams;
  }

  const readonly = new ReadonlyURLSearchParams(searchParams);
  _readonlyPagesSearchParamsCache.set(searchParams, readonly);
  _cachedReadonlyPagesSearchParamsKey = key;
  _cachedReadonlyPagesSearchParams = readonly;
  return readonly;
}

/**
 * Get cached pathname snapshot for useSyncExternalStore.
 * Note: Returns cached value from ClientNavigationState, not live window.location.
 * The cache is updated by syncCommittedUrlStateFromLocation() after navigation commits.
 * This ensures referential stability and prevents infinite re-renders.
 * External pushState/replaceState while URL notifications are suppressed won't
 * be visible until the next commit.
 */
function getPathnameSnapshot(): string | null {
  const pagesCtx = _getPagesNavigationContext();
  if (pagesCtx) return pagesCtx.pathname;
  return getClientNavigationState()?.cachedPathname ?? "/";
}

let _cachedEmptyClientSearchParams: ReadonlyURLSearchParams | null = null;

/**
 * Get cached search params snapshot for useSyncExternalStore.
 * Note: Returns cached value from ClientNavigationState, not live window.location.search.
 * The cache is updated by syncCommittedUrlStateFromLocation() after navigation commits.
 * This ensures referential stability and prevents infinite re-renders.
 * External pushState/replaceState while URL notifications are suppressed won't
 * be visible until the next commit.
 */
function getSearchParamsSnapshot(): ReadonlyURLSearchParams {
  if (getNavigationContext()) return getServerSearchParamsSnapshot();

  const pagesCtx = _getPagesNavigationContext();
  if (pagesCtx) {
    return getReadonlyPagesSearchParams(pagesCtx.searchParams);
  }

  const cached = getClientNavigationState()?.cachedReadonlySearchParams;
  if (cached) return cached;
  if (_cachedEmptyClientSearchParams === null) {
    _cachedEmptyClientSearchParams = new ReadonlyURLSearchParams();
  }
  return _cachedEmptyClientSearchParams;
}

function syncCommittedUrlStateFromLocation(): boolean {
  const state = getClientNavigationState();
  if (!state) return false;

  let changed = false;

  const pathname = stripBasePath(window.location.pathname, __basePath);
  if (pathname !== state.cachedPathname) {
    state.cachedPathname = pathname;
    changed = true;
  }

  const search = window.location.search;
  if (search !== state.cachedSearch) {
    state.cachedSearch = search;
    state.cachedReadonlySearchParams = new ReadonlyURLSearchParams(search);
    changed = true;
  }

  return changed;
}

function getServerSearchParamsSnapshot(): ReadonlyURLSearchParams {
  const ctx = getNavigationContext() as NavigationContextWithReadonlyCache | null;

  if (!ctx) {
    // No App Router server context - try Pages Router compat shim.
    // See `adaptForSearchParams` in Next.js's adapters:
    // .nextjs-ref/packages/next/src/shared/lib/router/adapters.tsx
    const pagesCtx = _getPagesNavigationContext();
    if (pagesCtx) {
      return getReadonlyPagesSearchParams(pagesCtx.searchParams);
    }
    if (_cachedEmptyServerSearchParams === null) {
      _cachedEmptyServerSearchParams = new ReadonlyURLSearchParams();
    }
    return _cachedEmptyServerSearchParams;
  }

  const source = ctx.searchParams;
  const cached = ctx[_READONLY_SEARCH_PARAMS];
  const cachedSource = ctx[_READONLY_SEARCH_PARAMS_SOURCE];

  // Fast path: identical source object — reuse the wrapper without serializing.
  if (cached && cachedSource === source) {
    return cached;
  }

  // The source object can change identity while keeping the same value (e.g. a
  // hydration-cloned URLSearchParams). Serialize only when the identity check
  // misses, then compare against the cached value key before rebuilding.
  const sourceKey = source.toString();
  if (cached && ctx[_READONLY_SEARCH_PARAMS_SOURCE_KEY] === sourceKey) {
    ctx[_READONLY_SEARCH_PARAMS_SOURCE] = source;
    return cached;
  }

  // Create and cache new wrapper
  const readonly = new ReadonlyURLSearchParams(source);
  ctx[_READONLY_SEARCH_PARAMS] = readonly;
  ctx[_READONLY_SEARCH_PARAMS_SOURCE] = source;
  ctx[_READONLY_SEARCH_PARAMS_SOURCE_KEY] = sourceKey;

  return readonly;
}

// ---------------------------------------------------------------------------
// Navigation snapshot activation flag
//
// The render snapshot context provides pending URL values during transitions.
// After the transition commits, the snapshot becomes stale and must NOT shadow
// subsequent external URL changes (user pushState/replaceState). This flag
// tracks whether a navigation transition is in progress — hooks only prefer
// the snapshot while it's active.
// ---------------------------------------------------------------------------

/**
 * Mark a navigation snapshot as active. Called before startTransition
 * in renderNavigationPayload. While active, hooks prefer the snapshot
 * context value over useSyncExternalStore. Uses a counter (not boolean)
 * to handle overlapping navigations — rapid clicks can interleave
 * activate/deactivate if multiple transitions are in flight.
 */
export function activateNavigationSnapshot(): void {
  const state = getClientNavigationState();
  if (state) state.navigationSnapshotActiveCount++;
}

// Track client-side params (set during RSC hydration/navigation)
// We cache the params object for referential stability — only create a new
// object when the params actually change (shallow key/value comparison).
const _EMPTY_PARAMS: Record<string, string | string[]> = {};

// ---------------------------------------------------------------------------
// Client navigation render snapshot — provides pending URL values to hooks
// during a startTransition so they see the destination, not the stale URL.
// ---------------------------------------------------------------------------

export type ClientNavigationRenderSnapshot = {
  pathname: string;
  searchParams: ReadonlyURLSearchParams;
  params: Record<string, string | string[]>;
};

const _CLIENT_NAV_RENDER_CTX_KEY = Symbol.for("vinext.clientNavigationRenderContext");
type _ClientNavRenderGlobal = typeof globalThis & {
  [_CLIENT_NAV_RENDER_CTX_KEY]?: React.Context<ClientNavigationRenderSnapshot | null> | null;
};

export function getClientNavigationRenderContext(): React.Context<ClientNavigationRenderSnapshot | null> | null {
  if (typeof React.createContext !== "function") return null;

  const globalState = globalThis as _ClientNavRenderGlobal;
  if (!globalState[_CLIENT_NAV_RENDER_CTX_KEY]) {
    globalState[_CLIENT_NAV_RENDER_CTX_KEY] =
      React.createContext<ClientNavigationRenderSnapshot | null>(null);
  }

  return globalState[_CLIENT_NAV_RENDER_CTX_KEY] ?? null;
}

/* oxlint-disable eslint-plugin-react-hooks/rules-of-hooks */
/** @internal */
export function useClientNavigationRenderSnapshot(): ClientNavigationRenderSnapshot | null {
  const ctx = getClientNavigationRenderContext();
  if (!ctx || typeof React.useContext !== "function") return null;
  try {
    return React.useContext(ctx);
  } catch {
    return null;
  }
}
/* oxlint-enable eslint-plugin-react-hooks/rules-of-hooks */

export function createClientNavigationRenderSnapshot(
  href: string,
  params: Record<string, string | string[]>,
): ClientNavigationRenderSnapshot {
  const origin = typeof window !== "undefined" ? window.location.origin : "http://localhost";
  const url = new URL(href, origin);

  return {
    pathname: stripBasePath(url.pathname, __basePath),
    searchParams: new ReadonlyURLSearchParams(url.search),
    params,
  };
}

export function createSnapshotPathAndSearch(snapshot: ClientNavigationRenderSnapshot): string {
  const query = snapshot.searchParams.toString();
  return query === "" ? snapshot.pathname : `${snapshot.pathname}?${query}`;
}

// Module-level fallback for environments without window (tests, SSR).
let _fallbackClientParams: Record<string, string | string[]> = _EMPTY_PARAMS;
let _fallbackClientParamsJson = "{}";

export function setClientParams(params: Record<string, string | string[]>): void {
  const state = getClientNavigationState();
  if (!state) {
    const json = JSON.stringify(params);
    if (json !== _fallbackClientParamsJson) {
      _fallbackClientParams = params;
      _fallbackClientParamsJson = json;
    }
    return;
  }

  const json = JSON.stringify(params);
  if (json !== state.clientParamsJson) {
    state.clientParams = params;
    state.clientParamsJson = json;
    state.pendingClientParams = null;
    state.pendingClientParamsJson = null;
    notifyNavigationListeners();
  }
}

export function replaceClientParamsWithoutNotify(params: Record<string, string | string[]>): void {
  const state = getClientNavigationState();
  if (!state) return;

  const json = JSON.stringify(params);
  if (json !== state.clientParamsJson && json !== state.pendingClientParamsJson) {
    state.pendingClientParams = params;
    state.pendingClientParamsJson = json;
    state.hasPendingNavigationUpdate = true;
  }
}

/** Get the current client params (for testing referential stability). */
export function getClientParams(): Record<string, string | string[]> {
  return getClientNavigationState()?.clientParams ?? _fallbackClientParams;
}

/**
 * Set the pending pathname for client-side navigation.
 * Strips the base path before storing. Associates the pathname with the given navId
 * so only that navigation (or a newer one) can clear it.
 */
export function setPendingPathname(pathname: string, navId: number): void {
  const state = getClientNavigationState();
  if (!state) return;
  state.pendingPathname = stripBasePath(pathname, __basePath);
  state.pendingPathnameNavId = navId;
}

/**
 * Clear the pending pathname, but only if the given navId matches the one
 * that set it, or if pendingPathnameNavId is null (no active owner).
 * This prevents superseded navigations from clearing state belonging to newer navigations.
 */
export function clearPendingPathname(navId: number): void {
  const state = getClientNavigationState();
  if (!state) return;
  // Only clear if this navId is the one that set the pendingPathname,
  // or if pendingPathnameNavId is null (no owner)
  if (state.pendingPathnameNavId === null || state.pendingPathnameNavId === navId) {
    state.pendingPathname = null;
    state.pendingPathnameNavId = null;
  }
}

function getClientParamsSnapshot(): Record<string, string | string[]> | null {
  const state = getClientNavigationState();
  const ctx = getNavigationContext();
  if (ctx) return ctx.params;

  const pagesCtx = _getPagesNavigationContext();
  if (pagesCtx) {
    return pagesCtx.params;
  }
  return state?.clientParams ?? _EMPTY_PARAMS;
}

function getServerParamsSnapshot(): Record<string, string | string[]> | null {
  const ctx = getNavigationContext();
  if (ctx) return ctx.params;
  // No App Router navigation context — fall back to Pages Router state.
  // See `adaptForPathParams` in Next.js's pages-router adapter:
  // .nextjs-ref/packages/next/src/shared/lib/router/adapters.tsx
  const pagesCtx = _getPagesNavigationContext();
  if (pagesCtx) return pagesCtx.params;
  return _EMPTY_PARAMS;
}

function subscribeToNavigation(cb: () => void): () => void {
  const state = getClientNavigationState();
  if (!state) return () => {};

  state.listeners.add(cb);
  return () => {
    state.listeners.delete(cb);
  };
}

/* oxlint-disable eslint-plugin-react-hooks/rules-of-hooks */
/**
 * Returns the current pathname.
 * Server: from request context. Client: from window.location.
 */
export function usePathname(): string | null {
  if (isServer) {
    markPprFallbackShellDynamicBoundary();
    // During SSR of "use client" components, the navigation context may not be set.
    // Return a safe fallback — the client will hydrate with the real value.
    const ctx = getNavigationContext();
    if (ctx) return ctx.pathname;
    // Pages Router compat shim: derive pathname from the Pages Router state.
    const pagesCtx = _getPagesNavigationContext();
    return pagesCtx ? pagesCtx.pathname : "/";
  }
  const renderSnapshot = useClientNavigationRenderSnapshot();
  // Client-side: use the hook system for reactivity
  const pathname = React.useSyncExternalStore(subscribeToNavigation, getPathnameSnapshot, () => {
    const ctx = getNavigationContext();
    if (ctx) return ctx.pathname;
    const pagesCtx = _getPagesNavigationContext();
    return pagesCtx ? pagesCtx.pathname : "/";
  });
  // Prefer the render snapshot during an active navigation transition so
  // hooks return the pending URL, not the stale committed one. After commit,
  // fall through to useSyncExternalStore so user pushState/replaceState
  // calls are immediately reflected.
  if (renderSnapshot && (getClientNavigationState()?.navigationSnapshotActiveCount ?? 0) > 0) {
    return renderSnapshot.pathname;
  }
  return pathname;
}
/* oxlint-enable eslint-plugin-react-hooks/rules-of-hooks */

/* oxlint-disable eslint-plugin-react-hooks/rules-of-hooks */
/**
 * Returns the current search params as a read-only URLSearchParams.
 */
export function useSearchParams(): ReadonlyURLSearchParams {
  if (isServer) {
    markPprFallbackShellDynamicBoundary();
    // During SSR for "use client" components, the navigation context may not be set.
    // getServerSearchParamsSnapshot also covers the Pages Router compat shim.
    return getServerSearchParamsSnapshot();
  }
  const renderSnapshot = useClientNavigationRenderSnapshot();
  const searchParams = React.useSyncExternalStore(
    subscribeToNavigation,
    getSearchParamsSnapshot,
    getServerSearchParamsSnapshot,
  );
  if (renderSnapshot && (getClientNavigationState()?.navigationSnapshotActiveCount ?? 0) > 0) {
    return renderSnapshot.searchParams;
  }
  return searchParams;
}
/* oxlint-enable eslint-plugin-react-hooks/rules-of-hooks */

/* oxlint-disable eslint-plugin-react-hooks/rules-of-hooks */
/**
 * Returns the dynamic params for the current route.
 */
export function useParams<
  T extends Record<string, string | string[]> = Record<string, string | string[]>,
>(): T | null {
  if (isServer) {
    markPprFallbackShellDynamicBoundary();
    // During SSR for "use client" components, the navigation context may not be set.
    // getServerParamsSnapshot covers both App Router and Pages Router compat.
    return getServerParamsSnapshot() as T | null;
  }
  const renderSnapshot = useClientNavigationRenderSnapshot();
  const params = React.useSyncExternalStore(
    subscribeToNavigation,
    getClientParamsSnapshot as () => T | null,
    getServerParamsSnapshot as () => T | null,
  );
  if (renderSnapshot && (getClientNavigationState()?.navigationSnapshotActiveCount ?? 0) > 0) {
    return renderSnapshot.params as T;
  }
  return params;
}
/* oxlint-enable eslint-plugin-react-hooks/rules-of-hooks */

/**
 * Check if a href is an external URL (any URL scheme per RFC 3986, or protocol-relative).
 */
function isExternalUrl(href: string): boolean {
  return isAbsoluteOrProtocolRelativeUrl(href);
}

// ---------------------------------------------------------------------------
// History method wrappers — suppress notifications for internal updates
// ---------------------------------------------------------------------------

function withSuppressedUrlNotifications<T>(fn: () => T): T {
  const state = getClientNavigationState();
  if (!state) {
    return fn();
  }

  state.suppressUrlNotifyCount += 1;
  try {
    return fn();
  } finally {
    state.suppressUrlNotifyCount -= 1;
  }
}

/**
 * Commit pending client navigation state to committed snapshots.
 *
 * navId is optional: callers that don't own pendingPathname (for example,
 * superseded pre-paint cleanup) may pass undefined to flush URL/params state
 * without clearing pendingPathname owned by the active navigation. Such callers
 * must opt in explicitly if they also own an activated render snapshot.
 */
export function commitClientNavigationState(
  navId?: number,
  options?: CommitClientNavigationStateOptions,
): void {
  if (isServer) return;
  const state = getClientNavigationState();
  if (!state) return;

  // Only navigation-owned commits may release a render snapshot. Ownerless URL
  // syncs still update committed pathname/search state, but must not consume
  // the active snapshot for an in-flight App Router transition.
  const shouldReleaseSnapshot = navId !== undefined || options?.releaseSnapshot === true;
  if (shouldReleaseSnapshot && state.navigationSnapshotActiveCount > 0) {
    state.navigationSnapshotActiveCount -= 1;
  }

  const urlChanged = syncCommittedUrlStateFromLocation();
  let paramsChanged = false;
  if (state.pendingClientParams !== null && state.pendingClientParamsJson !== null) {
    state.clientParams = state.pendingClientParams;
    state.clientParamsJson = state.pendingClientParamsJson;
    state.pendingClientParams = null;
    state.pendingClientParamsJson = null;
    paramsChanged = true;
  }
  // Clear pending pathname when navigation commits, but only if:
  // - The navId matches the one that set pendingPathname
  // - No newer navigation has overwritten pendingPathname (pendingPathnameNavId === null or matches)
  // - navId is undefined only for non-owning callers, which must not clear
  //   pendingPathname for an active navigation.
  const canClearPendingPathname =
    state.pendingPathnameNavId === null ||
    (navId !== undefined && state.pendingPathnameNavId === navId);
  if (canClearPendingPathname) {
    state.pendingPathname = null;
    state.pendingPathnameNavId = null;
  }
  const shouldNotify = urlChanged || state.hasPendingNavigationUpdate;
  state.hasPendingNavigationUpdate = false;

  if (urlChanged || paramsChanged) {
    clearClientHydrationContext();
  }

  if (shouldNotify) {
    notifyNavigationListeners();
  }
}

export function pushHistoryStateWithoutNotify(
  data: unknown,
  unused: string,
  url?: string | URL | null,
): void {
  withSuppressedUrlNotifications(() => {
    const state = getClientNavigationState();
    state?.originalPushState.call(window.history, data, unused, url);
  });
}

export function replaceHistoryStateWithoutNotify(
  data: unknown,
  unused: string,
  url?: string | URL | null,
): void {
  withSuppressedUrlNotifications(() => {
    const state = getClientNavigationState();
    state?.originalReplaceState.call(window.history, data, unused, url);
  });
}

/**
 * Save the current scroll position into the current history state.
 * Called before every navigation to enable scroll restoration on back/forward.
 *
 * Uses replaceHistoryStateWithoutNotify to avoid triggering the patched
 * history.replaceState interception (which would cause spurious re-renders).
 */
export function saveScrollPosition(): void {
  const state = window.history.state ?? {};
  replaceHistoryStateWithoutNotify(
    { ...state, __vinext_scrollX: window.scrollX, __vinext_scrollY: window.scrollY },
    "",
  );
}

function commitHashOnlyHistoryState(href: string, mode: "push" | "replace", scroll: boolean): void {
  const commitAppRouterHashNavigation = getNavigationRuntime()?.functions.commitHashNavigation;
  if (commitAppRouterHashNavigation) {
    commitAppRouterHashNavigation(href, mode, scroll);
    return;
  }

  const historyState = createHashOnlyHistoryStatePreservingNavigationMetadata(window.history.state);
  if (mode === "replace") {
    replaceHistoryStateWithoutNotify(historyState, "", href);
  } else {
    pushHistoryStateWithoutNotify(historyState, "", href);
  }
}

// Exported for direct unit coverage of the document-top fallback decision; not
// part of the next/navigation public API. The fallback runs after a committed
// navigation declined to consume its scroll intent (see navigateClientSide).
export function applyAppRouterScrollFallback(intent: AppRouterScrollIntent): void {
  if (typeof document === "undefined" || typeof window === "undefined") {
    return;
  }

  if (intent.hash !== null) {
    scrollToHashTarget(intent.hash);
    return;
  }

  // Next's legacy App Router scroll handler can fail to scroll when the
  // target route's first DOM child is a React-hoisted stylesheet in <head>.
  // The committed AppRouterScrollTarget detects that case for this navigation
  // and marks the intent, so we must not mask the observable old-handler
  // behavior by synthesizing a document-top scroll. The flag is per-intent: a
  // hoisted stylesheet merely present in <head> for an unrelated navigation
  // does not suppress this fallback.
  if (intent.targetHoistedInHead) {
    return;
  }

  document.documentElement.scrollTop = 0;
}

function scheduleAppRouterScrollFallback(intent: AppRouterScrollIntent): void {
  queueMicrotask(() => {
    const pendingIntent = getPendingAppRouterScrollIntent();
    if (pendingIntent === null || pendingIntent.id !== intent.id) return;
    const fallbackIntent = consumeAppRouterScrollIntent(intent);
    if (fallbackIntent) applyAppRouterScrollFallback(fallbackIntent);
  });
}

/**
 * Restore scroll position from a history state object (used on popstate).
 *
 * When an RSC navigation is in flight (back/forward triggers both this
 * handler and the browser entry's popstate handler which calls the registered
 * navigation runtime), we must wait for the new content to render
 * before scrolling. Otherwise the user sees old content flash at the
 * restored scroll position.
 *
 * This handler fires before the browser entry's popstate handler (because
 * navigation.ts is loaded before hydration completes), so we defer via a
 * microtask to give the browser entry handler a chance to set
 * __VINEXT_RSC_PENDING__. Promise.resolve() schedules a microtask
 * that runs after all synchronous event listeners have completed.
 */
function restoreScrollPosition(state: unknown): void {
  if (state && typeof state === "object" && "__vinext_scrollY" in state) {
    const { __vinext_scrollX: x, __vinext_scrollY: y } = state as {
      __vinext_scrollX: number;
      __vinext_scrollY: number;
    };

    // Defer to allow other popstate listeners (browser entry) to run first
    // and set __VINEXT_RSC_PENDING__. Promise.resolve() schedules a microtask
    // that runs after all synchronous event listeners have completed.
    void Promise.resolve().then(() => {
      const pending: Promise<void> | null = window.__VINEXT_RSC_PENDING__ ?? null;

      if (pending) {
        void pending.then(() => retryScrollTo(x, y));
      } else {
        retryScrollTo(x, y);
      }
    });
  }
}

/**
 * Hard-navigate to a URL via `window.location`, preserving push/replace
 * semantics. Used for URLs the App Router cannot serve (Pages-owned
 * targets in a hybrid build) and for catch-all RSC failures.
 */
function hardNavigateTo(fullHref: string, mode: "push" | "replace"): void {
  if (mode === "replace") {
    window.location.replace(fullHref);
  } else {
    window.location.assign(fullHref);
  }
}

/**
 * Navigate to a URL, handling external URLs, hash-only changes, and RSC navigation.
 */
export async function navigateClientSide(
  href: string,
  mode: "push" | "replace",
  scroll: boolean,
  programmaticTransition = false,
  visibleCommitMode: NavigationRuntimeVisibleCommitMode = "transition",
): Promise<void> {
  // Reset any link still showing a `useLinkStatus()` pending state that did not
  // initiate this navigation (e.g. a programmatic router.push or form submit).
  // A <Link> click registers itself first, so the hook keeps that link pending.
  getNavigationRuntime()?.functions.notifyLinkNavigationStart?.();

  // Normalize same-origin absolute URLs to local paths for SPA navigation
  let normalizedHref = href;
  if (isExternalUrl(href)) {
    const localPath = toSameOriginAppPath(href, __basePath);
    if (localPath == null) {
      notifyAppRouterTransitionStart(href, mode);

      const externalNavigate = getNavigationRuntime()?.functions.navigateExternal;
      if (externalNavigate) {
        await externalNavigate(href, mode);
        return;
      }

      hardNavigateTo(href, mode);
      await new Promise<void>(() => {});
      return;
    }
    normalizedHref = localPath;
  }

  // Hybrid ownership: when both an App and a Pages route can match the
  // destination, defer to the shared `compareHybridRoutePatterns` decision
  // (the same logic the server uses for direct document loads). If Pages
  // owns the URL, hard-navigate so the Pages handler renders the page
  // instead of the App catch-all — soft-navigating through RSC would
  // either return null (because `renderPagesFallback` short-circuits RSC
  // requests) or render the App catch-all's path array. This is the
  // programmatic equivalent of the link click / prefetch check in
  // `link.tsx`.
  const hybridOwner = resolveHybridClientRouteOwner(normalizedHref, __basePath);
  if (hybridOwner === "pages" || hybridOwner === "document") {
    const fullHref = toBrowserNavigationHref(normalizedHref, window.location.href, __basePath);
    notifyAppRouterTransitionStart(fullHref, mode);
    if (mode === "push") {
      saveScrollPosition();
    }
    hardNavigateTo(fullHref, mode);
    await new Promise<void>(() => {});
    return;
  }

  const fullHref = toBrowserNavigationHref(normalizedHref, window.location.href, __basePath);
  stageAppNavigationFailureTarget(fullHref);
  // Match Next.js: App Router reports navigation start before dispatching,
  // including hash-only navigations that short-circuit after URL update.
  notifyAppRouterTransitionStart(fullHref, mode);

  // Save scroll position before navigating (for back/forward restoration)
  if (mode === "push") {
    saveScrollPosition();
  }

  // The planner classifies the early navigation intent from the URL delta. A
  // same-document scroll updates the URL and scrolls to the hash target without
  // an RSC fetch; everything else proceeds to the RSC navigation below.
  const earlyIntent = navigationPlanner.classifyEarlyNavigationIntent({
    basePath: __basePath,
    currentHref: window.location.href,
    mode,
    scroll,
    targetHref: fullHref,
  });
  if (earlyIntent.kind === "sameDocumentScroll") {
    clearAppRouterScrollIntent();
    commitHashOnlyHistoryState(fullHref, earlyIntent.mode, earlyIntent.scroll);
    clearAppNavigationFailureTarget(fullHref);
    commitClientNavigationState();
    if (earlyIntent.scroll) {
      scrollToHashTarget(earlyIntent.hash);
    }
    return;
  }

  // Next.js treats a streamed redirect meta tag as an MPA-navigation marker.
  // A soft RSC redirect would leave the source document alive long enough for
  // the delayed meta refresh to fire and render the target a second time.
  if (hasPendingAppRouterPageRedirect(typeof document === "undefined" ? undefined : document)) {
    const mpaNavigate = getNavigationRuntime()?.functions.navigateExternal;
    if (mpaNavigate) {
      await mpaNavigate(fullHref, mode);
      return;
    }

    hardNavigateTo(fullHref, mode);
    await new Promise<void>(() => {});
    return;
  }

  // Extract hash for post-navigation scrolling
  const hashIdx = fullHref.indexOf("#");
  const hash = hashIdx !== -1 ? fullHref.slice(hashIdx) : "";
  const scrollIntent = scroll ? beginAppRouterScrollIntent(hash || null) : null;
  if (!scroll) {
    clearAppRouterScrollIntent();
  }

  // Trigger RSC re-fetch if available, and wait for the new content to render
  // before scrolling. This prevents the old page from visibly jumping to the
  // top before the new content paints.
  //
  // History is NOT pushed here for RSC navigations — the commit effect inside
  // navigateRsc owns the push/replace exclusively. This avoids a fragile
  // double-push and ensures window.location still reflects the *current* URL
  // when navigateRsc publishes the committed URL.
  const appNavigate = getNavigationRuntime()?.functions.navigate;
  try {
    if (appNavigate) {
      await appNavigate(
        fullHref,
        0,
        "navigate",
        mode,
        undefined,
        programmaticTransition,
        undefined,
        scrollIntent,
        visibleCommitMode,
      );
    } else {
      if (mode === "replace") {
        replaceHistoryStateWithoutNotify(null, "", fullHref);
      } else {
        pushHistoryStateWithoutNotify(null, "", fullHref);
      }
      commitClientNavigationState();
    }
  } catch (error) {
    if (scrollIntent) {
      consumeAppRouterScrollIntent(scrollIntent);
    }
    throw error;
  }

  if (scrollIntent) {
    scheduleAppRouterScrollFallback(scrollIntent);
  }
}

// ---------------------------------------------------------------------------
// App Router router singleton
//
// All methods close over module-level state (navigateClientSide, withBasePath, etc.)
// and carry no per-render data, so the object can be created once and reused.
// Next.js returns the same router reference on every call to useRouter(), which
// matters for components that rely on referential equality (e.g. useMemo /
// useEffect dependency arrays, React.memo bailouts).
// ---------------------------------------------------------------------------

// `router.refresh()` can run in the same outer transition after push/replace
// while the nested navigation transition is still being scheduled.
let scheduledAppRouterNavigationCount = 0;

function trackScheduledAppRouterNavigation(): () => void {
  scheduledAppRouterNavigationCount += 1;
  let released = false;

  return () => {
    if (released) return;
    released = true;
    scheduledAppRouterNavigationCount = Math.max(0, scheduledAppRouterNavigationCount - 1);
  };
}

function hasScheduledAppRouterNavigation(): boolean {
  return scheduledAppRouterNavigationCount > 0;
}

function releaseScheduledAppRouterNavigationAfterCurrentTask(release: () => void): void {
  queueMicrotask(release);
}

/**
 * App Router public router instance. Mirrors Next.js's
 * `publicAppRouterInstance` from
 * `packages/next/src/client/components/app-router-instance.ts`.
 *
 * Exported so the App Router browser entry can install it on
 * `window.next.router` for Next.js parity (see `client/window-next.ts`).
 * Internal callers in this file continue to use `_appRouter` for brevity.
 */
const _appRouter: AppRouterInstance = {
  bfcacheId: INITIAL_BFCACHE_ID,
  push(href: string, options?: { scroll?: boolean }): void {
    assertSafeNavigationUrl(href);
    if (isServer) return;
    // An imperative navigation supersedes any <Link>-owned pending state.
    // Clear it before entering the navigation transition so React does not
    // defer the idle update behind the suspended destination render.
    getNavigationRuntime()?.functions.notifyLinkNavigationStart?.();
    const releaseNavigation = trackScheduledAppRouterNavigation();
    try {
      React.startTransition(() => {
        void navigateClientSide(href, "push", options?.scroll !== false, true);
      });
    } catch (error) {
      releaseNavigation();
      throw error;
    }
    releaseScheduledAppRouterNavigationAfterCurrentTask(releaseNavigation);
  },
  replace(href: string, options?: { scroll?: boolean }): void {
    assertSafeNavigationUrl(href);
    if (isServer) return;
    getNavigationRuntime()?.functions.notifyLinkNavigationStart?.();
    const releaseNavigation = trackScheduledAppRouterNavigation();
    try {
      React.startTransition(() => {
        void navigateClientSide(href, "replace", options?.scroll !== false, true);
      });
    } catch (error) {
      releaseNavigation();
      throw error;
    }
    releaseScheduledAppRouterNavigationAfterCurrentTask(releaseNavigation);
  },
  back(): void {
    if (isServer) return;
    window.history.back();
  },
  forward(): void {
    if (isServer) return;
    window.history.forward();
  },
  refresh(): void {
    if (isServer) return;
    // Drop cached RSC payloads for every previously-visited / prefetched route
    // before re-fetching. Next.js's refresh-reducer invalidates the entire
    // segment cache (refresh-reducer.ts → invalidateSegmentCacheEntries), so
    // without this, a stale cached payload for a sibling route (e.g. a page
    // gated by a session that has since been cleared) would still satisfy a
    // subsequent client navigation and bypass the server's redirect logic.
    getNavigationRuntime()?.functions.clearNavigationCaches?.();
    if (hasScheduledAppRouterNavigation()) return;
    // Re-fetch the current page's RSC stream
    const rscNavigate = getNavigationRuntime()?.functions.navigate;
    if (rscNavigate) {
      const navigate = () => {
        void rscNavigate(window.location.href, 0, "refresh", undefined, undefined, true);
      };
      React.startTransition(navigate);
    }
  },
  prefetch(href: string, options?: PrefetchOptions): void {
    assertSafeNavigationUrl(href);
    if (isServer) return;
    if (isBotUserAgent(window.navigator?.userAgent ?? "")) return;
    // Validate the URL is parseable. Mirrors Next.js's createPrefetchURL:
    // `packages/next/src/client/components/app-router-utils.ts` — when the URL
    // cannot be converted, Next.js throws so the call site (and its surrounding
    // error boundary, in the App Router) surfaces the failure. Without this
    // guard, vinext silently swallows unparseable hrefs and the test app's
    // error boundary never renders. basePath is applied before parsing to match
    // Next.js exactly: a non-empty basePath can make an otherwise broken-looking
    // href parseable (e.g. `new URL("/app///", origin)` succeeds while
    // `new URL("///", origin)` throws).
    try {
      new URL(withBasePath(href, __basePath), window.location.href);
    } catch {
      throw new Error(`Cannot prefetch '${href}' because it cannot be converted to a URL.`);
    }
    void (async () => {
      // Normalize same-origin absolute URLs to local paths; no-op for external
      // origins so we don't pollute the prefetch cache with a same-path .rsc on
      // the current origin. Mirrors Link's prefetchUrl and navigateClientSide.
      let prefetchHref = href;
      if (isAbsoluteOrProtocolRelativeUrl(href)) {
        const localPath = toSameOriginAppPath(href, __basePath);
        if (localPath == null) return;
        prefetchHref = localPath;
      }

      // Hybrid ownership: when a Pages route owns the URL, the App Router
      // cannot serve it (Pages produces HTML documents / `_next/data` JSON,
      // not RSC streams). Prefetching an RSC URL would either 404 or warm
      // an unusable cache entry. The matching `push`/`replace` call will
      // hard-navigate via `window.location`, so a no-op here is correct —
      // the document prefetch the link shim emits on hover still runs.
      const hybridOwner = resolveHybridClientRouteOwner(prefetchHref, __basePath);
      if (hybridOwner === "pages" || hybridOwner === "document") {
        return;
      }

      // Prefetch the RSC payload for the target route and store in cache.
      // We must add to prefetchedUrls manually for deduplication.
      // prefetchRscResponse only manages the cache Map, not the URL set.
      const fullHref = toBrowserNavigationHref(prefetchHref, window.location.href, __basePath);
      const interceptionContext = getPrefetchInterceptionContext(fullHref);
      const mountedSlotsHeader = getMountedSlotsHeader();
      const headers = createRscRequestHeaders({ interceptionContext });
      if (mountedSlotsHeader) {
        headers.set(VINEXT_MOUNTED_SLOTS_HEADER, mountedSlotsHeader);
      }
      const rscUrl = await createRscRequestUrl(fullHref, headers);
      const cacheKey = AppElementsWire.encodeCacheKey(rscUrl, interceptionContext);
      const prefetched = getPrefetchedUrls();
      if (prefetched.has(cacheKey)) {
        attachPrefetchInvalidationCallback(cacheKey, options?.onInvalidate);
        return;
      }
      prefetched.add(cacheKey);
      prefetchRscResponse(
        rscUrl,
        fetch(rscUrl, {
          headers,
          credentials: "include",
          priority: "low" as RequestInit["priority"],
        }),
        interceptionContext,
        mountedSlotsHeader,
        options,
      );
    })().catch((error) => {
      console.error("[vinext] RSC prefetch setup error:", error);
    });
  },
};

if (process.env.__NEXT_GESTURE_TRANSITION) {
  _appRouter.experimental_gesturePush = (href: string, options?: { scroll?: boolean }): void => {
    assertSafeNavigationUrl(href);
    if (isServer) return;

    // Next.js parity: upstream's gesturePush early-returns when
    // `getCurrentAppRouterState() === null` (a gesture dispatched before
    // hydration is a no-op). Our equivalent readiness signal is the runtime's
    // navigate function — the same check navigateClientSide uses before its
    // non-runtime fallback, which would otherwise perform a real history push
    // here instead of upstream's no-op.
    //
    // This guard and navigateClientSide's own `appNavigate` lookup read the
    // runtime separately, but there is no TOCTOU window between them: every
    // `await` ahead of that lookup sits in a branch that returns without
    // reaching it, so when the lookup runs it runs synchronously in this same
    // task — and runtime registration is monotonic (the browser entry installs
    // `navigate` once and never unregisters it), so a passed guard cannot go
    // stale. Revisit if registration ever becomes async or revocable.
    if (!getNavigationRuntime()?.functions.navigate) return;

    // navigateClientSide would normalize same-origin absolute URLs itself; this
    // inline check exists to *no-op* on external hrefs instead of falling
    // through to its hard window.location.assign.
    let appHref = href;
    if (isAbsoluteOrProtocolRelativeUrl(href)) {
      const localPath = toSameOriginAppPath(href, __basePath);
      if (localPath === null) return;
      appHref = localPath;
    }

    // Track the scheduled navigation like push/replace so a `refresh()` issued
    // in the same task skips its redundant re-fetch (see
    // hasScheduledAppRouterNavigation() in refresh()). Unlike push/replace
    // there is no synchronous React.startTransition dispatch here that could
    // throw, so no try/catch unwind is needed. The un-awaited
    // `void navigateClientSide(...)` deliberately matches push/replace's
    // fire-and-forget shape (their try/catch only covers the synchronous
    // startTransition throw): an RSC fetch rejection mid-gesture surfaces the
    // same way it would for those siblings.
    const releaseNavigation = trackScheduledAppRouterNavigation();
    void navigateClientSide(appHref, "push", options?.scroll !== false, false, "synchronous");
    releaseScheduledAppRouterNavigationAfterCurrentTask(releaseNavigation);
  };
}

function formatPublicBfcacheId(value: string | null | undefined): string {
  if (!value || value === INITIAL_BFCACHE_ID) return PUBLIC_INITIAL_BFCACHE_ID;
  return value;
}

/* oxlint-disable eslint-plugin-react-hooks/rules-of-hooks */
function readBfcacheIdFromContext(): string {
  const segmentContext = getBfcacheSegmentIdContext();
  const idMapContext = getBfcacheIdMapContext();
  if (!segmentContext || !idMapContext || typeof React.useContext !== "function") {
    return formatPublicBfcacheId(null);
  }

  try {
    const segmentId = React.useContext(segmentContext);
    const idMap = React.useContext(idMapContext);
    return formatPublicBfcacheId(segmentId !== null ? idMap?.[segmentId] : null);
  } catch (error) {
    // Low-level tests and direct module calls can hit this outside render.
    if (process.env.NODE_ENV !== "production") {
      console.warn("[vinext] readBfcacheIdFromContext failed:", error);
    }
    return formatPublicBfcacheId(null);
  }
}
/* oxlint-enable eslint-plugin-react-hooks/rules-of-hooks */

/**
 * Public App Router instance, exposed for the browser entry so it can wire
 * `window.next.router` to the same singleton returned from `useRouter()`.
 *
 * Mirrors `publicAppRouterInstance` from Next.js's
 * `packages/next/src/client/components/app-router-instance.ts` (line 392).
 */
export const appRouterInstance = _appRouter;

/**
 * App Router's useRouter — returns push/replace/back/forward/refresh.
 * Different from Pages Router's useRouter (next/router).
 *
 * Preserves the mounted AppRouterContext router as the authority for methods
 * and layers the nearest segment's contextual `bfcacheId` on top.
 */
export function useRouter() {
  if (
    !AppRouterContext ||
    typeof React.useContext !== "function" ||
    typeof React.useMemo !== "function"
  ) {
    throw new Error("invariant expected app router to be mounted");
  }
  const router = React.useContext(AppRouterContext);
  if (router === null) {
    throw new Error("invariant expected app router to be mounted");
  }
  const bfcacheId = readBfcacheIdFromContext();
  return React.useMemo(
    () => ({
      ...router,
      bfcacheId,
    }),
    [router, bfcacheId],
  );
}

/**
 * Returns the active child segment one level below the layout where it's called.
 *
 * Returns the first segment from the route tree below this layout, including
 * route groups (e.g., "(marketing)") and resolved dynamic params. Returns null
 * if at the leaf (no child segments).
 *
 * @param parallelRoutesKey - Which parallel route to read (default: "children")
 */
export function useSelectedLayoutSegment(parallelRoutesKey?: string): string | null {
  const segments = useSelectedLayoutSegments(parallelRoutesKey);
  if (segments.length === 0) return null;

  return parallelRoutesKey === undefined || parallelRoutesKey === "children"
    ? segments[0]
    : segments[segments.length - 1];
}

/**
 * Returns all active segments below the layout where it's called.
 *
 * Each layout in the App Router tree wraps its children with a
 * LayoutSegmentProvider whose value is a map of parallel route key to
 * segment arrays. The "children" key is the default parallel route.
 *
 * @param parallelRoutesKey - Which parallel route to read (default: "children")
 */
export function useSelectedLayoutSegments(parallelRoutesKey?: string): string[] {
  if (isServer) {
    markPprFallbackShellDynamicBoundary();
  }
  return useChildSegments(parallelRoutesKey);
}

export { ReadonlyURLSearchParams };

/**
 * useServerInsertedHTML — inject HTML during SSR from client components.
 *
 * Used by CSS-in-JS libraries (styled-components, emotion, StyleX) to inject
 * <style> tags during SSR so styles appear in the initial HTML (no FOUC).
 *
 * The callback is called once after each SSR render pass. The returned JSX/HTML
 * is serialized and injected into the HTML stream.
 *
 * Usage (in a "use client" component wrapping children):
 *   useServerInsertedHTML(() => {
 *     const styles = sheet.getStyleElement();
 *     sheet.instance.clearTag();
 *     return <>{styles}</>;
 *   });
 */

export function useServerInsertedHTML(callback: () => unknown): void {
  if (typeof document !== "undefined") {
    // Client-side: no-op (styles are already in the DOM)
    return;
  }
  registerServerInsertedHTMLCallback(callback);
}

// ---------------------------------------------------------------------------
// Unrecognized server-action errors
//
// `UnrecognizedActionError` / `unstable_isUnrecognizedActionError` live in a
// dedicated zero-dependency module so this `next/navigation` shim and vinext's
// client server-action dispatcher (`server/server-action-not-found.ts`) share
// one class. `instanceof` is identity-based per module instance, so the
// dispatcher and user code must resolve the same class for the predicate to
// work. Re-exported here to keep the public `next/navigation` surface intact.
// ---------------------------------------------------------------------------

export {
  UnrecognizedActionError,
  unstable_isUnrecognizedActionError,
} from "./unrecognized-action-error.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Listen for popstate on the client
if (!isServer) {
  const state = getClientNavigationState();
  if (state && !state.patchInstalled) {
    state.patchInstalled = true;

    // Listen for popstate on the client.
    // Note: This handler runs for Pages Router only (when App Router navigation
    // runtime is not available). It restores scroll position with microtask-based deferral.
    // App Router scroll restoration is handled in server/app-browser-entry.ts:697
    // with RSC navigation coordination (waits for pending navigation to settle).
    window.addEventListener("popstate", () => {
      // Browser back/forward starts a new navigation that the tracked link did
      // not initiate, so clear any sticky `useLinkStatus()` pending state. Runs
      // for both routers; the App Router's own popstate handler (in
      // app-browser-entry.ts) drives scroll restoration and RSC fetching.
      getNavigationRuntime()?.functions.notifyLinkNavigationStart?.();
    });

    window.addEventListener("popstate", (event) => {
      if (!hasAppNavigationRuntime()) {
        commitClientNavigationState();
        restoreScrollPosition(event.state);
      }
    });

    window.history.pushState = function patchedPushState(
      data: unknown,
      unused: string,
      url?: string | URL | null,
    ): void {
      state.originalPushState.call(
        window.history,
        createExternalHistoryStatePreservingMetadata(data, window.history.state),
        unused,
        url,
      );
      if (state.suppressUrlNotifyCount === 0) {
        // A raw history.pushState (shallow routing) starts a navigation that did
        // not go through navigateClientSide; clear any sticky pending link.
        getNavigationRuntime()?.functions.notifyLinkNavigationStart?.();
        commitClientNavigationState();
      }
    };

    window.history.replaceState = function patchedReplaceState(
      data: unknown,
      unused: string,
      url?: string | URL | null,
    ): void {
      state.originalReplaceState.call(
        window.history,
        createExternalHistoryStatePreservingMetadata(data, window.history.state),
        unused,
        url,
      );
      if (state.suppressUrlNotifyCount === 0) {
        getNavigationRuntime()?.functions.notifyLinkNavigationStart?.();
        commitClientNavigationState();
      }
    };
  }
}
