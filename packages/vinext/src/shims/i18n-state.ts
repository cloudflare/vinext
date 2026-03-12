/**
 * Server-only i18n state backed by AsyncLocalStorage.
 *
 * Provides request-scoped isolation for i18n context (locale,
 * defaultLocale, domainLocales, hostname) so concurrent requests
 * on Workers or Node.js don't share mutable locale state.
 *
 * This module is server-only — it imports node:async_hooks and must NOT
 * be bundled for the browser.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { _registerI18nStateAccessors, type I18nContext } from "./i18n-context.js";

// ---------------------------------------------------------------------------
// ALS setup
// ---------------------------------------------------------------------------

interface I18nState {
  context: I18nContext | null;
}

const _ALS_KEY = Symbol.for("vinext.i18n.als");
const _FALLBACK_KEY = Symbol.for("vinext.i18n.fallback");
const _g = globalThis as unknown as Record<PropertyKey, unknown>;
const _als = (_g[_ALS_KEY] ??= new AsyncLocalStorage<I18nState>()) as AsyncLocalStorage<I18nState>;

const _fallbackState = (_g[_FALLBACK_KEY] ??= {
  context: null,
} satisfies I18nState) as I18nState;

function _getState(): I18nState {
  return _als.getStore() ?? _fallbackState;
}

/**
 * Run a function within an i18n state ALS scope.
 * Ensures per-request isolation for i18n context on concurrent runtimes.
 */
export function runWithI18nState<T>(fn: () => T | Promise<T>): T | Promise<T> {
  const state: I18nState = {
    context: null,
  };
  return _als.run(state, fn);
}

// ---------------------------------------------------------------------------
// Register ALS-backed accessors into i18n-context.ts
// ---------------------------------------------------------------------------

_registerI18nStateAccessors({
  getI18nContext(): I18nContext | null {
    return _getState().context;
  },

  setI18nContext(ctx: I18nContext | null): void {
    const state = _als.getStore();
    if (state) {
      state.context = ctx;
    } else {
      // No ALS scope — fallback for environments without als.run() wrapping.
      _fallbackState.context = ctx;
    }
  },
});
