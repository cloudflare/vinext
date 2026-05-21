import type { AppRoute } from "../routing/app-router.js";

type RouteModuleFilesOptions = {
  includeRouteHandler?: boolean;
};

// Ordering is not cascade-sensitive here; these files are registered as route
// modules, unlike client-visible asset collection below.
export function collectAppRouteModuleFiles(
  route: AppRoute,
  options: RouteModuleFilesOptions = {},
): string[] {
  const files = [
    route.pagePath,
    options.includeRouteHandler ? route.routePath : null,
    ...route.layouts,
    ...route.templates,
    route.loadingPath,
    route.errorPath,
    ...route.layoutErrorPaths,
    ...(route.errorPaths ?? []),
    route.notFoundPath,
    ...route.notFoundPaths,
    route.forbiddenPath,
    ...route.forbiddenPaths,
    route.unauthorizedPath,
    ...route.unauthorizedPaths,
    ...route.parallelSlots.flatMap((slot) => [
      slot.pagePath,
      slot.defaultPath,
      slot.layoutPath,
      slot.loadingPath,
      slot.errorPath,
      ...slot.interceptingRoutes.flatMap((intercept) => [
        intercept.pagePath,
        ...intercept.layoutPaths,
      ]),
    ]),
  ];

  return files.filter((filePath): filePath is string => typeof filePath === "string");
}

/**
 * Collect modules that can contribute client-visible route assets. Route
 * handlers are excluded because they do not render UI, and layouts are listed
 * before pages so CSS follows the route tree's cascade order.
 */
export function collectAppRouteAssetModuleFiles(route: AppRoute): string[] {
  const files = [
    ...route.layouts,
    ...route.templates,
    route.loadingPath,
    route.errorPath,
    ...route.layoutErrorPaths,
    ...(route.errorPaths ?? []),
    route.notFoundPath,
    ...route.notFoundPaths,
    route.forbiddenPath,
    ...route.forbiddenPaths,
    route.unauthorizedPath,
    ...route.unauthorizedPaths,
    route.pagePath,
    ...route.parallelSlots.flatMap((slot) => [
      slot.layoutPath,
      slot.loadingPath,
      slot.errorPath,
      slot.defaultPath,
      slot.pagePath,
      ...slot.interceptingRoutes.flatMap((intercept) => [
        ...intercept.layoutPaths,
        intercept.pagePath,
      ]),
    ]),
  ];

  return files.filter((filePath): filePath is string => typeof filePath === "string");
}
