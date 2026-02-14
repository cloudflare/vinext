/**
 * Shim for next/dist/shared/lib/app-router-context.shared-runtime
 *
 * Used by: @clerk/nextjs, next-intl, next-nprogress-bar, nextjs-toploader,
 * next-view-transitions. Mostly type-only imports in published .d.ts files.
 *
 * We export the types and minimal context objects so these libraries resolve.
 */
import { createContext } from "react";

export interface NavigateOptions {
  scroll?: boolean;
}

export interface PrefetchOptions {
  kind?: unknown;
  onInvalidate?: () => void;
}

export interface AppRouterInstance {
  back(): void;
  forward(): void;
  refresh(): void;
  push(href: string, options?: NavigateOptions): void;
  replace(href: string, options?: NavigateOptions): void;
  prefetch(href: string, options?: PrefetchOptions): void;
}

export const AppRouterContext = createContext<AppRouterInstance | null>(null);
export const GlobalLayoutRouterContext = createContext<unknown>(null);
export const LayoutRouterContext = createContext<unknown>(null);
export const MissingSlotContext = createContext<Set<string>>(new Set());
export const TemplateContext = createContext<unknown>(null);
