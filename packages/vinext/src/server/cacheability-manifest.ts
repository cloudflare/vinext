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

export const CACHEABILITY_MANIFEST_MODULE = "__vinext_cacheability_manifest.js";

export type CacheabilityRouteKind = "app-page" | "app-route" | "pages-page";
export type CacheabilityRepresentation =
  | "app-route"
  | "html"
  | "pages-data"
  | "rsc-full"
  | "rsc-loading-shell";
export type CacheabilityManifestRouteState = "static-candidate" | "runtime-check";

export type CacheabilityManifestRoute = {
  kind: CacheabilityRouteKind;
  pattern: string;
  /** Default completed-render policy for authorized non-static representations. */
  state: CacheabilityManifestRouteState;
  /** Permit completed-render admission for paths not observed during probing. */
  allowUnknown?: boolean;
  /** Next.js fallback classification for paths not observed during probing. */
  unknownState?: CacheabilityManifestRouteState;
  /** Common prefix omitted from every exact path below. */
  pathPrefix?: string;
  /** Runtime-checked representation authorized for every path in a pattern. */
  runtimeRepresentation?: CacheabilityRepresentation;
  /** Static representation for a literal route that needs no exact path list. */
  staticRepresentation?: CacheabilityRepresentation;
  /** Exact dynamic paths observed in a mixed or pattern-dynamic route. */
  runtimePaths?: string[];
  /** Exact paths statically certified by the representation that was probed. */
  staticPaths?: Partial<Record<CacheabilityRepresentation, string[]>>;
};

export type CacheabilityManifest = {
  buildId: string;
  routes: Record<string, CacheabilityManifestRoute>;
  version: 1;
};

export function cacheabilityManifestRouteKey(
  kind: CacheabilityManifestRoute["kind"],
  pattern: string,
): string {
  return JSON.stringify([kind, pattern]);
}

function isRouteState(value: unknown): value is CacheabilityManifestRouteState {
  return value === "static-candidate" || value === "runtime-check";
}

function isRepresentation(value: unknown): value is CacheabilityRepresentation {
  return CACHEABILITY_REPRESENTATIONS.includes(value as CacheabilityRepresentation);
}

const CACHEABILITY_REPRESENTATIONS: readonly CacheabilityRepresentation[] = [
  "app-route",
  "html",
  "pages-data",
  "rsc-full",
  "rsc-loading-shell",
];

function expandPathToken(pathPrefix: string | undefined, token: string): string | null {
  if (!pathPrefix) return token;
  const pathname = `${pathPrefix}${token}`;
  return pathname === normalizeCacheabilityRoutePathname(pathname) ? pathname : null;
}

function parsePathList(value: unknown, pathPrefix: string | undefined): string[] | null {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every(
      (token, index, tokens) =>
        typeof token === "string" &&
        (pathPrefix !== undefined || token.startsWith("/")) &&
        expandPathToken(pathPrefix, token) !== null &&
        (index === 0 || tokens[index - 1] < token),
    )
  ) {
    return null;
  }
  return value as string[];
}

function parseStaticPaths(
  value: unknown,
  pathPrefix: string | undefined,
): Partial<Record<CacheabilityRepresentation, string[]>> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (entries.length === 0) return null;
  const parsed: Partial<Record<CacheabilityRepresentation, string[]>> = {};
  for (const [representation, paths] of entries) {
    if (!isRepresentation(representation)) {
      return null;
    }
    const parsedPaths = parsePathList(paths, pathPrefix);
    if (!parsedPaths) return null;
    parsed[representation as CacheabilityRepresentation] = parsedPaths;
  }
  return parsed;
}

function parseRoute(key: string, value: unknown): CacheabilityManifestRoute | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const route = value as Record<string, unknown>;
  if (
    (route.kind !== "app-page" && route.kind !== "app-route" && route.kind !== "pages-page") ||
    typeof route.pattern !== "string" ||
    !route.pattern.startsWith("/") ||
    !isRouteState(route.state)
  ) {
    return null;
  }
  const pathPrefix =
    typeof route.pathPrefix === "string" &&
    route.pathPrefix.startsWith("/") &&
    new URL(route.pathPrefix, "http://vinext.local").pathname === route.pathPrefix
      ? route.pathPrefix
      : undefined;
  const runtimePaths =
    route.runtimePaths === undefined ? undefined : parsePathList(route.runtimePaths, pathPrefix);
  const staticPaths =
    route.staticPaths === undefined ? undefined : parseStaticPaths(route.staticPaths, pathPrefix);
  const staticRepresentation = isRepresentation(route.staticRepresentation)
    ? route.staticRepresentation
    : undefined;
  const runtimeRepresentation = isRepresentation(route.runtimeRepresentation)
    ? route.runtimeRepresentation
    : undefined;
  if (
    (route.allowUnknown !== undefined && route.allowUnknown !== true) ||
    (route.unknownState !== undefined && route.unknownState !== "static-candidate") ||
    (route.unknownState !== undefined && route.allowUnknown !== true) ||
    (route.pathPrefix !== undefined && pathPrefix === undefined) ||
    (route.staticRepresentation !== undefined && staticRepresentation === undefined) ||
    (route.runtimeRepresentation !== undefined && runtimeRepresentation === undefined) ||
    (runtimeRepresentation !== undefined &&
      (route.state !== "runtime-check" ||
        route.allowUnknown !== undefined ||
        pathPrefix !== undefined ||
        staticRepresentation !== undefined ||
        runtimePaths !== undefined ||
        staticPaths !== undefined)) ||
    (staticRepresentation !== undefined &&
      (route.state !== "runtime-check" ||
        /(^|\/):/.test(route.pattern) ||
        runtimePaths !== undefined ||
        staticPaths !== undefined)) ||
    (pathPrefix !== undefined && !runtimePaths && !staticPaths) ||
    (route.runtimePaths !== undefined && !runtimePaths) ||
    (route.staticPaths !== undefined && !staticPaths) ||
    ((runtimePaths || staticPaths || route.allowUnknown === true) &&
      route.state !== "runtime-check")
  ) {
    return null;
  }
  const parsed: CacheabilityManifestRoute = {
    kind: route.kind,
    pattern: route.pattern,
    state: route.state,
    ...(route.allowUnknown === true ? { allowUnknown: true } : {}),
    ...(route.unknownState === "static-candidate"
      ? { unknownState: "static-candidate" as const }
      : {}),
    ...(pathPrefix ? { pathPrefix } : {}),
    ...(runtimeRepresentation ? { runtimeRepresentation } : {}),
    ...(staticRepresentation ? { staticRepresentation } : {}),
    ...(runtimePaths ? { runtimePaths } : {}),
    ...(staticPaths ? { staticPaths } : {}),
  };

  const observedPaths = new Set<string>();
  for (const tokens of [runtimePaths, ...Object.values(staticPaths ?? {})]) {
    for (const token of tokens ?? []) {
      const pathname = expandPathToken(pathPrefix, token)!;
      if (observedPaths.has(pathname)) return null;
      observedPaths.add(pathname);
    }
  }
  return key === cacheabilityManifestRouteKey(parsed.kind, parsed.pattern) ? parsed : null;
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
  if (/(?:^|\/)_next\/data\/[^/]+\/.+\.json$/.test(url.pathname)) {
    return { representation: "pages-data", requestKey };
  }
  const isRsc = request.headers.get(RSC_HEADER) === "1" || url.pathname.endsWith(".rsc");
  if (!isRsc) {
    const accept = request.headers.get("Accept")?.toLowerCase() ?? "";
    return accept.includes("text/html")
      ? { representation: "html", requestKey }
      : { representation: "app-route", requestKey };
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

export function normalizeCacheabilityRoutePathname(pathname: string): string {
  const normalized = new URL(pathname, "http://vinext.local").pathname;
  return normalized.length > 1 && normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

export function cacheabilityRoutePathname(
  pathname: string,
  representation: CacheabilityRepresentation,
): string {
  const normalized = new URL(pathname, "http://vinext.local").pathname;
  if (representation === "rsc-full" || representation === "rsc-loading-shell") {
    return normalizeCacheabilityRoutePathname(
      normalized.endsWith(".rsc") ? normalized.slice(0, -4) : normalized,
    );
  }
  if (representation !== "pages-data") return normalizeCacheabilityRoutePathname(normalized);

  const marker = normalized.indexOf("/_next/data/");
  const restWithBuildId = marker === -1 ? "" : normalized.slice(marker + "/_next/data/".length);
  const buildIdEnd = restWithBuildId.indexOf("/");
  if (buildIdEnd === -1 || !restWithBuildId.endsWith(".json")) {
    return normalizeCacheabilityRoutePathname(normalized);
  }
  const assetPath = restWithBuildId.slice(buildIdEnd + 1, -".json".length);
  if (!assetPath) return normalizeCacheabilityRoutePathname(normalized);

  let pagePathname: string;
  if (assetPath === "index") pagePathname = "/";
  else if (assetPath.endsWith("/index")) {
    pagePathname = `/${assetPath.slice(0, -"/index".length)}`;
  } else if (assetPath.startsWith("index/")) {
    pagePathname = `/${assetPath.slice("index/".length)}`;
  } else {
    pagePathname = `/${assetPath}`;
  }
  const basePath = normalized.slice(0, marker);
  return normalizeCacheabilityRoutePathname(
    pagePathname === "/" ? basePath || "/" : `${basePath}${pagePathname}`,
  );
}

export function cacheabilityManifestRouteState(
  route: CacheabilityManifestRoute,
  routePathname: string,
  representation?: CacheabilityRepresentation,
): CacheabilityManifestRouteState | null {
  const pathname = normalizeCacheabilityRoutePathname(routePathname);
  let pathToken = pathname;
  if (route.pathPrefix !== undefined) {
    if (
      !pathname.startsWith(route.pathPrefix) ||
      (!route.pathPrefix.endsWith("/") &&
        pathname.length > route.pathPrefix.length &&
        pathname[route.pathPrefix.length] !== "/")
    ) {
      return route.allowUnknown === true ? (route.unknownState ?? route.state) : null;
    }
    pathToken = pathname.slice(route.pathPrefix.length);
  }
  const includesPath = (paths: readonly string[] | undefined): boolean => {
    if (!paths) return false;
    let low = 0;
    let high = paths.length - 1;
    while (low <= high) {
      const middle = (low + high) >>> 1;
      const candidate = paths[middle];
      if (candidate === pathToken) return true;
      if (candidate < pathToken) low = middle + 1;
      else high = middle - 1;
    }
    return false;
  };

  if (representation && includesPath(route.staticPaths?.[representation])) {
    return "static-candidate";
  }
  if (representation && route.staticRepresentation === representation) {
    return "static-candidate";
  }
  if (route.runtimeRepresentation !== undefined) {
    return representation === route.runtimeRepresentation ? route.state : null;
  }
  if (!route.staticPaths && !route.runtimePaths && route.allowUnknown !== true) {
    return route.state;
  }
  if (includesPath(route.runtimePaths)) return route.state;
  if (route.staticPaths) {
    for (const paths of Object.values(route.staticPaths)) {
      if (includesPath(paths)) return route.state;
    }
  }
  if (route.allowUnknown === true) return route.unknownState ?? route.state;
  return null;
}

export function findCacheabilityManifestRoute(
  manifest: CacheabilityManifest,
  kind: CacheabilityRouteKind,
  pattern: string,
): CacheabilityManifestRoute | null {
  return manifest.routes[cacheabilityManifestRouteKey(kind, pattern)] ?? null;
}
