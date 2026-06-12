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
  type ClientNavigationRenderSnapshot,
} from "../navigation.js";

const isServer = typeof window === "undefined";

// ─── Cross-module-instance server context access ────────────────────────────
// These globals are the same symbols used by navigation.ts so that separate
// Vite module instances (SSR entry vs "use client" component) still share
// the same navigation state. See issue #688 in the vinext repo.

type NavigationContext = {
  pathname: string;
  searchParams: URLSearchParams;
  params: Record<string, string | string[]>;
};

const _GLOBAL_ACCESSORS_KEY = Symbol.for("vinext.navigation.globalAccessors");
const _GLOBAL_HYDRATION_CONTEXT_KEY = Symbol.for("vinext.navigation.clientHydrationContext");

type _GlobalWithAccessors = typeof globalThis & {
  [_GLOBAL_ACCESSORS_KEY]?: {
    getServerContext: () => NavigationContext | null;
    setServerContext: (ctx: NavigationContext | null) => void;
    getInsertedHTMLCallbacks: () => Array<() => unknown>;
    clearInsertedHTMLCallbacks: () => void;
  };
};

type _GlobalWithHydrationContext = typeof globalThis & {
  [_GLOBAL_HYDRATION_CONTEXT_KEY]?: NavigationContext | null;
};

function _getGlobalAccessors(): _GlobalWithAccessors[typeof _GLOBAL_ACCESSORS_KEY] | undefined {
  return (globalThis as _GlobalWithAccessors)[_GLOBAL_ACCESSORS_KEY];
}

function _getClientHydrationContext(): NavigationContext | null | undefined {
  const globalState = globalThis as _GlobalWithHydrationContext;
  if (Object.prototype.hasOwnProperty.call(globalState, _GLOBAL_HYDRATION_CONTEXT_KEY)) {
    return globalState[_GLOBAL_HYDRATION_CONTEXT_KEY] ?? null;
  }
  return undefined;
}

let _serverContext: NavigationContext | null = null;

function _getServerContext(): NavigationContext | null {
  if (typeof window !== "undefined") {
    const hydrationContext = _getClientHydrationContext();
    return hydrationContext !== undefined ? hydrationContext : _serverContext;
  }
  const g = _getGlobalAccessors();
  return g ? g.getServerContext() : _serverContext;
}

// ─── Pages Router compat ────────────────────────────────────────────────────

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
 * Client: reads directly from the navigation snapshot or location without
 * subscribing to URL changes.
 *
 * Used by `unstable_catchError` error boundaries to avoid unnecessary re-renders.
 *
 * @internal
 */
/* oxlint-disable eslint-plugin-react-hooks/rules-of-hooks */
export function useUntrackedPathname(): string | null {
  if (isServer) {
    const ctx = _getServerContext();
    if (ctx) return ctx.pathname;
    const pagesCtx = _getPagesNavigationContext();
    return pagesCtx ? pagesCtx.pathname : "/";
  }
  const renderSnapshot = useClientNavigationRenderSnapshot();
  if (renderSnapshot) {
    return renderSnapshot.pathname;
  }
  const pagesCtx = _getPagesNavigationContext();
  if (pagesCtx) return pagesCtx.pathname;
  return getPathnameSnapshot();
}
/* oxlint-enable eslint-plugin-react-hooks/rules-of-hooks */
