/**
 * Server-only head state backed by AsyncLocalStorage.
 *
 * Provides request-scoped isolation for SSR head elements so concurrent
 * requests on Workers don't leak <Head> tags between responses.
 *
 * This module is server-only — it imports node:async_hooks and must NOT
 * be bundled for the browser.
 */

import type React from "react";
import { _registerHeadStateAccessors } from "./head.js";
import { getOrCreateAls } from "./internal/als-registry.js";
import {
  getRequestContext,
  isInsideUnifiedScope,
  runWithUnifiedStateMutation,
} from "./unified-request-context.js";

// ---------------------------------------------------------------------------
// ALS setup
// ---------------------------------------------------------------------------

export type HeadState = {
  ssrHeadChildren: React.ReactNode[];
};

const _FALLBACK_KEY = Symbol.for("vinext.head.fallback");
const _g = globalThis as unknown as Record<PropertyKey, unknown>;
const _als = getOrCreateAls<HeadState>("vinext.head.als");

const _fallbackState = (_g[_FALLBACK_KEY] ??= {
  ssrHeadChildren: [],
} satisfies HeadState) as HeadState;

function _getState(): HeadState {
  if (isInsideUnifiedScope()) {
    return getRequestContext();
  }
  return _als.getStore() ?? _fallbackState;
}

/**
 * Run a function within a head state ALS scope.
 * Ensures per-request isolation for Pages Router <Head> elements
 * on concurrent runtimes.
 */
export function runWithHeadState<T>(fn: () => Promise<T>): Promise<T>;
export function runWithHeadState<T>(fn: () => T | Promise<T>): T | Promise<T>;
export function runWithHeadState<T>(fn: () => T | Promise<T>): T | Promise<T> {
  if (isInsideUnifiedScope()) {
    return runWithUnifiedStateMutation((uCtx) => {
      uCtx.ssrHeadChildren = [];
    }, fn);
  }

  const state: HeadState = {
    ssrHeadChildren: [],
  };
  return _als.run(state, fn);
}

// ---------------------------------------------------------------------------
// Register ALS-backed accessors into head.ts
// ---------------------------------------------------------------------------

_registerHeadStateAccessors({
  getSSRHeadChildren(): React.ReactNode[] {
    return _getState().ssrHeadChildren;
  },

  resetSSRHead(): void {
    _getState().ssrHeadChildren = [];
  },
});
