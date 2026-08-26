import {
  NEXT_ACTION_HEADER,
  NEXT_ROUTER_PREFETCH_HEADER,
  NEXT_ROUTER_SEGMENT_PREFETCH_HEADER,
  NEXT_ROUTER_STATE_TREE_HEADER,
  NEXT_URL_HEADER,
  RSC_ACTION_HEADER,
  RSC_HEADER,
  VINEXT_INTERCEPTION_CONTEXT_HEADER,
  VINEXT_INTERCEPTION_ID_HEADER,
  VINEXT_MOUNTED_SLOTS_HEADER,
  VINEXT_RSC_RENDER_MODE_HEADER,
  VINEXT_RSC_STATE_FINGERPRINT_HEADER,
} from "./headers.js";
import { APP_RSC_RENDER_MODE_PREFETCH_LOADING_SHELL } from "./app-rsc-render-mode.js";

export type CacheabilityRepresentation = "html" | "rsc-full" | "rsc-loading-shell";
type CacheabilityManifestRouteState =
  | "static-candidate"
  | "runtime-check"
  | "dynamic"
  | "probe-failed";

export type CacheabilityManifestRoute = {
  kind: "app-page";
  pattern: string;
  representation: CacheabilityRepresentation;
  requestKey: string;
  state: CacheabilityManifestRouteState;
  status: number;
};

export type CacheabilityManifest = {
  buildId: string;
  routes: Record<string, CacheabilityManifestRoute>;
  version: 1;
};

export function cacheabilityManifestRouteKey(
  kind: CacheabilityManifestRoute["kind"],
  pattern: string,
  representation: CacheabilityRepresentation,
  requestKey: string,
): string {
  return JSON.stringify([kind, pattern, representation, requestKey]);
}

function isRepresentation(value: unknown): value is CacheabilityRepresentation {
  return value === "html" || value === "rsc-full" || value === "rsc-loading-shell";
}

function isRouteState(value: unknown): value is CacheabilityManifestRouteState {
  return (
    value === "static-candidate" ||
    value === "runtime-check" ||
    value === "dynamic" ||
    value === "probe-failed"
  );
}

function parseRoute(key: string, value: unknown): CacheabilityManifestRoute | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const route = value as Record<string, unknown>;
  if (
    route.kind !== "app-page" ||
    typeof route.pattern !== "string" ||
    !route.pattern.startsWith("/") ||
    !isRepresentation(route.representation) ||
    typeof route.requestKey !== "string" ||
    !route.requestKey.startsWith("/") ||
    !isRouteState(route.state) ||
    !Number.isInteger(route.status) ||
    (route.status as number) < 100 ||
    (route.status as number) > 599
  ) {
    return null;
  }
  const parsed: CacheabilityManifestRoute = {
    kind: "app-page",
    pattern: route.pattern,
    representation: route.representation,
    requestKey: route.requestKey,
    state: route.state,
    status: route.status as number,
  };
  return key ===
    cacheabilityManifestRouteKey(
      parsed.kind,
      parsed.pattern,
      parsed.representation,
      parsed.requestKey,
    )
    ? parsed
    : null;
}

export function parseCacheabilityManifest(
  value: string | null | undefined,
  expectedBuildId: string | null | undefined,
): CacheabilityManifest | null {
  if (!value || !expectedBuildId) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (
      record.version !== 1 ||
      record.buildId !== expectedBuildId ||
      !record.routes ||
      typeof record.routes !== "object" ||
      Array.isArray(record.routes)
    ) {
      return null;
    }

    const routes: Record<string, CacheabilityManifestRoute> = {};
    for (const [key, routeValue] of Object.entries(record.routes)) {
      const route = parseRoute(key, routeValue);
      if (!route) return null;
      routes[key] = route;
    }
    return { buildId: expectedBuildId, routes, version: 1 };
  } catch {
    return null;
  }
}

const CONTEXTUAL_RSC_HEADERS = [
  NEXT_ROUTER_STATE_TREE_HEADER,
  NEXT_URL_HEADER,
  VINEXT_INTERCEPTION_CONTEXT_HEADER,
  VINEXT_INTERCEPTION_ID_HEADER,
  VINEXT_MOUNTED_SLOTS_HEADER,
  VINEXT_RSC_STATE_FINGERPRINT_HEADER,
] as const;

export function cacheabilityRequestIdentity(request: Request): {
  representation: CacheabilityRepresentation;
  requestKey: string;
} | null {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  if (request.headers.has(NEXT_ACTION_HEADER) || request.headers.has(RSC_ACTION_HEADER))
    return null;

  const url = new URL(request.url);
  const requestKey = `${url.pathname}${url.search}`;
  const isRsc = request.headers.get(RSC_HEADER) === "1" || url.pathname.endsWith(".rsc");
  if (!isRsc) {
    const accept = request.headers.get("Accept")?.toLowerCase() ?? "";
    return accept.includes("text/html") ? { representation: "html", requestKey } : null;
  }

  if (CONTEXTUAL_RSC_HEADERS.some((header) => request.headers.has(header))) return null;
  const renderMode = request.headers.get(VINEXT_RSC_RENDER_MODE_HEADER);
  if (renderMode === APP_RSC_RENDER_MODE_PREFETCH_LOADING_SHELL) {
    if (
      request.headers.get(NEXT_ROUTER_PREFETCH_HEADER) !== "1" ||
      request.headers.get(NEXT_ROUTER_SEGMENT_PREFETCH_HEADER) !== "1"
    ) {
      return null;
    }
    return { representation: "rsc-loading-shell", requestKey };
  }
  if (
    renderMode !== null ||
    request.headers.has(NEXT_ROUTER_PREFETCH_HEADER) ||
    request.headers.has(NEXT_ROUTER_SEGMENT_PREFETCH_HEADER)
  ) {
    return null;
  }
  return { representation: "rsc-full", requestKey };
}

export function findCacheabilityManifestRoute(
  manifest: CacheabilityManifest,
  pattern: string,
  identity: { representation: CacheabilityRepresentation; requestKey: string },
): CacheabilityManifestRoute | null {
  return (
    manifest.routes[
      cacheabilityManifestRouteKey(
        "app-page",
        pattern,
        identity.representation,
        identity.requestKey,
      )
    ] ?? null
  );
}
