/**
 * Server-only Pages Router state backed by AsyncLocalStorage.
 *
 * Provides request-scoped isolation for SSR context (pathname, query,
 * locale) so concurrent requests on Workers don't share state.
 *
 * This module is server-only — it imports node:async_hooks and must NOT
 * be bundled for the browser.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { _registerRouterStateAccessors } from "./router.js";

// ---------------------------------------------------------------------------
// ALS setup
// ---------------------------------------------------------------------------

interface SSRContext {
  pathname: string;
  query: Record<string, string | string[]>;
  asPath: string;
  locale?: string;
  locales?: string[];
  defaultLocale?: string;
}

interface RouterState {
  ssrContext: SSRContext | null;
}

const _ALS_KEY = Symbol.for("vinext.router.als");
const _FALLBACK_KEY = Symbol.for("vinext.router.fallback");
const _g = globalThis as unknown as Record<PropertyKey, unknown>;
const _als = (_g[_ALS_KEY] ??= new AsyncLocalStorage<RouterState>()) as AsyncLocalStorage<RouterState>;

const _fallbackState = (_g[_FALLBACK_KEY] ??= {
  ssrContext: null,
} satisfies RouterState) as RouterState;

function _getState(): RouterState {
  return _als.getStore() ?? _fallbackState;
}

/**
 * Run a function within a router state ALS scope.
 * Ensures per-request isolation for Pages Router SSR context
 * on concurrent runtimes.
 */
export function runWithRouterState<T>(fn: () => T | Promise<T>): T | Promise<T> {
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
    const state = _als.getStore();
    if (state) {
      state.ssrContext = ctx;
    } else {
      // No ALS scope — fallback for environments without als.run() wrapping.
      _fallbackState.ssrContext = ctx;
    }
  },
});
