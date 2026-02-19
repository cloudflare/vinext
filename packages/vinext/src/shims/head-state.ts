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

function _enterWith(state: HeadState): void {
  const enterWith = (_als as any).enterWith;
  if (typeof enterWith === "function") {
    try {
      enterWith.call(_als, state);
      return;
    } catch {
      // Fall through to best-effort fallback.
    }
  }
  _fallbackState.ssrHeadElements = state.ssrHeadElements;
}

function _getState(): HeadState {
  return _als.getStore() ?? _fallbackState;
}

// ---------------------------------------------------------------------------
// Register ALS-backed accessors into head.ts
// ---------------------------------------------------------------------------

_registerHeadStateAccessors({
  getSSRHeadElements(): string[] {
    return _getState().ssrHeadElements;
  },

  resetSSRHead(): void {
    _enterWith({ ssrHeadElements: [] });
    _fallbackState.ssrHeadElements = [];
  },
});
