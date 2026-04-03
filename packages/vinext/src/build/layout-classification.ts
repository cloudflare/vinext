/**
 * Layout classification — determines whether each layout in an App Router
 * route tree is static or dynamic via two complementary detection layers:
 *
 *   Layer 1: Segment config (`export const dynamic`, `export const revalidate`)
 *   Layer 2: Module graph traversal (checks for transitive dynamic shim imports)
 *
 * Layer 3 (probe-based runtime detection) is handled separately in
 * `app-page-execution.ts` at request time.
 */

import { classifyLayoutSegmentConfig } from "./report.js";
import { createAppPageTreePath } from "../server/app-page-route-wiring.js";

export type ModuleGraphClassification = "static" | "needs-probe";
export type LayoutClassificationResult = "static" | "dynamic" | "needs-probe";

export type ModuleInfoProvider = {
  getModuleInfo(id: string): {
    importedIds: string[];
    dynamicImportedIds: string[];
  } | null;
};

type RouteForClassification = {
  layouts: string[];
  layoutTreePositions: number[];
  routeSegments: string[];
  layoutSegmentConfigs?: ReadonlyArray<{ code: string } | null>;
};

/**
 * BFS traversal of a layout's dependency tree. If any transitive import
 * resolves to a dynamic shim path (headers, cache, server), the layout
 * cannot be proven static at build time and needs a runtime probe.
 */
export function classifyLayoutByModuleGraph(
  layoutModuleId: string,
  dynamicShimPaths: ReadonlySet<string>,
  moduleInfo: ModuleInfoProvider,
): ModuleGraphClassification {
  const visited = new Set<string>();
  const queue: string[] = [layoutModuleId];
  let head = 0;

  while (head < queue.length) {
    const currentId = queue[head++]!;

    if (visited.has(currentId)) continue;
    visited.add(currentId);

    if (dynamicShimPaths.has(currentId)) return "needs-probe";

    const info = moduleInfo.getModuleInfo(currentId);
    if (!info) continue;

    for (const importedId of info.importedIds) {
      if (!visited.has(importedId)) queue.push(importedId);
    }
    for (const dynamicId of info.dynamicImportedIds) {
      if (!visited.has(dynamicId)) queue.push(dynamicId);
    }
  }

  return "static";
}

/**
 * Classifies all layouts across all routes using a two-layer strategy:
 *
 * 1. Segment config (Layer 1) — short-circuits to "static" or "dynamic"
 * 2. Module graph (Layer 2) — BFS for dynamic shim imports → "static" or "needs-probe"
 *
 * Shared layouts (same file appearing in multiple routes) are classified once
 * and deduplicated by layout ID.
 */
export function classifyAllRouteLayouts(
  routes: readonly RouteForClassification[],
  dynamicShimPaths: ReadonlySet<string>,
  moduleInfo: ModuleInfoProvider,
): Map<string, LayoutClassificationResult> {
  const result = new Map<string, LayoutClassificationResult>();

  for (const route of routes) {
    for (let i = 0; i < route.layouts.length; i++) {
      const treePosition = route.layoutTreePositions[i] ?? 0;
      const layoutId = `layout:${createAppPageTreePath(route.routeSegments, treePosition)}`;

      if (result.has(layoutId)) continue;

      // Layer 1: segment config
      const segmentConfig = route.layoutSegmentConfigs?.[i];
      if (segmentConfig) {
        const configResult = classifyLayoutSegmentConfig(segmentConfig.code);
        if (configResult !== null) {
          result.set(layoutId, configResult);
          continue;
        }
      }

      // Layer 2: module graph
      const graphResult = classifyLayoutByModuleGraph(
        route.layouts[i],
        dynamicShimPaths,
        moduleInfo,
      );
      result.set(layoutId, graphResult);
    }
  }

  return result;
}
