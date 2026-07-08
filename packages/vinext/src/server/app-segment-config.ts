import type { FetchCacheMode } from "vinext/shims/fetch-cache";
import { isEdgeApiRuntime } from "./edge-api-runtime.js";

type AppRouteSegmentDynamic = "auto" | "error" | "force-dynamic" | "force-static";

type AppRouteSegmentConfigModule = {
  dynamic?: unknown;
  dynamicParams?: unknown;
  fetchCache?: unknown;
  generateStaticParams?: unknown;
  revalidate?: unknown;
  runtime?: unknown;
  unstable_dynamicStaleTime?: unknown;
};

type EffectiveAppPageSegmentConfig = {
  dynamicConfig?: AppRouteSegmentDynamic;
  dynamicParamsConfig?: boolean;
  dynamicStaleTimeSeconds?: number;
  fetchCache?: FetchCacheMode;
  revalidateSeconds: number | null;
  runtime?: "edge" | "experimental-edge" | "nodejs";
};

type ParallelAppPageSegmentConfigBranch = {
  configLayouts?: readonly (AppRouteSegmentConfigModule | null | undefined)[] | null;
  configLayoutTreePositions?: readonly number[] | null;
  layout?: AppRouteSegmentConfigModule | null;
  page?: AppRouteSegmentConfigModule | null;
  routeSegments?: readonly string[] | null;
};

type ResolveAppPageSegmentConfigOptions = {
  layouts?: readonly (AppRouteSegmentConfigModule | null | undefined)[];
  layoutTreePositions?: readonly number[];
  page?: AppRouteSegmentConfigModule | null;
  parallelBranches?: readonly (ParallelAppPageSegmentConfigBranch | null | undefined)[];
  parallelPages?: readonly (AppRouteSegmentConfigModule | null | undefined)[];
  parallelSegments?: readonly (AppRouteSegmentConfigModule | null | undefined)[];
  routeSegments?: readonly string[];
};

const DYNAMIC_VALUES = new Set<unknown>(["auto", "error", "force-dynamic", "force-static"]);
const FETCH_CACHE_VALUES = new Set<unknown>([
  "auto",
  "default-cache",
  "default-no-store",
  "force-cache",
  "force-no-store",
  "only-cache",
  "only-no-store",
]);

function isRouteSegmentDynamic(value: unknown): value is AppRouteSegmentDynamic {
  return DYNAMIC_VALUES.has(value);
}

function isRouteSegmentFetchCache(value: unknown): value is FetchCacheMode {
  return FETCH_CACHE_VALUES.has(value);
}

function isRouteSegmentRuntime(value: unknown): value is EffectiveAppPageSegmentConfig["runtime"] {
  return value === "edge" || value === "experimental-edge" || value === "nodejs";
}

function resolveRevalidateSeconds(current: number | null, value: unknown): number | null {
  // revalidate = false means "cache indefinitely" in Next.js segment config.
  // Represent it as Infinity so downstream code can distinguish "never
  // revalidate" (Infinity) from "no config / unset" (null).
  if (value === false) {
    if (current === null) return Infinity;
    // Shortest-wins: any finite interval is shorter than Infinity.
    return current === Infinity ? Infinity : current;
  }

  if (typeof value !== "number") {
    return current;
  }

  if (current === null) {
    return value;
  }

  return value < current ? value : current;
}

function resolveDynamicStaleTimeSeconds(
  current: number | undefined,
  value: unknown,
): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return current;
  }

  return current === undefined ? value : Math.min(current, value);
}

function isDynamicSegment(segment: string): boolean {
  return segment.startsWith("[") && segment.endsWith("]");
}

function getParallelSegments(
  options: ResolveAppPageSegmentConfigOptions,
): readonly (AppRouteSegmentConfigModule | null | undefined)[] {
  if (!options.parallelBranches) return options.parallelSegments ?? [];
  return options.parallelBranches.flatMap((branch) =>
    branch ? [branch.layout, ...(branch.configLayouts ?? []), branch.page] : [],
  );
}

function resolveDynamicParamsConfig(
  options: ResolveAppPageSegmentConfigOptions,
): boolean | undefined {
  const parallelSegments = getParallelSegments(options);
  const segments = [...(options.layouts ?? []), options.page, ...parallelSegments];
  let dynamicParamsConfig: boolean | undefined;

  for (const segment of segments) {
    if (segment?.dynamicParams === false) {
      dynamicParamsConfig = false;
    } else if (segment?.dynamicParams === true && dynamicParamsConfig !== false) {
      dynamicParamsConfig = true;
    }
  }

  if (dynamicParamsConfig !== false || !options.routeSegments) {
    return dynamicParamsConfig;
  }

  let lastDynamicPosition = -1;
  for (let index = options.routeSegments.length - 1; index >= 0; index--) {
    if (isDynamicSegment(options.routeSegments[index])) {
      lastDynamicPosition = index;
      break;
    }
  }
  if (lastDynamicPosition < 0) return dynamicParamsConfig;

  const layouts = options.layouts ?? [];
  const layoutPositions = options.layoutTreePositions ?? [];
  let lastDynamicSegmentIsStaticOnly = false;
  let lastDynamicSegmentHasStaticParams = false;

  layouts.forEach((layout, index) => {
    const ownerPosition = (layoutPositions[index] ?? 0) - 1;
    if (ownerPosition !== lastDynamicPosition) return;
    if (layout?.dynamicParams === false) lastDynamicSegmentIsStaticOnly = true;
    if (typeof layout?.generateStaticParams === "function") {
      lastDynamicSegmentHasStaticParams = true;
    }
  });

  if (options.page?.dynamicParams === false) lastDynamicSegmentIsStaticOnly = true;
  if (typeof options.page?.generateStaticParams === "function") {
    lastDynamicSegmentHasStaticParams = true;
  }

  for (const branch of options.parallelBranches ?? []) {
    if (!branch) continue;
    const branchStartPosition = options.routeSegments.length - (branch.routeSegments?.length ?? 0);
    const checkSegment = (
      segment: AppRouteSegmentConfigModule | null | undefined,
      ownerPosition: number,
    ) => {
      if (ownerPosition !== lastDynamicPosition) return;
      if (segment?.dynamicParams === false) lastDynamicSegmentIsStaticOnly = true;
      if (typeof segment?.generateStaticParams === "function") {
        lastDynamicSegmentHasStaticParams = true;
      }
    };

    checkSegment(branch.layout, branchStartPosition - 1);
    branch.configLayouts?.forEach((layout, index) => {
      checkSegment(
        layout,
        branchStartPosition + (branch.configLayoutTreePositions?.[index] ?? 0) - 1,
      );
    });
    checkSegment(branch.page, branchStartPosition + (branch.routeSegments?.length ?? 0) - 1);
  }

  if (!options.parallelBranches) {
    for (const segment of parallelSegments) {
      if (segment?.dynamicParams === false) lastDynamicSegmentIsStaticOnly = true;
      if (typeof segment?.generateStaticParams === "function") {
        lastDynamicSegmentHasStaticParams = true;
      }
    }
  }

  return lastDynamicSegmentIsStaticOnly || lastDynamicSegmentHasStaticParams ? false : undefined;
}

function isCacheFetchCacheMode(value: FetchCacheMode): boolean {
  return value === "default-cache" || value === "force-cache" || value === "only-cache";
}

function describeFetchCacheConflict(value: FetchCacheMode): string {
  return `Route segment config has incompatible fetchCache values including "${value}".`;
}

/**
 * Resolve the route segment config that applies to an App page route.
 *
 * Next.js collects config from every segment in the loader tree and reduces it
 * into the effective route config. The generated vinext entry already knows
 * the concrete layout/page modules for a route, so it should only describe
 * those modules and delegate the behavior to this helper.
 */
export function resolveAppPageSegmentConfig(
  options: ResolveAppPageSegmentConfigOptions,
): EffectiveAppPageSegmentConfig {
  const segments = [...(options.layouts ?? []), options.page];
  const parallelSegments = getParallelSegments(options);
  // Reduction strategies differ by field:
  // - dynamic: child segments override parents.
  // - dynamicParams: false is sticky across the route tree.
  // - fetchCache: force/only modes take route-level precedence and reject conflicts.
  // - revalidate: the shortest numeric interval wins.
  const config: EffectiveAppPageSegmentConfig = {
    revalidateSeconds: null,
  };
  config.dynamicParamsConfig = resolveDynamicParamsConfig(options);
  let hasForceCache = false;
  let hasForceNoStore = false;
  let hasOnlyCache = false;
  let hasOnlyNoStore = false;
  let hasParentDefaultNoStore = false;
  let hasForceDynamic = false;

  for (const segment of segments) {
    if (!segment) continue;

    if (isRouteSegmentDynamic(segment.dynamic)) {
      if (segment.dynamic === "force-dynamic") {
        hasForceDynamic = true;
      }
      config.dynamicConfig = hasForceDynamic ? "force-dynamic" : segment.dynamic;
    }

    if (isRouteSegmentRuntime(segment.runtime)) {
      config.runtime = segment.runtime;
    }

    if (isRouteSegmentFetchCache(segment.fetchCache)) {
      const fetchCache = segment.fetchCache;

      if (hasParentDefaultNoStore && (fetchCache === "auto" || isCacheFetchCacheMode(fetchCache))) {
        throw new Error(describeFetchCacheConflict(fetchCache));
      }

      if (fetchCache === "force-cache") hasForceCache = true;
      if (fetchCache === "force-no-store") hasForceNoStore = true;
      if (fetchCache === "only-cache") hasOnlyCache = true;
      if (fetchCache === "only-no-store") hasOnlyNoStore = true;

      const hasConflictingForces = hasForceCache && hasForceNoStore;
      const hasConflictingOnlyModes =
        !hasForceCache && !hasForceNoStore && hasOnlyCache && hasOnlyNoStore;
      if (hasConflictingForces || hasConflictingOnlyModes) {
        throw new Error(describeFetchCacheConflict(fetchCache));
      }

      if (fetchCache === "default-no-store") {
        hasParentDefaultNoStore = true;
      }

      if (hasForceCache) {
        config.fetchCache = "force-cache";
      } else if (hasForceNoStore) {
        config.fetchCache = "force-no-store";
      } else if (hasOnlyCache) {
        config.fetchCache = "only-cache";
      } else if (hasOnlyNoStore) {
        config.fetchCache = "only-no-store";
      } else {
        config.fetchCache = fetchCache;
      }
    }

    config.revalidateSeconds = resolveRevalidateSeconds(
      config.revalidateSeconds,
      segment.revalidate,
    );
  }

  for (const segment of parallelSegments) {
    if (!segment) continue;

    // Next.js traverses every parallel branch. Vinext's flattened route graph
    // does not preserve the exact breadth-first overwrite order, so primary
    // chain values remain authoritative when present. Slot-only values still
    // define the route, while sticky route-wide constraints aggregate across
    // every active branch.
    if (segment.dynamic === "force-dynamic") {
      hasForceDynamic = true;
      config.dynamicConfig = "force-dynamic";
    } else if (config.dynamicConfig === undefined && isRouteSegmentDynamic(segment.dynamic)) {
      config.dynamicConfig = segment.dynamic;
    }

    if (config.runtime === undefined && isRouteSegmentRuntime(segment.runtime)) {
      config.runtime = segment.runtime;
    }

    if (isRouteSegmentFetchCache(segment.fetchCache)) {
      const fetchCache = segment.fetchCache;
      if (hasParentDefaultNoStore && (fetchCache === "auto" || isCacheFetchCacheMode(fetchCache))) {
        throw new Error(describeFetchCacheConflict(fetchCache));
      }
      if (fetchCache === "force-cache") hasForceCache = true;
      if (fetchCache === "force-no-store") hasForceNoStore = true;
      if (fetchCache === "only-cache") hasOnlyCache = true;
      if (fetchCache === "only-no-store") hasOnlyNoStore = true;
      const hasConflictingForces = hasForceCache && hasForceNoStore;
      const hasConflictingOnlyModes =
        !hasForceCache && !hasForceNoStore && hasOnlyCache && hasOnlyNoStore;
      if (hasConflictingForces || hasConflictingOnlyModes) {
        throw new Error(describeFetchCacheConflict(fetchCache));
      }
      if (fetchCache === "default-no-store") {
        hasParentDefaultNoStore = true;
      }
      if (hasForceCache) config.fetchCache = "force-cache";
      else if (hasForceNoStore) config.fetchCache = "force-no-store";
      else if (hasOnlyCache) config.fetchCache = "only-cache";
      else if (hasOnlyNoStore) config.fetchCache = "only-no-store";
      else if (config.fetchCache === undefined) config.fetchCache = fetchCache;
    }

    config.revalidateSeconds = resolveRevalidateSeconds(
      config.revalidateSeconds,
      segment.revalidate,
    );
  }

  for (const segment of [options.page, ...(options.parallelPages ?? [])]) {
    if (!segment) continue;
    config.dynamicStaleTimeSeconds = resolveDynamicStaleTimeSeconds(
      config.dynamicStaleTimeSeconds,
      segment.unstable_dynamicStaleTime,
    );
  }

  if (config.dynamicConfig === "force-dynamic") {
    config.revalidateSeconds = 0;
  }

  // Static-only dynamic modes supply fetchCache defaults unless a segment does.
  // `dynamic = "force-dynamic"` is handled at the fetch decision layer: it
  // defaults no-config fetches to no-store but must not override explicit
  // per-fetch cache/revalidate options.
  if (config.fetchCache === undefined) {
    if (config.dynamicConfig === "error") {
      config.fetchCache = "only-cache";
    }
  }

  return config;
}

export function resolveAppPageFetchCacheMode(
  options: ResolveAppPageSegmentConfigOptions,
): FetchCacheMode | null {
  return resolveAppPageSegmentConfig(options).fetchCache ?? null;
}

/**
 * Resolve the `fetchCache` segment config exported by a route handler module.
 *
 * Route handlers have no layout chain, so the module's own export applies
 * directly. Mirrors upstream's app-route module, which copies
 * `userland.fetchCache` into the work store before invoking the handler.
 */
export function resolveAppRouteHandlerFetchCacheMode(
  handler: Pick<AppRouteSegmentConfigModule, "fetchCache">,
): FetchCacheMode | null {
  return isRouteSegmentFetchCache(handler.fetchCache) ? handler.fetchCache : null;
}

export function isEdgeRuntime(runtime: string | undefined): boolean {
  return isEdgeApiRuntime(runtime);
}
