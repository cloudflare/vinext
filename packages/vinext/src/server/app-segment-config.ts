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
  unstable_instant?: unknown;
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
  cacheComponents?: boolean;
  layouts?: readonly (AppRouteSegmentConfigModule | null | undefined)[];
  layoutTreePositions?: readonly number[];
  page?: AppRouteSegmentConfigModule | null;
  parallelBranches?: readonly (ParallelAppPageSegmentConfigBranch | null | undefined)[];
  parallelPages?: readonly (AppRouteSegmentConfigModule | null | undefined)[];
  parallelSegments?: readonly (AppRouteSegmentConfigModule | null | undefined)[];
  route?: string;
  routeSegments?: readonly string[];
};

type ValidateAppRouteSegmentConfigOptions = {
  cacheComponents: boolean;
  isClientModule?: boolean;
  route: string;
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
const INSTANT_CONFIG_KEYS = new Set([
  "prefetch",
  "samples",
  "from",
  "unstable_disableValidation",
  "unstable_disableDevValidation",
  "unstable_disableBuildValidation",
]);
const INSTANT_SAMPLE_KEYS = new Set(["cookies", "headers", "params", "searchParams"]);
const INSTANT_COOKIE_KEYS = new Set(["name", "value"]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isInstantParamRecord(value: unknown, allowNull: boolean): boolean {
  if (!isPlainRecord(value)) return false;
  return Object.values(value).every(
    (entry) =>
      typeof entry === "string" ||
      (allowNull && entry === null) ||
      (Array.isArray(entry) && entry.every((item) => typeof item === "string")),
  );
}

function isInstantSample(value: unknown): boolean {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, INSTANT_SAMPLE_KEYS)) return false;

  if (
    value.cookies !== undefined &&
    (!Array.isArray(value.cookies) ||
      !value.cookies.every(
        (cookie) =>
          isPlainRecord(cookie) &&
          hasOnlyKeys(cookie, INSTANT_COOKIE_KEYS) &&
          typeof cookie.name === "string" &&
          (typeof cookie.value === "string" || cookie.value === null),
      ))
  ) {
    return false;
  }

  if (
    value.headers !== undefined &&
    (!Array.isArray(value.headers) ||
      !value.headers.every(
        (header) =>
          Array.isArray(header) &&
          header.length === 2 &&
          typeof header[0] === "string" &&
          (typeof header[1] === "string" || header[1] === null),
      ))
  ) {
    return false;
  }

  if (value.params !== undefined && !isInstantParamRecord(value.params, false)) return false;
  if (value.searchParams !== undefined && !isInstantParamRecord(value.searchParams, true)) {
    return false;
  }

  return true;
}

function isInstantConfig(value: unknown): boolean {
  // Mirrors the unstable_instant revision in Next.js v16.2.6, the pinned
  // deploy-suite oracle. Canary revisions may use a different unstable shape.
  if (value === false) return true;
  if (!isPlainRecord(value) || !hasOnlyKeys(value, INSTANT_CONFIG_KEYS)) return false;
  if (value.prefetch !== "static" && value.prefetch !== "runtime") return false;

  if (value.samples !== undefined) {
    if (
      !Array.isArray(value.samples) ||
      value.samples.length === 0 ||
      !value.samples.every(isInstantSample)
    ) {
      return false;
    }
  } else if (value.prefetch === "runtime") {
    return false;
  }

  if (value.from !== undefined && !isStringArray(value.from)) return false;
  for (const key of [
    "unstable_disableValidation",
    "unstable_disableDevValidation",
    "unstable_disableBuildValidation",
  ] as const) {
    if (value[key] !== undefined && value[key] !== true) return false;
  }

  return true;
}

function describeInvalidInstant(value: unknown, route: string): string {
  return (
    `Invalid segment configuration options detected for "${route}". ` +
    "Read more at https://nextjs.org/docs/app/api-reference/file-conventions/route-segment-config\n" +
    `Invalid unstable_instant value ${JSON.stringify(value)} on "${route}", must be an object ` +
    'with `prefetch: "static"` or `prefetch: "runtime"`, or `false`. Read more at ' +
    "https://nextjs.org/docs/messages/invalid-instant-configuration"
  );
}

/**
 * Validate the segment-level `unstable_instant` contract used by Next.js.
 *
 * This deliberately checks export presence rather than truthiness: exporting
 * `false` is valid schema-wise, but still requires Cache Components and still
 * conflicts with `unstable_dynamicStaleTime`, matching Next's static-info pass.
 */
export function validateAppRouteSegmentConfig(
  segment: AppRouteSegmentConfigModule,
  options: ValidateAppRouteSegmentConfigOptions,
): void {
  if (!("unstable_instant" in segment)) return;

  if (options.isClientModule) {
    throw new Error(
      `Page "${options.route}" cannot export "unstable_instant" from a Client Component module. ` +
        'To use this API, convert this module to a Server Component by removing the "use client" directive.',
    );
  }

  if (!options.cacheComponents) {
    throw new Error(
      `Page "${options.route}" cannot use \`export const unstable_instant = ...\` without enabling \`cacheComponents\`.`,
    );
  }

  if ("unstable_dynamicStaleTime" in segment) {
    throw new Error(
      `Page "${options.route}" cannot use both \`export const unstable_dynamicStaleTime\` and \`export const unstable_instant\`.`,
    );
  }

  if (!isInstantConfig(segment.unstable_instant)) {
    throw new Error(describeInvalidInstant(segment.unstable_instant, options.route));
  }
}

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

function resolveSegmentConfigOwnerPosition(
  routeSegments: readonly string[],
  treePosition: number,
): number {
  let ownerPosition = Math.min(treePosition - 1, routeSegments.length - 1);
  while (ownerPosition >= 0) {
    const segment = routeSegments[ownerPosition];
    if (!segment.startsWith("@") && !(segment.startsWith("(") && segment.endsWith(")"))) {
      break;
    }
    ownerPosition -= 1;
  }
  return ownerPosition;
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

  const routeSegments = options.routeSegments;
  let lastDynamicPosition = -1;
  for (let index = routeSegments.length - 1; index >= 0; index--) {
    if (isDynamicSegment(routeSegments[index])) {
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
    const ownerPosition = resolveSegmentConfigOwnerPosition(
      routeSegments,
      layoutPositions[index] ?? 0,
    );
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
    const branchStartPosition = routeSegments.length - (branch.routeSegments?.length ?? 0);
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
  for (const segment of [...segments, ...parallelSegments]) {
    if (!segment) continue;
    validateAppRouteSegmentConfig(segment, {
      cacheComponents: options.cacheComponents === true,
      route: options.route ?? "unknown",
    });
  }
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
