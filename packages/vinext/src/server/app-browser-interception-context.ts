import type { RouteManifest } from "../routing/app-route-graph.js";
import {
  matchRoutePattern,
  matchRoutePatternPrefix,
  matchRoutePatternWithOptionalDynamicSegments,
} from "../routing/route-pattern.js";
import { normalizePathnameForRouteMatch, splitPathnameForRouteMatch } from "../routing/utils.js";
import { stripBasePath } from "../utils/base-path.js";
import { normalizePath } from "./normalize-path.js";

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
      return encodeMatchedPathname(currentMatchedPathname);
    }
  }

  return null;
}

/**
 * The matched route pathname is the matched URL decoded once per segment, with
 * path delimiters (and literal `%2F`-style text) re-escaped. The server matches
 * the context on its raw segments, so undo that: keep the escaped delimiters and
 * encode every other `%`, then let the URL parser encode the rest (`café`
 * becomes `caf%C3%A9`). An escaped ASCII character comes back unescaped (`%61`
 * as `a`), like Next.js's `Next-Url`, which it builds from the router tree's
 * canonical params; both spellings match the same params. `%252F` is
 * ambiguous, since both a literal `%2F` and a literal `%252F` produce it. That
 * case, and a result that does not reproduce the same matched pathname because
 * the URL parser changed it (stripping a control character, say), navigate
 * without interception instead of naming a different source.
 */
function encodeMatchedPathname(pathname: string): string | null {
  if (/%25(?:2f|23|3f|5c)/i.test(pathname)) return null;
  let encoded: string;
  try {
    encoded = new URL(pathname.replace(/%(?!(?:25)?(?:2f|23|3f|5c))/gi, "%25"), "http://n")
      .pathname;
  } catch {
    return null;
  }
  return normalizePath(normalizePathnameForRouteMatch(encoded)) === pathname ? encoded : null;
}
