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
import { createElement, useEffect, useRef, type ReactNode } from "react";
import { getLayoutSegmentContext, type SegmentMap } from "./navigation-server.js";

const committedSegmentMapsByProviderId = new Map<string, SegmentMap>();

export function mergeLayoutSegmentMap(previous: SegmentMap | null, next: SegmentMap): SegmentMap {
  if (!previous) return next;
  return { ...previous, ...next };
}

/**
 * Wraps children with the layout segment context.
 *
 * Each layout in the App Router tree wraps its children with this provider,
 * passing a map of parallel route key to segment path. The "children" key is
 * always present (the default parallel route). Named parallel slots at this
 * layout level add their own keys.
 *
 * Components inside the provider call useSelectedLayoutSegments(parallelRoutesKey)
 * to read the segments for a specific parallel route.
 */
export function LayoutSegmentProvider({
  providerId,
  segmentMap,
  children,
}: {
  providerId?: string;
  segmentMap: SegmentMap;
  children: ReactNode;
}) {
  const previousSegmentMap = useRef<SegmentMap | null>(null);
  const ctx = getLayoutSegmentContext();
  const previousSegmentMapForProvider =
    previousSegmentMap.current ??
    (providerId ? (committedSegmentMapsByProviderId.get(providerId) ?? null) : null);
  const mergedSegmentMap = mergeLayoutSegmentMap(previousSegmentMapForProvider, segmentMap);
  useEffect(() => {
    previousSegmentMap.current = mergedSegmentMap;
    if (providerId) {
      committedSegmentMapsByProviderId.set(providerId, mergedSegmentMap);
    }
  }, [mergedSegmentMap, providerId]);
  if (!ctx) {
    // No context available — expected only in RSC environment, not SSR/browser.
    return children;
  }
  return createElement(ctx.Provider, { value: mergedSegmentMap }, children);
}
