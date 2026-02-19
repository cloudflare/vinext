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

function _enterWith(state: NavigationState): void {
  const enterWith = (_als as any).enterWith;
  if (typeof enterWith === "function") {
    try {
      enterWith.call(_als, state);
      return;
    } catch {
      // Fall through to best-effort fallback.
    }
  }
  _fallbackState.serverContext = state.serverContext;
  _fallbackState.serverInsertedHTMLCallbacks = state.serverInsertedHTMLCallbacks;
}

function _getState(): NavigationState {
  return _als.getStore() ?? _fallbackState;
}

// ---------------------------------------------------------------------------
// Register ALS-backed accessors into navigation.ts
// ---------------------------------------------------------------------------

_registerStateAccessors({
  getServerContext(): NavigationContext | null {
    return _getState().serverContext;
  },

  setServerContext(ctx: NavigationContext | null): void {
    if (ctx !== null) {
      const existing = _als.getStore();
      _enterWith({
        serverContext: ctx,
        serverInsertedHTMLCallbacks: existing?.serverInsertedHTMLCallbacks
          ?? _fallbackState.serverInsertedHTMLCallbacks
          ?? [],
      });
      _fallbackState.serverContext = ctx;
      return;
    }
    // Cleanup: clear context in both ALS store and fallback to prevent leaks.
    const state = _als.getStore();
    if (state) {
      state.serverContext = null;
    }
    _fallbackState.serverContext = null;
  },

  getInsertedHTMLCallbacks(): Array<() => unknown> {
    return _getState().serverInsertedHTMLCallbacks;
  },

  clearInsertedHTMLCallbacks(): void {
    const state = _als.getStore();
    if (state) {
      state.serverInsertedHTMLCallbacks = [];
    }
    _fallbackState.serverInsertedHTMLCallbacks = [];
  },
});
