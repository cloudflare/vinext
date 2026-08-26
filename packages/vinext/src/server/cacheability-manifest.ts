export const CACHEABILITY_MANIFEST_PLACEHOLDER =
  "__VINEXT_CACHEABILITY_MANIFEST_7A4D2D86_5848_4C3D_A2D5_52B32F178CF9__";

export type CacheabilityRouteKind = "app-page" | "app-route" | "pages-page";

export type CacheabilityRouteState =
  | "static-candidate"
  | "dynamic"
  | "runtime-check"
  | "probe-failed";

export type CacheabilityManifestRoute = {
  kind: CacheabilityRouteKind;
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

export function cacheabilityRouteKey(kind: CacheabilityRouteKind, pattern: string): string {
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
        !isCacheabilityRouteState(route.state) ||
        key !== cacheabilityRouteKey(route.kind, route.pattern)
      ) {
        return null;
      }
      routes[key] = {
        kind: route.kind,
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
