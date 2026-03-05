/**
 * Server-only navigation state backed by AsyncLocalStorage.
 *
 * This module provides request-scoped isolation for navigation context
 * and useServerInsertedHTML callbacks. Without ALS, concurrent requests
 * on Cloudflare Workers would share module-level state and leak data
 * (pathnames, params, CSS-in-JS styles) between requests.
 *
 * This module is server-only — it imports node:async_hooks and must NOT
 * be bundled for the browser. The dual-environment navigation.ts shim
 * uses a registration pattern so it works in both environments.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import {
  _registerStateAccessors,
  type NavigationContext,
} from "./navigation.js";

// ---------------------------------------------------------------------------
// ALS setup — same pattern as headers.ts
// ---------------------------------------------------------------------------

interface NavigationState {
  serverContext: NavigationContext | null;
  serverInsertedHTMLCallbacks: Array<() => unknown>;
}

const _ALS_KEY = Symbol.for("vinext.navigation.als");
const _FALLBACK_KEY = Symbol.for("vinext.navigation.fallback");
const _g = globalThis as unknown as Record<PropertyKey, unknown>;
const _als = (_g[_ALS_KEY] ??= new AsyncLocalStorage<NavigationState>()) as AsyncLocalStorage<NavigationState>;

const _fallbackState = (_g[_FALLBACK_KEY] ??= {
  serverContext: null,
  serverInsertedHTMLCallbacks: [],
} satisfies NavigationState) as NavigationState;

function _getState(): NavigationState {
  return _als.getStore() ?? _fallbackState;
}

/**
 * Run a function within a navigation ALS scope.
 * Ensures per-request isolation for navigation context and
 * useServerInsertedHTML callbacks on concurrent runtimes.
 */
export function runWithNavigationContext<T>(fn: () => T | Promise<T>): T | Promise<T> {
  const state: NavigationState = {
    serverContext: null,
    serverInsertedHTMLCallbacks: [],
  };
  return _als.run(state, fn);
}

// ---------------------------------------------------------------------------
// Register ALS-backed accessors into navigation.ts
// ---------------------------------------------------------------------------

_registerStateAccessors({
  getServerContext(): NavigationContext | null {
    return _getState().serverContext;
  },

  setServerContext(ctx: NavigationContext | null): void {
    const state = _als.getStore();
    if (state) {
      state.serverContext = ctx;
    } else {
      // No ALS scope — fallback for environments without als.run() wrapping.
      _fallbackState.serverContext = ctx;
    }
  },

  getInsertedHTMLCallbacks(): Array<() => unknown> {
    return _getState().serverInsertedHTMLCallbacks;
  },

  clearInsertedHTMLCallbacks(): void {
    const state = _als.getStore();
    if (state) {
      state.serverInsertedHTMLCallbacks = [];
    } else {
      _fallbackState.serverInsertedHTMLCallbacks = [];
    }
  },
});
