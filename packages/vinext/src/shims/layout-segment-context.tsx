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
import { getLayoutSegmentContext } from "next/navigation";

/**
 * Wraps children with the layout segment depth context.
 * Each layout in the App Router tree wraps its children with this provider,
 * passing the number of URL segments consumed up to that layout's level.
 */
export function LayoutSegmentProvider({
  depth,
  children,
}: {
  depth: number;
  children: ReactNode;
}) {
  const ctx = getLayoutSegmentContext();
  if (!ctx) {
    // Fallback: no context available (shouldn't happen in SSR/Browser)
    return children as any;
  }
  return createElement(ctx.Provider, { value: depth }, children);
}
