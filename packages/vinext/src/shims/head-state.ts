/**
 * Server-only head state backed by AsyncLocalStorage.
 *
 * Provides request-scoped isolation for SSR head elements so concurrent
 * requests on Workers don't leak <Head> tags between responses.
 *
 * This module is server-only — it imports node:async_hooks and must NOT
 * be bundled for the browser.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { _registerHeadStateAccessors } from "./head.js";

// ---------------------------------------------------------------------------
// ALS setup
// ---------------------------------------------------------------------------

interface HeadState {
  ssrHeadElements: string[];
}

const _ALS_KEY = Symbol.for("vinext.head.als");
const _FALLBACK_KEY = Symbol.for("vinext.head.fallback");
const _g = globalThis as unknown as Record<PropertyKey, unknown>;
const _als = (_g[_ALS_KEY] ??= new AsyncLocalStorage<HeadState>()) as AsyncLocalStorage<HeadState>;

const _fallbackState = (_g[_FALLBACK_KEY] ??= {
  ssrHeadElements: [],
} satisfies HeadState) as HeadState;

function _getState(): HeadState {
  return _als.getStore() ?? _fallbackState;
}

/**
 * Run a function within a head state ALS scope.
 * Ensures per-request isolation for Pages Router <Head> elements
 * on concurrent runtimes.
 */
export function runWithHeadState<T>(fn: () => T | Promise<T>): T | Promise<T> {
  const state: HeadState = {
    ssrHeadElements: [],
  };
  return _als.run(state, fn);
}

// ---------------------------------------------------------------------------
// Register ALS-backed accessors into head.ts
// ---------------------------------------------------------------------------

_registerHeadStateAccessors({
  getSSRHeadElements(): string[] {
    return _getState().ssrHeadElements;
  },

  resetSSRHead(): void {
    const state = _als.getStore();
    if (state) {
      state.ssrHeadElements = [];
    } else {
      _fallbackState.ssrHeadElements = [];
    }
  },
});
