import type { AppRoute } from "./app-route-graph.js";
import { matchAppRoute } from "./app-router.js";

export type VisitAppRouteModulePathsOptions = {
  includeBaseModules: boolean;
  includeSlotModules: boolean;
  includeInterceptions: boolean;
};

/**
 * Visit the filesystem modules represented by a route's runtime load plan.
 * The manifest registers lazy imports through this visitor before codegen, and
 * optimizer startup discovery consumes the same projection.
 */
export function visitAppRouteModulePaths(
  route: AppRoute,
  options: VisitAppRouteModulePathsOptions,
  visit: (filePath: string) => void,
): void {
  if (options.includeBaseModules) {
    if (route.pagePath) visit(route.pagePath);
    if (route.routePath) visit(route.routePath);
    route.layouts?.forEach(visit);
    route.templates?.forEach(visit);
    if (route.loadingPath) visit(route.loadingPath);
    if (route.errorPath) visit(route.errorPath);
    route.layoutErrorPaths?.forEach((filePath) => filePath && visit(filePath));
    route.errorPaths?.forEach(visit);
    if (route.notFoundPath) visit(route.notFoundPath);
    route.notFoundPaths?.forEach((filePath) => filePath && visit(filePath));
    if (route.forbiddenPath) visit(route.forbiddenPath);
    route.forbiddenPaths?.forEach((filePath) => filePath && visit(filePath));
    if (route.unauthorizedPath) visit(route.unauthorizedPath);
    route.unauthorizedPaths?.forEach((filePath) => filePath && visit(filePath));
  }

  if (options.includeSlotModules) {
    for (const slot of route.parallelSlots ?? []) {
      if (slot.pagePath) visit(slot.pagePath);
      if (slot.defaultPath) visit(slot.defaultPath);
      if (slot.layoutPath) visit(slot.layoutPath);
      slot.configLayoutPaths?.forEach(visit);
      if (slot.loadingPath) visit(slot.loadingPath);
      if (slot.errorPath) visit(slot.errorPath);
    }
  }

  if (!options.includeInterceptions) return;

  for (const slot of route.parallelSlots ?? []) {
    for (const interception of slot.interceptingRoutes ?? []) {
      visit(interception.pagePath);
      interception.layoutPaths.forEach(visit);
    }
  }
  for (const interception of route.siblingIntercepts ?? []) {
    visit(interception.pagePath);
    interception.layoutPaths.forEach(visit);
  }
}

/**
 * Resolve the startup route through the route matcher when the graph carries
 * its cached pattern parts. A few code-generation callers still construct the
 * older, partial route shape directly; preserve their former exact-root
 * behavior until those fixtures move to graph-built routes.
 */
export function matchAppRootRoute(routes: AppRoute[]): AppRoute | null {
  if (routes.every((route) => Array.isArray(route.patternParts))) {
    return matchAppRoute("/", routes)?.route ?? null;
  }

  return routes.find((route) => route.pattern === "/") ?? null;
}

/** Select the route whose root layout and boundaries back startup rendering. */
export function selectAppRootBoundaryRoute(
  routes: readonly AppRoute[],
  matchedRootRoute: AppRoute | null | undefined,
): AppRoute | undefined {
  return (
    matchedRootRoute ??
    routes.find((route) => route.layouts.length > 0 && route.layoutTreePositions.length > 0)
  );
}

export function getAppRootLayoutPaths(route: AppRoute | undefined): readonly string[] {
  if (!route) return [];
  if (route.pattern === "/") return route.layouts;

  const rootPosition = route.layoutTreePositions[0];
  return route.layouts.filter((_, index) => route.layoutTreePositions[index] === rootPosition);
}

export function getAppRootBoundaryPath(
  route: AppRoute | undefined,
  boundaryPaths: readonly (string | null)[] | undefined,
  fallbackPath: string | null | undefined,
): string | null {
  if (!route) return null;
  if (route.pattern === "/") return fallbackPath ?? null;
  // Boundary arrays are ordered from the root layout outward, so a fallback
  // route contributes only its root boundary rather than its leaf boundary.
  return boundaryPaths?.[0] ?? fallbackPath ?? null;
}
