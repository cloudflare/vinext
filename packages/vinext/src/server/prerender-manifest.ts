import fs from "node:fs";
import {
  NEXT_ROUTER_PREFETCH_HEADER,
  NEXT_ROUTER_SEGMENT_PREFETCH_HEADER,
  NEXT_ROUTER_STATE_TREE_HEADER,
  NEXT_URL_HEADER,
  RSC_HEADER,
  VINEXT_CLIENT_REUSE_MANIFEST_HEADER,
  VINEXT_INTERCEPTION_CONTEXT_HEADER,
  VINEXT_MOUNTED_SLOTS_HEADER,
  VINEXT_RSC_RENDER_MODE_HEADER,
} from "./headers.js";

export type PrerenderManifestRoute = {
  route: string;
  status?: string;
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
  headers?: Record<string, string>;
  /** The final rendered response attempted to set a cookie; values are never persisted. */
  hasSetCookie?: boolean;
  /** A required response-side prewarm probe rejected this route. */
  prewarmable?: false;
  tags?: string[];
};

export type PrerenderManifest = {
  buildId?: string;
  deploymentId?: string;
  trailingSlash?: boolean;
  routes?: PrerenderManifestRoute[];
  pregeneratedConcretePaths?: Array<[string, string[]]>;
};

export type PrerenderedPathSelectionOptions = {
  includeFallbackShells?: boolean;
  includeErrorDocuments?: boolean;
  router?: "app" | "pages";
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

export function isCdnCachePolicyHeaderName(name: string): boolean {
  const lowerName = name.toLowerCase();
  return (
    lowerName === "cache-control" ||
    lowerName === "cdn-cache-control" ||
    lowerName.endsWith("-cdn-cache-control")
  );
}

const CONTROLLED_PREWARM_VARY_HEADERS = new Set(
  [
    RSC_HEADER,
    NEXT_ROUTER_STATE_TREE_HEADER,
    NEXT_ROUTER_PREFETCH_HEADER,
    NEXT_ROUTER_SEGMENT_PREFETCH_HEADER,
    NEXT_URL_HEADER,
    VINEXT_INTERCEPTION_CONTEXT_HEADER,
    VINEXT_MOUNTED_SLOTS_HEADER,
    VINEXT_RSC_RENDER_MODE_HEADER,
    VINEXT_CLIENT_REUSE_MANIFEST_HEADER,
    "Accept",
    "Cookie",
    "Authorization",
    "Host",
  ].map((name) => name.toLowerCase()),
);

export function hasNonCacheablePrewarmHeaders(
  headers: Headers | Record<string, string> | undefined,
): boolean {
  if (!headers) return false;
  for (const [name, value] of headers instanceof Headers ? headers : Object.entries(headers)) {
    const lowerName = name.toLowerCase();
    if (lowerName === "set-cookie") return true;
    if (lowerName === "vary") {
      for (const token of value.split(",")) {
        const fieldName = token.trim().toLowerCase();
        if (!fieldName) continue;
        if (fieldName === "*" || !CONTROLLED_PREWARM_VARY_HEADERS.has(fieldName)) return true;
      }
    }
    if (!isCdnCachePolicyHeaderName(name)) continue;
    if (/\b(?:no-store|no-cache|private)\b/i.test(value)) return true;
  }
  return false;
}

/**
 * A prerendered App route is safe to address through the shared, source-independent
 * RSC cache shape only when its completed build result has a cacheable lifetime.
 * `revalidate: 0` and explicit private/no-store policies fail closed.
 */
export function isPrewarmableAppRoute(route: PrerenderManifestRoute): boolean {
  return route.router === "app" && isPrewarmableRoute(route);
}

export function isPrewarmableRoute(route: PrerenderManifestRoute): boolean {
  const hasCacheableLifetime =
    route.revalidate === false ||
    (typeof route.revalidate === "number" &&
      Number.isFinite(route.revalidate) &&
      route.revalidate > 0);
  return (
    route.status === "rendered" &&
    hasCacheableLifetime &&
    route.prewarmable !== false &&
    route.hasSetCookie !== true &&
    !hasNonCacheablePrewarmHeaders(route.headers)
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

function isUnresolvedRoutePattern(pathname: string, route: PrerenderManifestRoute): boolean {
  if (route.path !== undefined || pathname !== route.route) return false;
  return route.route.split("/").some((segment) => segment.startsWith(":"));
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
    if (options?.router && route.router !== options.router) continue;
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

export function getPrewarmableConcretePaths(
  manifest: PrerenderManifest,
  options?: PrerenderedPathSelectionOptions,
): string[] {
  const routes = manifest.routes;
  if (!routes?.length) return [];

  const paths: string[] = [];
  const seen = new Set<string>();
  for (const route of routes) {
    if (!isPrewarmableRoute(route)) continue;
    if (options?.router && route.router !== options.router) continue;
    const pathname = route.path ?? route.route;
    if (!options?.includeFallbackShells && isFallbackShellArtifactPath(pathname, route)) continue;
    if (!options?.includeErrorDocuments && isErrorDocumentRoute(pathname, route)) continue;
    if (isUnresolvedRoutePattern(pathname, route) || seen.has(pathname)) continue;
    seen.add(pathname);
    paths.push(pathname);
  }
  return paths;
}

/** Select exact concrete App paths whose completed prerender is CDN-prewarmable. */
export function getPrewarmableAppPaths(manifest: PrerenderManifest): string[] {
  const routes = manifest.routes;
  if (!routes?.length) return [];

  const paths: string[] = [];
  const seen = new Set<string>();
  for (const route of routes) {
    if (!isPrewarmableAppRoute(route)) continue;
    const pathname = route.path ?? route.route;
    if (
      isUnresolvedRoutePattern(pathname, route) ||
      isFallbackShellArtifactPath(pathname, route) ||
      isErrorDocumentRoute(pathname, route)
    ) {
      continue;
    }
    if (seen.has(pathname)) continue;
    seen.add(pathname);
    paths.push(pathname);
  }
  return paths;
}
