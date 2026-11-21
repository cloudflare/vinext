import type { MetadataFileRoute } from "./metadata-routes.js";

function routeSegmentsApply(
  routeSegments: readonly string[],
  routePrefixSegments: readonly string[],
): boolean {
  if (routePrefixSegments.length > routeSegments.length) {
    return false;
  }

  for (let index = 0; index < routePrefixSegments.length; index++) {
    if (routeSegments[index] !== routePrefixSegments[index]) {
      return false;
    }
  }

  return true;
}

function removeParallelRouteSegments(routeSegments: readonly string[]): string[] {
  return routeSegments.filter((segment) => !segment.startsWith("@"));
}

export function routeSegmentsApplyWithParallelSlots(
  routeSegments: readonly string[],
  routePrefixSegments: readonly string[],
): boolean {
  if (routeSegmentsApply(routeSegments, routePrefixSegments)) {
    return true;
  }

  const visiblePrefixSegments = removeParallelRouteSegments(routePrefixSegments);
  return (
    visiblePrefixSegments.length !== routePrefixSegments.length &&
    routeSegmentsApply(routeSegments, visiblePrefixSegments)
  );
}

/**
 * The metadata files of the segments along `routeSegments` itself: a parallel
 * slot's files apply only when that slot is on the branch. One whose segments
 * aren't known applies wherever its prefix does.
 */
export function filterMetadataRoutesForSegments(
  metadataRoutes: readonly MetadataFileRoute[],
  routeSegments: readonly string[],
): MetadataFileRoute[] {
  return metadataRoutes.filter(
    (route) => !route.routeSegments || routeSegmentsApply(routeSegments, route.routeSegments),
  );
}
