import * as React from "react";
import { stripBasePath } from "../utils/base-path.js";
import { getNavigationContext } from "./navigation-server.js";
import { AppRouterContext, type AppRouterInstance } from "./internal/app-router-context.js";
import { markPprFallbackShellDynamicBoundary } from "./ppr-fallback-shell.js";
import { toCanonicalBrowserNavigationHref } from "./url-utils.js";

const CLIENT_NAVIGATION_STATE_KEY = Symbol.for("vinext.clientNavigationState");
const CLIENT_NAVIGATION_RENDER_CONTEXT_KEY = Symbol.for("vinext.clientNavigationRenderContext");
const BASE_PATH = process.env.__NEXT_ROUTER_BASEPATH ?? "";
const TRAILING_SLASH = process.env.__VINEXT_TRAILING_SLASH === "true";

type ClientNavigationState = {
  cachedPathname: string;
  listeners: Set<() => void>;
  navigationSnapshotActiveCount: number;
};

type ClientNavigationRenderSnapshot = {
  pathname: string;
};

type ClientNavigationGlobal = typeof globalThis & {
  [CLIENT_NAVIGATION_STATE_KEY]?: ClientNavigationState;
  [CLIENT_NAVIGATION_RENDER_CONTEXT_KEY]?: React.Context<ClientNavigationRenderSnapshot | null> | null;
};

function getClientNavigationState(): ClientNavigationState | undefined {
  return (globalThis as ClientNavigationGlobal)[CLIENT_NAVIGATION_STATE_KEY];
}

function getClientPathnameSnapshot(): string {
  return (
    getClientNavigationState()?.cachedPathname ?? stripBasePath(window.location.pathname, BASE_PATH)
  );
}

function getServerPathnameSnapshot(): string {
  return getNavigationContext()?.pathname ?? "/";
}

function subscribeToCommittedPathname(listener: () => void): () => void {
  const state = getClientNavigationState();
  if (!state) return () => {};

  state.listeners.add(listener);
  return () => state.listeners.delete(listener);
}

function getClientNavigationRenderContext(): React.Context<ClientNavigationRenderSnapshot | null> {
  const globalState = globalThis as ClientNavigationGlobal;
  return (globalState[CLIENT_NAVIGATION_RENDER_CONTEXT_KEY] ??=
    React.createContext<ClientNavigationRenderSnapshot | null>(null));
}

export function useErrorBoundaryPathname(): string {
  if (typeof window === "undefined") {
    markPprFallbackShellDynamicBoundary();
  }

  const renderSnapshot = React.useContext(getClientNavigationRenderContext());
  const committedPathname = React.useSyncExternalStore(
    subscribeToCommittedPathname,
    getClientPathnameSnapshot,
    getServerPathnameSnapshot,
  );
  if (renderSnapshot && (getClientNavigationState()?.navigationSnapshotActiveCount ?? 0) > 0) {
    return renderSnapshot.pathname;
  }
  return committedPathname;
}

export function useErrorBoundaryRouter(): AppRouterInstance {
  if (!AppRouterContext || typeof React.useContext !== "function") {
    throw new Error("invariant expected app router to be mounted");
  }

  const router = React.useContext(AppRouterContext);
  if (router === null) {
    throw new Error("invariant expected app router to be mounted");
  }
  return router;
}

/**
 * Whether following a redirect() would load the URL the browser is already
 * at, which re-renders the same redirect.
 */
export function isRedirectToCurrentUrl(redirect: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    const target = new URL(
      toCanonicalBrowserNavigationHref(redirect, window.location.href, BASE_PATH, TRAILING_SLASH),
      window.location.href,
    );
    return target.href === window.location.href;
  } catch {
    return false;
  }
}
