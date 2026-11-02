/**
 * Build-time route facts that let `revalidatePath()` skip a CDN purge no
 * edge-cached response could match.
 *
 * Edge purges are rate limited (Workers Cache allows 5 a minute per account),
 * and a `dynamic = "force-dynamic"` App route never stores a response the
 * edge can serve. The check is conservative: it only skips a path when at
 * least one App route could serve it and every such route is force-dynamic.
 * The data cache is always invalidated.
 */
import { matchRoutePatternPrefix, routePatternParts } from "../routing/route-pattern.js";

type CdnPurgeRoute = {
  patternParts: readonly string[];
  routeSegments: readonly string[];
};

type CdnPurgeRoutes = {
  metadataRoutes: readonly (Omit<CdnPurgeRoute, "patternParts"> & {
    patternParts: readonly string[] | null;
    servedUrl: string;
  })[];
  routes: readonly (CdnPurgeRoute & { forceDynamic?: boolean })[];
};

const CDN_PURGE_ROUTES_KEY = Symbol.for("vinext.cdnPurgeRoutes");
const globals = globalThis as unknown as Record<PropertyKey, unknown>;
const DERIVED_TAG_SUFFIXES = new Set(["layout", "page", "route"]);

/** Register the App Router's routes. Apps with a Pages Router never register. */
export function registerCdnPurgeRoutes(routes: CdnPurgeRoutes): void {
  globals[CDN_PURGE_ROUTES_KEY] = routes;
}

/** Whether some URL matched by `patternParts` starts with `pathParts`. */
function canServeUnder(pathParts: readonly string[], patternParts: readonly string[]): boolean {
  const last = patternParts.at(-1) ?? "";
  const endsInCatchAll = last.startsWith(":") && (last.endsWith("+") || last.endsWith("*"));
  if (patternParts.length < pathParts.length && !endsInCatchAll) return false;
  return matchRoutePatternPrefix(pathParts, patternParts.slice(0, pathParts.length));
}

/**
 * Whether a response from `route` could carry a `revalidatePath(path)` tag.
 * Implicit tags use either the URL (`/blog/a`) or the route's segments
 * (`/(site)/blog/[slug]`), so check both as prefixes.
 */
function couldCarryPathTag(pathParts: readonly string[], route: CdnPurgeRoute): boolean {
  return (
    canServeUnder(pathParts, route.patternParts) ||
    canServeUnder(pathParts, routePatternParts(route.routeSegments.join("/")))
  );
}

/**
 * Whether a metadata route, or a child it generates (`/icon/small` from
 * `generateImageMetadata`, `/sitemap/0.xml` from `generateSitemaps`), could
 * carry a `revalidatePath(path)` tag.
 */
function metadataCouldCarryPathTag(
  pathParts: readonly string[],
  route: CdnPurgeRoutes["metadataRoutes"][number],
): boolean {
  const patternParts = route.patternParts ?? routePatternParts(route.servedUrl);
  const childParts = [
    ...patternParts.slice(0, -1),
    (patternParts.at(-1) ?? "").replace(/\.[^.]*$/, ""),
    ":children*",
  ];
  return (
    couldCarryPathTag(pathParts, { patternParts, routeSegments: route.routeSegments }) ||
    canServeUnder(pathParts, childParts)
  );
}

/**
 * Whether no edge-cacheable response can carry the implicit tags of
 * `revalidatePath(path)`, for any `type`. Paths that need encoding, the
 * `/index` alias, and paths ending in a derived tag suffix (`/docs/page` is
 * also the `/docs` page tag) always purge.
 */
export function isPathKnownNotEdgeCached(path: string): boolean {
  const registered = globals[CDN_PURGE_ROUTES_KEY] as CdnPurgeRoutes | undefined;
  if (!registered || path === "/index" || /[^\x21-\x7e]|%/.test(path)) return false;
  const pathParts = path.split("/").filter(Boolean);
  if (DERIVED_TAG_SUFFIXES.has(pathParts.at(-1) ?? "")) return false;
  if (registered.metadataRoutes.some((route) => metadataCouldCarryPathTag(pathParts, route))) {
    return false;
  }

  let matched = false;
  for (const route of registered.routes) {
    if (!couldCarryPathTag(pathParts, route)) continue;
    if (route.forceDynamic !== true) return false;
    matched = true;
  }
  return matched;
}
