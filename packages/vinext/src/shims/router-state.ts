/**
 * Server-only Pages Router state backed by AsyncLocalStorage.
 *
 * Provides request-scoped isolation for SSR context (pathname, query,
 * locale) so concurrent requests on Workers don't share state.
 *
 * This module is server-only — it imports node:async_hooks and must NOT
 * be bundled for the browser.
 */

import { _registerRouterStateAccessors } from "./router.js";
import { getOrCreateAls } from "./internal/als-registry.js";
import {
  getRequestContext,
  isInsideUnifiedScope,
  runWithUnifiedStateMutation,
} from "./unified-request-context.js";

// ---------------------------------------------------------------------------
// ALS setup
// ---------------------------------------------------------------------------

export type SSRContext = {
  pathname: string;
  query: Record<string, string | string[]>;
  asPath: string;
  locale?: string;
  locales?: string[];
  defaultLocale?: string;
};

export type RouterState = {
  ssrContext: SSRContext | null;
};

const _FALLBACK_KEY = Symbol.for("vinext.router.fallback");
const _g = globalThis as unknown as Record<PropertyKey, unknown>;
const _als = getOrCreateAls<RouterState>("vinext.router.als");

const _fallbackState = (_g[_FALLBACK_KEY] ??= {
  ssrContext: null,
} satisfies RouterState) as RouterState;

function _getState(): RouterState {
  if (isInsideUnifiedScope()) {
    return getRequestContext();
  }
  return _als.getStore() ?? _fallbackState;
}

/**
 * Run a function within a router state ALS scope.
 * Ensures per-request isolation for Pages Router SSR context
 * on concurrent runtimes.
 */
export function runWithRouterState<T>(fn: () => Promise<T>): Promise<T>;
export function runWithRouterState<T>(fn: () => T | Promise<T>): T | Promise<T>;
export function runWithRouterState<T>(fn: () => T | Promise<T>): T | Promise<T> {
  if (isInsideUnifiedScope()) {
    return runWithUnifiedStateMutation((uCtx) => {
      uCtx.ssrContext = null;
    }, fn);
  }

  const state: RouterState = {
    ssrContext: null,
  };
  return _als.run(state, fn);
}

// ---------------------------------------------------------------------------
// Register ALS-backed accessors into router.ts
// ---------------------------------------------------------------------------

_registerRouterStateAccessors({
  getSSRContext(): SSRContext | null {
    return _getState().ssrContext;
  },

  setSSRContext(ctx: SSRContext | null): void {
    _getState().ssrContext = ctx;
  },
});
