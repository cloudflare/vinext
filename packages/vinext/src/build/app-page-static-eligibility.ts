import fs from "node:fs";
import path from "pathslash";
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
 * Read the segment config exports of App layout and page sources. A source MDX
 * without the MDX parser leaves the reader "unreadable".
 */
function createSegmentConfigReader(readMdxEsm: ((source: string) => string) | null) {
  let unreadable = false;
  const read = (filePath: string | null | undefined) => {
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
  return { isUnreadable: () => unreadable, read };
}

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
  const { isUnreadable, read: readSegmentConfig } = createSegmentConfigReader(readMdxEsm);
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
  if (isUnreadable()) return "unreadable";
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

/**
 * Whether the route's segment config rules out static generation, so Next.js
 * renders it on every request. An "unreadable" route or a source that can't be
 * read counts as not dynamic.
 */
export function isAppPageRouteRenderedDynamically(
  route: AppRoute,
  readMdxEsm: ((source: string) => string) | null,
): boolean {
  try {
    return classifyAppPageRouteStaticEligibility(route, readMdxEsm) === "ineligible";
  } catch {
    return false;
  }
}

type AppRouteIntercept = AppRoute["siblingIntercepts"][number];

/**
 * Whether Next.js renders an intercepted page on every request. Next.js builds
 * the intercepting page as its own route (`/feed/(.)photos/[id]`): the
 * layouts of every folder from `app/` down to the intercepting page, then the
 * page. `layoutPaths` are the candidate layouts; those outside the page's
 * folder chain are ignored. An unreadable source counts as not dynamic.
 */
export function isAppInterceptRenderedDynamically(
  intercept: AppRouteIntercept,
  layoutPaths: readonly string[],
  readMdxEsm: ((source: string) => string) | null,
): boolean {
  const routeSegments = intercept.sourcePageSegments;
  if (!routeSegments) return false;
  try {
    const pageDir = path.dirname(intercept.pagePath);
    const layoutsByPosition = new Map<number, string>();
    for (const layoutPath of layoutPaths) {
      const relative = path.relative(path.dirname(layoutPath), pageDir);
      if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
      const depthBelowLayout = relative.split("/").filter(Boolean).length;
      layoutsByPosition.set(routeSegments.length - depthBelowLayout, layoutPath);
    }
    const layoutTreePositions = [...layoutsByPosition.keys()].sort((a, b) => a - b);
    const { isUnreadable, read } = createSegmentConfigReader(readMdxEsm);
    const layouts = layoutTreePositions.map((position) => read(layoutsByPosition.get(position)));
    const page = read(intercept.pagePath);
    if (isUnreadable()) return false;
    const tree = { layouts, layoutTreePositions, page, routeSegments };
    const segmentConfig = resolveAppPageSegmentConfig(tree);
    return !isAppPageStaticEligible({
      dynamicConfig: segmentConfig.dynamicConfig,
      hasGenerateStaticParams: hasAppPageGenerateStaticParamsAtLastDynamicSegment(tree),
      isDynamicRoute: routeSegments.some(
        (segment) => segment.startsWith("[") && segment.endsWith("]"),
      ),
      isStaticGenerationEdgeRuntime: isEdgeRuntime(
        resolveAppPageStaticGenerationRuntime(collectAppPageStaticGenerationRuntimes(tree)),
      ),
      revalidateSeconds: segmentConfig.revalidateSeconds,
    });
  } catch {
    return false;
  }
}
