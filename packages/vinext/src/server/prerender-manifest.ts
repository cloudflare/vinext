import fs from "node:fs";

type PrerenderManifestRoute = {
  route: string;
  status?: string;
  revalidate?: number | false;
  expire?: number;
  path?: string;
  router?: string;
  fallback?: boolean;
  headers?: Record<string, string>;
};

export type PrerenderManifest = {
  buildId?: string;
  trailingSlash?: boolean;
  routes?: PrerenderManifestRoute[];
  pregeneratedConcretePaths?: Array<[string, string[]]>;
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

  return Array.from(groupRoutesByPattern(concreteRoutes).entries());
}
