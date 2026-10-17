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
import type { NextHeader } from "../config/next-config.js";
import { matchRoutePatternPrefix, routePatternParts } from "../routing/route-pattern.js";
import { isCacheableCdnResponsePolicy } from "../server/cache-control.js";

type CdnPurgeRoute = {
  patternParts: readonly string[];
  routeSegments: readonly string[];
};

type CdnPurgeRoutes = {
  configHeaders: readonly NextHeader[];
  metadataRoutes: readonly (Omit<CdnPurgeRoute, "patternParts"> & {
    patternParts: readonly string[] | null;
    servedUrl: string;
  })[];
  routes: readonly (CdnPurgeRoute & { forceDynamic?: boolean })[];
};

const CDN_PURGE_ROUTES_KEY = Symbol.for("vinext.cdnPurgeRoutes");
const globals = globalThis as unknown as Record<PropertyKey, unknown>;

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
 * Whether no edge-cacheable response can carry the implicit tags of
 * `revalidatePath(path)`, for any `type`. Paths that need encoding, the
 * `/index` alias, and apps whose `next.config` headers can make a
 * force-dynamic route cacheable always purge.
 */
export function isPathKnownNotEdgeCached(path: string): boolean {
  const registered = globals[CDN_PURGE_ROUTES_KEY] as CdnPurgeRoutes | undefined;
  if (!registered || path === "/index" || /[^\x21-\x7e]|%/.test(path)) return false;
  if (
    registered.configHeaders.some((rule) =>
      rule.headers.some(({ key, value }) => isCacheableCdnResponsePolicy(key, value)),
    )
  ) {
    return false;
  }

  const pathParts = path.split("/").filter(Boolean);
  const metadataCouldCarry = registered.metadataRoutes.some((route) =>
    couldCarryPathTag(pathParts, {
      patternParts: route.patternParts ?? routePatternParts(route.servedUrl),
      routeSegments: route.routeSegments,
    }),
  );
  if (metadataCouldCarry) return false;

  let matched = false;
  for (const route of registered.routes) {
    if (!couldCarryPathTag(pathParts, route)) continue;
    if (route.forceDynamic !== true) return false;
    matched = true;
  }
  return matched;
}
