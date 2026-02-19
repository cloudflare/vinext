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

function _enterWith(state: RouterState): void {
  const enterWith = (_als as any).enterWith;
  if (typeof enterWith === "function") {
    try {
      enterWith.call(_als, state);
      return;
    } catch {
      // Fall through to best-effort fallback.
    }
  }
  _fallbackState.ssrContext = state.ssrContext;
}

function _getState(): RouterState {
  return _als.getStore() ?? _fallbackState;
}

// ---------------------------------------------------------------------------
// Register ALS-backed accessors into router.ts
// ---------------------------------------------------------------------------

_registerRouterStateAccessors({
  getSSRContext(): SSRContext | null {
    return _getState().ssrContext;
  },

  setSSRContext(ctx: SSRContext | null): void {
    if (ctx !== null) {
      _enterWith({ ssrContext: ctx });
      _fallbackState.ssrContext = ctx;
      return;
    }
    // Clear in both ALS store and fallback to prevent leaks.
    const state = _als.getStore();
    if (state) {
      state.ssrContext = null;
    }
    _fallbackState.ssrContext = null;
  },
});
