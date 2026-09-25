import fs from "node:fs";
import { hasQueryInvariantRenderProof, type RenderObservation } from "./cache-proof.js";
import {
  isPrerenderRenderObservations,
  type PrerenderRenderObservations,
} from "./prerender-render-observations.js";

export type { PrerenderRenderObservations };

export type PrerenderManifestRoute = {
  route: string;
  status?: string;
  reason?: string;
  revalidate?: number | false;
  expire?: number;
  /**
   * Client-router reuse bound resolved by the prerender's `cacheLife`. Absent on
   * manifests written by older builds, which seed entries without a
   * client-freshness claim and leave the client on its configured staleTimes.
   */
  stale?: number;
  path?: string;
  router?: string;
  fallback?: boolean;
  headers?: Record<string, string | string[]>;
  responseStatus?: number;
  routeSegments?: string[];
  tags?: string[];
  /**
   * Observations of the prerender's own render, stored with the seeded App
   * page entries. Absent on manifests written by older builds.
   */
  renderObservations?: PrerenderRenderObservations;
};

export type PrerenderManifest = {
  buildId?: string;
  trailingSlash?: boolean;
  routes?: PrerenderManifestRoute[];
  pregeneratedConcretePaths?: Array<[string, string[]]>;
};

export type PrerenderedPathSelectionOptions = {
  includeFallbackShells?: boolean;
  includeErrorDocuments?: boolean;
};

export function readPrerenderManifest(manifestPath: string): PrerenderManifest | null {
  if (!fs.existsSync(manifestPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  } catch (error) {
    console.warn(`[vinext] Failed to read prerender manifest at ${manifestPath}:`, error);
    return null;
  }
}

export function getRenderedAppRoutes(routes: PrerenderManifestRoute[]): PrerenderManifestRoute[] {
  return routes.filter((r) => r.status === "rendered" && r.router === "app");
}

export function getRenderedMetadataRoutes(
  routes: PrerenderManifestRoute[],
): PrerenderManifestRoute[] {
  return routes.filter((route) => route.status === "rendered" && route.router === "metadata");
}

/**
 * The observations a rendered App page's seeds are stored with, or `null` when
 * the seeds must not be written. Seeds stand in for core's request-time writes
 * (`finalizeAppPage*CacheResponse`), so they're only stored with an
 * observation those would store: a successful, public render of the page's
 * shared entries, not a mounted-slot RSC variant, proven to leave the query
 * unread, since every query shares them. A route without observations has no
 * proof.
 *
 * Those writes also skip a render that used a dynamic API, which the
 * observation doesn't record (a `force-static` `headers()` read, say, isn't
 * dynamic), so it can't be checked here: the prerender skips a route whose
 * response it sees turn dynamic.
 */
export function getQueryInvariantSeedObservations(
  route: PrerenderManifestRoute,
): PrerenderRenderObservations | null {
  const observations = route.renderObservations;
  if (
    !isPrerenderRenderObservations(observations) ||
    !isStorableSeedObservation(observations.html) ||
    !isStorableSeedObservation(observations.rsc)
  ) {
    return null;
  }
  return observations;
}

function isStorableSeedObservation(observation: RenderObservation): boolean {
  return (
    hasQueryInvariantRenderProof(observation) &&
    observation.boundaryOutcome.kind === "success" &&
    observation.cacheability === "public" &&
    (observation.output.kind !== "app-rsc" || observation.output.mountedSlotsFingerprint === null)
  );
}

function groupRoutesByPattern(routes: PrerenderManifestRoute[]): Map<string, string[]> {
  const byPattern = new Map<string, string[]>();
  for (const r of routes) {
    const pathname = r.path ?? r.route;
    const existing = byPattern.get(r.route);
    if (existing) {
      existing.push(pathname);
    } else {
      byPattern.set(r.route, [pathname]);
    }
  }
  return byPattern;
}

function isErrorDocumentRoute(pathname: string, route: PrerenderManifestRoute): boolean {
  return (
    pathname === "/404" ||
    pathname === "/500" ||
    pathname === "/_error" ||
    route.route === "/404" ||
    route.route === "/500" ||
    route.route === "/_error"
  );
}

/**
 * Returns true when `pathname` contains bracket-delimited route params,
 * indicating it is a fallback-shell placeholder (e.g. `/en/blog/[slug]`)
 * rather than a concrete rendered URL.
 */
export function isFallbackShellArtifactPath(
  pathname: string,
  route?: PrerenderManifestRoute,
): boolean {
  if (route?.fallback === true) {
    return true;
  }
  // Backward-compat only: manifests predating the `fallback` flag. Current
  // builds always set `fallback`, so a concrete URL containing a literal
  // bracket is never misclassified here.
  if (route?.fallback === undefined) {
    if (process.env.NODE_ENV !== "production") {
      console.warn(
        "[vinext] Legacy manifest detected: missing `fallback` flag for route. " +
          "Using bracket heuristic for fallback-shell detection. " +
          "A concrete URL containing literal brackets may be misclassified as a fallback shell.",
      );
    }
    return pathname.includes("[") || pathname.includes("]");
  }
  return false;
}

/**
 * Build the pregenerated concrete-path payload table from a prerender manifest.
 *
 * Filters out fallback-shell placeholder paths and groups remaining concrete
 * paths by route pattern. Returns an empty array when the manifest has no
 * rendered App routes or all routes are fallback-shell artifacts.
 */
export function buildPregeneratedConcretePathTable(
  manifest: PrerenderManifest,
): Array<[string, string[]]> {
  const routes = manifest?.routes;
  if (!routes?.length) return [];

  const appRoutes = getRenderedAppRoutes(routes);
  const concreteRoutes = appRoutes.filter((r) => {
    const pathname = r.path ?? r.route;
    return !isFallbackShellArtifactPath(pathname, r);
  });

  const byPattern = groupRoutesByPattern(concreteRoutes);
  for (const route of routes) {
    if (route.status === "skipped" && route.reason === "empty-static-params") {
      if (!byPattern.has(route.route)) byPattern.set(route.route, []);
    }
  }
  return Array.from(byPattern.entries());
}

/**
 * Select concrete URL paths that were rendered by the prerender engine.
 *
 * This intentionally includes both App Router and Pages Router entries because
 * deploy-time cache warmup should exercise the same URLs the prerender phase
 * proved are statically renderable. PPR fallback-shell placeholder artifacts
 * and known error documents are excluded by default so warmup does not request
 * synthetic bracket paths or treat a healthy 404 response as a failed warmup.
 */
export function getPrerenderedConcretePaths(
  manifest: PrerenderManifest,
  options?: PrerenderedPathSelectionOptions,
): string[] {
  const routes = manifest.routes;
  if (!routes?.length) return [];

  const paths: string[] = [];
  const seen = new Set<string>();
  for (const route of routes) {
    if (route.status !== "rendered") continue;
    const pathname = route.path ?? route.route;
    if (!options?.includeFallbackShells && isFallbackShellArtifactPath(pathname, route)) {
      continue;
    }
    if (!options?.includeErrorDocuments && isErrorDocumentRoute(pathname, route)) {
      continue;
    }
    if (seen.has(pathname)) continue;
    seen.add(pathname);
    paths.push(pathname);
  }
  return paths;
}
