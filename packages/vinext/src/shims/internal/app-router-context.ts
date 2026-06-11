/**
 * Shim for next/dist/shared/lib/app-router-context.shared-runtime
 *
 * Used by: @clerk/nextjs, next-intl, next-nprogress-bar, nextjs-toploader,
 * next-view-transitions. Mostly type-only imports in published .d.ts files.
 *
 * We export the types and minimal context objects so these libraries resolve.
 */
import * as React from "react";

export type NavigateOptions = {
  scroll?: boolean;
};

export type PrefetchOptions = {
  kind?: unknown;
  onInvalidate?: () => void;
};

export type AppRouterInstance = {
  bfcacheId: string;
  back(): void;
  forward(): void;
  refresh(): void;
  push(href: string, options?: NavigateOptions): void;
  replace(href: string, options?: NavigateOptions): void;
  prefetch(href: string, options?: PrefetchOptions): void;
  /**
   * Perform an experimental gesture transition navigation.
   * Only available when experimental.gestureTransition is enabled.
   */
  experimental_gesturePush?(href: string, options?: NavigateOptions): void;
};

const APP_ROUTER_CONTEXT_KEY = Symbol.for("vinext.appRouterContext");
const GLOBAL_LAYOUT_ROUTER_CONTEXT_KEY = Symbol.for("vinext.globalLayoutRouterContext");
const LAYOUT_ROUTER_CONTEXT_KEY = Symbol.for("vinext.layoutRouterContext");
const MISSING_SLOT_CONTEXT_KEY = Symbol.for("vinext.missingSlotContext");
const TEMPLATE_CONTEXT_KEY = Symbol.for("vinext.templateContext");

type AppRouterContextGlobal = typeof globalThis & {
  [APP_ROUTER_CONTEXT_KEY]?: React.Context<AppRouterInstance | null> | null;
  [GLOBAL_LAYOUT_ROUTER_CONTEXT_KEY]?: React.Context<unknown> | null;
  [LAYOUT_ROUTER_CONTEXT_KEY]?: React.Context<unknown> | null;
  [MISSING_SLOT_CONTEXT_KEY]?: React.Context<Set<string>> | null;
  [TEMPLATE_CONTEXT_KEY]?: React.Context<unknown> | null;
};

function getOrCreateContext<T>(key: symbol, defaultValue: T): React.Context<T> | null {
  if (typeof React.createContext !== "function") return null;

  // Boundary assertion: symbol-keyed global storage preserves context identity
  // across duplicate module instances while keeping the public exports typed.
  const globalState = globalThis as AppRouterContextGlobal & {
    [key]?: React.Context<T> | null;
  };
  if (!globalState[key]) {
    globalState[key] = React.createContext(defaultValue);
  }
  return globalState[key] ?? null;
}

export const AppRouterContext: React.Context<AppRouterInstance | null> | null =
  getOrCreateContext<AppRouterInstance | null>(APP_ROUTER_CONTEXT_KEY, null);
export const GlobalLayoutRouterContext: React.Context<unknown> | null = getOrCreateContext<unknown>(
  GLOBAL_LAYOUT_ROUTER_CONTEXT_KEY,
  null,
);
export const LayoutRouterContext: React.Context<unknown> | null = getOrCreateContext<unknown>(
  LAYOUT_ROUTER_CONTEXT_KEY,
  null,
);
export const MissingSlotContext: React.Context<Set<string>> | null = getOrCreateContext(
  MISSING_SLOT_CONTEXT_KEY,
  new Set(),
);
export const TemplateContext: React.Context<unknown> | null = getOrCreateContext<unknown>(
  TEMPLATE_CONTEXT_KEY,
  null,
);
