export const CACHEABILITY_MANIFEST_PLACEHOLDER =
  "__VINEXT_CACHEABILITY_MANIFEST_7A4D2D86_5848_4C3D_A2D5_52B32F178CF9__";

export type CacheabilityRouteKind = "app-page" | "app-route" | "pages-page";

export type CacheabilityRouteState =
  | "static-candidate"
  | "dynamic"
  | "runtime-check"
  | "probe-failed";

export type CacheabilityManifestRoute = {
  /** Concrete generated paths eligible to use this dynamic pattern fallback. */
  eligiblePaths?: string[];
  kind: CacheabilityRouteKind;
  /** Concrete public pathname classified by this entry. Omitted for the pattern fallback. */
  path?: string;
  pattern: string;
  state: CacheabilityRouteState;
};

export type CacheabilityManifest = {
  buildId?: string;
  routes: Record<string, CacheabilityManifestRoute>;
  version: 1;
};

declare const __VINEXT_CACHEABILITY_MANIFEST__: string | undefined;

let parsedManifest: CacheabilityManifest | null | undefined;

export function cacheabilityRouteKey(
  kind: CacheabilityRouteKind,
  pattern: string,
  path?: string,
): string {
  // Retain the original readable key for pattern fallbacks. Exact-path keys use
  // a JSON tuple so arbitrary dynamic-pattern/path characters cannot collide.
  if (path !== undefined) return JSON.stringify([kind, pattern, path]);
  return `${kind}:${pattern}`;
}

function isCacheabilityRouteKind(value: unknown): value is CacheabilityRouteKind {
  return value === "app-page" || value === "app-route" || value === "pages-page";
}

function isCacheabilityRouteState(value: unknown): value is CacheabilityRouteState {
  return (
    value === "static-candidate" ||
    value === "dynamic" ||
    value === "runtime-check" ||
    value === "probe-failed"
  );
}

export function parseCacheabilityManifest(
  value: string | null | undefined,
): CacheabilityManifest | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (record.version !== 1 || !record.routes || typeof record.routes !== "object") return null;

    const routes: Record<string, CacheabilityManifestRoute> = {};
    for (const [key, entry] of Object.entries(record.routes as Record<string, unknown>)) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
      const route = entry as Record<string, unknown>;
      if (
        !isCacheabilityRouteKind(route.kind) ||
        typeof route.pattern !== "string" ||
        !route.pattern.startsWith("/") ||
        (route.path !== undefined &&
          (typeof route.path !== "string" || !route.path.startsWith("/"))) ||
        !isCacheabilityRouteState(route.state) ||
        (route.eligiblePaths !== undefined &&
          (!Array.isArray(route.eligiblePaths) ||
            route.eligiblePaths.length === 0 ||
            route.eligiblePaths.some(
              (path, index, paths) =>
                typeof path !== "string" ||
                !path.startsWith("/") ||
                (index > 0 && paths[index - 1] >= path),
            ))) ||
        key !==
          cacheabilityRouteKey(
            route.kind,
            route.pattern,
            typeof route.path === "string" ? route.path : undefined,
          )
      ) {
        return null;
      }
      routes[key] = {
        ...(Array.isArray(route.eligiblePaths)
          ? { eligiblePaths: route.eligiblePaths as string[] }
          : {}),
        kind: route.kind,
        ...(typeof route.path === "string" ? { path: route.path } : {}),
        pattern: route.pattern,
        state: route.state,
      };
    }

    return {
      ...(typeof record.buildId === "string" ? { buildId: record.buildId } : {}),
      routes,
      version: 1,
    };
  } catch {
    return null;
  }
}

function includesSortedPath(paths: readonly string[], pathname: string): boolean {
  let low = 0;
  let high = paths.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const candidate = paths[middle];
    if (candidate === pathname) return true;
    if (candidate < pathname) low = middle + 1;
    else high = middle - 1;
  }
  return false;
}

export function cacheabilityRouteAllowsPath(
  route: CacheabilityManifestRoute,
  pathname: string,
): boolean {
  return route.eligiblePaths === undefined || includesSortedPath(route.eligiblePaths, pathname);
}

export function getEmbeddedCacheabilityManifest(): CacheabilityManifest | null {
  if (parsedManifest !== undefined) return parsedManifest;
  const raw =
    typeof __VINEXT_CACHEABILITY_MANIFEST__ === "string"
      ? __VINEXT_CACHEABILITY_MANIFEST__
      : CACHEABILITY_MANIFEST_PLACEHOLDER;
  parsedManifest = parseCacheabilityManifest(raw);
  return parsedManifest;
}

/** Test-only reset for modules whose compile-time define is stubbed between cases. */
export function resetEmbeddedCacheabilityManifestForTests(): void {
  parsedManifest = undefined;
}
