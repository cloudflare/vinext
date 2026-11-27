import fs from "node:fs";
import path from "pathslash";
import type { AppRoute } from "../routing/app-router.js";
import {
  collectAppPageStaticGenerationRuntimes,
  collectAppPageStaticParamsWalkSegments,
  hasAppPageGenerateStaticParamsAtLastDynamicSegment,
  isAppPageStaticEligible,
  isEdgeRuntime,
  lastDynamicSegmentHasGenerateStaticParams,
  resolveAppPageSegmentConfig,
  resolveAppPageStaticGenerationRuntime,
} from "../server/app-segment-config.js";
import {
  extractExportConstBoolean,
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
    const dynamicParams = extractExportConstBoolean(code, "dynamicParams");
    const revalidate = extractExportConstNumber(code, "revalidate");
    const runtime = extractExportConstString(code, "runtime");
    return {
      ...(dynamic === null ? {} : { dynamic }),
      ...(dynamicParams === null ? {} : { dynamicParams }),
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
 *
 * A dynamic route whose last dynamic segment has no `generateStaticParams` is
 * "every-param" when it sets `dynamicParams = false` and its config is
 * otherwise static: it is SSG only if its generators give every
 * row every param, which only running them tells. vinext's runtime check
 * learns that per request and stores such a route only then, and never where a
 * parallel route slot exports `generateStaticParams`.
 */
export function classifyAppPageRouteStaticEligibility(
  route: AppRoute,
  readMdxEsm: ((source: string) => string) | null,
): "eligible" | "every-param" | "ineligible" | "unreadable" {
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
  const tree = {
    childrenSlot: route.childrenSlot ?? null,
    layouts,
    layoutTreePositions: route.layoutTreePositions,
    page,
    parallelBranches,
    routeSegments: route.routeSegments,
  };
  const walkSegments = collectAppPageStaticParamsWalkSegments(tree);
  const classify = (hasGenerateStaticParams: boolean) =>
    isAppPageStaticEligible({
      dynamicConfig: segmentConfig.dynamicConfig,
      hasGenerateStaticParams,
      isDynamicRoute: route.isDynamic,
      isStaticGenerationEdgeRuntime: isEdgeRuntime(
        resolveAppPageStaticGenerationRuntime(collectAppPageStaticGenerationRuntimes(tree)),
      ),
      revalidateSeconds: segmentConfig.revalidateSeconds,
    });
  if (classify(lastDynamicSegmentHasGenerateStaticParams(walkSegments))) return "eligible";
  // The runtime never stores such a route with a slot generator.
  const hasSlotGenerator = parallelBranches.some((branch) =>
    [branch.layout, ...branch.configLayouts, branch.page].some(
      (config) => config?.generateStaticParams !== undefined,
    ),
  );
  return segmentConfig.dynamicParamsConfig === false && !hasSlotGenerator && classify(true)
    ? "every-param"
    : "ineligible";
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
    // An "every-param" route is SSG only for some generator results, so its
    // prefetches stay those of a dynamic route.
    const eligibility = classifyAppPageRouteStaticEligibility(route, readMdxEsm);
    return eligibility === "ineligible" || eligibility === "every-param";
  } catch {
    return false;
  }
}

type AppRouteIntercept = AppRoute["siblingIntercepts"][number];

const INTERCEPTION_MARKER_RE = /^(?:\(\.\.\.\)|\(\.\.\)\(\.\.\)|\(\.\.\)|\(\.\))/;

/**
 * Whether Next.js renders an intercepted page on every request. Next.js builds
 * the intercepting page as its own route (`/feed/(.)photos/[id]`): the
 * layouts of every folder from `app/` down to the intercepting page, then the
 * page, with a slot intercept's owner default in the owner's children and
 * `slotDefaultPaths`, the other slots' defaults, beside it. `layoutPaths` are
 * the candidate layouts; those outside the page's folder chain are ignored. An
 * unreadable source counts as not dynamic.
 */
export function isAppInterceptRenderedDynamically(
  intercept: AppRouteIntercept,
  layoutPaths: readonly string[],
  readMdxEsm: ((source: string) => string) | null,
  slotDefaultPaths: readonly (string | null)[] = [],
): boolean {
  if (!intercept.sourcePageSegments) return false;
  // The marker isn't part of the segment: `(.)[slug]` is the dynamic `[slug]`.
  const routeSegments = intercept.sourcePageSegments.map((segment) =>
    segment.replace(INTERCEPTION_MARKER_RE, ""),
  );
  try {
    const pageDir = path.dirname(intercept.pagePath);
    // The tree position of a folder on the page's folder chain, or null.
    const treePositionOf = (dir: string) => {
      const relative = path.relative(dir, pageDir);
      if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
      return routeSegments.length - relative.split("/").filter(Boolean).length;
    };
    const layoutsByPosition = new Map<number, string>();
    for (const layoutPath of layoutPaths) {
      const position = treePositionOf(path.dirname(layoutPath));
      if (position !== null) layoutsByPosition.set(position, layoutPath);
    }
    const layoutTreePositions = [...layoutsByPosition.keys()].sort((a, b) => a - b);
    const { isUnreadable, read } = createSegmentConfigReader(readMdxEsm);
    const layouts = layoutTreePositions.map((position) => read(layoutsByPosition.get(position)));
    const page = read(intercept.pagePath);
    // A slot intercept's route renders the owner's default in its children,
    // and every other slot's default, each a `__DEFAULT__` segment beside the
    // slot at its owner's position. Next.js visits children before the other
    // slots, and the last segment's value wins, while the reducer keeps the
    // first parallel value, so the owner's default goes last. The
    // `generateStaticParams` walk orders the branches by name itself.
    const defaults: [name: string, ownerDir: string, defaultPath: string][] = [];
    for (const defaultPath of slotDefaultPaths) {
      if (!defaultPath) continue;
      const slotDir = path.dirname(defaultPath);
      defaults.push([path.basename(slotDir).slice(1), path.dirname(slotDir), defaultPath]);
    }
    if (intercept.ownerDefaultPath) {
      defaults.push(["", path.dirname(intercept.ownerDefaultPath), intercept.ownerDefaultPath]);
    }
    const parallelBranches = defaults.flatMap(([name, ownerDir, defaultPath]) => {
      const ownerTreePosition = treePositionOf(ownerDir);
      if (ownerTreePosition === null) return [];
      return [{ isDefault: true, name, ownerTreePosition, page: read(defaultPath) }];
    });
    if (isUnreadable()) return false;
    const tree = { layouts, layoutTreePositions, page, parallelBranches, routeSegments };
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
