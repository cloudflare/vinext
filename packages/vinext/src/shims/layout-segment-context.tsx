"use client";

/**
 * Layout segment context provider.
 *
 * Must be "use client" so that Vite's RSC bundler renders this component in
 * the SSR/browser environment where React.createContext is available. The RSC
 * entry imports and renders LayoutSegmentProvider directly, but because of the
 * "use client" boundary the actual execution happens on the SSR/client side
 * where the context can be created and consumed by useSelectedLayoutSegment(s).
 *
 * Without "use client", this runs in the RSC environment where
 * React.createContext is undefined, getLayoutSegmentContext() returns null,
 * the provider becomes a no-op, and useSelectedLayoutSegments always returns [].
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
