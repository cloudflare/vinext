import fs from "node:fs";
import type { AppRoute } from "../routing/app-router.js";
import {
  collectAppPageStaticGenerationRuntimes,
  hasAppPageGenerateStaticParamsAtLastDynamicSegment,
  isAppPageStaticEligible,
  isEdgeRuntime,
  resolveAppPageSegmentConfig,
  resolveAppPageStaticGenerationRuntime,
} from "../server/app-segment-config.js";
import {
  extractExportConstNumber,
  extractExportConstString,
  hasRuntimeExportedName,
} from "./report.js";

/**
 * Whether Next.js classifies an App page route as static or SSG, read from its
 * layout, page and parallel-slot sources with the helpers dispatch applies to
 * the loaded modules. Only such a route has listed paths.
 *
 * An MDX source read without the MDX parser has unknown exports, so its route
 * is "unreadable". Its paths are still listed: the built runtime reads the real
 * exports and never stores a route that isn't static, while an unlisted path's
 * render failure would be dropped instead of failing. But no probe renders an
 * unreadable route's fallback, so it never certifies one.
 */
export function classifyAppPageRouteStaticEligibility(
  route: AppRoute,
  readMdxEsm: ((source: string) => string) | null,
): "eligible" | "ineligible" | "unreadable" {
  let unreadable = false;
  const readSegmentConfig = (filePath: string | null | undefined) => {
    if (!filePath) return null;
    let code = fs.readFileSync(filePath, "utf8");
    if (filePath.toLowerCase().endsWith(".mdx")) {
      let esm: string | null = null;
      try {
        esm = readMdxEsm?.(code) ?? null;
      } catch {
        // A source MDX can't parse can't build either.
      }
      unreadable ||= esm === null;
      code = esm ?? "";
    }
    const dynamic = extractExportConstString(code, "dynamic");
    const revalidate = extractExportConstNumber(code, "revalidate");
    const runtime = extractExportConstString(code, "runtime");
    return {
      ...(dynamic === null ? {} : { dynamic }),
      ...(hasRuntimeExportedName(code, "generateStaticParams")
        ? { generateStaticParams() {} }
        : {}),
      ...(revalidate === null ? {} : { revalidate }),
      ...(runtime === null ? {} : { runtime }),
    };
  };
  const layouts = route.layouts.map(readSegmentConfig);
  const page = readSegmentConfig(route.pagePath);
  const parallelBranches = route.parallelSlots.map((slot) => ({
    configLayouts: (slot.configLayoutPaths ?? []).map(readSegmentConfig),
    configLayoutTreePositions: slot.configLayoutTreePositions ?? [],
    isDefault: !slot.pagePath,
    layout: readSegmentConfig(slot.layoutPath),
    name: slot.name,
    ownerTreePosition: slot.ownerTreePosition ?? null,
    page: readSegmentConfig(slot.pagePath ?? slot.defaultPath),
    routeSegments: slot.routeSegments,
  }));
  if (unreadable) return "unreadable";
  const segmentConfig = resolveAppPageSegmentConfig({
    layouts,
    layoutTreePositions: route.layoutTreePositions,
    page,
    parallelBranches,
    routeSegments: route.routeSegments,
  });
  const eligible = isAppPageStaticEligible({
    dynamicConfig: segmentConfig.dynamicConfig,
    hasGenerateStaticParams: hasAppPageGenerateStaticParamsAtLastDynamicSegment({
      childrenSlot: route.childrenSlot ?? null,
      layouts,
      layoutTreePositions: route.layoutTreePositions,
      page,
      parallelBranches,
      routeSegments: route.routeSegments,
    }),
    isDynamicRoute: route.isDynamic,
    isStaticGenerationEdgeRuntime: isEdgeRuntime(
      resolveAppPageStaticGenerationRuntime(
        collectAppPageStaticGenerationRuntimes({
          childrenSlot: route.childrenSlot ?? null,
          layouts,
          layoutTreePositions: route.layoutTreePositions,
          page,
          parallelBranches,
          routeSegments: route.routeSegments,
        }),
      ),
    ),
    revalidateSeconds: segmentConfig.revalidateSeconds,
  });
  return eligible ? "eligible" : "ineligible";
}
