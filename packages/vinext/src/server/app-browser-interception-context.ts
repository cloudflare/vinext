import type { RouteManifest } from "../routing/app-route-graph.js";
import {
  matchRoutePattern,
  matchRoutePatternPrefix,
  matchRoutePatternWithOptionalDynamicSegments,
} from "../routing/route-pattern.js";
import { splitPathnameForRouteMatch } from "../routing/utils.js";
import { stripBasePath } from "../utils/base-path.js";

type ResolveManifestNavigationInterceptionContextOptions = {
  basePath: string;
  currentMatchedPathname?: string | null;
  currentPathname: string;
  routeManifest: RouteManifest | null;
  targetPathname: string;
};

/**
 * Resolve the first-hop interception context from declared route topology.
 *
 * This is intentionally manifest-only: it lets a normal browser navigation
 * ask the server for an intercepted payload when the current URL is a declared
 * interception source for the target URL, without reintroducing snapshot
 * topology as route/layout/slot authority.
 *
 * When multiple manifest interceptions match, the first one wins. That order
 * is owned by the deterministic route graph builder.
 */
export function resolveManifestNavigationInterceptionContext(
  options: ResolveManifestNavigationInterceptionContextOptions,
): string | null {
  if (options.routeManifest === null) return null;

  const currentPathname = stripBasePath(options.currentPathname, options.basePath);
  const targetPathname = stripBasePath(options.targetPathname, options.basePath);
  const sourceParts = splitPathnameForRouteMatch(currentPathname);
  const targetParts = splitPathnameForRouteMatch(targetPathname);

  for (const interception of options.routeManifest.segmentGraph.interceptions.values()) {
    if (!matchRoutePatternPrefix(sourceParts, interception.sourcePatternParts)) continue;
    if (matchRoutePattern(targetParts, interception.targetPatternParts) === null) continue;
    return currentPathname;
  }

  return null;
}

export function resolveMiddlewareRewriteNavigationInterceptionContext(
  options: ResolveManifestNavigationInterceptionContextOptions,
): string | null {
  if (options.routeManifest === null) return null;

  const currentPathname = stripBasePath(options.currentPathname, options.basePath);
  const currentMatchedPathname = options.currentMatchedPathname
    ? stripBasePath(options.currentMatchedPathname, options.basePath)
    : null;
  const targetPathname = stripBasePath(options.targetPathname, options.basePath);
  const sourceParts = splitPathnameForRouteMatch(currentPathname);
  const matchedSourceParts = currentMatchedPathname
    ? splitPathnameForRouteMatch(currentMatchedPathname)
    : null;
  const targetParts = splitPathnameForRouteMatch(targetPathname);

  for (const interception of options.routeManifest.segmentGraph.interceptions.values()) {
    if (
      !matchRoutePatternWithOptionalDynamicSegments(targetParts, interception.targetPatternParts)
    ) {
      continue;
    }
    if (matchRoutePatternPrefix(sourceParts, interception.sourcePatternParts)) {
      return currentPathname;
    }

    if (
      currentMatchedPathname !== null &&
      matchedSourceParts !== null &&
      matchRoutePatternPrefix(matchedSourceParts, interception.sourcePatternParts)
    ) {
      return currentMatchedPathname;
    }
  }

  return null;
}
