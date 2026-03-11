/**
 * Layout segment context provider.
 *
 * Does NOT use "use client" — this module is imported directly by the RSC
 * entry which runs in the react-server condition. getLayoutSegmentContext()
 * returns null when React.createContext is unavailable (RSC), and the
 * provider gracefully falls back to passing children through unchanged.
 *
 * The context is shared with navigation.ts via getLayoutSegmentContext()
 * to avoid creating separate contexts in different modules.
 */
import { createElement, type ReactNode } from "react";
import { getLayoutSegmentContext } from "./navigation.js";

/**
 * Wraps children with the layout segment context.
 * Each layout in the App Router tree wraps its children with this provider,
 * passing the remaining route tree segments below that layout level.
 * Segments include route groups and resolved dynamic param values.
 */
export function LayoutSegmentProvider({
  childSegments,
  children,
}: {
  childSegments: string[];
  children: ReactNode;
}) {
  const ctx = getLayoutSegmentContext();
  if (!ctx) {
    // Fallback: no context available (shouldn't happen in SSR/Browser)
    return children as any;
  }
  return createElement(ctx.Provider, { value: childSegments }, children);
}
