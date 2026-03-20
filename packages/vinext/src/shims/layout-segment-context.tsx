"use client";

/**
 * Layout segment context provider.
 *
 * This is a "use client" module because it needs React's createContext
 * and useContext, which are NOT available in the react-server condition.
 * The RSC entry renders this as a client component boundary.
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
