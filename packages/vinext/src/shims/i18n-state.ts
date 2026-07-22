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

import { _registerI18nStateAccessors, type I18nContext } from "./i18n-context.js";
import { getOrCreateAls } from "./internal/als-registry.js";
import {
  getRequestContext,
  isInsideUnifiedScope,
  runWithUnifiedStateMutation,
} from "./unified-request-context.js";

// ---------------------------------------------------------------------------
// ALS setup
// ---------------------------------------------------------------------------

export type I18nState = {
  i18nContext: I18nContext | null;
};

const _FALLBACK_KEY = Symbol.for("vinext.i18n.fallback");
const _g = globalThis as unknown as Record<PropertyKey, unknown>;
const _als = getOrCreateAls<I18nState>("vinext.i18n.als");

const _fallbackState = (_g[_FALLBACK_KEY] ??= {
  i18nContext: null,
} satisfies I18nState) as I18nState;

function _getState(): I18nState {
  if (isInsideUnifiedScope()) {
    return getRequestContext();
  }
  return _als.getStore() ?? _fallbackState;
}

/**
 * Run a function within an i18n state ALS scope.
 * Ensures per-request isolation for i18n context on concurrent runtimes.
 */
export function runWithI18nState<T>(fn: () => Promise<T>): Promise<T>;
export function runWithI18nState<T>(fn: () => T | Promise<T>): T | Promise<T>;
export function runWithI18nState<T>(fn: () => T | Promise<T>): T | Promise<T> {
  if (isInsideUnifiedScope()) {
    return runWithUnifiedStateMutation((uCtx) => {
      uCtx.i18nContext = null;
    }, fn);
  }

  const state: I18nState = {
    i18nContext: null,
  };
  return _als.run(state, fn);
}

// ---------------------------------------------------------------------------
// Register ALS-backed accessors into i18n-context.ts
// ---------------------------------------------------------------------------

_registerI18nStateAccessors({
  getI18nContext(): I18nContext | null {
    return _getState().i18nContext;
  },

  setI18nContext(ctx: I18nContext | null): void {
    _getState().i18nContext = ctx;
  },
});
