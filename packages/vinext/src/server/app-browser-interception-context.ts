import type { BrowserRouteManifest } from "../routing/browser-route-manifest.js";
import {
  matchRoutePattern,
  matchRoutePatternPrefix,
  matchRoutePatternWithOptionalDynamicSegments,
} from "../routing/route-pattern.js";
import { normalizePathnameForRouteMatch, splitPathnameForRouteMatch } from "../routing/utils.js";
import { stripBasePath } from "../utils/base-path.js";
import { AppElementsWire } from "./app-elements.js";
import { ROUTE_MISS_INTERCEPTION_CONTEXT } from "./app-interception-context-header.js";
import { normalizePath } from "./normalize-path.js";

type ResolveManifestNavigationInterceptionContextOptions = {
  basePath: string;
  currentMatchedPathname?: string | null;
  currentPathname: string;
  /**
   * The committed render matched no route (an unmatched URL's not-found
   * page). Next.js builds `Next-Url` from the rendered router tree rather than
   * the browser URL, and that tree is then /_not-found, so the context is
   * /_not-found and only an interception whose source matches it applies.
   * When the root layout has a parallel slot, a target of any such
   * interception loads as a document instead.
   */
  currentRenderIsRouteMiss?: boolean;
  routeManifest: BrowserRouteManifest | null;
  targetPathname: string;
};

/**
 * A navigation from an unmatched URL's not-found page to an intercept whose
 * source matches /_not-found, where the root layout has a parallel slot
 * besides `children`. Next.js loads the target's document there, so the
 * caller performs a document navigation instead of fetching a payload.
 */
export const ROUTE_MISS_DOCUMENT_NAVIGATION: unique symbol = Symbol(
  "vinext.routeMissDocumentNavigation",
);

export type NavigationInterceptionContextResolution =
  | string
  | null
  | typeof ROUTE_MISS_DOCUMENT_NAVIGATION;

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
): NavigationInterceptionContextResolution {
  if (options.routeManifest === null) return null;
  const loadsDocument = loadsTargetDocument(options.routeManifest, options);

  const currentPathname = resolveCurrentSourcePathname(options);
  const targetPathname = stripBasePath(options.targetPathname, options.basePath);
  const sourceParts = splitPathnameForRouteMatch(currentPathname);
  const targetParts = splitPathnameForRouteMatch(targetPathname);

  for (const interception of options.routeManifest.segmentGraph.interceptions.values()) {
    if (!matchRoutePatternPrefix(sourceParts, interception.sourcePatternParts)) continue;
    if (matchRoutePattern(targetParts, interception.targetPatternParts) === null) continue;
    return loadsDocument ? ROUTE_MISS_DOCUMENT_NAVIGATION : currentPathname;
  }

  return null;
}

/**
 * Whether any intercept's target can match the target pathname, also after a
 * middleware rewrite adds dynamic segments to it, a required catch-all's too.
 * Next.js's server drops the `Next-Url` of a request to any other path, so its
 * response stays cacheable.
 */
export function canInterceptNavigationTarget(options: {
  basePath: string;
  routeManifest: BrowserRouteManifest | null;
  targetPathname: string;
}): boolean {
  if (options.routeManifest === null) return true;
  const targetParts = splitPathnameForRouteMatch(
    stripBasePath(options.targetPathname, options.basePath),
  );
  for (const interception of options.routeManifest.segmentGraph.interceptions.values()) {
    if (
      matchRoutePatternWithOptionalDynamicSegments(
        targetParts,
        interception.targetPatternParts.map((part) =>
          part.startsWith(":") && part.endsWith("+") ? `${part.slice(0, -1)}*` : part,
        ),
      )
    ) {
      return true;
    }
  }
  return false;
}

export function resolveMiddlewareRewriteNavigationInterceptionContext(
  options: ResolveManifestNavigationInterceptionContextOptions,
): NavigationInterceptionContextResolution {
  if (options.routeManifest === null) return null;
  const loadsDocument = loadsTargetDocument(options.routeManifest, options);

  const currentPathname = resolveCurrentSourcePathname(options);
  // The not-found page of an unmatched URL has no matched route pathname.
  const currentMatchedPathname =
    options.currentMatchedPathname && options.currentRenderIsRouteMiss !== true
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
      return loadsDocument ? ROUTE_MISS_DOCUMENT_NAVIGATION : currentPathname;
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

const ROOT_LAYOUT_ID = AppElementsWire.encodeLayoutId("/");

// The not-found page of an unmatched URL holds only `children` at the root, so
// when the root layout has another slot, Next.js can't apply a target's tree
// in place and loads the target's document instead.
function loadsTargetDocument(
  routeManifest: BrowserRouteManifest,
  options: ResolveManifestNavigationInterceptionContextOptions,
): boolean {
  return options.currentRenderIsRouteMiss === true && rootLayoutHasSlot(routeManifest);
}

function rootLayoutHasSlot(routeManifest: BrowserRouteManifest): boolean {
  for (const binding of routeManifest.segmentGraph.slotBindings.values()) {
    if (binding.ownerLayoutId === ROOT_LAYOUT_ID) return true;
  }
  return false;
}

// A route miss renders /_not-found, so that is the source pathname, as in
// Next.js's `Next-Url`. Any source matching it applies: a root-level one (a
// sibling intercept or a route group's slot) or a top-level dynamic segment.
// The server authorizes it as a direct request to /_not-found.
function resolveCurrentSourcePathname(
  options: ResolveManifestNavigationInterceptionContextOptions,
): string {
  return options.currentRenderIsRouteMiss === true
    ? ROUTE_MISS_INTERCEPTION_CONTEXT
    : stripBasePath(options.currentPathname, options.basePath);
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
