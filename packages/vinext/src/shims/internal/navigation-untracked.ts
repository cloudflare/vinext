/**
 * Internal navigation-untracked pathname hook.
 *
 * Used by `unstable_catchError` error boundaries to avoid subscribing to
 * pathname changes. This is NOT part of the public `next/navigation` API.
 *
 * Ported from Next.js:
 *   https://github.com/vercel/next.js/blob/v16.2.6/packages/next/src/client/components/navigation-untracked.ts
 */

import * as React from "react";
import {
  getClientNavigationState,
  getClientNavigationRenderContext,
  getNavigationContext,
  type ClientNavigationRenderSnapshot,
} from "../navigation.js";

const isServer = typeof window === "undefined";

// ─── Pages Router compat ────────────────────────────────────────────────────
// The Pages Router accessor is not exported from navigation.ts, so we duplicate
// only this Symbol-based lookup here.

type PagesNavigationContext = {
  pathname: string | null;
  searchParams: URLSearchParams;
  params: Record<string, string | string[]> | null;
};

const PAGES_NAVIGATION_ACCESSOR_KEY = Symbol.for(
  "vinext.navigation.pagesNavigationContextAccessor",
);

type _GlobalWithPagesAccessor = typeof globalThis & {
  [PAGES_NAVIGATION_ACCESSOR_KEY]?: () => PagesNavigationContext | null;
};

function _getPagesNavigationContext(): PagesNavigationContext | null {
  const accessor = (globalThis as _GlobalWithPagesAccessor)[PAGES_NAVIGATION_ACCESSOR_KEY];
  if (!accessor) return null;
  try {
    return accessor();
  } catch {
    return null;
  }
}

// ─── Client snapshots ───────────────────────────────────────────────────────

function getPathnameSnapshot(): string | null {
  const pagesCtx = _getPagesNavigationContext();
  if (pagesCtx) return pagesCtx.pathname;
  return getClientNavigationState()?.cachedPathname ?? "/";
}

/* oxlint-disable eslint-plugin-react-hooks/rules-of-hooks */
function useClientNavigationRenderSnapshot(): ClientNavigationRenderSnapshot | null {
  const ctx = getClientNavigationRenderContext();
  if (!ctx || typeof React.useContext !== "function") return null;
  try {
    return React.useContext(ctx);
  } catch {
    return null;
  }
}
/* oxlint-enable eslint-plugin-react-hooks/rules-of-hooks */

// ─── useUntrackedPathname ───────────────────────────────────────────────────

/**
 * Returns the current pathname without registering it as a tracked render
 * dependency. Unlike `usePathname()`, this does not use `useSyncExternalStore`
 * and therefore does not cause the component to re-render on navigation.
 *
 * Server: returns the pathname from context, or `"/"` when no navigation context
 * is available (the client will hydrate with the real value). Returns `null` only
 * when the render is a missing-params shell — vinext does not yet implement
 * fallback-route-param detection, so this path is not currently reachable.
 *
 * Client: prefers the render snapshot **only during an active navigation**
 * transition (`navigationSnapshotActiveCount > 0`) so the hook returns the
 * pending URL, not the stale committed one. After commit, falls back to the
 * cached pathname so user `pushState`/`replaceState` calls are immediately
 * reflected.
 *
 * Used by `unstable_catchError` error boundaries to avoid unnecessary re-renders.
 *
 * @internal
 */
/* oxlint-disable eslint-plugin-react-hooks/rules-of-hooks */
export function useUntrackedPathname(): string | null {
  if (isServer) {
    const ctx = getNavigationContext();
    if (ctx) return ctx.pathname;
    const pagesCtx = _getPagesNavigationContext();
    return pagesCtx ? pagesCtx.pathname : "/";
  }
  const renderSnapshot = useClientNavigationRenderSnapshot();
  if (renderSnapshot && (getClientNavigationState()?.navigationSnapshotActiveCount ?? 0) > 0) {
    return renderSnapshot.pathname;
  }
  const pagesCtx = _getPagesNavigationContext();
  if (pagesCtx) return pagesCtx.pathname;
  return getPathnameSnapshot();
}
/* oxlint-enable eslint-plugin-react-hooks/rules-of-hooks */
